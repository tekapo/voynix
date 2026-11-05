//! Cross-device track identity: the `track_key` / `content_hash` pair, the
//! (size, mtime)-validated hash cache, and cloud-placeholder ("dataless")
//! detection. Shared by the library scan, the iTunes import, tag edits and the
//! backfill commands, which must all derive a file's identity the same way.

use crate::tags::read_tag_summary;
use crate::util;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct TrackIdentity {
    pub(crate) track_key: String,
    pub(crate) content_hash: String,
}

/// Cross-device identity: same song => same key on Mac and Android, stable across retagging.
pub(crate) fn compute_track_key(
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
    pub(crate) file_path: String,
    pub(crate) size: u64,
    pub(crate) mtime: u64,
    pub(crate) content_hash: String,
    pub(crate) track_key: String,
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
pub(crate) fn is_dataless(path: &Path) -> bool {
    use std::os::macos::fs::MetadataExt;
    std::fs::metadata(path)
        .map(|m| is_dataless_flag(m.st_flags()))
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn is_dataless(_path: &Path) -> bool {
    false
}

/// File size and mtime (seconds since epoch), or (0, 0) if unreadable.
pub(crate) fn size_and_mtime(path: &Path) -> (u64, u64) {
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
pub(crate) fn content_hash_cached(
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

pub(crate) fn cache_lookup(entries: Option<Vec<HashCacheEntry>>) -> HashMap<String, (u64, u64, String)> {
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

/// One row of `compute_track_identities` output: the file path plus its
/// freshly computed cross-device key and content fingerprint.
#[derive(Debug, Serialize)]
pub struct TrackIdentityRow {
    file_path: String,
    pub(crate) track_key: String,
    content_hash: String,
}

/// Batch result: the identity rows, plus refreshed `content_hash_cache` entries
/// (same shape as `ScanResult::hash_cache`) so the caller can persist them and
/// skip re-hashing these files on the next rescan.
#[derive(Debug, Serialize)]
pub struct IdentityBatch {
    pub(crate) rows: Vec<TrackIdentityRow>,
    hash_cache: Vec<HashCacheEntry>,
}

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

/// Compute `track_key` / `content_hash` for a batch of files. Used once to
/// backfill rows scanned before those columns existed (see
/// backfillTrackIdentities in db.ts). Missing files and cloud placeholders are
/// skipped so the next launch retries them. Runs on a blocking thread since
/// each file needs up to 128KB of real I/O for its content hash.
#[tauri::command]
pub async fn compute_track_identities(
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
pub(crate) fn identity_from_path(path_buf: &Path) -> Result<TrackIdentity, String> {
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
pub fn compute_track_identity(path: String) -> Result<TrackIdentity, String> {
    identity_from_path(&PathBuf::from(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn fallback_title_drops_the_extension() {
        assert_eq!(fallback_title(Path::new("/m/live set.mp3")), "live set");
        assert_eq!(fallback_title(Path::new("/m/no_extension")), "no_extension");
        assert_eq!(fallback_title(Path::new("/m/archive.tar.gz")), "archive.tar");
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
}
