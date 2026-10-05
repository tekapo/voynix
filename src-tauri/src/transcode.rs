//! On-sync transcoding (Mac side).
//!
//! Android's WebView media stack can't decode ALAC (Apple Lossless), which a
//! library ripped in Apple Music will be full of. Before a file is offered to a
//! paired device we convert anything Android can't play natively to either AAC
//! (lossy, default 256kbps) or FLAC (lossless, larger) per `TranscodeOptions`,
//! cached by source path + mtime + those options so repeat syncs are instant
//! and a settings change invalidates stale cache entries.
//!
//! macOS ships `afconvert` and `afinfo`; the sync server only ever runs on a
//! Mac, so we lean on those rather than bundling an encoder.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Serializes `prepare_sync_media` runs. The snapshot-push effect on the JS side
/// is debounced but not mutually exclusive, so a library change during a slow
/// first transcode can fire a second run — two runs would then race to write the
/// same `<name>.part` in the cache dir. One at a time avoids that entirely.
static PREPARE_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/// How many `afconvert` processes to run at once. AAC encoding is CPU-bound, so
/// this scales with cores; capped so a big first sync doesn't starve the machine.
fn transcode_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(1, 4)
}

#[derive(Deserialize)]
pub struct MediaItem {
    pub track_key: String,
    pub file_path: String,
    pub content_hash: String,
}

/// User-configurable transcode target, set via the Settings UI (`transcode_format`
/// / `transcode_bitrate`) and threaded down from `prepare_sync_media`.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TranscodeFormat {
    #[default]
    Aac,
    Flac,
}

#[derive(Deserialize, Clone, Copy)]
pub struct TranscodeOptions {
    #[serde(default)]
    pub format: TranscodeFormat,
    /// Only meaningful for `Aac` — FLAC is always lossless. Defaults to the
    /// long-standing 256k.
    #[serde(default = "default_bitrate")]
    pub bitrate: u32,
}

fn default_bitrate() -> u32 {
    256_000
}

impl Default for TranscodeOptions {
    fn default() -> Self {
        TranscodeOptions {
            format: TranscodeFormat::default(),
            bitrate: default_bitrate(),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct PreparedMedia {
    pub track_key: String,
    /// Either the original path or the cached transcode.
    pub file_path: String,
    /// Fingerprint of whatever `file_path` now points at.
    pub content_hash: String,
    /// Byte length of `file_path`, so the phone can check free space up front.
    pub size: i64,
    pub transcoded: bool,
}

fn file_size(path: &Path) -> i64 {
    std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
}

#[derive(Serialize, Clone)]
struct PrepareProgress {
    done: usize,
    total: usize,
}

/// Decide whether a file needs transcoding, given its extension and (for the
/// ambiguous MPEG-4 container) whether its codec is ALAC. Pure so it can be
/// tested without the macOS tools.
fn needs_transcode(ext: &str, is_alac: bool) -> bool {
    match ext.to_lowercase().as_str() {
        // Android plays these natively.
        "mp3" | "flac" | "ogg" | "oga" | "opus" | "wav" => false,
        // An m4a/mp4 is fine if it's AAC, not if it's Apple Lossless.
        "m4a" | "mp4" | "aac" | "m4b" => is_alac,
        // aiff, wv, ape, dsf, … — convert.
        _ => true,
    }
}

/// Whether `afconvert` is on PATH, i.e. we're actually running on a Mac. When
/// it isn't, ALAC/AIFF/etc. sources are served as-is (see `prepare_one`'s
/// passthrough on a failed transcode) and Android simply can't play them —
/// the server surfaces this via `ServerStatus::transcode_available` so the UI
/// can warn instead of silently producing unplayable files.
pub fn transcode_available() -> bool {
    std::process::Command::new("afconvert")
        .arg("-h")
        .output()
        .is_ok()
}

/// True when the file's audio codec is Apple Lossless. Probed with symphonia
/// (already a dependency for `player.rs`'s decoder) rather than shelling out
/// to `afinfo` and scraping its "Data format: … alac …" text line — that
/// output format isn't a stable contract, and probing works on any OS instead
/// of only where `afinfo` happens to be installed.
fn is_alac(path: &Path) -> bool {
    use symphonia::core::codecs::audio::well_known::CODEC_ID_ALAC;
    use symphonia::core::codecs::CodecParameters;
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
    use symphonia::core::meta::MetadataOptions;

    let Ok(file) = std::fs::File::open(path) else { return false };
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let Ok(reader) = symphonia::default::get_probe().probe(
        &hint,
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    ) else {
        return false;
    };
    reader.tracks().iter().any(|t| {
        matches!(&t.codec_params, Some(CodecParameters::Audio(p)) if p.codec == CODEC_ID_ALAC)
    })
}

/// (size, mtime in nanoseconds). Sub-second precision matters: a rewrite within
/// the same second must not reuse a stale transcode.
fn source_fingerprint(path: &Path) -> (u64, u128) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (0, 0);
    };
    let nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    (meta.len(), nanos)
}

/// Bumped whenever what we *produce* for a given source+options changes, so
/// existing cache entries are invalidated and rebuilt on the next sync.
/// v2: transcodes now carry the source's cover art (`embed_source_artwork`) —
/// afconvert itself drops it.
/// v3: key includes size, nanosecond mtime and the source content hash.
const CACHE_VERSION: u32 = 3;

/// Cache file name: source path digest + size + mtime (ns) + content hash +
/// target format/bitrate, so a re-tag *or* a settings change invalidates it
/// (bitrate is folded in even for FLAC, harmlessly, to keep this simple).
fn cache_name(
    src: &Path,
    size: u64,
    mtime_nanos: u128,
    content_hash: &str,
    options: &TranscodeOptions,
) -> String {
    let digest = crate::util::sha256_hex(src.to_string_lossy().as_bytes());
    let hash_part: String = if content_hash.is_empty() {
        "-".into()
    } else {
        content_hash.chars().take(16).collect()
    };
    let ext = match options.format {
        TranscodeFormat::Aac => "m4a",
        TranscodeFormat::Flac => "flac",
    };
    format!(
        "v{}_{}_{}_{}_{}_{}_{}.{}",
        CACHE_VERSION,
        &digest[..16],
        size,
        mtime_nanos,
        hash_part,
        options.format as u8,
        options.bitrate,
        ext
    )
}

/// Copy the source's embedded cover into a freshly transcoded file. `afconvert`
/// drops artwork for both AAC and FLAC output, so the cached transcode would
/// otherwise have no cover of its own (the album-art sync path hides this by
/// reading the *source* file instead, but the transcode alone is bare). A
/// missing source picture, or any failure along the way, is not an error —
/// the transcode itself is still good.
fn embed_source_artwork(src: &Path, out: &Path, format: TranscodeFormat) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::{AudioFile, FileType, TaggedFileExt};
    use lofty::probe::Probe;
    use lofty::tag::Tag;

