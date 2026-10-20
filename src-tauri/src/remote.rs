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
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};
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

/// Extra fields the frontend sends are ignored. A track key can map to several
/// files (the same recording kept in two places, one of them maybe unmounted), so
/// the file actually served is the first of `file_paths` that exists right now.
#[derive(Clone, Deserialize)]
pub struct RemoteTrackIn {
    pub track_key: String,
    pub file_paths: Vec<String>,
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
    tracks: HashMap<String, Vec<PathBuf>>,
}

impl Library {
    fn build(input: RemoteLibraryIn) -> Self {
        let tracks = input
            .tracks
            .into_iter()
            .map(|t| (t.track_key, t.file_paths.into_iter().map(PathBuf::from).collect()))
            .collect();
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
    /// Flips to `true` on stop: ends the accept loop and gracefully closes open connections.
    shutdown_tx: Option<watch::Sender<bool>>,
    /// Resolves once the accept task has dropped the listener, so a restart can rebind the port.
    closed_rx: Option<oneshot::Receiver<()>>,
    /// Same double-start guard as `SyncServer::starting`.
    starting: bool,
    /// `stop` arrived while `start` was still in flight: `start` must not leave a server running.
    stop_requested: bool,
    port: u16,
    secret: String,
    library: Library,
    app: Option<AppHandle>,
}

impl RemoteServer {
    pub fn new() -> Self {
        Self { shutdown_tx: None, closed_rx: None, starting: false, stop_requested: false, port: 0, secret: String::new(), library: Library::default(), app: None }
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
    // A start still in flight (a quick off-then-on) finishes or cancels first; this
    // one then runs normally, so the user's last choice wins.
    let mut waited = 0;
    loop {
        {
            let mut s = state.lock().unwrap();
            if s.shutdown_tx.is_some() {
                // Already serving (e.g. after a webview reload): the settings are the source
                // of truth for the secret, so it follows them; the port and certificate stay.
                s.secret = secret;
                return Ok(status_from(&s, true));
            }
            if !s.starting {
                s.starting = true;
                s.stop_requested = false;
                break;
            }
        }
        waited += 1;
        if waited > 250 {
            return Err("Echo server is still starting".to_string());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _guard = StartingGuard(state.clone());

    let acceptor = Arc::new(crate::tls::ReloadingAcceptor::new(PathBuf::from(cert_path.trim()), PathBuf::from(key_path.trim()))?);
    let listener = TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("Could not listen on port {port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (tx, mut rx) = watch::channel(false);
    let (closed_tx, closed_rx) = oneshot::channel::<()>();
    let router = build_router(state.clone());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = rx.changed() => break,
                accepted = listener.accept() => {
                    let (stream, addr) = match accepted {
                        Ok(conn) => conn,
                        // E.g. out of file descriptors: retrying at once would spin a core.
                        Err(_) => {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        }
                    };
                    let acceptor = acceptor.current();
                    let router = router.clone().layer(Extension(Peer(addr.ip())));
                    let stop = rx.clone();
                    // One connection's handshake/serve failure must not stop the accept loop.
                    tokio::spawn(serve_connection(stream, acceptor, router, stop));
                }
            }
        }
        drop(listener);
        let _ = closed_tx.send(());
    });
    // Old converted files pile up otherwise (each re-tagged source adds another).
    let dir = cache_dir(&app);
    tokio::task::spawn_blocking(move || prune_cache(&dir, CACHE_MAX_AGE));

