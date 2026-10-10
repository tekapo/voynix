mod metadata;
mod player;
mod server;
mod tls;
mod transcode;
mod util;

use lofty::file::AudioFile;
use lofty::prelude::{Accessor, ItemKey, TaggedFileExt};
use lofty::probe::Probe;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use siphasher::sip::SipHasher13;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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

#[derive(Debug, Serialize)]
pub struct TrackIdentity {
    track_key: String,
    content_hash: String,
}

/// What we pull out of a file's audio tags in one probe.
#[derive(Default)]
struct TagSummary {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_secs: u64,
    disc_no: Option<u32>,
    track_no: Option<u32>,
    genre: Option<String>,
    year: Option<u32>,
    album_artist: Option<String>,
    composer: Option<String>,
}

fn read_tag_summary(path: &Path) -> TagSummary {
    let mut s = TagSummary::default();

    if let Ok(tagged_file) = Probe::open(path).and_then(|p| p.read()) {
        s.duration_secs = tagged_file.properties().duration().as_secs();
        if let Some(tag) = tagged_file
            .primary_tag()
            .or_else(|| tagged_file.first_tag())
        {
            s.title = tag
                .title()
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty());
            s.artist = tag.artist().map(|s| s.to_string());
            s.album = tag.album().map(|s| s.to_string());
            s.disc_no = tag.disk();
            s.track_no = tag.track();
            s.genre = tag.genre().map(|s| s.to_string());
            s.year = tag.year();
            s.album_artist = tag.get_string(&ItemKey::AlbumArtist).map(|s| s.to_string());
            s.composer = tag.get_string(&ItemKey::Composer).map(|s| s.to_string());
        }
    }

    s
}

/// Cross-device identity: same song => same key on Mac and Android, stable across retagging.
fn compute_track_key(
    artist: Option<&str>,
    album: Option<&str>,
    title: &str,
    duration_secs: u64,
    track_no: Option<u32>,
) -> String {
    let composite = format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        util::normalize_field(artist.unwrap_or("")),
        util::normalize_field(album.unwrap_or("")),
        util::normalize_field(title),
        duration_secs,
        track_no.map(|n| n.to_string()).unwrap_or_default(),
    );
    util::sha256_hex(composite.as_bytes())
}

/// One `content_hash_cache` row: the fingerprint we last computed for a file,
/// keyed by its path and validated by (size, mtime). Passed in by the frontend
/// before a scan and handed back refreshed so a rescan skips re-hashing files
/// that haven't changed.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HashCacheEntry {
    file_path: String,
    size: u64,
    mtime: u64,
    content_hash: String,
    track_key: String,
}

/// `SF_DATALESS` test, split out so it can be unit-tested (a real dataless file
/// can't be created from a test).
#[cfg(target_os = "macos")]
fn is_dataless_flag(st_flags: u32) -> bool {
    // <sys/stat.h>: SF_DATALESS 0x40000000 — "file is dataless object", set by the
    // kernel on a cloud placeholder whose bytes live only on the provider's server.
    st_flags & 0x4000_0000 != 0
}

