//! Library scan and iTunes XML import: walk a folder (or parse the XML) into
//! `Track` rows plus a refreshed content-hash cache, with progress events and a
//! shared cancel flag.

use crate::identity::{
    cache_lookup, compute_track_key, content_hash_cached, is_dataless, size_and_mtime, HashCacheEntry,
};
use crate::tags::{read_tag_summary, TagSummary};
use serde::{Deserialize, Serialize};
use siphasher::sip::SipHasher13;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use walkdir::WalkDir;

/// Shared cancel flag for an in-flight library scan / iTunes import. The scan
/// runs on a blocking thread and polls this between files; `cancel_scan` flips
/// it from the UI thread.
#[derive(Default)]
pub struct ScanState {
    cancel: Arc<AtomicBool>,
}

/// Per-file progress for a running scan, emitted as `scan-progress`.
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    done: usize,
    total: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Track {
    id: String,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    file_path: String,
    file_name: String,
    duration: Option<f64>,
    /// Disc / track numbers from the file's tags, for the natural album order.
    /// `None` when the tag is absent or the file is a cloud placeholder.
    #[serde(default)]
    disc_no: Option<u32>,
    #[serde(default)]
    track_no: Option<u32>,
    /// Stable identity of "the same song" across devices (hash of normalized tags).
    track_key: String,
    /// Cheap fingerprint of the file bytes; changes when the file is replaced/retagged.
    content_hash: String,
    /// Smart-playlist fields, read alongside the rest of the tag. `None` when
    /// the tag has no such field (not when it's simply unread — see
    /// `extra_tags_read`).
    #[serde(default)]
    genre: Option<String>,
    #[serde(default)]
    year: Option<u32>,
    #[serde(default)]
    album_artist: Option<String>,
    #[serde(default)]
    composer: Option<String>,
    /// True once genre/year/album_artist/composer were actually read from this
    /// file's tags (as opposed to a cloud placeholder we skipped). Lets the
    /// frontend tell "no such tag" apart from "never read" and retry the
    /// latter on a later launch via `read_extra_tags`.
    #[serde(default)]
    extra_tags_read: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    tracks: Vec<Track>,
    scanned_path: String,
    /// Refreshed `content_hash_cache` rows for every scanned file — the frontend
    /// persists these so the next scan can skip unchanged files.
    hash_cache: Vec<HashCacheEntry>,
    /// The user hit Cancel before the walk finished; `tracks` is partial and the
    /// caller should discard it (the hash cache is still worth persisting).
    #[serde(default)]
    cancelled: bool,
    /// Count of cloud-only placeholder files that were registered with
    /// filename-only metadata because downloading them to read tags was skipped.
    #[serde(default)]
    skipped_cloud: usize,
}

/// Result of walking one directory, before it's wrapped in a `ScanResult`.
struct ScanOutcome {
    tracks: Vec<Track>,
    hash_cache: Vec<HashCacheEntry>,
    cancelled: bool,
    skipped_cloud: usize,
}

/// Hashes `t` into the track id persisted in the DB. Deliberately not
/// `std::hash::DefaultHasher`: that hasher's algorithm is an unspecified
/// implementation detail and isn't guaranteed stable across Rust releases,
/// which would silently reassign every track's id on a toolchain upgrade.
/// `SipHasher13::new_with_keys(0, 0)` is verified (see
/// `test_calculate_hash_matches_previous_default_hasher_values`) to produce
/// the exact same output `DefaultHasher` does today, so existing ids are
/// unaffected.
fn calculate_hash<T: Hash>(t: &T) -> u64 {
    let mut s = SipHasher13::new_with_keys(0, 0);
    t.hash(&mut s);
    s.finish()
}