    let Some(picture) = crate::read_embedded_picture(src) else {
        return Ok(()); // nothing to carry over
    };

    // `out` is still the `.part` temp file, so its extension can't tell us the
    // container — go by what we told afconvert to produce instead.
    let file_type = match format {
        TranscodeFormat::Aac => FileType::Mp4,
        TranscodeFormat::Flac => FileType::Flac,
    };
    let mut tagged_file = Probe::open(out)
        .map_err(|e| e.to_string())?
        .set_file_type(file_type)
        .read()
        .map_err(|e| e.to_string())?;

    if tagged_file.primary_tag().is_none() {
        tagged_file.insert_tag(Tag::new(file_type.primary_tag_type()));
    }
    let tag = tagged_file
        .primary_tag_mut()
        .ok_or_else(|| "no tag after insert".to_string())?;
    tag.push_picture(picture);

    tagged_file
        .save_to_path(out, WriteOptions::default())
        .map_err(|e| e.to_string())
}

fn transcode_one(src: &Path, dst: &Path, options: &TranscodeOptions) -> Result<(), String> {
    // Per-destination `.part` name so parallel workers never collide.
    let tmp = dst.with_extension("part");
    let mut cmd = std::process::Command::new("afconvert");
    match options.format {
        TranscodeFormat::Aac => {
            cmd.args(["-f", "m4af", "-d", "aac", "-b"])
                .arg(options.bitrate.to_string());
        }
        TranscodeFormat::Flac => {
            cmd.args(["-f", "flac", "-d", "flac"]);
        }
    }
    let status = cmd
        .arg(src)
        .arg(&tmp)
        .status()
        .map_err(|e| format!("afconvert failed to start: {e}"))?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("afconvert exited with {status}"));
    }
    // Best-effort: afconvert never carries artwork over, so try to put it back
    // before the file becomes visible under `dst`. A failure here is cosmetic
    // and must not fail the transcode.
    if let Err(e) = embed_source_artwork(src, &tmp, options.format) {
        eprintln!("artwork {}: {e}", src.display());
    }
    std::fs::rename(&tmp, dst).map_err(|e| e.to_string())
}