/// True when `path` is a cloud placeholder with no local bytes (Google Drive
/// File Stream, iCloud Drive "Optimize Mac Storage"). Reading even its header
/// forces the file provider to download the entire file, so the scanner must
/// leave these untouched. Non-macOS platforms have no such concept here.
#[cfg(target_os = "macos")]
fn is_dataless(path: &Path) -> bool {
    use std::os::macos::fs::MetadataExt;
    std::fs::metadata(path)
        .map(|m| is_dataless_flag(m.st_flags()))
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn is_dataless(_path: &Path) -> bool {
    false
}

/// File size and mtime (seconds since epoch), or (0, 0) if unreadable.
fn size_and_mtime(path: &Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (m.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

/// Content hash for `path`, reused from `cache` when the file's (size, mtime)
/// still match the cached row, otherwise computed fresh.
fn content_hash_cached(
    path: &Path,
    size: u64,
    mtime: u64,
    cache: &HashMap<String, (u64, u64, String)>,
) -> String {
    if let Some((s, m, h)) = cache.get(&path.to_string_lossy().to_string()) {
        if *s == size && *m == mtime && !h.is_empty() {
            return h.clone();
        }
    }
    compute_content_hash(path).unwrap_or_default()
}

fn cache_lookup(entries: Option<Vec<HashCacheEntry>>) -> HashMap<String, (u64, u64, String)> {
    entries
        .unwrap_or_default()
        .into_iter()
        .map(|e| (e.file_path, (e.size, e.mtime, e.content_hash)))
        .collect()
}

/// Cheap change-detector: file size + first 64KB + last 64KB.
pub(crate) fn compute_content_hash(path: &Path) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};
    const CHUNK: u64 = 64 * 1024;

    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();

    let mut hasher = Sha256::new();
    hasher.update(len.to_le_bytes());

    let head_len = len.min(CHUNK) as usize;
    let mut head = vec![0u8; head_len];
    file.read_exact(&mut head)?;
    hasher.update(&head);

    if len > CHUNK {
        let tail_len = (len - CHUNK).min(CHUNK);
        file.seek(SeekFrom::End(-(tail_len as i64)))?;
        let mut tail = vec![0u8; tail_len as usize];
        file.read_exact(&mut tail)?;
        hasher.update(&tail);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

/// One row of `read_track_numbers` output: the file path plus its disc / track
/// numbers from the audio tags. Only files that yielded at least one number are
/// returned.
#[derive(Debug, Serialize)]
pub struct TrackNumbers {
    file_path: String,
    disc_no: Option<u32>,
    track_no: Option<u32>,
}

/// Read disc / track numbers for a batch of files. Used once to backfill rows
/// scanned before those columns existed (see NATURAL_ORDER in db.ts). Missing
/// files and cloud placeholders are skipped so the next launch retries them.
#[tauri::command]
fn read_track_numbers(paths: Vec<String>) -> Vec<TrackNumbers> {
    paths
        .into_iter()
        .filter_map(|p| {
            let pb = PathBuf::from(&p);
            if !pb.exists() || is_dataless(&pb) {
                return None;
            }
            let t = read_tag_summary(&pb);
            if t.disc_no.is_none() && t.track_no.is_none() {
                return None;
            }
            Some(TrackNumbers {
                file_path: p,
                disc_no: t.disc_no,
                track_no: t.track_no,
            })
        })
        .collect()
}

/// One row of `read_extra_tags` output: the file path plus the smart-playlist
/// fields from its tags. Unlike `read_track_numbers`, a row is returned even
/// when every field is empty — the caller needs to know the file *was* read
/// so it can mark `extra_tags_read` and stop retrying it.
#[derive(Debug, Serialize)]
pub struct ExtraTags {
    file_path: String,
    genre: Option<String>,
    year: Option<u32>,
    album_artist: Option<String>,
    composer: Option<String>,
}

/// Read genre/year/album_artist/composer for a batch of files. Used once to
/// backfill rows scanned before those columns existed (see migration #12 in
/// migrations.ts). Missing files and cloud placeholders are skipped so the
/// next launch retries them.
#[tauri::command]
fn read_extra_tags(paths: Vec<String>) -> Vec<ExtraTags> {
    paths
        .into_iter()
        .filter_map(|p| {
            let pb = PathBuf::from(&p);
            if !pb.exists() || is_dataless(&pb) {
                return None;
            }
            let t = read_tag_summary(&pb);
            Some(ExtraTags {
                file_path: p,
                genre: t.genre,
                year: t.year,
                album_artist: t.album_artist,
                composer: t.composer,
            })
        })
        .collect()
}

/// One row of `compute_track_identities` output: the file path plus its
/// freshly computed cross-device key and content fingerprint.
#[derive(Debug, Serialize)]
pub struct TrackIdentityRow {
    file_path: String,
    track_key: String,
    content_hash: String,
}

/// Batch result: the identity rows, plus refreshed `content_hash_cache` entries
/// (same shape as `ScanResult::hash_cache`) so the caller can persist them and
/// skip re-hashing these files on the next rescan.
#[derive(Debug, Serialize)]
pub struct IdentityBatch {
    rows: Vec<TrackIdentityRow>,
    hash_cache: Vec<HashCacheEntry>,
}

/// Compute `track_key` / `content_hash` for a batch of files. Used once to
/// backfill rows scanned before those columns existed (see
/// backfillTrackIdentities in db.ts). Missing files and cloud placeholders are
/// skipped so the next launch retries them. Runs on a blocking thread since
/// each file needs up to 128KB of real I/O for its content hash.
/// The title used for `track_key` when a file has no title tag: the file name
/// *without* its extension, exactly as `scan_directory` and `import_itunes_xml`
/// derive it. Every path that recomputes a key (the backfill, `Get Info` tag
/// edits) must use this too — a different fallback gives one file two keys, which
/// orphans its play events and favorites and makes the phone delete and
/// re-download the track.
fn fallback_title(path: &Path) -> String {
    path.file_stem()
        .or_else(|| path.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
async fn compute_track_identities(
    paths: Vec<String>,
    hash_cache: Option<Vec<HashCacheEntry>>,
) -> Result<IdentityBatch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lookup = cache_lookup(hash_cache);
        let mut rows = Vec::new();
        let mut fresh_cache = Vec::new();

        for p in paths {
            let pb = PathBuf::from(&p);
            if !pb.exists() || is_dataless(&pb) {
                continue;
            }
            let tags = read_tag_summary(&pb);
            let title = tags.title.clone().unwrap_or_else(|| fallback_title(&pb));
            let track_key = compute_track_key(
                tags.artist.as_deref(),
                tags.album.as_deref(),
                &title,
                tags.duration_secs,
                tags.track_no,
            );
            let (size, mtime) = size_and_mtime(&pb);
            let content_hash = content_hash_cached(&pb, size, mtime, &lookup);

            fresh_cache.push(HashCacheEntry {
                file_path: p.clone(),
                size,
                mtime,
                content_hash: content_hash.clone(),
                track_key: track_key.clone(),
            });
            rows.push(TrackIdentityRow {
                file_path: p,
                track_key,
                content_hash,
            });
        }

        IdentityBatch {
            rows,
            hash_cache: fresh_cache,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Shared by `compute_track_identity` and `write_track_tags`: re-derive
/// `track_key` / `content_hash` from whatever is on disk right now.
fn identity_from_path(path_buf: &Path) -> Result<TrackIdentity, String> {
    if !path_buf.exists() {
        return Err("File not found".to_string());
    }
    let tags = read_tag_summary(path_buf);
    let title = tags.title.unwrap_or_else(|| fallback_title(path_buf));
    Ok(TrackIdentity {
        track_key: compute_track_key(
            tags.artist.as_deref(),
            tags.album.as_deref(),
            &title,
            tags.duration_secs,
            tags.track_no,
        ),
        content_hash: compute_content_hash(path_buf).map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
fn compute_track_identity(path: String) -> Result<TrackIdentity, String> {
    identity_from_path(&PathBuf::from(&path))
}

/// Technical + tag info for the "Get Info…" dialog. Read-only fields come
/// straight from the file; `title`/`artist`/`album`/`disc_no`/`track_no`
/// double as the editable form's initial values.
#[derive(Debug, Serialize)]
pub struct TrackFileInfo {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
    year: Option<u32>,
    disc_no: Option<u32>,
    track_no: Option<u32>,
    duration_ms: u64,
    /// e.g. "FLAC", "MP3", "AAC" — from lofty's `FileType`, `Debug`-formatted.
    format: String,
    audio_bitrate_kbps: Option<u32>,
    sample_rate_hz: Option<u32>,
    bit_depth: Option<u8>,
    channels: Option<u8>,
    size_bytes: u64,
    modified_at: Option<u64>,
    /// True when the file is an iCloud-only placeholder; every other field
    /// past the tag-derived ones is unavailable and the caller shouldn't
    /// offer to edit tags.
    cloud_only: bool,
}

#[tauri::command]
fn get_track_file_info(path: String) -> Result<TrackFileInfo, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("File not found".to_string());
    }

    let fs_meta = std::fs::metadata(&path_buf).map_err(|e| e.to_string())?;
    let modified_at = fs_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    if is_dataless(&path_buf) {
        return Ok(TrackFileInfo {
            title: None,
            artist: None,
            album: None,
            genre: None,
            year: None,
            disc_no: None,
            track_no: None,
            duration_ms: 0,
            format: String::new(),
            audio_bitrate_kbps: None,
            sample_rate_hz: None,
            bit_depth: None,
            channels: None,
            size_bytes: fs_meta.len(),
            modified_at,
            cloud_only: true,
        });
    }

    let tagged_file = Probe::open(&path_buf)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    let props = tagged_file.properties();
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

    Ok(TrackFileInfo {
        title: tag.and_then(|t| t.title()).map(|s| s.to_string()),
        artist: tag.and_then(|t| t.artist()).map(|s| s.to_string()),
        album: tag.and_then(|t| t.album()).map(|s| s.to_string()),
        genre: tag.and_then(|t| t.genre()).map(|s| s.to_string()),
        year: tag.and_then(|t| t.year()),
        disc_no: tag.and_then(|t| t.disk()),
        track_no: tag.and_then(|t| t.track()),
        duration_ms: props.duration().as_millis() as u64,
        format: format!("{:?}", tagged_file.file_type()),
        audio_bitrate_kbps: props.audio_bitrate(),
        sample_rate_hz: props.sample_rate(),
        bit_depth: props.bit_depth(),
        channels: props.channels(),
        size_bytes: fs_meta.len(),
        modified_at,
        cloud_only: false,
    })
}

/// Edits from the "Get Info…" dialog. Empty strings clear the field; `None`
/// disc/track numbers clear those. Everything else in the file's tag is left
/// untouched.
#[derive(Debug, Deserialize)]
pub struct TagEdit {
    title: String,
    artist: String,
    album: String,
    disc_no: Option<u32>,
    track_no: Option<u32>,
}

/// Write edited tags back to the file and return its refreshed identity
/// (`track_key`/`content_hash` both change whenever the tag-derived fields
/// change) so the caller can re-key `play_events`.
#[tauri::command]
fn write_track_tags(path: String, edit: TagEdit) -> Result<TrackIdentity, String> {
    use lofty::tag::Tag;

    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("File not found".to_string());
    }
    if is_dataless(&path_buf) {
        return Err("This file is iCloud-only and hasn't downloaded yet.".to_string());
    }

    let mut tagged_file = Probe::open(&path_buf)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    if tagged_file.primary_tag().is_none() && tagged_file.first_tag().is_none() {
        let tag_type = tagged_file.primary_tag_type();
        tagged_file.insert_tag(Tag::new(tag_type));
    }
    let tag = if tagged_file.primary_tag().is_some() {
        tagged_file.primary_tag_mut().expect("checked above")
    } else {
        tagged_file.first_tag_mut().expect("tag was just inserted")
    };

    if edit.title.trim().is_empty() {
        tag.remove_title();
    } else {
        tag.set_title(edit.title.trim().to_string());
    }
    if edit.artist.trim().is_empty() {
        tag.remove_artist();
    } else {
        tag.set_artist(edit.artist.trim().to_string());
    }
    if edit.album.trim().is_empty() {
        tag.remove_album();
    } else {
        tag.set_album(edit.album.trim().to_string());
    }
    match edit.disc_no {
        Some(n) => tag.set_disk(n),
        None => tag.remove_disk(),
    }
    match edit.track_no {
        Some(n) => tag.set_track(n),
        None => tag.remove_track(),
    }

    use lofty::config::WriteOptions;
    tagged_file
        .save_to_path(&path_buf, WriteOptions::default())
        .map_err(|e| e.to_string())?;

    identity_from_path(&path_buf)
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
fn cancel_scan(state: tauri::State<'_, ScanState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn scan_music_dir(
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
async fn import_itunes_xml(
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

#[tauri::command]
async fn start_sync_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<server::SyncServer>>>,
    token: String,
    preferred_port: Option<u16>,
) -> Result<server::ServerStatus, String> {
    server::start(state.inner().clone(), token, Some(app), preferred_port).await
}

/// The Mac owner's answer to a pairing prompt raised by `POST /pair`.
#[tauri::command]
fn respond_pairing(
    state: tauri::State<'_, Arc<Mutex<server::SyncServer>>>,
    id: u64,
    approve: bool,
) -> Result<(), String> {
    server::respond_pairing(state.inner(), id, approve)
}

#[tauri::command]
async fn stop_sync_server(
    state: tauri::State<'_, Arc<Mutex<server::SyncServer>>>,
) -> Result<(), String> {
    server::stop(state.inner().clone()).await
}

#[tauri::command]
fn set_sync_snapshot(
    state: tauri::State<'_, Arc<Mutex<server::SyncServer>>>,
    snapshot: server::SyncSnapshot,
) -> Result<(), String> {
    state
        .lock()
        .map_err(|e| e.to_string())?
        .set_snapshot(snapshot);
    Ok(())
}

#[tauri::command]
fn take_sync_inbox(
    state: tauri::State<'_, Arc<Mutex<server::SyncServer>>>,
) -> Result<Vec<server::IncomingStats>, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.take_inbox())
}

#[tauri::command]
fn requeue_sync_inbox(
    state: tauri::State<'_, Arc<Mutex<server::SyncServer>>>,
    items: Vec<server::IncomingStats>,
) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.requeue_inbox(items);
    Ok(())
}

#[tauri::command]
fn sync_server_activity(
    state: tauri::State<'_, Arc<Mutex<server::SyncServer>>>,
) -> Result<server::Activity, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.activity())
}

#[tauri::command]
fn sync_server_status(
    state: tauri::State<'_, Arc<Mutex<server::SyncServer>>>,
) -> Result<Option<server::ServerStatus>, String> {
    Ok(server::status(state.inner()))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// --- Native gapless playback engine (music only — see src/player.rs and
// src/player/nativeEngine.ts on the frontend) ---

#[tauri::command]
async fn player_load(
    state: tauri::State<'_, player::PlayerHandle>,
    track_id: String,
    path: String,
    autoplay: bool,
    seek_to: f64,
) -> Result<(), String> {
    let rx = state.load(track_id, PathBuf::from(path), autoplay, seek_to);
    // Opening the file happens on the playback thread; wait off the async pool.
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn player_set_next(state: tauri::State<player::PlayerHandle>, track_id: Option<String>, path: Option<String>) {
    state.set_next(track_id, path.map(PathBuf::from));
}

#[tauri::command]
fn player_play(state: tauri::State<player::PlayerHandle>) {
    state.play();
}

#[tauri::command]
fn player_pause(state: tauri::State<player::PlayerHandle>) {
    state.pause();
}

#[tauri::command]
fn player_stop(state: tauri::State<player::PlayerHandle>) {
    state.stop();
}

#[tauri::command]
fn player_seek(state: tauri::State<player::PlayerHandle>, position: f64) {
    state.seek(position);
}

#[tauri::command]
fn player_set_volume(state: tauri::State<player::PlayerHandle>, volume: f32) {
    state.set_volume(volume);
}

#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn show_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else {
                format!(
                    "Failed to reveal in Finder: exit status {:?}",
                    output.status.code()
                )
            });
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Fallback for other OS if needed, or just open directory
        // For now, we focus on macOS as requested
    }
    Ok(())
}

/// First embedded cover picture, ready to be pushed into another file's tag
/// (e.g. re-embedding it into a transcode that `afconvert` stripped it from).
pub(crate) fn read_embedded_picture(path: &Path) -> Option<lofty::picture::Picture> {
    if !path.exists() {
        return None;
    }
    let tagged_file = Probe::open(path).ok()?.read().ok()?;
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag())?;
    tag.pictures().first().cloned()
}

