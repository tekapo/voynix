//! Echo (Alexa) playback server (off by default).
//!
//! A small HTTPS server on the LAN that serves one thing: `GET /play`, the URL an
//! Alexa skill hands to an Echo's AudioPlayer. The Echo fetches it straight from
//! this Mac — nothing is exposed to the internet. For that to work, the host
//! name in the URL must resolve to a public IP for Alexa's cloud (which rejects
//! private addresses in a Play directive) and to this Mac's LAN IP for the Echo
//! (split DNS); `docs/echo-lan.md` walks through the setup.
//!
//! The skill never talks to the Mac. It signs `/play?list=<spoken name>&i=<n>
//! &seed=<s>&exp=<unix>&sig=<HMAC>` with a shared secret, and the Mac does the
//! rest: fuzzy-match the playlist name, shuffle deterministically from `seed`
//! (0 means in order), and serve the `i`-th track. Requests must come from a
//! private address and carry a valid, unexpired signature.
//!
//! Like the sync server in `server.rs`, it never reads the database: the
//! frontend pushes a [`RemoteLibraryIn`] (smart playlists already evaluated) via
//! `set_remote_library`.
//!
//! Echo can only play MP3 and AAC, so anything else goes through the same
//! `afconvert` path `transcode.rs` uses, into its own `remote-cache/` (the sync
//! cache is pruned by `prepare_sync_media`, so the two can't share one).

use axum::{
    body::Body,
    extract::{Extension, Query, Request, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower::ServiceExt;
use tower_http::services::ServeFile;
use unicode_normalization::UnicodeNormalization;

/// Spoken once when no playlist matches, so the Echo says something instead of
/// failing silently.
const PLAYLIST_NOT_FOUND_AAC: &[u8] = include_bytes!("../assets/playlist-not-found.aac");
/// A spoken playlist name must score at least this against a playlist to be
/// played: a prefix/substring hit, or a strong bigram overlap.
const PLAYLIST_MIN_SCORE: f64 = 0.5;

type HmacSha256 = Hmac<Sha256>;

// ---- Library pushed by the frontend ----------------------------------------

/// Extra fields the frontend sends (artist, duration, …) are ignored.
#[derive(Clone, Deserialize)]
pub struct RemoteTrackIn {
    pub track_key: String,
    pub file_path: String,
}

#[derive(Clone, Deserialize)]
pub struct RemotePlaylistIn {
    pub name: String,
    pub track_keys: Vec<String>,
}

#[derive(Clone, Deserialize, Default)]
pub struct RemoteLibraryIn {
    pub playlists: Vec<RemotePlaylistIn>,
    pub tracks: Vec<RemoteTrackIn>,
}

/// The library with playlist-name search keys precomputed once per push.
#[derive(Default)]
struct Library {
    playlists: Vec<(RemotePlaylistIn, String)>,
    tracks: HashMap<String, PathBuf>,
}

impl Library {
    fn build(input: RemoteLibraryIn) -> Self {
        let tracks = input.tracks.into_iter().map(|t| (t.track_key, PathBuf::from(t.file_path))).collect();
        let playlists = input
            .playlists
            .into_iter()
            .map(|p| {
                let norm = normalize_for_search(&p.name);
                (p, norm)
            })
            .collect();
        Library { playlists, tracks }
    }
}

// ---- State -----------------------------------------------------------------

pub struct RemoteServer {
    shutdown_tx: Option<oneshot::Sender<()>>,
    /// Same double-start guard as `SyncServer::starting`.
    starting: bool,
    port: u16,
    secret: String,
    library: Library,
    app: Option<AppHandle>,
}

impl RemoteServer {
    pub fn new() -> Self {
        Self { shutdown_tx: None, starting: false, port: 0, secret: String::new(), library: Library::default(), app: None }
    }

    pub fn set_library(&mut self, lib: RemoteLibraryIn) {
        self.library = Library::build(lib);
    }

    /// Takes effect on the next request, so regenerating the secret doesn't
    /// need a restart.
    pub fn set_secret(&mut self, secret: String) {
        self.secret = secret;
    }
}

#[derive(Serialize, Clone)]
pub struct RemoteStatus {
    pub running: bool,
    pub port: u16,
    pub transcode_available: bool,
}

type Shared = Arc<Mutex<RemoteServer>>;

fn status_from(s: &RemoteServer, running: bool) -> RemoteStatus {
    RemoteStatus { running, port: s.port, transcode_available: crate::transcode::transcode_available() }
}

pub fn status(state: &Shared) -> Option<RemoteStatus> {
    let s = state.lock().unwrap();
    s.shutdown_tx.is_some().then(|| status_from(&s, true))
}

struct StartingGuard(Shared);
impl Drop for StartingGuard {
    fn drop(&mut self) {
        self.0.lock().unwrap().starting = false;
    }
}

/// Where the connection came from, attached to each connection's router so the
/// `/play` handler can refuse anything that isn't on a private network.
#[derive(Clone, Copy)]
struct Peer(IpAddr);

/// Private (RFC 1918 / unique-local) and loopback sources only: an Echo on the
/// LAN, or a local `curl`. The server is meant for the LAN, and this keeps it
/// that way if the port is ever forwarded by mistake.
fn is_private_source(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_private_source(IpAddr::V4(v4)),
            None => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        },
    }
}

