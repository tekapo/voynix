//! Online metadata: album art (iTunes Search API) and lyrics (LRCLIB), fetched
//! lazily when a track has no embedded data. Results are cached on disk under the
//! app cache dir; a `.miss` marker records "looked, found nothing" so we don't
//! re-hit the API on every play. The user's music files are never modified.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{Emitter, Manager};

const MISS_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 14); // 2 weeks
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

// ---- pure helpers (unit-tested) ------------------------------------------------

/// Stable cache key from free-text fields: trimmed, lowercased, unit-separated,
/// hashed. Leading/trailing whitespace and case collapse to the same key, but
/// — unlike `util::normalize_field` (used for track_key) — internal whitespace
/// is left alone: this must match Android's `albumArtCacheKey` in
/// `sync/ContentHash.kt` bit-for-bit, and that implementation doesn't collapse
/// internal whitespace either.
///
/// `pub(crate)`: shared with `server.rs` so the sync `/album-art/:key` route
/// and the native Android app's fetcher key into the exact same `artwork/`
/// cache this module already reads from and writes to.
pub(crate) fn cache_key(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .map(|p| p.trim().to_lowercase())
        .collect::<Vec<_>>()
        .join("\u{1f}");
    crate::util::sha256_hex(joined.as_bytes())
}

/// iTunes hands back a 100px `artworkUrl100` like `.../100x100bb.jpg`; ask for a
/// larger square by swapping the size token.
fn upscale_itunes_art_url(url: &str, size: u32) -> String {
    url.replace("100x100bb", &format!("{size}x{size}bb"))
}

/// Prefer plain lyrics, fall back to synced (LRC) — the modal renders line by
/// line either way, and LRC timestamps are harmless as leading text.
fn pick_lyrics(v: &serde_json::Value) -> Option<String> {
    let non_empty = |s: &str| !s.trim().is_empty();
    v["plainLyrics"]
        .as_str()
        .filter(|s| non_empty(s))
        .or_else(|| v["syncedLyrics"].as_str().filter(|s| non_empty(s)))
        .map(str::to_string)
}

pub(crate) fn bytes_to_data_uri(mime: &str, data: &[u8]) -> String {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    format!("data:{mime};base64,{b64}")
}

// ---- cache plumbing ----------------------------------------------------------

/// Shared across every call site so connections (and their TLS handshakes) to
/// the same host — iTunes Search, Deezer, LRCLIB are each hit repeatedly over
/// a session — get pooled instead of torn down and redone on every lookup.
static HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(concat!("Voynix/", env!("CARGO_PKG_VERSION"), " (music player)"))
        .timeout(HTTP_TIMEOUT)
        .build()
        .expect("static reqwest::Client config is valid")
});

fn http_client() -> Result<reqwest::Client, String> {
    Ok(HTTP_CLIENT.clone())
}

pub(crate) fn cache_subdir(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A `.miss` marker still within its TTL — treat as "known absent".
fn fresh_miss(p: &Path) -> bool {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|age| age < MISS_TTL)
        .unwrap_or(false)
}

fn touch_miss(p: &Path) {
    let _ = write_atomic(p, b"");
}

// ---- album art -------------------------------------------------------------