/// Flip the shared cancel flag so a running scan / import stops after the file
/// it's currently on. No-op when nothing is scanning.
#[tauri::command]
pub fn cancel_scan(state: tauri::State<'_, ScanState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn scan_music_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, ScanState>,
    directory: Option<String>,
    hash_cache: Option<Vec<HashCacheEntry>>,
) -> Result<ScanResult, String> {
    let target_dir = if let Some(dir) = directory {
        PathBuf::from(dir)
    } else {
        app.path().audio_dir().map_err(|e| e.to_string())?
    };

    // A registered folder that's temporarily unreachable (e.g. an unmounted
    // cloud-synced volume) must not be treated as "scanned, found nothing" —
    // the caller empties the folder's playlist and prunes orphaned tracks on
    // a successful scan, which would wipe the library instead of just
    // skipping this run.
    if let Some(err) = missing_folder_error(&target_dir) {
        return Err(err);
    }

    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let lookup = cache_lookup(hash_cache);

    tauri::async_runtime::spawn_blocking(move || {
        let emitter = app.clone();
        let outcome = scan_directory(&target_dir, &lookup, &cancel, move |done, total| {
            let _ = emitter.emit("scan-progress", ScanProgress { done, total });
        });
        ScanResult {
            tracks: outcome.tracks,
            scanned_path: target_dir.to_string_lossy().to_string(),
            hash_cache: outcome.hash_cache,
            cancelled: outcome.cancelled,
            skipped_cloud: outcome.skipped_cloud,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn import_itunes_xml(
    app: tauri::AppHandle,
    state: tauri::State<'_, ScanState>,
    xml_path: String,
    hash_cache: Option<Vec<HashCacheEntry>>,
) -> Result<ScanResult, String> {
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let hash_cache = cache_lookup(hash_cache);

    tauri::async_runtime::spawn_blocking(move || {
        let emitter = app.clone();
        import_itunes_xml_blocking(&cancel, xml_path, hash_cache, move |done, total| {
            let _ = emitter.emit("scan-progress", ScanProgress { done, total });
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn import_itunes_xml_blocking(
    cancel: &AtomicBool,
    xml_path: String,
    hash_cache: HashMap<String, (u64, u64, String)>,
    progress: impl Fn(usize, usize),
) -> Result<ScanResult, String> {
    let mut tracks = Vec::new();
    let mut fresh_cache = Vec::new();
    let mut skipped_cloud = 0usize;
    let mut cancelled = false;

    // Parse the XML file
    let value =
        plist::Value::from_file(&xml_path).map_err(|e| format!("Failed to parse XML: {}", e))?;

    let dict = value.as_dictionary().ok_or("Root is not a dictionary")?;

    if let Some(tracks_dict) = dict.get("Tracks").and_then(|t| t.as_dictionary()) {
        let total = tracks_dict.len();
        progress(0, total);
        for (done, (_key, track_info)) in tracks_dict.into_iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            progress(done + 1, total);
            if let Some(info) = track_info.as_dictionary() {
                // Get Location (URL-encoded file path)
                if let Some(location) = info.get("Location").and_then(|l| l.as_string()) {
                    if location.starts_with("file://") {
                        let path = url::Url::parse(location)
                            .ok()
                            .and_then(|u| u.to_file_path().ok());
                        if let Some(path) = path.filter(|p| p.exists()) {
                            let path_str = path.to_string_lossy().to_string();
                            let file_name = path
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();

                            // A cloud placeholder: reading its tags would download
                            // the whole file. Take identity/metadata from the XML
                            // and the filename instead, and skip the hash.
                            let cloud_only = is_dataless(&path);
                            if cloud_only {
                                skipped_cloud += 1;
                            }
                            let TagSummary {
                                title: tag_title,
                                artist: tag_artist,
                                album: tag_album,
                                duration_secs,
                                disc_no,
                                track_no,
                                genre,
                                year,
                                album_artist,
                                composer,
                            } = if cloud_only {
                                TagSummary::default()
                            } else {
                                read_tag_summary(&path)
                            };

                            // Cross-device identity must be derived the same way as
                            // scan_directory: purely from the file's own tags, never
                            // from the (possibly edited) iTunes metadata.
                            let key_title = tag_title.clone().unwrap_or_else(|| {
                                path.file_stem()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_else(|| file_name.clone())
                            });
                            let track_key = compute_track_key(
                                tag_artist.as_deref(),
                                tag_album.as_deref(),
                                &key_title,
                                duration_secs,
                                track_no,
                            );

                            let title = info
                                .get("Name")
                                .and_then(|n| n.as_string())
                                .map(|s| s.to_string())
                                .or(tag_title)
                                .unwrap_or_else(|| file_name.clone());

                            let artist = info
                                .get("Artist")
                                .and_then(|v| v.as_string())
                                .map(|s| s.to_string())
                                .or(tag_artist);

                            let album = info
                                .get("Album")
                                .and_then(|v| v.as_string())
                                .map(|s| s.to_string())
                                .or(tag_album);

                            let duration = info
                                .get("Total Time")
                                .and_then(|v| v.as_signed_integer())
                                .map(|ms| ms as f64 / 1000.0)
                                .or(if duration_secs > 0 {
                                    Some(duration_secs as f64)
                                } else {
                                    None
                                });

                            let id = calculate_hash(&path_str).to_string();
                            let content_hash = if cloud_only {
                                String::new()
                            } else {
                                let (size, mtime) = size_and_mtime(&path);
                                let hash =
                                    content_hash_cached(&path, size, mtime, &hash_cache);
                                fresh_cache.push(HashCacheEntry {
                                    file_path: path_str.clone(),
                                    size,
                                    mtime,
                                    content_hash: hash.clone(),
                                    track_key: track_key.clone(),
                                });
                                hash
                            };

                            tracks.push(Track {
                                id,
                                title,
                                artist,
                                album,
                                file_path: path_str,
                                file_name,
                                duration,
                                disc_no,
                                track_no,
                                track_key,
                                content_hash,
                                genre,
                                year,
                                album_artist,
                                composer,
                                extra_tags_read: !cloud_only,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(ScanResult {
        tracks,
        scanned_path: xml_path,
        hash_cache: fresh_cache,
        cancelled,
        skipped_cloud,
    })
}

/// `Some(message)` when `dir` isn't a reachable directory — used by
/// `scan_music_dir` to refuse a scan of a registered folder that's
/// temporarily unmounted, rather than silently reporting zero tracks.
fn missing_folder_error(dir: &Path) -> Option<String> {
    if dir.is_dir() {
        None
    } else {
        Some(format!("Folder not found: {}", dir.to_string_lossy()))
    }
}

/// Convenience wrapper used by tests and the default `audio_dir` path: no cancel
/// flag, no progress callback.
#[cfg(test)]
fn scan_directory_simple(
    base_dir: &std::path::Path,
    hash_cache: &HashMap<String, (u64, u64, String)>,
) -> (Vec<Track>, Vec<HashCacheEntry>) {
    let cancel = AtomicBool::new(false);
    let outcome = scan_directory(base_dir, hash_cache, &cancel, |_, _| {});
    (outcome.tracks, outcome.hash_cache)
}

fn scan_directory(
    base_dir: &std::path::Path,
    hash_cache: &HashMap<String, (u64, u64, String)>,
    cancel: &AtomicBool,
    progress: impl Fn(usize, usize),
) -> ScanOutcome {
    let supported_extensions = ["mp3", "m4a", "flac"];
    let is_supported = |p: &Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| supported_extensions.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
    };

    // Pass 1: list candidate files. `WalkDir` only reads directory entries here,
    // never file contents, so this stays fast and safe even when `base_dir` is a
    // cloud-synced folder full of un-downloaded placeholders.
    let files: Vec<PathBuf> = WalkDir::new(base_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(walkdir::DirEntry::into_path)
        .filter(|p| is_supported(p))
        .collect();

    let total = files.len();
    let mut tracks = Vec::with_capacity(total);
    let mut fresh_cache = Vec::with_capacity(total);
    let mut skipped_cloud = 0usize;
    let mut cancelled = false;
    progress(0, total);

    // Pass 2: read tags + hash. This is where cloud downloads would be triggered,
    // so it's the part the user can cancel and where placeholders are skipped.
    for (i, path) in files.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        let path = path.as_path();
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        let file_path = path.to_string_lossy().to_string();
        let id = calculate_hash(&file_path).to_string();
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file_name.clone());

        if is_dataless(path) {
            // Cloud placeholder with no local bytes — register it from the
            // filename only and leave no hash-cache row, so the next rescan
            // retries once the file has been made available offline.
            skipped_cloud += 1;
            let track_key = compute_track_key(None, None, &stem, 0, None);
            tracks.push(Track {
                id,
                title: stem,
                artist: None,
                album: None,
                file_path,
                file_name,
                duration: None,
                disc_no: None,
                track_no: None,
                track_key,
                content_hash: String::new(),
                genre: None,
                year: None,
                album_artist: None,
                composer: None,
                extra_tags_read: false,
            });
            progress(i + 1, total);
            continue;
        }

        let TagSummary {
            title: tag_title,
            artist,
            album,
            duration_secs,
            disc_no,
            track_no,
            genre,
            year,
            album_artist,
            composer,
        } = read_tag_summary(path);
        let title = tag_title.unwrap_or(stem);
        let duration = if duration_secs > 0 {
            Some(duration_secs as f64)
        } else {
            None
        };
        let track_key = compute_track_key(
            artist.as_deref(),
            album.as_deref(),
            &title,
            duration_secs,
            track_no,
        );
        let (size, mtime) = size_and_mtime(path);
        let content_hash = content_hash_cached(path, size, mtime, hash_cache);

        fresh_cache.push(HashCacheEntry {
            file_path: file_path.clone(),
            size,
            mtime,
            content_hash: content_hash.clone(),
            track_key: track_key.clone(),
        });

        tracks.push(Track {
            id,
            title,
            artist,
            album,
            file_path,
            file_name,
            duration,
            disc_no,
            track_no,
            track_key,
            content_hash,
            genre,
            year,
            album_artist,
            composer,
            extra_tags_read: true,
        });
        progress(i + 1, total);
    }

    ScanOutcome {
        tracks,
        hash_cache: fresh_cache,
        cancelled,
        skipped_cloud,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{compute_track_identities, compute_track_identity};
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_missing_folder_error() {
        let dir = tempdir().unwrap();
        assert_eq!(missing_folder_error(dir.path()), None);

        let gone = dir.path().join("does-not-exist");
        assert!(missing_folder_error(&gone).unwrap().contains("Folder not found"));
    }

    #[test]
    fn test_scan_directory_basic() {
        let dir = tempdir().unwrap();
        let file_path_mp3 = dir.path().join("test.mp3");
        File::create(&file_path_mp3).unwrap();

        let (tracks, cache) = scan_directory_simple(dir.path(), &HashMap::new());
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].file_name, "test.mp3");
        assert_eq!(cache.len(), 1);
        assert_eq!(cache[0].file_path, tracks[0].file_path);
    }

    #[test]
    fn test_scan_track_key_derived_from_tags_not_path() {
        // A tagless file falls back to the filename stem for the key title;
        // scan_directory must produce exactly compute_track_key(None, None, stem, 0, None)
        // so an iTunes import of the same file lands on the same key.
        let dir = tempdir().unwrap();
        File::create(dir.path().join("come together.mp3")).unwrap();

        let (tracks, _) = scan_directory_simple(dir.path(), &HashMap::new());
        assert_eq!(
            tracks[0].track_key,
            compute_track_key(None, None, "come together", 0, None)
        );
    }

    #[tokio::test]
    async fn untagged_file_gets_the_same_track_key_from_scan_backfill_and_tag_edit_paths() {
        // The fallback title is the file *stem*. The backfill and `Get Info` paths
        // once used the full file name (extension included), so an untagged
        // "live set.mp3" had two keys that flipped on every rescan — orphaning its
        // play history and making the phone delete and re-download it.
        let dir = tempdir().unwrap();
        let p = dir.path().join("live set.mp3");
        std::fs::write(&p, b"pretend mp3 bytes").unwrap();
        let path = p.to_string_lossy().to_string();

        let (tracks, _) = scan_directory_simple(dir.path(), &HashMap::new());
        let scanned = tracks[0].track_key.clone();

        assert_eq!(compute_track_identity(path.clone()).unwrap().track_key, scanned);
        let batch = compute_track_identities(vec![path], None).await.unwrap();
        assert_eq!(batch.rows[0].track_key, scanned);
    }

    #[test]
    fn scan_directory_stops_when_cancel_flag_is_set() {
        let dir = tempdir().unwrap();
        File::create(dir.path().join("a.mp3")).unwrap();
        File::create(dir.path().join("b.mp3")).unwrap();

        let cancel = AtomicBool::new(true);
        let outcome = scan_directory(dir.path(), &HashMap::new(), &cancel, |_, _| {});
        assert!(outcome.cancelled);
        assert!(outcome.tracks.is_empty());
    }

    #[test]
    fn test_scan_directory_ignores_unsupported_extensions() {
        let dir = tempdir().unwrap();
        let txt_file = dir.path().join("notes.txt");
        let jpg_file = dir.path().join("cover.jpg");
        File::create(&txt_file).unwrap();
        File::create(&jpg_file).unwrap();

        let (tracks, _) = scan_directory_simple(dir.path(), &HashMap::new());
        assert_eq!(tracks.len(), 0);
    }

    #[test]
    fn test_calculate_hash_deterministic() {
        let hash1 = calculate_hash(&"/path/to/song.mp3".to_string());
        let hash2 = calculate_hash(&"/path/to/song.mp3".to_string());
        let hash3 = calculate_hash(&"/path/to/other.mp3".to_string());
        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }

    /// Pins `calculate_hash`'s output to the exact values
    /// `std::hash::DefaultHasher` produced before the switch to
    /// `SipHasher13` (recorded once, on rustc 1.96.1) — a change here would
    /// reassign every track's id for everyone already using the app.
    #[test]
    fn test_calculate_hash_matches_previous_default_hasher_values() {
        assert_eq!(calculate_hash(&"/path/to/song.mp3".to_string()), 2860210751367922828);
        assert_eq!(calculate_hash(&"hello".to_string()), 16156531084128653017);
        assert_eq!(calculate_hash(&String::new()), 3476900567878811119);
        assert_eq!(calculate_hash(&"日本語のパス/曲.flac".to_string()), 11271436260817261377);
    }

    #[test]
    fn test_import_itunes_xml_invalid_path() {
        let cancel = AtomicBool::new(false);
        let result = import_itunes_xml_blocking(
            &cancel,
            "/nonexistent/itunes.xml".to_string(),
            HashMap::new(),
            |_, _| {},
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_import_itunes_xml_decodes_file_url_locations() {
        // Real iTunes exports use `file://localhost/`, and percent-encode
        // spaces and other characters in the path.
        let dir = tempdir().unwrap();
        let sub = dir.path().join("Rock & Roll");
        std::fs::create_dir(&sub).unwrap();
        let song = sub.join("track one.mp3");
        File::create(&song).unwrap();

        let location = format!(
            "file://localhost{}",
            url::Url::from_file_path(&song).unwrap().path()
        )
        .replace('&', "&amp;"); // XML-escape for embedding in the plist below
        let xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Tracks</key>
    <dict>
        <key>1</key>
        <dict>
            <key>Name</key><string>Track One</string>
            <key>Location</key><string>{location}</string>
        </dict>
    </dict>
</dict>
</plist>"#
        );
        let xml_path = dir.path().join("Library.xml");
        std::fs::write(&xml_path, xml).unwrap();

        let cancel = AtomicBool::new(false);
        let result = import_itunes_xml_blocking(
            &cancel,
            xml_path.to_string_lossy().to_string(),
            HashMap::new(),
            |_, _| {},
        )
        .unwrap();

        assert!(!result.cancelled);
        assert_eq!(result.tracks.len(), 1);
        assert_eq!(result.tracks[0].title, "Track One");
        assert_eq!(result.tracks[0].file_path, song.to_string_lossy());
    }

    #[test]
    fn scan_directory_reuses_cached_hash() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("track.mp3");
        std::fs::write(&p, b"pretend mp3").unwrap();
        let (size, mtime) = size_and_mtime(&p);

        let mut cache = HashMap::new();
        cache.insert(
            p.to_string_lossy().to_string(),
            (size, mtime, "STALE_BUT_TRUSTED".to_string()),
        );
        let (tracks, fresh) = scan_directory_simple(dir.path(), &cache);
        assert_eq!(tracks[0].content_hash, "STALE_BUT_TRUSTED");
        assert_eq!(fresh[0].content_hash, "STALE_BUT_TRUSTED");
        assert_eq!(fresh[0].size, size);
    }
}