    let mut s = state.lock().unwrap();
    if s.stop_requested {
        // Switched off before it finished starting: shut the new listener down again.
        let _ = tx.send(true);
        return Ok(RemoteStatus { running: false, port: 0, transcode_available: crate::transcode::transcode_available() });
    }
    s.shutdown_tx = Some(tx);
    s.closed_rx = Some(closed_rx);
    s.port = port;
    s.secret = secret;
    s.app = app;
    Ok(status_from(&s, true))
}

/// A peer that connects and never finishes the TLS handshake, or never sends a
/// request's headers, must not hold a task and a file descriptor forever.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// How long an in-flight response may finish after the server is stopped.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Converted files older than this are deleted when the server starts.
const CACHE_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

async fn serve_connection(
    stream: tokio::net::TcpStream,
    acceptor: tokio_rustls::TlsAcceptor,
    router: Router,
    mut stop: watch::Receiver<bool>,
) {
    let Ok(Ok(tls)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await else { return };
    let service = hyper_util::service::TowerToHyperService::new(router);
    let mut builder = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
    builder
        .http1()
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(HEADER_READ_TIMEOUT);
    let conn = builder.serve_connection(hyper_util::rt::TokioIo::new(tls), service);
    tokio::pin!(conn);
    tokio::select! {
        _ = conn.as_mut() => {}
        // Stopping the server also ends connections an Echo left open (keep-alive).
        _ = stop.changed() => {
            conn.as_mut().graceful_shutdown();
            let _ = tokio::time::timeout(SHUTDOWN_GRACE, conn).await;
        }
    }
}

/// Deletes regular files in `dir` last modified more than `max_age` ago
/// (converted tracks, and `.part` files a crashed conversion left behind).
fn prune_cache(dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let age = meta.modified().ok().and_then(|m| m.elapsed().ok());
        if meta.is_file() && age.is_some_and(|a| a > max_age) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

pub async fn stop(state: Shared) -> Result<(), String> {
    let closed = {
        let mut s = state.lock().unwrap();
        if s.starting {
            s.stop_requested = true;
        }
        if let Some(tx) = s.shutdown_tx.take() {
            let _ = tx.send(true);
        }
        s.port = 0;
        s.app = None;
        // Don't serve a stale library after a restart.
        s.library = Library::default();
        s.closed_rx.take()
    };
    // Return only once the port is free again: a restart (new port or certificate)
    // binds it right away.
    if let Some(closed) = closed {
        let _ = tokio::time::timeout(Duration::from_secs(2), closed).await;
    }
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
    // One character can be a whole word in Japanese ("夏"), so it may still start a
    // name — but a one-character mishearing ("の") is a substring of half the
    // library, so it never matches in the middle.
    if query.chars().count() < 2 {
        return if target.starts_with(query) { 0.9 } else { 0.0 };
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

/// Where `key` lands in the shuffle for `seed`: a hash of both, so a track's
/// place relative to the others doesn't depend on how many tracks the playlist
/// has. A library push that adds or drops a track mid-session then nudges the
/// queue by one at most, instead of reshuffling everything (which a seeded
/// Fisher–Yates over the whole list would).
fn shuffle_rank(seed: u64, key: &str) -> u64 {
    let mut h = Sha256::new();
    h.update(seed.to_be_bytes());
    h.update(key.as_bytes());
    u64::from_be_bytes(h.finalize()[..8].try_into().expect("a SHA-256 digest has 32 bytes"))
}

/// The playlist's tracks in play order: as stored for `seed == 0`, otherwise
/// sorted by [`shuffle_rank`], so every request for the same (playlist, seed)
/// sees the same order — which is what lets the skill ask for track `i + 1`
/// later and get the one that follows.
fn play_order<T>(mut items: Vec<T>, seed: u64, key: impl Fn(&T) -> &str) -> Vec<T> {
    if seed != 0 {
        items.sort_by_cached_key(|t| (shuffle_rank(seed, key(t)), key(t).to_string()));
    }
    items
}

enum Pick {
    /// No playlist matched, or none of its tracks can be played.
    NoPlaylist,
    /// The queue ran out (`i` is past the last track).
    OutOfRange,
    Track { id: String, src: PathBuf, next: Option<(String, PathBuf)> },
}

/// The best-matching playlist's tracks as (key, candidate files), in stored
/// order; `None` if no playlist matches. Cheap and lock-friendly: no file I/O.
fn resolve_playlist(lib: &Library, list: &str) -> Option<Vec<(String, Vec<PathBuf>)>> {
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
    let (playlist, _) = best?;
    // Tracks that left the library since the last push are skipped, not played.
    Some(
        playlist
            .track_keys
            .iter()
            .filter_map(|k| lib.tracks.get(k).map(|paths| (k.clone(), paths.clone())))
            .collect(),
    )
}

/// Picks track `i` of the playlist in play order. Tracks with no file that
/// `exists` are skipped, so a moved or unmounted file doesn't end the queue.
/// Does file I/O (`exists`): call it off the async executor and off the lock.
fn pick_from(entries: Vec<(String, Vec<PathBuf>)>, i: usize, seed: u64, exists: impl Fn(&Path) -> bool) -> Pick {
    let playable: Vec<(String, PathBuf)> = entries
        .into_iter()
        .filter_map(|(key, paths)| paths.into_iter().find(|p| exists(p)).map(|p| (key, p)))
        .collect();
    if playable.is_empty() {
        return Pick::NoPlaylist;
    }
    let order = play_order(playable, seed, |(key, _)| key);
    let mut rest = order.into_iter().skip(i);
    let Some((id, src)) = rest.next() else { return Pick::OutOfRange };
    Pick::Track { id, src, next: rest.next() }
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
    let (entries, app) = {
        let s = state.lock().unwrap();
        if !verify_play(&s.secret, &q.list, q.i, q.seed, q.exp, &q.sig, now_secs()) {
            return text(StatusCode::FORBIDDEN, "Invalid or expired link");
        }
        (resolve_playlist(&s.library, &q.list), s.app.clone())
    };
    let started = std::time::Instant::now();
    let (i, seed) = (q.i, q.seed);
    // Stat-ing every track's file can be slow (a stalled network volume), so it
    // happens here, off the executor and without the library lock.
    let picked = match entries {
        None => Pick::NoPlaylist,
        Some(entries) => tokio::task::spawn_blocking(move || pick_from(entries, i, seed, |p| p.is_file()))
            .await
            .unwrap_or(Pick::NoPlaylist),
    };

    // The signature is deliberately kept out of the log line.
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

/// Converts `src` if needed, one conversion per track at a time. The lock and the
/// conversion run in their own task, so a client that hangs up (and drops its
/// request future) doesn't free the lock while `afconvert` is still writing: the
/// next request waits for it and then finds the finished file.
async fn playable_path(id: String, src: PathBuf, dir: PathBuf) -> Result<PathBuf, String> {
    let lock = transcode_lock(&id);
    tokio::spawn(async move {
        let _held = lock.lock_owned().await;
        tokio::task::spawn_blocking(move || ensure_playable(&src, &dir)).await.map_err(|e| e.to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

fn prefetch(id: String, src: PathBuf, dir: PathBuf) {
    if !src.is_file() {
        return;
    }
    tokio::spawn(async move {
        let _ = playable_path(id, src, dir).await;
    });
}

async fn serve_track(id: String, src: PathBuf, dir: PathBuf, req: Request) -> Response {
    let path = match playable_path(id.clone(), src, dir).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("echo track {id}: {e}");
            return text(StatusCode::INTERNAL_SERVER_ERROR, "Could not prepare audio");
        }
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
        let track = |key: &str| RemoteTrackIn { track_key: key.into(), file_paths: vec![path.into()] };
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
        assert_eq!(match_score("z", &t), 0.0, "one character is never a fragment from the middle of a name");
        assert_eq!(match_score("a", "a"), 1.0, "but it can be the name");
        assert_eq!(match_score(&normalize_for_search("夏"), &normalize_for_search("夏の歌")), 0.9, "or its first character");
        assert_eq!(match_score(&normalize_for_search("の"), &normalize_for_search("夏の歌")), 0.0);
    }

    fn order_of(keys: &[&str], seed: u64) -> Vec<String> {
        let items: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
        play_order(items, seed, |k| k.as_str())
    }

    #[test]
    fn shuffle_is_deterministic_per_seed_and_a_permutation() {
        let names: Vec<String> = (0..50).map(|n| format!("k{n}")).collect();
        let keys: Vec<&str> = names.iter().map(String::as_str).collect();
        let a = order_of(&keys, 42);
        assert_eq!(a, order_of(&keys, 42), "same seed, same order");
        assert_ne!(a, order_of(&keys, 43), "another seed, another order");
        assert_ne!(a, names, "shuffled");
        assert_eq!(order_of(&keys, 0), names, "seed 0 keeps the stored order");
        let (mut sorted, mut expect) = (a.clone(), names.clone());
        sorted.sort();
        expect.sort();
        assert_eq!(sorted, expect, "nothing lost or duplicated");
        assert!(order_of(&[], 7).is_empty());
    }

    #[test]
    fn dropping_or_adding_a_track_keeps_the_others_in_the_same_relative_order() {
        let names: Vec<String> = (0..40).map(|n| format!("k{n}")).collect();
        let all: Vec<&str> = names.iter().map(String::as_str).collect();
        let before = order_of(&all, 7);

        let without: Vec<&str> = all.iter().copied().filter(|k| *k != "k13").collect();
        let expect: Vec<String> = before.iter().filter(|k| *k != "k13").cloned().collect();
        assert_eq!(order_of(&without, 7), expect, "a removed track doesn't reshuffle the rest");

        let mut with_new = all.clone();
        with_new.push("brand-new");
        let after: Vec<String> = order_of(&with_new, 7).into_iter().filter(|k| k != "brand-new").collect();
        assert_eq!(after, before, "an added track doesn't reshuffle the rest");
    }

    fn id_of(p: Pick) -> String {
        match p {
            Pick::Track { id, .. } => id,
            Pick::NoPlaylist => "none".into(),
            Pick::OutOfRange => "end".into(),
        }
    }

    fn picked(l: &Library, list: &str, i: usize, seed: u64) -> Pick {
        match resolve_playlist(l, list) {
            Some(entries) => pick_from(entries, i, seed, |_| true),
            None => Pick::NoPlaylist,
        }
    }

    #[test]
    fn a_spoken_name_picks_the_playlist_and_skips_tracks_that_left_the_library() {
        let l = Library::build(lib("/music/a.mp3"));
        // "gone" isn't in the library, so the playlist is k1, k2, k3.
        assert_eq!(id_of(picked(&l, "ドライブ", 0, 0)), "k1");
        assert_eq!(id_of(picked(&l, "どらいぶ", 1, 0)), "k2");
        assert_eq!(id_of(picked(&l, "ドライブ", 2, 0)), "k3");
        assert_eq!(id_of(picked(&l, "ドライブ", 3, 0)), "end");
        assert_eq!(id_of(picked(&l, "ドライブ 夜", 0, 0)), "k3", "the exact name beats the prefix match");
        assert_eq!(id_of(picked(&l, "クラシック", 0, 0)), "none");
        assert_eq!(id_of(picked(&l, "Morning Jazz", 0, 0)), "none", "an empty playlist has nothing to play");
        // The next track is the one a later request for i + 1 will return.
        let Pick::Track { next, .. } = picked(&l, "ドライブ", 0, 99) else { panic!() };
        let Pick::Track { id: second, .. } = picked(&l, "ドライブ", 1, 99) else { panic!() };
        assert_eq!(next.unwrap().0, second);
    }

    #[test]
    fn files_that_are_gone_are_skipped_and_the_first_existing_copy_is_served() {
        let two_copies = |key: &str, paths: &[&str]| RemoteTrackIn {
            track_key: key.into(),
            file_paths: paths.iter().map(|p| p.to_string()).collect(),
        };
        let l = Library::build(RemoteLibraryIn {
            playlists: vec![RemotePlaylistIn { name: "Mix".into(), track_keys: vec!["a".into(), "b".into(), "c".into()] }],
            tracks: vec![
                two_copies("a", &["/gone/a.mp3", "/disk2/a.mp3"]),
                two_copies("b", &["/gone/b.mp3"]),
                two_copies("c", &["/disk2/c.mp3"]),
            ],
        });
        let exists = |p: &Path| p.starts_with("/disk2");
        let entries = || resolve_playlist(&l, "Mix").unwrap();

        let Pick::Track { id, src, next } = pick_from(entries(), 0, 0, exists) else { panic!() };
        assert_eq!((id.as_str(), src), ("a", PathBuf::from("/disk2/a.mp3")), "the copy that exists, not the first listed");
        assert_eq!(next.unwrap().0, "c", "b has no file anywhere, so it is skipped rather than ending the queue");
        assert_eq!(id_of(pick_from(entries(), 2, 0, exists)), "end");
        assert_eq!(id_of(pick_from(entries(), 0, 0, |_| false)), "none", "nothing playable at all");
    }

    #[test]
    fn prune_removes_only_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let (old, fresh) = (dir.path().join("old.m4a"), dir.path().join("fresh.m4a"));
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&fresh, b"x").unwrap();
        let long_ago = std::time::SystemTime::now() - Duration::from_secs(40 * 24 * 60 * 60);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(long_ago).unwrap();
        prune_cache(dir.path(), CACHE_MAX_AGE);
        assert!(!old.exists() && fresh.exists());
        prune_cache(&dir.path().join("missing"), CACHE_MAX_AGE); // no directory yet: nothing to do
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

        // The client above holds a keep-alive connection; stopping must end it, not leave it served.
        stop(state.clone()).await.unwrap();
        assert!(super::status(&state).is_none());
        tokio::time::sleep(Duration::from_millis(200)).await;
        let after = http.get(format!("https://127.0.0.1:{}{uri}", status.port)).send().await;
        assert!(after.is_err(), "a stopped server answers nothing, even on an already-open connection");
    }

    fn test_cert_files(dir: &Path) -> (String, String) {
        let key_pair = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string()]).unwrap().self_signed(&key_pair).unwrap();
        let (cert_path, key_path) = (dir.join("fullchain.pem"), dir.join("privkey.pem"));
        std::fs::write(&cert_path, cert.pem()).unwrap();
        std::fs::write(&key_path, key_pair.serialize_pem()).unwrap();
        (cert_path.to_string_lossy().to_string(), key_path.to_string_lossy().to_string())
    }

    #[tokio::test]
    async fn restarting_on_the_same_port_works_and_a_running_server_takes_the_new_secret() {
        let dir = tempfile::tempdir().unwrap();
        let (c, k) = test_cert_files(dir.path());
        let state = Arc::new(Mutex::new(RemoteServer::new()));

        let first = start(state.clone(), 0, "old".into(), c.clone(), k.clone(), None).await.unwrap();
        let again = start(state.clone(), 0, "new".into(), c.clone(), k.clone(), None).await.unwrap();
        assert_eq!(again.port, first.port, "already running: same server");
        assert_eq!(state.lock().unwrap().secret, "new", "but it follows the latest secret");

        // A port or certificate change is stop + start on the same port: stop must have freed it.
        stop(state.clone()).await.unwrap();
        let rebound = start(state.clone(), first.port, "new".into(), c, k, None).await.unwrap();
        assert_eq!(rebound.port, first.port);
        stop(state).await.unwrap();
    }

    #[tokio::test]
    async fn a_stop_during_a_start_is_remembered_and_a_second_start_waits_its_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (c, k) = test_cert_files(dir.path());
        let state = Arc::new(Mutex::new(RemoteServer::new()));

        // Pretend a start is in flight: stop can't undo it yet, so it leaves a note.
        state.lock().unwrap().starting = true;
        stop(state.clone()).await.unwrap();
        assert!(state.lock().unwrap().stop_requested);

        // A new start (the user switched it on again) waits for the in-flight one instead of failing …
        let waiting = tokio::spawn(start(state.clone(), 0, "s".into(), c, k, None));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!waiting.is_finished());
        // … and once that one is done, runs normally, with the old note cleared.
        state.lock().unwrap().starting = false;
        let status = waiting.await.unwrap().unwrap();
        assert!(status.running);
        assert!(!state.lock().unwrap().stop_requested);
        stop(state).await.unwrap();
    }
}