/// Sidecar holding the content hash of a cached transcode, so a repeat sync
/// doesn't re-read every cached file just to re-derive the same fingerprint.
fn hash_sidecar(dst: &Path) -> PathBuf {
    dst.with_extension("sha256")
}

/// Content hash of a finished transcode, reading the sidecar when present and
/// writing it when it isn't.
fn cached_transcode_hash(dst: &Path) -> Result<String, String> {
    let sidecar = hash_sidecar(dst);
    if let Ok(h) = std::fs::read_to_string(&sidecar) {
        let h = h.trim();
        if !h.is_empty() {
            return Ok(h.to_string());
        }
    }
    let hash = crate::compute_content_hash(dst).map_err(|e| e.to_string())?;
    let _ = std::fs::write(&sidecar, &hash);
    Ok(hash)
}

fn passthrough(it: &MediaItem) -> PreparedMedia {
    PreparedMedia {
        track_key: it.track_key.clone(),
        file_path: it.file_path.clone(),
        content_hash: it.content_hash.clone(),
        size: file_size(Path::new(&it.file_path)),
        transcoded: false,
    }
}

/// Resolve one track to a path Android can play: the original when its format is
/// already supported, otherwise a cached transcode per `options` (built here on
/// a miss). Never fails — an un-convertible file falls back to the original.
/// Cache destination for `item` if it must be transcoded, else `None`
/// (already playable, or the source is missing).
fn transcode_dst(item: &MediaItem, cache_dir: &Path, options: &TranscodeOptions) -> Option<PathBuf> {
    let src = PathBuf::from(&item.file_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_string();
    if !src.is_file() || !needs_transcode(&ext, is_alac(&src)) {
        return None;
    }
    let (size, mtime) = source_fingerprint(&src);
    Some(cache_dir.join(cache_name(&src, size, mtime, &item.content_hash, options)))
}

fn prepare_one(item: &MediaItem, cache_dir: &Path, options: &TranscodeOptions) -> PreparedMedia {
    let Some(dst) = transcode_dst(item, cache_dir, options) else {
        return passthrough(item);
    };
    let src = PathBuf::from(&item.file_path);
    if !dst.is_file() {
        if let Err(e) = transcode_one(&src, &dst, options) {
            eprintln!("transcode {}: {e}", src.display());
            return passthrough(item); // Android just won't play this one
        }
    }
    match cached_transcode_hash(&dst) {
        Ok(hash) => PreparedMedia {
            track_key: item.track_key.clone(),
            file_path: dst.to_string_lossy().to_string(),
            content_hash: hash,
            size: file_size(&dst),
            transcoded: true,
        },
        Err(e) => {
            eprintln!("hash {}: {e}", dst.display());
            passthrough(item)
        }
    }
}

/// For each track, return a path Android can actually play — the original when
/// it's already a supported format, otherwise a cached transcode per `options`.
/// Runs the conversions across a small thread pool and emits `sync-prepare`
/// progress events as each file completes.
#[tauri::command]
pub async fn prepare_sync_media(
    app: AppHandle,
    items: Vec<MediaItem>,
    options: TranscodeOptions,
) -> Result<Vec<PreparedMedia>, String> {
    let _guard = PREPARE_LOCK.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        let cache_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("sync-cache");
        std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

        let total = items.len();
        // Progress counts only files that actually need converting now (cache
        // misses), so a fully cached sync shows no "Converting" banner.
        let pending: Vec<bool> = items
            .iter()
            .map(|it| transcode_dst(it, &cache_dir, &options).is_some_and(|d| !d.is_file()))
            .collect();
        let convert_total = pending.iter().filter(|p| **p).count();
        let _ = app.emit("sync-prepare", PrepareProgress { done: 0, total: convert_total });

        // Fan the per-file work (mostly `afconvert`) out across a few threads.
        let results: Vec<Mutex<Option<PreparedMedia>>> =
            (0..total).map(|_| Mutex::new(None)).collect();
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        let workers = transcode_concurrency().min(total.max(1));

        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= total {
                        break;
                    }
                    let prepared = prepare_one(&items[i], &cache_dir, &options);
                    *results[i].lock().unwrap() = Some(prepared);
                    if pending[i] {
                        let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                        let _ = app.emit("sync-prepare", PrepareProgress { done: d, total: convert_total });
                    }
                });
            }
        });

        let out: Vec<PreparedMedia> = results
            .into_iter()
            .zip(items.iter())
            .map(|(slot, item)| slot.into_inner().unwrap().unwrap_or_else(|| passthrough(item)))
            .collect();

        // Drop cache entries (transcode + its hash sidecar) no longer referenced
        // because the source was deleted or re-tagged.
        let mut keep: HashSet<PathBuf> = HashSet::new();
        for p in out.iter().filter(|p| p.transcoded) {
            let dst = PathBuf::from(&p.file_path);
            keep.insert(hash_sidecar(&dst));
            keep.insert(dst);
        }
        if let Ok(rd) = std::fs::read_dir(&cache_dir) {
            for e in rd.flatten() {
                if !keep.contains(&e.path()) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        let _ = app.emit("sync-prepare", PrepareProgress { done: convert_total, total: convert_total });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_formats_are_not_transcoded() {
        for ext in ["mp3", "flac", "MP3", "Flac", "opus", "wav", "ogg"] {
            assert!(!needs_transcode(ext, false), "{ext} should pass through");
        }
    }

    #[test]
    fn m4a_depends_on_codec() {
        assert!(!needs_transcode("m4a", false)); // AAC in m4a — fine
        assert!(needs_transcode("m4a", true)); // ALAC in m4a — convert
        assert!(!needs_transcode("mp4", false));
        assert!(needs_transcode("M4A", true));
    }

    #[test]
    fn unknown_lossless_formats_are_transcoded() {
        for ext in ["aiff", "aif", "wv", "ape", "dsf", ""] {
            assert!(needs_transcode(ext, false), "{ext} should be converted");
        }
    }

    #[test]
    fn cache_name_tracks_path_and_source() {
        let p = Path::new("/Music/a.m4a");
        let o = TranscodeOptions::default();
        let base = cache_name(p, 10, 100, "abc", &o);
        assert_eq!(base, cache_name(p, 10, 100, "abc", &o));
        // same second, different nanoseconds
        assert_ne!(base, cache_name(p, 10, 101, "abc", &o));
        assert_ne!(base, cache_name(p, 11, 100, "abc", &o));
        assert_ne!(base, cache_name(p, 10, 100, "abd", &o));
        assert_ne!(base, cache_name(Path::new("/Music/b.m4a"), 10, 100, "abc", &o));
        assert!(base.ends_with(".m4a"));
    }

    #[test]
    fn cache_name_changes_with_format_and_bitrate() {
        let p = Path::new("/Music/a.m4a");
        let aac_256 = TranscodeOptions { format: TranscodeFormat::Aac, bitrate: 256_000 };
        let aac_128 = TranscodeOptions { format: TranscodeFormat::Aac, bitrate: 128_000 };
        let flac = TranscodeOptions { format: TranscodeFormat::Flac, bitrate: 256_000 };
        let n = |o: &TranscodeOptions| cache_name(p, 10, 100, "h", o);
        assert_ne!(n(&aac_256), n(&aac_128));
        assert_ne!(n(&aac_256), n(&flac));
        assert!(n(&flac).ends_with(".flac"));
    }

    #[test]
    fn transcode_dst_changes_when_the_source_or_its_hash_changes() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.aiff");
        std::fs::write(&src, b"first").unwrap();
        let cache = dir.path().join("cache");
        let opts = TranscodeOptions::default();
        let item = |hash: &str| MediaItem {
            track_key: "k".into(),
            file_path: src.to_string_lossy().into_owned(),
            content_hash: hash.into(),
        };

        let before = transcode_dst(&item("h1"), &cache, &opts).unwrap();
        assert_eq!(before, transcode_dst(&item("h1"), &cache, &opts).unwrap());
        assert_ne!(before, transcode_dst(&item("h2"), &cache, &opts).unwrap());

        // Rewritten with a different size: a stale transcode must not be reused.
        std::fs::write(&src, b"second, longer").unwrap();
        assert_ne!(before, transcode_dst(&item("h1"), &cache, &opts).unwrap());
    }

    #[test]
    fn transcode_concurrency_is_bounded() {
        let n = transcode_concurrency();
        assert!((1..=4).contains(&n), "got {n}");
    }

    #[test]
    fn hash_sidecar_sits_next_to_the_transcode() {
        let s = hash_sidecar(Path::new("/cache/abc_100.m4a"));
        assert_eq!(s, Path::new("/cache/abc_100.sha256"));
    }

    #[test]
    fn cached_transcode_hash_writes_then_reuses_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("clip_1.m4a");
        std::fs::write(&dst, b"pretend this is aac").unwrap();

        let first = cached_transcode_hash(&dst).unwrap();
        assert!(hash_sidecar(&dst).is_file(), "sidecar should be written");

        // Corrupt the audio but keep the sidecar: the cached hash must win.
        std::fs::write(&dst, b"totally different bytes now").unwrap();
        assert_eq!(cached_transcode_hash(&dst).unwrap(), first);
    }

    #[tokio::test]
    async fn prepare_lock_serializes_runs() {
        // Hold the lock, then confirm a second acquire can't proceed until it's
        // dropped — this is what keeps two prepare_sync_media runs off the same
        // `.part` file.
        let g = PREPARE_LOCK.lock().await;
        assert!(PREPARE_LOCK.try_lock().is_err());
        drop(g);
        assert!(PREPARE_LOCK.try_lock().is_ok());
    }

    /// Writes a tiny valid PCM WAV (silence) that `afconvert` can read, with
    /// no tags at all.
    fn write_silent_wav(path: &Path) {
        // 44.1kHz / 2s: afconvert's AAC encoder rejects some lower rates (e.g.
        // 8kHz mono fails to set up), and its FLAC "optimize" pass fails on
        // very short clips (0.1s reproducibly errors with "ExtAudioFileOpenURL
        // failed"), so this stays comfortably inside what both encoders like.
        let sample_rate: u32 = 44_100;
        let num_samples: u32 = sample_rate * 2;
        let data_len = num_samples * 2; // 16-bit mono
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
        wav.extend_from_slice(&2u16.to_le_bytes()); // block align
        wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        wav.extend(std::iter::repeat_n(0u8, data_len as usize));
        std::fs::write(path, &wav).unwrap();
    }

    /// Embeds `picture_data` as a cover into an already-written audio file via
    /// lofty, so the fixture looks like a real ripped file with art.
    fn embed_cover_for_test(path: &Path, picture_data: &[u8]) {
        use lofty::file::{AudioFile, TaggedFileExt};
        use lofty::picture::{MimeType, Picture, PictureType};
        use lofty::probe::Probe;
        use lofty::tag::{Tag, TagType};

        let mut tagged = Probe::open(path).unwrap().read().unwrap();
        let mut tag = Tag::new(TagType::Id3v2);
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            None,
            picture_data.to_vec(),
        ));
        tagged.insert_tag(tag);
        tagged
            .save_to_path(path, lofty::config::WriteOptions::default())
            .unwrap();
    }

    /// End-to-end: a source WAV with embedded art, transcoded to AAC and to
    /// FLAC, should come out the other side still carrying that same cover —
    /// `afconvert` itself drops it, so this is `embed_source_artwork` doing
    /// its job. Skips when not on a Mac (no `afconvert`/`afinfo`).
    #[test]
    fn transcode_one_carries_source_artwork_into_aac_and_flac() {
        if !transcode_available() {
            eprintln!("skipping: afconvert not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("source.wav");
        let cover = b"not really a jpeg, just test bytes".to_vec();
        write_silent_wav(&src);
        embed_cover_for_test(&src, &cover);

        for (format, ext) in [(TranscodeFormat::Aac, "m4a"), (TranscodeFormat::Flac, "flac")] {
            let dst = dir.path().join(format!("out.{ext}"));
            let options = TranscodeOptions { format, bitrate: 256_000 };
            transcode_one(&src, &dst, &options).expect("transcode should succeed");

            let picture = crate::read_embedded_picture(&dst)
                .unwrap_or_else(|| panic!("{ext}: expected embedded cover after transcode"));
            assert_eq!(picture.data(), cover.as_slice(), "{ext}: cover bytes should match source");
        }
    }

    /// A source with no embedded art transcodes fine and stays art-free —
    /// `embed_source_artwork` must be a no-op, not an error, in that case.
    #[test]
    fn transcode_one_without_source_artwork_still_succeeds() {
        if !transcode_available() {
            eprintln!("skipping: afconvert not available");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("bare.wav");
        write_silent_wav(&src); // no tag at all

        let dst = dir.path().join("out.m4a");
        let options = TranscodeOptions { format: TranscodeFormat::Aac, bitrate: 256_000 };
        transcode_one(&src, &dst, &options).expect("transcode should succeed without source art");
        assert!(crate::read_embedded_picture(&dst).is_none());
    }

    #[test]
    fn prepare_one_passes_through_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let item = MediaItem {
            track_key: "k".into(),
            file_path: "/no/such/file.aiff".into(),
            content_hash: "orig".into(),
        };
        let p = prepare_one(&item, dir.path(), &TranscodeOptions::default());
        assert!(!p.transcoded);
        assert_eq!(p.content_hash, "orig");
    }
}