/// First embedded cover image as `(mime_type, bytes)`, if any.
pub(crate) fn read_embedded_artwork(path: &Path) -> Option<(String, Vec<u8>)> {
    let picture = read_embedded_picture(path)?;
    let mime = picture.mime_type()?.as_str().to_string();
    Some((mime, picture.data().to_vec()))
}

/// Async so the tag-read/base64-encode work runs off the main thread — a
/// synchronous `#[tauri::command]` executes on it in Tauri 2, and this is
/// called once per row/card across an entire library grid (see also
/// `get_album_thumb`, which the same UI calls even more often).
#[tauri::command]
async fn get_track_artwork(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_embedded_artwork(Path::new(&path))
            .map(|(mime, data)| metadata::bytes_to_data_uri(&mime, &data))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Makes `picture` the file's only embedded picture. Everything reads the *first*
/// one (`read_embedded_picture`), so appending would leave the old cover showing
/// and add more image bytes to the file on every change.
fn replace_cover(tag: &mut lofty::tag::Tag, picture: lofty::picture::Picture) {
    while !tag.pictures().is_empty() {
        tag.remove_picture(0);
    }
    tag.push_picture(picture);
}

#[tauri::command]
fn set_track_artwork(path: String, image_path: String) -> Result<(), String> {
    use lofty::file::AudioFile; // Import AudioFile trait for save_to_path
    use lofty::file::TaggedFileExt;
    use lofty::picture::{MimeType, Picture};
    use std::fs::read;

    let path_buf = PathBuf::from(&path);
    let image_buf = PathBuf::from(&image_path);

    if !path_buf.exists() || !image_buf.exists() {
        return Err("File not found".to_string());
    }
    // Saving rewrites the file, which on an iCloud placeholder would force a full download.
    if is_dataless(&path_buf) {
        return Err("This file is iCloud-only and hasn't downloaded yet.".to_string());
    }

    // Read image data
    let image_data = read(&image_buf).map_err(|e| e.to_string())?;

    // Determine mime type from extension
    let ext = image_buf
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime_type = match ext.as_str() {
        "png" => MimeType::Png,
        "jpg" | "jpeg" => MimeType::Jpeg,
        _ => return Err("Unsupported image format. Use PNG or JPEG.".to_string()),
    };

    // Create Picture
    let picture = Picture::new_unchecked(
        lofty::picture::PictureType::CoverFront,
        Some(mime_type), // Wrap in Some
        None,
        image_data,
    );

    // Read Audio File
    let mut tagged_file = Probe::open(&path_buf)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    // Attempt to get a mutable tag
    let tag = if let Some(t) = tagged_file.primary_tag_mut() {
        t
    } else if let Some(t) = tagged_file.first_tag_mut() {
        t
    } else {
        return Err(
            "No tags found in file. Please ensure file has metadata tags initialized.".to_string(),
        );
    };

    replace_cover(tag, picture);

    // Save
    // save_to_path requires WriteOptions in newer lofty versions?
    // Let's check the error message again.
    // `fn save_to_path(&self, path: impl AsRef<Path>, write_options: WriteOptions) -> Result<()>`
    // We need to pass WriteOptions.
    use lofty::config::WriteOptions;
    tagged_file
        .save_to_path(&path_buf, WriteOptions::default())
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "macos")]
mod dock;

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build());

    let app = builder
        .manage(Arc::new(Mutex::new(server::SyncServer::new())))
        .manage(ScanState::default())
        .manage(metadata::ThumbPrewarmState::default())
        .setup(|app| {
            // Needs a real AppHandle (for player-* events), so this can't be
            // built until the app itself exists — hence .setup() rather than
            // an earlier .manage() alongside the other state above.
            app.manage(player::PlayerHandle::spawn(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            scan_music_dir,
            import_itunes_xml,
            cancel_scan,
            start_sync_server,
            stop_sync_server,
            respond_pairing,
            player_load,
            player_set_next,
            player_play,
            player_pause,
            player_stop,
            player_seek,
            player_set_volume,
            set_sync_snapshot,
            take_sync_inbox,
            requeue_sync_inbox,
            sync_server_activity,
            sync_server_status,
            transcode::prepare_sync_media,
            show_in_finder,
            get_track_artwork,
            set_track_artwork,
            get_track_file_info,
            write_track_tags,
            metadata::fetch_album_art,
            metadata::ensure_album_art,
            metadata::fetch_lyrics,
            metadata::get_album_thumb,
            metadata::clear_album_thumb_cache,
            metadata::prewarm_album_thumbs,
            metadata::cancel_thumb_prewarm,
            metadata::read_image_as_data_uri,
            metadata::search_artist_images,
            metadata::search_album_covers,
            metadata::fetch_image_as_data_uri,
            metadata::auto_artist_image,
            compute_track_identity,
            compute_track_identities,
            read_track_numbers,
            read_extra_tags,
            dock::set_dock_labels
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    #[cfg(target_os = "macos")]
    dock::install(app.handle());

    app.run(|app_handle, event| {
        // Withdraw the mDNS advertisement on quit — otherwise the process
        // dies before the daemon's background thread sends its "goodbye"
        // packets, leaving a stale entry that collides with (and forces a
        // "Voynix (2)" rename of) the next launch's registration.
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<Arc<Mutex<server::SyncServer>>>();
            state.lock().unwrap().shutdown_mdns();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn replace_cover_leaves_exactly_the_new_picture() {
        use lofty::picture::{MimeType, Picture, PictureType};
        use lofty::tag::{Tag, TagType};

        let pic = |bytes: &[u8], ty| Picture::new_unchecked(ty, Some(MimeType::Png), None, bytes.to_vec());
        let mut tag = Tag::new(TagType::Id3v2);
        tag.push_picture(pic(b"old-front", PictureType::CoverFront));
        tag.push_picture(pic(b"old-back", PictureType::CoverBack));

        replace_cover(&mut tag, pic(b"new-front", PictureType::CoverFront));
        assert_eq!(tag.pictures().len(), 1);
        assert_eq!(tag.pictures()[0].data(), b"new-front");

        // And again: repeated changes never accumulate.
        replace_cover(&mut tag, pic(b"newer", PictureType::CoverFront));
        assert_eq!(tag.pictures().len(), 1);
        assert_eq!(tag.pictures()[0].data(), b"newer");
    }

    #[test]
    fn fallback_title_drops_the_extension() {
        assert_eq!(fallback_title(Path::new("/m/live set.mp3")), "live set");
        assert_eq!(fallback_title(Path::new("/m/no_extension")), "no_extension");
        assert_eq!(fallback_title(Path::new("/m/archive.tar.gz")), "archive.tar");
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

    #[cfg(target_os = "macos")]
    #[test]
    fn dataless_flag_detects_sf_dataless_bit() {
        assert!(!is_dataless_flag(0));
        assert!(!is_dataless_flag(0x0000_0002)); // UF_HIDDEN
        assert!(is_dataless_flag(0x4000_0000)); // SF_DATALESS
        assert!(is_dataless_flag(0x4000_0000 | 0x0000_0002));
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
    fn test_get_track_artwork_nonexistent() {
        // get_track_artwork itself is `async` now (see its doc comment), so
        // this exercises the same underlying lookup it wraps.
        let result = read_embedded_artwork(Path::new("/nonexistent/song.mp3"));
        assert_eq!(result, None);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_show_in_finder_nonexistent() {
        let result = show_in_finder("/nonexistent/voynix/test/file.mp3".to_string());
        assert!(result.is_err());
    }

    /// A minimal-but-valid 16-bit mono PCM WAV lofty can probe and re-save —
    /// there's no bundled fixture audio file in this repo, so build one.
    fn write_minimal_wav(path: &Path, num_samples: u32) {
        let mut data = Vec::new();
        let byte_rate: u32 = 44100 * 1 * 16 / 8;
        let block_align: u16 = 1 * 16 / 8;
        let data_len = num_samples * block_align as u32;

        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + data_len).to_le_bytes());
        data.extend_from_slice(b"WAVE");
        data.extend_from_slice(b"fmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes()); // PCM
        data.extend_from_slice(&1u16.to_le_bytes()); // mono
        data.extend_from_slice(&44100u32.to_le_bytes());
        data.extend_from_slice(&byte_rate.to_le_bytes());
        data.extend_from_slice(&block_align.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&data_len.to_le_bytes());
        data.extend(std::iter::repeat(0u8).take(data_len as usize));

        std::fs::write(path, data).unwrap();
    }

    #[test]
    fn get_track_file_info_reads_technical_properties() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("silence.wav");
        write_minimal_wav(&path, 44100); // 1 second

        let info = get_track_file_info(path.to_string_lossy().to_string()).unwrap();
        assert!(!info.cloud_only);
        assert_eq!(info.sample_rate_hz, Some(44100));
        assert_eq!(info.channels, Some(1));
        assert_eq!(info.bit_depth, Some(16));
        assert!(info.duration_ms >= 900 && info.duration_ms <= 1100);
        assert!(info.format.contains("Wav"));
        assert!(info.size_bytes > 0);
    }

    #[test]
    fn get_track_file_info_reports_missing_file() {
        let result = get_track_file_info("/nonexistent/voynix/test/silence.wav".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn read_extra_tags_skips_missing_files_and_returns_rows_for_existing_ones() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("silence.wav");
        write_minimal_wav(&path, 44100);
        let path_str = path.to_string_lossy().to_string();

        let rows = read_extra_tags(vec![
            path_str.clone(),
            "/nonexistent/voynix/test/missing.wav".to_string(),
        ]);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, path_str);
        // A bare WAV has no genre/year/album-artist/composer tags, but the row
        // is still returned — the caller needs to know it *was* read.
        assert_eq!(rows[0].genre, None);
        assert_eq!(rows[0].year, None);
    }

    #[test]
    fn write_track_tags_updates_file_and_rederives_identity() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("song.wav");
        write_minimal_wav(&path, 44100);
        let path_str = path.to_string_lossy().to_string();

        let before = identity_from_path(&path).unwrap();

        let edit = TagEdit {
            title: "New Title".to_string(),
            artist: "New Artist".to_string(),
            album: "New Album".to_string(),
            disc_no: Some(1),
            track_no: Some(7),
        };
        let after = write_track_tags(path_str.clone(), edit).unwrap();

        // Tag-derived fields feed compute_track_key, so writing new tags must
        // change it (and callers rely on this to re-key play_events).
        assert_ne!(before.track_key, after.track_key);
        assert_eq!(
            after.track_key,
            compute_track_key(Some("New Artist"), Some("New Album"), "New Title", 1, Some(7))
        );

        let info = get_track_file_info(path_str).unwrap();
        assert_eq!(info.title.as_deref(), Some("New Title"));
        assert_eq!(info.artist.as_deref(), Some("New Artist"));
        assert_eq!(info.album.as_deref(), Some("New Album"));
        assert_eq!(info.disc_no, Some(1));
        assert_eq!(info.track_no, Some(7));
    }

    #[test]
    fn write_track_tags_clears_fields_left_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("song.wav");
        write_minimal_wav(&path, 44100);
        let path_str = path.to_string_lossy().to_string();

        write_track_tags(
            path_str.clone(),
            TagEdit {
                title: "Has Title".to_string(),
                artist: "Has Artist".to_string(),
                album: String::new(),
                disc_no: None,
                track_no: None,
            },
        )
        .unwrap();

        let info = get_track_file_info(path_str).unwrap();
        assert_eq!(info.album, None);
        assert_eq!(info.disc_no, None);
        assert_eq!(info.track_no, None);
    }

    #[test]
    fn test_track_key_stable_and_path_independent() {
        // Same song, different absolute paths (Mac vs Android) => same key.
        let a = compute_track_key(
            Some("The Beatles"),
            Some("Abbey Road"),
            "Come Together",
            259,
            Some(1),
        );
        let b = compute_track_key(
            Some("the beatles"),
            Some("abbey road"),
            "  Come   Together ",
            259,
            Some(1),
        );
        assert_eq!(a, b);

        // Different song => different key.
        let c = compute_track_key(
            Some("The Beatles"),
            Some("Abbey Road"),
            "Something",
            182,
            Some(2),
        );
        assert_ne!(a, c);
    }

    #[tokio::test]
    async fn compute_track_identities_matches_single_file_command_and_skips_missing() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("come together.mp3");
        std::fs::write(&p, b"pretend mp3 bytes").unwrap();
        let path = p.to_string_lossy().to_string();

        let expected = compute_track_identity(path.clone()).unwrap();

        let batch = compute_track_identities(vec![path.clone(), "/nonexistent/gone.mp3".to_string()], None)
            .await
            .unwrap();

        assert_eq!(batch.rows.len(), 1);
        assert_eq!(batch.rows[0].file_path, path);
        assert_eq!(batch.rows[0].track_key, expected.track_key);
        assert_eq!(batch.rows[0].content_hash, expected.content_hash);
        assert_eq!(batch.hash_cache.len(), 1);
        assert_eq!(batch.hash_cache[0].track_key, expected.track_key);
    }

    #[test]
    fn test_content_hash_detects_change() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.bin");
        std::fs::write(&p, b"hello world").unwrap();
        let h1 = compute_content_hash(&p).unwrap();
        let h2 = compute_content_hash(&p).unwrap();
        assert_eq!(h1, h2);

        std::fs::write(&p, b"hello worlD").unwrap();
        let h3 = compute_content_hash(&p).unwrap();
        assert_ne!(h1, h3);
    }

    #[test]
    fn content_hash_cached_reuses_on_size_mtime_match() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("song.mp3");
        std::fs::write(&p, b"some audio bytes").unwrap();
        let (size, mtime) = size_and_mtime(&p);
        let key = p.to_string_lossy().to_string();

        // A cache row matching (size, mtime) wins even if its hash is stale —
        // that's the whole point: we trust it and skip the read.
        let mut cache = HashMap::new();
        cache.insert(key.clone(), (size, mtime, "CACHED".to_string()));
        assert_eq!(content_hash_cached(&p, size, mtime, &cache), "CACHED");

        // Size mismatch → recompute the real hash.
        cache.insert(key.clone(), (size + 1, mtime, "CACHED".to_string()));
        assert_eq!(
            content_hash_cached(&p, size, mtime, &cache),
            compute_content_hash(&p).unwrap()
        );

        // mtime mismatch → recompute.
        cache.insert(key, (size, mtime + 1, "CACHED".to_string()));
        assert_ne!(content_hash_cached(&p, size, mtime, &cache), "CACHED");
    }

    /// Shared contract with Android's `computeContentHash` (see
    /// docs/test-vectors/content-hash.json and the matching Kotlin test in
    /// ContentHashTest.kt) — pins the exact hash both sides must produce for a
    /// deterministically generated file of each size.
    #[test]
    fn compute_content_hash_matches_shared_test_vectors() {
        let json = include_str!("../../docs/test-vectors/content-hash.json");
        let doc: serde_json::Value = serde_json::from_str(json).unwrap();
        let dir = tempdir().unwrap();
        for v in doc["vectors"].as_array().unwrap() {
            let size = v["size"].as_u64().unwrap() as usize;
            let expected = v["hash"].as_str().unwrap();
            let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let path = dir.path().join(format!("f{size}"));
            std::fs::write(&path, &data).unwrap();
            assert_eq!(
                compute_content_hash(&path).unwrap(),
                expected,
                "content hash mismatch for size {size}"
            );
        }
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