async fn itunes_lookup_art(artist: &str, album: &str) -> Result<Option<Vec<u8>>, String> {
    let client = http_client()?;
    let term = format!("{artist} {album}");
    let resp = client
        .get("https://itunes.apple.com/search")
        .query(&[("term", term.as_str()), ("entity", "album"), ("limit", "1")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("iTunes search HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let Some(art100) = body["results"][0]["artworkUrl100"].as_str() else {
        return Ok(None);
    };
    let big = upscale_itunes_art_url(art100, 600);
    let img = client.get(&big).send().await.map_err(|e| e.to_string())?;
    if !img.status().is_success() {
        return Ok(None);
    }
    let bytes = img.bytes().await.map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(bytes.to_vec()))
}

/// Album art for a track with no embedded cover. Returns a `data:` URI, or
/// `None` if nothing was found. Cached on disk by (artist, album).
///
/// Prefers `<key>.sync.jpg` over this device's own `<key>.jpg` (this same
/// function's past iTunes guesses) whenever both exist.
#[tauri::command]
pub async fn fetch_album_art(
    app: tauri::AppHandle,
    artist: String,
    album: String,
) -> Result<Option<String>, String> {
    if artist.trim().is_empty() && album.trim().is_empty() {
        return Ok(None);
    }
    let dir = cache_subdir(&app, "artwork")?;
    let key = cache_key(&[&artist, &album]);
    let sync_hit = dir.join(format!("{key}.sync.jpg"));
    let hit = dir.join(format!("{key}.jpg"));
    let miss = dir.join(format!("{key}.miss"));

    if let Ok(data) = std::fs::read(&sync_hit) {
        return Ok(Some(bytes_to_data_uri("image/jpeg", &data)));
    }
    if let Ok(data) = std::fs::read(&hit) {
        return Ok(Some(bytes_to_data_uri("image/jpeg", &data)));
    }
    if fresh_miss(&miss) {
        return Ok(None);
    }

    match itunes_lookup_art(&artist, &album).await {
        Ok(Some(bytes)) => {
            write_atomic(&hit, &bytes).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&miss);
            Ok(Some(bytes_to_data_uri("image/jpeg", &bytes)))
        }
        Ok(None) => {
            touch_miss(&miss);
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// Make sure `artwork/<key>.jpg` holds a cover for `(artist, album)`, resolving
/// it the same way `fetch_album_art` would (embedded tag, else iTunes) but
/// without returning the bytes — this is called once per album while building
/// the sync snapshot, purely to populate the cache that `/api/album-art/:key`
/// (server.rs) and the native Android app's album-art fetcher both read from.
/// Returns whether a cover ended up cached (art found or already there).
///
/// `lookup_online` (default `true`) gates the iTunes fallback: the caller
/// passes `false` for an album name that's actually a folder name stood in
/// for a missing tag (see the Mac UI's `albumName.ts`), since searching
/// iTunes for a folder name would likely match an unrelated release rather
/// than leave the cover blank.
#[tauri::command]
pub async fn ensure_album_art(
    app: tauri::AppHandle,
    artist: String,
    album: String,
    path: String,
    extra_paths: Option<Vec<String>>,
    lookup_online: Option<bool>,
) -> Result<bool, String> {
    if artist.trim().is_empty() && album.trim().is_empty() {
        return Ok(false);
    }
    let dir = cache_subdir(&app, "artwork")?;
    let key = cache_key(&[&artist, &album]);
    let hit = dir.join(format!("{key}.jpg"));
    let miss = dir.join(format!("{key}.miss"));

    if hit.is_file() {
        return Ok(true);
    }
    if fresh_miss(&miss) {
        return Ok(false);
    }

    // Embedded art first — cheap, local, and exactly what get_album_thumb would
    // have used directly had this track never been transcoded for sync. Try
    // every track of the album (not just the first — it may be the only one
    // without a cover), and treat an undecodable image as "none here" so we
    // still fall through to the next track / the iTunes lookup.
    let mut paths = vec![path];
    paths.extend(extra_paths.unwrap_or_default());
    for p in paths {
        let embedded = tokio::task::spawn_blocking(move || {
            let (_, bytes) = crate::read_embedded_artwork(Path::new(&p))?;
            downscale_jpeg(&bytes, 600).ok()
        })
        .await
        .ok()
        .flatten();
        if let Some(resized) = embedded {
            write_atomic(&hit, &resized).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&miss);
            return Ok(true);
        }
    }

    if !lookup_online.unwrap_or(true) {
        return Ok(false);
    }

    match itunes_lookup_art(&artist, &album).await {
        Ok(Some(bytes)) => {
            write_atomic(&hit, &bytes).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&miss);
            Ok(true)
        }
        Ok(None) => {
            touch_miss(&miss);
            Ok(false)
        }
        Err(_) => {
            // Network hiccup — don't poison the cache with a `.miss`; try again
            // next sync.
            Ok(false)
        }
    }
}

// ---- artist images (Deezer) -----------------------------------------------

/// One Deezer artist search hit, trimmed to what the picker UI needs.
#[derive(serde::Serialize)]
pub struct ArtistImageCandidate {
    pub id: i64,
    pub name: String,
    pub picture_url: String,
    pub thumb_url: String,
    pub nb_fan: i64,
}

/// True for Deezer's "no photo on file" placeholder artwork.
fn is_deezer_placeholder(url: &str) -> bool {
    url.contains("/images/artist//") || url.is_empty()
}

/// Same trim+lowercase convention as `cache_key` and `artistCoverKey` (db.ts)
/// — used to decide "is this Deezer hit actually the artist searched for".
fn normalize_artist_name(s: &str) -> String {
    s.trim().to_lowercase()
}

async fn deezer_search_artist(artist: &str) -> Result<Vec<ArtistImageCandidate>, String> {
    let client = http_client()?;
    let resp = client
        .get("https://api.deezer.com/search/artist")
        .query(&[("q", artist), ("limit", "10")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Deezer search HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let empty = Vec::new();
    let hits = body["data"].as_array().unwrap_or(&empty);
    Ok(hits
        .iter()
        .filter_map(|h| {
            let picture_url = h["picture_xl"].as_str().unwrap_or("");
            if is_deezer_placeholder(picture_url) {
                return None;
            }
            Some(ArtistImageCandidate {
                id: h["id"].as_i64().unwrap_or(0),
                name: h["name"].as_str().unwrap_or("").to_string(),
                picture_url: picture_url.to_string(),
                thumb_url: h["picture_medium"].as_str().unwrap_or(picture_url).to_string(),
                nb_fan: h["nb_fan"].as_i64().unwrap_or(0),
            })
        })
        .collect())
}

/// Search Deezer for artists matching `artist`, for the "Find Artist Image…"
/// picker. Not cached — this is a small, user-triggered, one-off lookup.
#[tauri::command]
pub async fn search_artist_images(artist: String) -> Result<Vec<ArtistImageCandidate>, String> {
    if artist.trim().is_empty() {
        return Ok(Vec::new());
    }
    deezer_search_artist(&artist).await
}

/// Download a Deezer / iTunes cover picture (`https://*.dzcdn.net/...` or
/// `https://*.mzstatic.com/...` only) and return it as a downscaled `data:` URI, ready for `setArtistCover`.
#[tauri::command]
pub async fn fetch_image_as_data_uri(url: String) -> Result<String, String> {
    if !is_allowed_image_url(&url) {
        return Err("only dzcdn.net / mzstatic.com image URLs are allowed".to_string());
    }
    let client = http_client()?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("image fetch HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let resized = downscale_jpeg(&bytes, 1000)?;
    Ok(bytes_to_data_uri("image/jpeg", &resized))
}

/// Only the artwork CDNs of the sources we search (Deezer, iTunes) may be
/// downloaded by `fetch_image_as_data_uri`.
fn is_allowed_image_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed
            .host_str()
            .map(|h| h.ends_with(".dzcdn.net") || h.ends_with(".mzstatic.com"))
            .unwrap_or(false)
}

// ---- album cover search (iTunes + Deezer) ----------------------------------

/// One album cover search hit, trimmed to what the picker UI needs.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct AlbumCoverCandidate {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub image_url: String,
    pub thumb_url: String,
    pub source: &'static str,
}

fn parse_itunes_albums(body: &serde_json::Value) -> Vec<AlbumCoverCandidate> {
    let empty = Vec::new();
    body["results"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|h| {
            let art = h["artworkUrl100"].as_str().filter(|s| !s.is_empty())?;
            Some(AlbumCoverCandidate {
                id: format!("itunes-{}", h["collectionId"].as_i64().unwrap_or(0)),
                title: h["collectionName"].as_str().unwrap_or("").to_string(),
                artist: h["artistName"].as_str().unwrap_or("").to_string(),
                image_url: upscale_itunes_art_url(art, 1000),
                thumb_url: upscale_itunes_art_url(art, 300),
                source: "itunes",
            })
        })
        .collect()
}

fn parse_deezer_albums(body: &serde_json::Value) -> Vec<AlbumCoverCandidate> {
    let empty = Vec::new();
    body["data"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|h| {
            let big = h["cover_xl"].as_str().unwrap_or("");
            if big.is_empty() || big.contains("/images/cover//") {
                return None;
            }
            Some(AlbumCoverCandidate {
                id: format!("deezer-{}", h["id"].as_i64().unwrap_or(0)),
                title: h["title"].as_str().unwrap_or("").to_string(),
                artist: h["artist"]["name"].as_str().unwrap_or("").to_string(),
                image_url: big.to_string(),
                thumb_url: h["cover_medium"].as_str().unwrap_or(big).to_string(),
                source: "deezer",
            })
        })
        .collect()
}

async fn search_json(url: &str, query: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let resp = http_client()?
        .get(url)
        .query(query)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{url} HTTP {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

/// Search iTunes and Deezer for album covers matching `query`, for the "Find
/// Album Cover…" picker. Not cached — small, user-triggered, one-off lookup.
/// One source failing is tolerated; only both failing is an error.
#[tauri::command]
pub async fn search_album_covers(query: String) -> Result<Vec<AlbumCoverCandidate>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let itunes_q = [("term", query.as_str()), ("entity", "album"), ("limit", "15")];
    let deezer_q = [("q", query.as_str()), ("limit", "15")];
    let (itunes, deezer) = tokio::join!(
        search_json("https://itunes.apple.com/search", &itunes_q),
        search_json("https://api.deezer.com/search/album", &deezer_q),
    );
    if let (Err(e), Err(_)) = (&itunes, &deezer) {
        return Err(e.clone());
    }
    let mut out = itunes.map(|b| parse_itunes_albums(&b)).unwrap_or_default();
    out.extend(deezer.map(|b| parse_deezer_albums(&b)).unwrap_or_default());
    Ok(out)
}

/// Best-effort automatic artist image for the bulk "Fetch Missing Artist
/// Images" action: only accepts a Deezer hit whose name matches `artist`
/// exactly (case/width-insensitive) — ambiguous searches are left for the
/// picker instead of guessing. Cached on disk by artist name; `None` results
/// are remembered for `MISS_TTL` so a repeat run doesn't re-hit Deezer for
/// artists it couldn't find.
#[tauri::command]
pub async fn auto_artist_image(app: tauri::AppHandle, artist: String) -> Result<Option<String>, String> {
    if artist.trim().is_empty() {
        return Ok(None);
    }
    let dir = cache_subdir(&app, "artist_art")?;
    let key = cache_key(&[&artist]);
    let miss = dir.join(format!("{key}.miss"));
    if fresh_miss(&miss) {
        return Ok(None);
    }

    let wanted = normalize_artist_name(&artist);
    let candidates = match deezer_search_artist(&artist).await {
        Ok(c) => c,
        Err(_) => return Ok(None), // network hiccup: no `.miss`, retry next time
    };
    let best = candidates
        .into_iter()
        .filter(|c| normalize_artist_name(&c.name) == wanted)
        .max_by_key(|c| c.nb_fan);

    let Some(best) = best else {
        touch_miss(&miss);
        return Ok(None);
    };

    match fetch_image_as_data_uri(best.picture_url).await {
        Ok(data_uri) => {
            let _ = std::fs::remove_file(&miss);
            Ok(Some(data_uri))
        }
        Err(_) => Ok(None), // network hiccup: no `.miss`, retry next time
    }
}

/// Read a user-picked image file (from the "Set Album Cover" dialog) and
/// return it as a downscaled `data:` URI, ready to store as a non-destructive
/// per-album override (see `album_covers` table in db.ts). Unlike
/// `set_track_artwork`, this never touches the music file itself.
///
/// Async so the decode/downscale work runs off the main thread (see
/// `get_album_thumb`'s doc comment for why that matters in Tauri 2).
#[tauri::command]
pub async fn read_image_as_data_uri(image_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&image_path).map_err(|e| e.to_string())?;
        let resized = downscale_jpeg(&bytes, 1000)?;
        Ok(bytes_to_data_uri("image/jpeg", &resized))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- album thumbnails -----------------------------------------------------

/// Decode `bytes`, shrink to fit `max` px on the long edge, re-encode as JPEG.
/// Pure — unit-tested below.
fn downscale_jpeg(bytes: &[u8], max: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("decode: {e}"))?;
    let small = img.thumbnail(max, max);
    let mut out = Vec::new();
    // `ImageOutputFormat` (which took a quality argument directly) was
    // removed in image 0.25 — an explicit quality now goes through the
    // codec's own encoder.
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82)
        .encode_image(&small)
        .map_err(|e| format!("encode: {e}"))?;
    Ok(out)
}

/// Write `bytes` to `path` atomically: to a sibling temp file first, then
/// `rename` over the destination. Guards against a reader (or another writer
/// racing on the exact same key/size, e.g. a foreground request landing
/// mid-prewarm) ever observing a partially written thumbnail.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("write_atomic: path has no parent dir")?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut tmp, bytes).map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

/// The underlying art for (artist, album, path) before any thumbnail sizing:
/// the file's own embedded cover, else the `fetch_album_art` disk cache
/// (a paired Mac's `.sync.jpg` answer preferred over this device's own,
/// less reliable `.jpg` iTunes guess — see `fetch_album_art`'s doc comment).
/// Never hits the network. `None` when nothing is available yet.
fn source_art_bytes(app: &tauri::AppHandle, artist: &str, album: &str, path: &str) -> Option<Vec<u8>> {
    if let Some((_, bytes)) = crate::read_embedded_artwork(Path::new(path)) {
        return Some(bytes);
    }
    let key = cache_key(&[artist, album]);
    let dir = cache_subdir(app, "artwork").ok()?;
    std::fs::read(dir.join(format!("{key}.sync.jpg")))
        .or_else(|_| std::fs::read(dir.join(format!("{key}.jpg"))))
        .ok()
}

/// One (artist, album)'s thumbnail at `size`: the cached file if already on
/// disk under `thumbs/`, else decoded/downscaled from `raw` and written
/// there. `key` is `cache_key(&[artist, album])`, computed once by the
/// caller so a multi-size prewarm doesn't hash it over and over.
fn thumb_for_size(dir: &Path, key: &str, size: u32, raw: &[u8]) -> Result<Vec<u8>, String> {
    let hit = dir.join(format!("{key}-{size}.jpg"));
    if let Ok(data) = std::fs::read(&hit) {
        return Ok(data);
    }
    let thumb = downscale_jpeg(raw, size)?;
    write_atomic(&hit, &thumb)?;
    Ok(thumb)
}

/// Small JPEG thumbnail for a track's album, as a `data:` URI — used by the
/// mobile track list (96px, where a full-size cover per row would be
/// wasteful) and the desktop album grid (larger, `size` param).
///
/// Reads only data already on disk (the embedded cover, then the
/// `fetch_album_art` cache) and never hits the network — fetching stays the job
/// of `fetch_album_art`, which the player calls once per track. Returns `None`
/// when no art is available yet. Thumbnails are cached under `thumbs/`, keyed
/// by (artist, album, size), so tracks that share an album share one thumbnail.
///
/// Async, decoding/downscaling on a blocking thread: a synchronous
/// `#[tauri::command]` runs on Tauri 2's main thread, and the Albums grid can
/// call this once per visible card across a library-sized list — left
/// synchronous, an untagged/large-artwork library would freeze the whole UI
/// (spinning cursor) until every card resolved. See also `prewarm_album_thumbs`,
/// which gets ahead of this after a scan so cards resolve from cache instead.
#[tauri::command]
pub async fn get_album_thumb(
    app: tauri::AppHandle,
    artist: String,
    album: String,
    path: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let size = size.unwrap_or(96).clamp(48, 512);
        let dir = cache_subdir(&app, "thumbs")?;
        let key = cache_key(&[&artist, &album]);
        let hit = dir.join(format!("{key}-{size}.jpg"));
        if let Ok(data) = std::fs::read(&hit) {
            return Ok(Some(bytes_to_data_uri("image/jpeg", &data)));
        }

        let Some(raw) = source_art_bytes(&app, &artist, &album, &path) else {
            return Ok(None);
        };
        let thumb = thumb_for_size(&dir, &key, size, &raw)?;
        Ok(Some(bytes_to_data_uri("image/jpeg", &thumb)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One album to prewarm a thumbnail for — same shape as the Mac UI's
/// representative-track map (`albumOf` grouping), just enough to resolve art.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ThumbPrewarmItem {
    pub artist: String,
    pub album: String,
    pub path: String,
}

/// Sizes the Mac UI actually renders album art at: the grid/section-header
/// cards (`THUMB_SIZE` in LibraryView.tsx) and LibraryColumns' left-pane rows.
const PREWARM_SIZES: [u32; 2] = [256, 64];

/// Shared cancel flag for an in-flight `prewarm_album_thumbs`, mirroring
/// `ScanState` in lib.rs (a separate flag: prewarming runs after a scan
/// completes, not concurrently with one, but the two are otherwise unrelated
/// long-running jobs).
#[derive(Default)]
pub struct ThumbPrewarmState {
    cancel: Arc<AtomicBool>,
}

/// Per-item progress for a running prewarm, emitted as `thumb-progress` —
/// same shape as lib.rs's `ScanProgress`/`scan-progress`.
#[derive(Debug, Clone, Serialize)]
struct ThumbProgress {
    done: usize,
    total: usize,
}

/// Flip the shared cancel flag so a running prewarm stops after the item
/// it's currently on. No-op when nothing is prewarming.
#[tauri::command]
pub fn cancel_thumb_prewarm(state: tauri::State<'_, ThumbPrewarmState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

/// Get ahead of `get_album_thumb` for every album in `items` right after a
/// scan, so opening the Albums grid resolves from an already-warm cache
/// instead of decoding/downscaling on demand one card at a time. Runs on a
/// blocking thread; emits `thumb-progress` (throttled to roughly once per
/// 50ms) so the caller can show "Loading artwork… n/total" without flooding
/// the event channel on a huge library. Best-effort: a single item's failure
/// (unreadable file, corrupt art) is skipped rather than aborting the batch.
#[tauri::command]
pub async fn prewarm_album_thumbs(
    app: tauri::AppHandle,
    state: tauri::State<'_, ThumbPrewarmState>,
    items: Vec<ThumbPrewarmItem>,
) -> Result<(), String> {
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let total = items.len();

    tauri::async_runtime::spawn_blocking(move || {
        let dir = match cache_subdir(&app, "thumbs") {
            Ok(d) => d,
            Err(_) => return,
        };
        let mut last_emit = std::time::Instant::now();
        let emit_every = Duration::from_millis(50);

        for (i, item) in items.into_iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            let key = cache_key(&[&item.artist, &item.album]);
            let missing: Vec<u32> = PREWARM_SIZES
                .into_iter()
                .filter(|size| !dir.join(format!("{key}-{size}.jpg")).is_file())
                .collect();
            if !missing.is_empty() {
                if let Some(raw) = source_art_bytes(&app, &item.artist, &item.album, &item.path) {
                    for size in missing {
                        let _ = thumb_for_size(&dir, &key, size, &raw);
                    }
                }
            }

            let done = i + 1;
            if done == total || last_emit.elapsed() >= emit_every {
                let _ = app.emit("thumb-progress", ThumbProgress { done, total });
                last_emit = std::time::Instant::now();
            }
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Drop the cached `get_album_thumb` thumbnails (all sizes) for one album.
/// `set_track_artwork` rewrites a file's embedded cover directly, and the
/// disk thumbnail cache — keyed by (artist, album), not by file content —
/// would otherwise keep serving the old image in the album grid.
#[tauri::command]
pub fn clear_album_thumb_cache(app: tauri::AppHandle, artist: String, album: String) -> Result<(), String> {
    let dir = cache_subdir(&app, "thumbs")?;
    let key = cache_key(&[&artist, &album]);
    let prefix = format!("{key}-");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

// ---- lyrics ---------------------------------------------------------------

async fn lrclib_lookup(
    artist: &str,
    title: &str,
    album: &str,
    duration: Option<f64>,
) -> Result<Option<String>, String> {
    let client = http_client()?;

    // Exact get first — cheapest and most accurate when the tags line up.
    let mut q: Vec<(&str, String)> = vec![
        ("artist_name", artist.to_string()),
        ("track_name", title.to_string()),
    ];
    if !album.trim().is_empty() {
        q.push(("album_name", album.to_string()));
    }
    if let Some(d) = duration {
        if d > 0.0 {
            q.push(("duration", (d.round() as i64).to_string()));
        }
    }
    let resp = client
        .get("https://lrclib.net/api/get")
        .query(&q)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if resp.status().is_success() {
        let obj: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(text) = pick_lyrics(&obj) {
            return Ok(Some(text));
        }
    } else if resp.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!("LRCLIB HTTP {}", resp.status()));
    }

    // Fall back to fuzzy search on artist + title.
    let resp = client
        .get("https://lrclib.net/api/search")
        .query(&[("artist_name", artist), ("track_name", title)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let arr: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(arr.as_array().and_then(|xs| xs.iter().find_map(pick_lyrics)))
}

/// Lyrics for a track with none embedded. Returns the lyric text or `None`.
/// Cached on disk by (artist, title, album).
#[tauri::command]
pub async fn fetch_lyrics(
    app: tauri::AppHandle,
    artist: String,
    title: String,
    album: String,
    duration: Option<f64>,
) -> Result<Option<String>, String> {
    if artist.trim().is_empty() || title.trim().is_empty() {
        return Ok(None);
    }
    let dir = cache_subdir(&app, "lyrics")?;
    let key = cache_key(&[&artist, &title, &album]);
    let hit = dir.join(format!("{key}.txt"));
    let miss = dir.join(format!("{key}.miss"));

    if let Ok(text) = std::fs::read_to_string(&hit) {
        return Ok(Some(text));
    }
    if fresh_miss(&miss) {
        return Ok(None);
    }

    match lrclib_lookup(&artist, &title, &album, duration).await {
        Ok(Some(text)) => {
            write_atomic(&hit, text.as_bytes()).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&miss);
            Ok(Some(text))
        }
        Ok(None) => {
            touch_miss(&miss);
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_itunes_albums_with_upscaled_art() {
        let v = serde_json::json!({"results":[
            {"collectionId":1,"collectionName":"Abbey Road","artistName":"The Beatles",
             "artworkUrl100":"https://x.mzstatic.com/a/100x100bb.jpg"},
            {"collectionId":2,"collectionName":"No Art"}
        ]});
        let r = parse_itunes_albums(&v);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "itunes-1");
        assert_eq!(r[0].image_url, "https://x.mzstatic.com/a/1000x1000bb.jpg");
        assert_eq!(r[0].thumb_url, "https://x.mzstatic.com/a/300x300bb.jpg");
    }

    #[test]
    fn parses_deezer_albums_and_drops_placeholders() {
        let v = serde_json::json!({"data":[
            {"id":5,"title":"T","artist":{"name":"A"},"cover_xl":"https://e.dzcdn.net/images/cover/x/1000x1000.jpg","cover_medium":"https://e.dzcdn.net/m.jpg"},
            {"id":6,"title":"P","artist":{"name":"A"},"cover_xl":"https://e.dzcdn.net/images/cover//1000x1000.jpg"}
        ]});
        let r = parse_deezer_albums(&v);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "deezer-5");
        assert_eq!(r[0].artist, "A");
    }

    #[test]
    fn image_url_allowlist() {
        assert!(is_allowed_image_url("https://cdn-images.dzcdn.net/a.jpg"));
        assert!(is_allowed_image_url("https://is1-ssl.mzstatic.com/a.jpg"));
        assert!(!is_allowed_image_url("http://cdn-images.dzcdn.net/a.jpg"));
        assert!(!is_allowed_image_url("https://evil.com/dzcdn.net"));
        assert!(!is_allowed_image_url("https://dzcdn.net.evil.com/a.jpg"));
        assert!(!is_allowed_image_url("not a url"));
    }

    #[test]
    fn cache_key_is_case_and_whitespace_insensitive() {
        assert_eq!(
            cache_key(&["The Beatles", "Abbey Road"]),
            cache_key(&["  the beatles ", "ABBEY ROAD"]),
        );
        assert_ne!(cache_key(&["a", "b"]), cache_key(&["a", "c"]));
    }

    #[test]
    fn cache_key_does_not_collapse_internal_whitespace() {
        // Must match Android's albumArtCacheKey (sync/ContentHash.kt), which
        // only trims + lowercases and never collapses internal whitespace.
        assert_ne!(cache_key(&["Foo  Bar", "Album"]), cache_key(&["Foo Bar", "Album"]));
    }

    /// Shared contract with Android's `albumArtCacheKey` (see
    /// docs/test-vectors/album-art-key.json and the matching Kotlin test in
    /// ContentHashTest.kt) — pins the exact key both sides must produce.
    #[test]
    fn cache_key_matches_shared_test_vectors() {
        let json = include_str!("../../docs/test-vectors/album-art-key.json");
        let doc: serde_json::Value = serde_json::from_str(json).unwrap();
        for v in doc["vectors"].as_array().unwrap() {
            let artist = v["artist"].as_str().unwrap();
            let album = v["album"].as_str().unwrap();
            let expected = v["key"].as_str().unwrap();
            assert_eq!(
                cache_key(&[artist, album]),
                expected,
                "cache_key mismatch for ({artist:?}, {album:?})"
            );
        }
    }

    #[test]
    fn upscale_swaps_the_itunes_size_token() {
        assert_eq!(
            upscale_itunes_art_url("https://x/source/100x100bb.jpg", 600),
            "https://x/source/600x600bb.jpg",
        );
        // nothing to swap -> unchanged
        assert_eq!(upscale_itunes_art_url("https://x/cover.png", 600), "https://x/cover.png");
    }

    #[test]
    fn downscale_jpeg_shrinks_to_fit_and_stays_decodable() {
        // A 300x200 source PNG.
        let src = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            300,
            200,
            image::Rgb([200, 60, 40]),
        ));
        let mut png = Vec::new();
        src.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let thumb = downscale_jpeg(&png, 96).unwrap();
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert!(decoded.width() <= 96 && decoded.height() <= 96, "{:?}", (decoded.width(), decoded.height()));
        // Aspect ratio preserved: 300:200 -> 96:64.
        assert_eq!((decoded.width(), decoded.height()), (96, 64));
    }

    #[test]
    fn downscale_jpeg_rejects_non_images() {
        assert!(downscale_jpeg(b"not an image", 96).is_err());
    }

    fn png_bytes(w: u32, h: u32) -> Vec<u8> {
        let src = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(w, h, image::Rgb([10, 20, 30])));
        let mut png = Vec::new();
        src.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        png
    }

    #[test]
    fn write_atomic_writes_via_a_sibling_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("key-256.jpg");
        let bytes = downscale_jpeg(&png_bytes(300, 200), 256).unwrap();

        write_atomic(&dest, &bytes).unwrap();

        assert!(dest.is_file());
        // No leftover temp files: the rename replaced the destination, it
        // didn't just write a stray sibling.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path() != dest)
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let decoded = image::load_from_memory(&std::fs::read(&dest).unwrap()).unwrap();
        assert!(decoded.width() <= 256 && decoded.height() <= 256);
    }

    #[test]
    fn thumb_for_size_writes_then_serves_from_cache() {
        let dir = tempfile::tempdir().unwrap();
        let key = "somekey";
        let raw = png_bytes(300, 200);

        let first = thumb_for_size(dir.path(), key, 64, &raw).unwrap();
        assert!(dir.path().join(format!("{key}-64.jpg")).is_file());

        // Second call must not need `raw` at all to still return the same
        // bytes — it should come straight from the cache file.
        let second = thumb_for_size(dir.path(), key, 64, &[]).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn thumb_for_size_is_independent_per_size() {
        let dir = tempfile::tempdir().unwrap();
        let key = "somekey";
        let raw = png_bytes(300, 200);

        thumb_for_size(dir.path(), key, 256, &raw).unwrap();
        thumb_for_size(dir.path(), key, 64, &raw).unwrap();

        assert!(dir.path().join(format!("{key}-256.jpg")).is_file());
        assert!(dir.path().join(format!("{key}-64.jpg")).is_file());
    }

    #[test]
    fn deezer_placeholder_urls_are_detected() {
        assert!(is_deezer_placeholder(""));
        assert!(is_deezer_placeholder("https://e-cdns-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg"));
        assert!(!is_deezer_placeholder("https://e-cdns-images.dzcdn.net/images/artist/abc123/1000x1000-000000-80-0-0.jpg"));
    }

    #[test]
    fn artist_name_normalization_ignores_case_and_whitespace() {
        assert_eq!(normalize_artist_name("  The Beatles "), normalize_artist_name("the beatles"));
        assert_ne!(normalize_artist_name("The Beatles"), normalize_artist_name("Beatles"));
    }

    #[test]
    fn pick_lyrics_prefers_plain_then_synced_then_none() {
        let plain = serde_json::json!({ "plainLyrics": "la la", "syncedLyrics": "[00:01] la" });
        assert_eq!(pick_lyrics(&plain).as_deref(), Some("la la"));

        let synced = serde_json::json!({ "plainLyrics": "", "syncedLyrics": "[00:01] la" });
        assert_eq!(pick_lyrics(&synced).as_deref(), Some("[00:01] la"));

        let empty = serde_json::json!({ "plainLyrics": "  ", "syncedLyrics": null });
        assert_eq!(pick_lyrics(&empty), None);
    }
}