/// Binds `0.0.0.0:port` with TLS from the user's PEM files and serves until
/// `stop`. There is no ephemeral-port fallback: the port is the one the host's
/// 443 redirect points at, so a taken port is an error rather than a silent move.
pub async fn start(
    state: Shared,
    port: u16,
    secret: String,
    cert_path: String,
    key_path: String,
    app: Option<AppHandle>,
) -> Result<RemoteStatus, String> {
    if secret.is_empty() {
        return Err("Echo playback needs a shared secret".to_string());
    }
    if cert_path.trim().is_empty() || key_path.trim().is_empty() {
        return Err("Echo playback needs a certificate and a private key".to_string());
    }
    {
        let mut s = state.lock().unwrap();
        if s.shutdown_tx.is_some() {
            return Ok(status_from(&s, true));
        }
        if s.starting {
            return Err("Echo server is already starting".to_string());
        }
        s.starting = true;
    }
    let _guard = StartingGuard(state.clone());

    let acceptor = Arc::new(crate::tls::ReloadingAcceptor::new(PathBuf::from(cert_path.trim()), PathBuf::from(key_path.trim()))?);
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("Could not listen on port {port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (tx, mut rx) = oneshot::channel::<()>();
    let router = build_router(state.clone());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, addr)) = accepted else { continue };
                    let acceptor = acceptor.current();
                    let router = router.clone().layer(Extension(Peer(addr.ip())));
                    // One connection's handshake/serve failure must not stop the accept loop.
                    tokio::spawn(async move {
                        let Ok(tls) = acceptor.accept(stream).await else { return };
                        let service = hyper_util::service::TowerToHyperService::new(router);
                        let _ = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new())
                            .serve_connection(hyper_util::rt::TokioIo::new(tls), service)
                            .await;
                    });
                }
            }
        }
    });

    let mut s = state.lock().unwrap();
    s.shutdown_tx = Some(tx);
    s.port = port;
    s.secret = secret;
    s.app = app;
    Ok(status_from(&s, true))
}

pub async fn stop(state: Shared) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    if let Some(tx) = s.shutdown_tx.take() {
        let _ = tx.send(());
    }
    s.port = 0;
    s.app = None;
    // Don't serve a stale library after a restart.
    s.library = Library::default();
    Ok(())
}

// ---- Signed play URLs ------------------------------------------------------

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// HMAC-SHA256 over `"{i}|{seed}|{exp}|{list}"`. `list` comes last because it is
/// free text: the three numbers before it can't contain `|`, so no other
/// combination of fields produces the same message. The skill signs the same way
/// (`alexa-skill/lambda`); both sides test the same vector.
fn play_mac(secret: &str, list: &str, i: usize, seed: u64, exp: u64) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(format!("{i}|{seed}|{exp}|{list}").as_bytes());
    mac
}

#[cfg(test)]
fn sign_play(secret: &str, list: &str, i: usize, seed: u64, exp: u64) -> String {
    URL_SAFE_NO_PAD.encode(play_mac(secret, list, i, seed, exp).finalize().into_bytes())
}

/// Constant-time check of the signature, then of the expiry.
fn verify_play(secret: &str, list: &str, i: usize, seed: u64, exp: u64, sig: &str, now: u64) -> bool {
    if secret.is_empty() {
        return false;
    }
    let Ok(sig_bytes) = URL_SAFE_NO_PAD.decode(sig) else { return false };
    play_mac(secret, list, i, seed, exp).verify_slice(&sig_bytes).is_ok() && exp > now
}

// ---- Playlist matching and order -------------------------------------------

/// Folds what Alexa's speech recognition and the user's tags disagree on:
/// full/half-width and compatibility forms (NFKC), case, katakana vs hiragana,
/// and spacing/punctuation. The same idea as `normalizeText` in
/// `src/textNormalize.ts`, plus the kana fold that one doesn't need.
pub(crate) fn normalize_for_search(s: &str) -> String {
    s.nfkc()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            // Katakana → hiragana (ァ..ヶ ↔ ぁ..ゖ are 0x60 apart).
            '\u{30A1}'..='\u{30F6}' => char::from_u32(c as u32 - 0x60).unwrap_or(c),
            _ => c,
        })
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn bigrams(s: &str) -> Vec<(char, char)> {
    let chars: Vec<char> = s.chars().collect();
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

/// 1.0 exact, 0.9 prefix, 0.8 substring, otherwise a bigram Dice coefficient
/// (scaled below the substring tier). Both inputs are already normalized.
fn match_score(query: &str, target: &str) -> f64 {
    if query.is_empty() || target.is_empty() {
        return 0.0;
    }
    if query == target {
        return 1.0;
    }
    if target.starts_with(query) {
        return 0.9;
    }
    if target.contains(query) {
        return 0.8;
    }
    let (a, b) = (bigrams(query), bigrams(target));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let mut pool = b.clone();
    let mut hits = 0usize;
    for g in &a {
        if let Some(i) = pool.iter().position(|x| x == g) {
            pool.swap_remove(i);
            hits += 1;
        }
    }
    (2.0 * hits as f64 / (a.len() + b.len()) as f64) * 0.75
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The playlist's tracks in play order: as stored for `seed == 0`, otherwise a
/// Fisher–Yates shuffle driven by `seed`, so every request for the same
/// (playlist, seed) sees the same order — which is what lets the skill ask for
/// track `i + 1` later and get the one that follows.
fn play_order(keys: &[String], seed: u64) -> Vec<&String> {
    let mut order: Vec<&String> = keys.iter().collect();
    if seed != 0 {
        let mut state = seed;
        for idx in (1..order.len()).rev() {
            let j = (splitmix64(&mut state) % (idx as u64 + 1)) as usize;
            order.swap(idx, j);
        }
    }
    order
}

enum Pick {
    /// No playlist matched, or it has nothing playable.
    NoPlaylist,
    /// The queue ran out (`i` is past the last track).
    OutOfRange,
    Track { id: String, src: PathBuf, next: Option<(String, PathBuf)> },
}

fn pick(lib: &Library, list: &str, i: usize, seed: u64) -> Pick {
    let query = normalize_for_search(list);
    // Highest score wins; on a tie the earlier playlist does.
    let best = lib
        .playlists
        .iter()
        .map(|(p, norm)| (p, match_score(&query, norm)))
        .filter(|(_, score)| *score >= PLAYLIST_MIN_SCORE)
        .fold(None::<(&RemotePlaylistIn, f64)>, |best, cand| match best {
            Some((_, s)) if s >= cand.1 => best,
            _ => Some(cand),
        });
    let Some((playlist, _)) = best else { return Pick::NoPlaylist };

    // Tracks that left the library since the last push are skipped, not played.
    let present: Vec<String> = playlist.track_keys.iter().filter(|k| lib.tracks.contains_key(*k)).cloned().collect();
    if present.is_empty() {
        return Pick::NoPlaylist;
    }
    let order = play_order(&present, seed);
    let Some(id) = order.get(i) else { return Pick::OutOfRange };
    let entry = |k: &&String| ((*k).clone(), lib.tracks[*k].clone());
    let (id, src) = entry(id);
    Pick::Track { id, src, next: order.get(i + 1).map(entry) }
}

// ---- Router ----------------------------------------------------------------

fn build_router(state: Shared) -> Router {
    Router::new().route("/play", get(play)).with_state(state)
}

#[derive(Deserialize)]
struct PlayQuery {
    list: String,
    i: usize,
    #[serde(default)]
    seed: u64,
    exp: u64,
    sig: String,
}

fn text(status: StatusCode, body: &'static str) -> Response {
    (status, body).into_response()
}

async fn play(
    State(state): State<Shared>,
    peer: Option<Extension<Peer>>,
    Query(q): Query<PlayQuery>,
    req: Request,
) -> Response {
    // A connection without a recorded source is refused rather than assumed local.
    let Some(Extension(Peer(ip))) = peer.filter(|Extension(Peer(ip))| is_private_source(*ip)) else {
        return text(StatusCode::FORBIDDEN, "LAN only");
    };
    let (picked, app) = {
        let s = state.lock().unwrap();
        if !verify_play(&s.secret, &q.list, q.i, q.seed, q.exp, &q.sig, now_secs()) {
            return text(StatusCode::FORBIDDEN, "Invalid or expired link");
        }
        (pick(&s.library, &q.list, q.i, q.seed), s.app.clone())
    };

    // The signature is deliberately kept out of the log line.
    let started = std::time::Instant::now();
    let (what, res) = match picked {
        // Said once: the skill queues track i + 1 as this one ends, so repeating it
        // for i > 0 would loop the message forever.
        Pick::NoPlaylist if q.i == 0 => ("no-playlist".to_string(), guidance()),
        Pick::NoPlaylist => ("no-playlist".to_string(), text(StatusCode::NOT_FOUND, "End of playlist")),
        Pick::OutOfRange => ("end-of-list".to_string(), text(StatusCode::NOT_FOUND, "End of playlist")),
        Pick::Track { id, src, next } => {
            // Convert the next track while this one plays, so Echo's request for
            // it doesn't wait on `afconvert`.
            if let Some((next_id, next_src)) = next {
                prefetch(next_id, next_src, cache_dir(&app));
            }
            let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            (format!("track {name}"), serve_track(id, src, cache_dir(&app), req).await)
        }
    };
    eprintln!(
        "echo /play {ip} i={} seed={} [{what}] -> {} in {}ms",
        q.i,
        q.seed,
        res.status(),
        started.elapsed().as_millis()
    );
    res
}

fn guidance() -> Response {
    let mut res = Response::new(Body::from(PLAYLIST_NOT_FOUND_AAC));
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("audio/aac"));
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

// ---- Streaming -------------------------------------------------------------

/// One conversion at a time per track, so Echo's repeated Range requests on a
/// not-yet-converted file don't each spawn their own `afconvert` onto one `.part`.
static TRANSCODE_LOCKS: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn transcode_lock(track_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    TRANSCODE_LOCKS.lock().unwrap().entry(track_id.to_string()).or_default().clone()
}

fn cache_dir(app: &Option<AppHandle>) -> PathBuf {
    app.as_ref()
        .and_then(|a| a.path().app_local_data_dir().ok())
        .map(|d| d.join("remote-cache"))
        .unwrap_or_else(|| std::env::temp_dir().join("voynix-remote-cache"))
}

/// A path Echo can play: the source itself if it's MP3/AAC, else the cached
/// AAC conversion (made here on a miss). Blocking — call from `spawn_blocking`.
fn ensure_playable(src: &Path, cache_dir: &Path) -> Result<PathBuf, String> {
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    // Probing for ALAC is only meaningful for the MPEG-4 family.
    let mp4_family = matches!(ext.as_str(), "m4a" | "mp4" | "aac" | "m4b");
    let alac = mp4_family && crate::transcode::is_alac(src);
    if !crate::transcode::echo_needs_transcode(&ext, alac) {
        return Ok(src.to_path_buf());
    }
    let options = crate::transcode::TranscodeOptions::default();
    let (size, mtime) = crate::transcode::source_fingerprint(src);
    let dst = cache_dir.join(crate::transcode::cache_name(src, size, mtime, "", &options));
    if !dst.is_file() {
        std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
        crate::transcode::transcode_one(src, &dst, &options)?;
    }
    Ok(dst)
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "aac" => "audio/aac",
        _ => "audio/mp4",
    }
}

fn prefetch(id: String, src: PathBuf, dir: PathBuf) {
    if !src.is_file() {
        return;
    }
    tokio::spawn(async move {
        let lock = transcode_lock(&id);
        let _held = lock.lock().await;
        let _ = tokio::task::spawn_blocking(move || ensure_playable(&src, &dir)).await;
    });
}

async fn serve_track(id: String, src: PathBuf, dir: PathBuf, req: Request) -> Response {
    if !src.is_file() {
        return text(StatusCode::NOT_FOUND, "File missing on host");
    }
    let lock = transcode_lock(&id);
    let playable = {
        let _held = lock.lock().await;
        tokio::task::spawn_blocking(move || ensure_playable(&src, &dir)).await
    };
    let path = match playable {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            eprintln!("echo track {id}: {e}");
            return text(StatusCode::INTERNAL_SERVER_ERROR, "Could not prepare audio");
        }
        Err(_) => return text(StatusCode::INTERNAL_SERVER_ERROR, "Could not prepare audio"),
    };

    // ServeFile streams via tokio::fs and handles Range/206; its extension-based
    // Content-Type guess isn't reliable for m4a, so state it explicitly.
    match ServeFile::new(&path).oneshot(req).await {
        Ok(res) => {
            let mut res = res.map(Body::new).into_response();
            if res.status().is_success() {
                res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type_for(&path)));
            }
            res
        }
        Err(_) => text(StatusCode::INTERNAL_SERVER_ERROR, "Read error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request as HttpRequest;

    const SECRET: &str = "test-secret";

    fn lib(path: &str) -> RemoteLibraryIn {
        let track = |key: &str| RemoteTrackIn { track_key: key.into(), file_path: path.into() };
        let playlist = |name: &str, keys: &[&str]| RemotePlaylistIn {
            name: name.into(),
            track_keys: keys.iter().map(|k| k.to_string()).collect(),
        };
        RemoteLibraryIn {
            playlists: vec![
                playlist("ドライブ", &["k1", "gone", "k2", "k3"]),
                playlist("Morning Jazz", &[]),
                playlist("ドライブ 夜", &["k3"]),
            ],
            tracks: vec![track("k1"), track("k2"), track("k3")],
        }
    }

    fn serving(path: &str) -> Shared {
        let s = Arc::new(Mutex::new(RemoteServer::new()));
        {
            let mut g = s.lock().unwrap();
            g.set_secret(SECRET.into());
            g.set_library(lib(path));
        }
        s
    }

    fn lan() -> Extension<Peer> {
        Extension(Peer("192.168.50.200".parse().unwrap()))
    }

    fn play_uri(list: &str, i: usize, seed: u64, exp: u64) -> String {
        let sig = sign_play(SECRET, list, i, seed, exp);
        let list: String = list.bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
        format!("/play?list={list}&i={i}&seed={seed}&exp={exp}&sig={sig}")
    }

    fn get(uri: &str, peer: Option<Extension<Peer>>) -> HttpRequest<Body> {
        let mut req = HttpRequest::get(uri).body(Body::empty()).unwrap();
        if let Some(p) = peer {
            req.extensions_mut().insert(p.0);
        }
        req
    }

    #[test]
    fn signature_matches_the_vector_the_skill_tests_too() {
        // Computed with Node's crypto (see alexa-skill/lambda); the skill asserts the same value.
        let sig = sign_play("test-secret", "ドライブ", 2, 123, 2_000_000_000);
        assert_eq!(sig, "tq0M_QDjXZlXkvGvXmraAMsEICMU3Df5o_zJkPPa9Fo");
    }

    #[test]
    fn signature_round_trips_and_rejects_tampering_and_expiry() {
        let sig = sign_play("s3cret", "ドライブ", 1, 7, 2000);
        assert!(verify_play("s3cret", "ドライブ", 1, 7, 2000, &sig, 1999));
        assert!(!verify_play("s3cret", "ドライブ", 1, 7, 2000, &sig, 2000), "expired");
        assert!(!verify_play("s3cret", "ドライブ", 2, 7, 2000, &sig, 1999), "other track");
        assert!(!verify_play("s3cret", "ドライブ", 1, 8, 2000, &sig, 1999), "other seed");
        assert!(!verify_play("s3cret", "ドライ", 1, 7, 2000, &sig, 1999), "other playlist");
        assert!(!verify_play("s3cret", "ドライブ", 1, 7, 2001, &sig, 1999), "other expiry");
        assert!(!verify_play("other", "ドライブ", 1, 7, 2000, &sig, 1999), "other secret");
        assert!(!verify_play("s3cret", "ドライブ", 1, 7, 2000, "!!not base64!!", 1999));
        assert!(!verify_play("", "ドライブ", 1, 7, 2000, &sig, 1999), "empty secret never verifies");
    }

    #[test]
    fn only_private_and_loopback_sources_are_allowed() {
        for ok in ["192.168.50.200", "10.1.2.3", "172.16.0.9", "172.31.255.1", "127.0.0.1", "::1", "fd12::1", "::ffff:192.168.1.5"] {
            assert!(is_private_source(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "169.254.1.1", "2001:db8::1", "::ffff:8.8.8.8"] {
            assert!(!is_private_source(bad.parse().unwrap()), "{bad}");
        }
    }

    #[test]
    fn normalization_folds_width_case_kana_and_spacing() {
        let drive = normalize_for_search("ドライブ");
        assert_eq!(normalize_for_search("どらいぶ"), drive);
        assert_eq!(normalize_for_search("ﾄﾞﾗｲﾌﾞ"), drive);
        assert_eq!(normalize_for_search("ＴＨＥ　Band!"), "theband");
        assert_eq!(normalize_for_search("Morning  Jazz"), normalize_for_search("morning jazz"));
    }

    #[test]
    fn scoring_orders_exact_prefix_substring_then_fuzzy() {
        let t = normalize_for_search("Morning Jazz");
        let exact = match_score(&normalize_for_search("morning jazz"), &t);
        let prefix = match_score(&normalize_for_search("morning"), &t);
        let sub = match_score(&normalize_for_search("jazz"), &t);
        let fuzzy = match_score(&normalize_for_search("mornin jaz"), &t);
        assert!(exact > prefix && prefix > sub && sub > fuzzy && fuzzy > PLAYLIST_MIN_SCORE);
        assert!(match_score("zzz", &t) < PLAYLIST_MIN_SCORE, "an incidental shared bigram stays below the cutoff");
        assert_eq!(match_score("", &t), 0.0);
    }

    #[test]
    fn shuffle_is_deterministic_per_seed_and_a_permutation() {
        let keys: Vec<String> = (0..50).map(|n| format!("k{n}")).collect();
        let a = play_order(&keys, 42);
        assert_eq!(a, play_order(&keys, 42), "same seed, same order");
        assert_ne!(a, play_order(&keys, 43), "another seed, another order");
        let in_order: Vec<&String> = keys.iter().collect();
        assert_ne!(a, in_order, "shuffled");
        assert_eq!(play_order(&keys, 0), in_order, "seed 0 keeps the stored order");
        let mut sorted = a.clone();
        sorted.sort();
        let mut expect = in_order;
        expect.sort();
        assert_eq!(sorted, expect, "nothing lost or duplicated");
        assert!(play_order(&[], 7).is_empty());
    }

    #[test]
    fn pick_matches_the_playlist_name_and_skips_missing_tracks() {
        let l = Library::build(lib("/music/a.mp3"));
        let id = |p: Pick| match p {
            Pick::Track { id, .. } => id,
            Pick::NoPlaylist => "none".into(),
            Pick::OutOfRange => "end".into(),
        };
        // "gone" isn't in the library, so the playlist is k1, k2, k3.
        assert_eq!(id(pick(&l, "ドライブ", 0, 0)), "k1");
        assert_eq!(id(pick(&l, "どらいぶ", 1, 0)), "k2");
        assert_eq!(id(pick(&l, "ドライブ", 2, 0)), "k3");
        assert_eq!(id(pick(&l, "ドライブ", 3, 0)), "end");
        assert_eq!(id(pick(&l, "ドライブ 夜", 0, 0)), "k3", "the exact name beats the prefix match");
        assert_eq!(id(pick(&l, "クラシック", 0, 0)), "none");
        assert_eq!(id(pick(&l, "Morning Jazz", 0, 0)), "none", "an empty playlist has nothing to play");
        // The next track is the one a later request for i + 1 will return.
        let Pick::Track { next, .. } = pick(&l, "ドライブ", 0, 99) else { panic!() };
        let Pick::Track { id: second, .. } = pick(&l, "ドライブ", 1, 99) else { panic!() };
        assert_eq!(next.unwrap().0, second);
    }

    #[tokio::test]
    async fn play_refuses_non_lan_sources_and_bad_signatures() {
        let app = build_router(serving("/nope"));
        let exp = now_secs() + 60;
        let uri = play_uri("ドライブ", 0, 0, exp);

        let outside = Extension(Peer("8.8.8.8".parse().unwrap()));
        let r = app.clone().oneshot(get(&uri, Some(outside))).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = app.clone().oneshot(get(&uri, None)).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN, "no recorded source");

        let tampered = uri.replace("&i=0", "&i=1");
        let r = app.clone().oneshot(get(&tampered, Some(lan()))).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);

        let old = now_secs() - 1;
        let r = app.clone().oneshot(get(&play_uri("ドライブ", 0, 0, old), Some(lan()))).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN, "expired");

        let r = app.oneshot(get("/play?list=x", Some(lan()))).await.unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST, "missing parameters");
    }

    #[tokio::test]
    async fn play_serves_ranges_with_the_right_type() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.mp3");
        std::fs::write(&path, b"0123456789").unwrap();
        let app = build_router(serving(&path.to_string_lossy()));
        let uri = play_uri("ドライブ", 0, 0, now_secs() + 60);

        let full = app.clone().oneshot(get(&uri, Some(lan()))).await.unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers()[header::CONTENT_TYPE], "audio/mpeg");
        assert_eq!(&to_bytes(full.into_body(), usize::MAX).await.unwrap()[..], b"0123456789");

        let mut ranged = get(&uri, Some(lan()));
        ranged.headers_mut().insert("range", "bytes=2-5".parse().unwrap());
        let ranged = app.oneshot(ranged).await.unwrap();
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.headers()[header::CONTENT_TYPE], "audio/mpeg");
        assert_eq!(&to_bytes(ranged.into_body(), usize::MAX).await.unwrap()[..], b"2345");
    }

    #[tokio::test]
    async fn play_answers_end_of_list_and_unknown_playlist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.mp3");
        std::fs::write(&path, b"0123456789").unwrap();
        let app = build_router(serving(&path.to_string_lossy()));
        let exp = now_secs() + 60;

        let end = app.clone().oneshot(get(&play_uri("ドライブ", 3, 0, exp), Some(lan()))).await.unwrap();
        assert_eq!(end.status(), StatusCode::NOT_FOUND);

        let unknown = app.clone().oneshot(get(&play_uri("クラシック", 0, 0, exp), Some(lan()))).await.unwrap();
        assert_eq!(unknown.status(), StatusCode::OK);
        assert_eq!(unknown.headers()[header::CONTENT_TYPE], "audio/aac");
        assert_eq!(&to_bytes(unknown.into_body(), usize::MAX).await.unwrap()[..], PLAYLIST_NOT_FOUND_AAC);

        // The skill queues the next track as the message ends; that must end the queue, not repeat the message.
        let again = app.oneshot(get(&play_uri("クラシック", 1, 0, exp), Some(lan()))).await.unwrap();
        assert_eq!(again.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn only_play_is_routed() {
        let app = build_router(serving("/nope"));
        for uri in ["/", "/api/playlists", "/stream/k1", "/play/extra"] {
            let r = app.clone().oneshot(get(uri, Some(lan()))).await.unwrap();
            assert_eq!(r.status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    #[tokio::test]
    async fn real_tls_socket_serves_play_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let key_pair = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap().self_signed(&key_pair).unwrap();
        let (cert_path, key_path) = (dir.path().join("fullchain.pem"), dir.path().join("privkey.pem"));
        std::fs::write(&cert_path, cert.pem()).unwrap();
        std::fs::write(&key_path, key_pair.serialize_pem()).unwrap();
        let (c, k) = (cert_path.to_string_lossy().to_string(), key_path.to_string_lossy().to_string());

        let state = Arc::new(Mutex::new(RemoteServer::new()));
        assert!(start(state.clone(), 0, String::new(), c.clone(), k.clone(), None).await.is_err(), "needs a secret");
        assert!(start(state.clone(), 0, SECRET.into(), String::new(), k.clone(), None).await.is_err(), "needs a certificate");
        assert!(start(state.clone(), 0, SECRET.into(), "/nope.pem".into(), k.clone(), None).await.is_err());

        let status = start(state.clone(), 0, SECRET.into(), c, k, None).await.unwrap();
        assert!(status.running && status.port != 0);
        let http = reqwest::Client::builder().danger_accept_invalid_certs(true).build().unwrap();
        // An unknown playlist is answered with the guidance clip, over real TLS from loopback.
        let uri = play_uri("クラシック", 0, 0, now_secs() + 60);
        let r = http.get(format!("https://127.0.0.1:{}{uri}", status.port)).send().await.unwrap();
        assert_eq!(r.status(), reqwest::StatusCode::OK);
        assert_eq!(r.headers()["content-type"], "audio/aac");
        let r = http.get(format!("https://127.0.0.1:{}/anything", status.port)).send().await.unwrap();
        assert_eq!(r.status(), reqwest::StatusCode::NOT_FOUND);

        stop(state.clone()).await.unwrap();
        assert!(super::status(&state).is_none());
    }
}
