//! LAN sync server (Mac side).
//!
//! The frontend pushes a [`SyncSnapshot`] (the playlists flagged "sync to device",
//! their tracks, and the full play-event log) via the `set_sync_snapshot` command.
//! The server just hands that snapshot and the referenced files to a paired Android
//! device over HTTP on the local network. Incoming play/favorite/podcast-progress
//! updates from the phone are queued in `inbox` for the frontend to drain and merge.

use axum::{
    body::Body,
    extract::{Path as AxumPath, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use local_ip_address::local_ip;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// Where the persisted TLS key pair lives. `app` is `None` in the headless
/// e2e server (no Tauri context), which falls back to a temp dir — that
/// server is thrown away between test runs anyway.
fn tls_identity_dir(app: Option<&AppHandle>) -> PathBuf {
    app.and_then(|a| a.path().app_local_data_dir().ok())
        .map(|d| d.join("sync-tls"))
        .unwrap_or_else(|| std::env::temp_dir().join("voynix-e2e-tls"))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SnapshotTrack {
    pub track_key: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub file_name: String,
    pub file_path: String,
    pub content_hash: String,
    /// Byte length of the file the phone will download (0 when unknown).
    #[serde(default)]
    pub size: i64,
    pub favorite: i64,
    pub favorite_updated_at: Option<i64>,
    /// "music" | "podcast" | "other". Defaults to "music" for older peers.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Disc / track numbers for the natural album order. Absent from older peers.
    #[serde(default)]
    pub disc_no: Option<i64>,
    #[serde(default)]
    pub track_no: Option<i64>,
    /// Podcast playback status: "unplayed" | "in_progress" | "played". LWW-synced
    /// via `play_state_updated_at`, same convention as `favorite_updated_at`.
    /// Defaults to "unplayed" for older peers.
    #[serde(default = "default_play_state")]
    pub play_state: String,
    /// Podcast only: seconds to resume from.
    #[serde(default)]
    pub resume_position: f64,
    #[serde(default)]
    pub play_state_updated_at: Option<i64>,
    /// When this track was first added on the sending device. Absent/null for
    /// older peers or rows never backfilled (see migration 11 in db/migrations.ts).
    #[serde(default)]
    pub added_at: Option<i64>,
}

fn default_kind() -> String {
    "music".to_string()
}

fn default_play_state() -> String {
    "unplayed".to_string()
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SnapshotPlaylist {
    pub id: String,
    pub name: String,
    /// "music" | "podcast" | "other". Defaults to "music" for older peers.
    #[serde(default = "default_kind")]
    pub kind: String,
    pub track_keys: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PlayEvent {
    pub track_key: String,
    pub played_at: i64,
    pub device_id: String,
}

/// A non-destructive per-album cover override (see `album_covers` in db.ts),
/// keyed by (artist, album) — not album alone, so two artists' self-titled (or
/// both-untagged) albums don't collide onto one cover.
/// `image_data_uri: None` means "cleared, use the default resolution again" —
/// LWW-merged by `updated_at`, same convention as `favorite_updated_at`.
#[derive(Clone, Serialize, Deserialize)]
pub struct AlbumCover {
    pub artist: String,
    pub album: String,
    pub image_data_uri: Option<String>,
    pub updated_at: i64,
}

/// A non-destructive per-artist image override (see `artist_covers` in db.ts),
/// same LWW-by-`updated_at` convention as [`AlbumCover`].
#[derive(Clone, Serialize, Deserialize)]
pub struct ArtistCover {
    pub artist: String,
    pub image_data_uri: Option<String>,
    pub updated_at: i64,
}

/// The desired state for a paired device. `file_path` is stripped before sending.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct SyncSnapshot {
    pub device_id: String,
    pub generated_at: i64,
    pub playlists: Vec<SnapshotPlaylist>,
    pub tracks: Vec<SnapshotTrack>,
    pub play_events: Vec<PlayEvent>,
    /// Absent from older peers.
    #[serde(default)]
    pub album_covers: Vec<AlbumCover>,
    /// Absent from older peers.
    #[serde(default)]
    pub artist_covers: Vec<ArtistCover>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct IncomingEvent {
    pub track_key: String,
    pub played_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FavoriteUpdate {
    pub track_key: String,
    pub favorite: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PlayStateUpdate {
    pub track_key: String,
    pub play_state: String,
    pub resume_position: f64,
    pub updated_at: i64,
}

/// Play/favorite/podcast-progress changes pushed up by a paired device, queued
/// for the frontend.
#[derive(Clone, Serialize, Deserialize)]
pub struct IncomingStats {
    pub device_id: String,
    #[serde(default)]
    pub events: Vec<IncomingEvent>,
    #[serde(default)]
    pub favorites: Vec<FavoriteUpdate>,
    #[serde(default)]
    pub play_states: Vec<PlayStateUpdate>,
}

/// mDNS service type the phone browses for to find a Mac without typing an IP.
pub const MDNS_SERVICE_TYPE: &str = "_voynix._tcp.local.";

/// How long a phone's `POST /pair` waits for the Mac's owner to approve or deny
/// before the request gives up.
const PAIR_APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);

/// `POST /pair` is unauthenticated (anyone on the LAN can send it) and each
/// request raises a modal approve/deny prompt on the Mac, so only one may wait
/// at a time — otherwise a host could stack prompts and hope for a stray
/// "Allow" — and a declined request is followed by a short cooldown.
const MAX_PENDING_PAIRS: usize = 1;
const PAIR_DECLINE_COOLDOWN: Duration = Duration::from_secs(10);
/// The device name is attacker-controlled text shown in the approval prompt.
const MAX_DEVICE_NAME_CHARS: usize = 40;

static NEXT_PAIR_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, PartialEq, Eq)]
enum PairAdmission {
    Admit,
    /// Another request is already waiting on the owner.
    Busy,
    /// The previous request was declined moments ago.
    CoolingDown,
}

fn pair_admission(pending: usize, declined_at: Option<Instant>, now: Instant) -> PairAdmission {
    if pending >= MAX_PENDING_PAIRS {
        PairAdmission::Busy
    } else if declined_at.is_some_and(|t| now.saturating_duration_since(t) < PAIR_DECLINE_COOLDOWN) {
        PairAdmission::CoolingDown
    } else {
        PairAdmission::Admit
    }
}

/// Invisible formatting characters (zero-width, bidi overrides/isolates, BOM)
/// that could disguise or reorder the text shown in the approval prompt.
fn is_invisible_format_char(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// Drops control and invisible formatting characters (no newlines/RTL tricks in
/// the prompt), collapses whitespace and caps the length; empty falls back to
/// a generic label.
fn sanitize_device_name(raw: Option<String>) -> String {
    let cleaned: String = raw
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() && !is_invisible_format_char(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let capped: String = cleaned.chars().take(MAX_DEVICE_NAME_CHARS).collect();
    if capped.is_empty() { "An Android device".to_string() } else { capped }
}

/// Removes a waiting `POST /pair` from `pending_pairs` when its handler future
/// ends — including being dropped because the phone disconnected, which would
/// otherwise skip any cleanup after the `.await` and leave a stale entry.
struct PendingPairGuard {
    state: Shared,
    id: u64,
}

impl Drop for PendingPairGuard {
    fn drop(&mut self) {
        if let Ok(mut s) = self.state.lock() {
            s.pending_pairs.remove(&self.id);
        }
    }
}

/// Everything the phone needs once the Mac's owner approves a pairing request.
#[derive(Serialize, Deserialize, Clone)]
pub struct PairGranted {
    pub url: String,
    pub token: String,
    /// SHA-256 of the server's TLS public key (SPKI), lowercase hex. The phone
    /// pins this — see `tls.rs` for why it's the key and not the certificate.
    pub fingerprint: String,
}

#[derive(Deserialize)]
struct PairRequestBody {
    #[serde(default)]
    device_name: Option<String>,
}

/// Emitted to the Mac frontend so it can show an approve/deny prompt.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PairPrompt {
    id: u64,
    device_name: String,
    /// Short, human-comparable form of the server's TLS fingerprint (see
    /// `tls::short_fingerprint`) so the owner can check it against what's
    /// shown on the phone before tapping "Allow".
    fingerprint: String,
}

pub struct SyncServer {
    shutdown_tx: Option<oneshot::Sender<()>>,
    /// Set for the duration of `start()`'s async setup (socket bind, TLS,
    /// mDNS publish). `shutdown_tx.is_some()` alone can't guard against two
    /// concurrent `start()` calls (e.g. React StrictMode double-invoking the
    /// autostart effect in dev) racing each other during that gap — both
    /// would see it as `None`, both would bind a port and register an mDNS
    /// service, and the second registration would collide with and get
    /// mDNS-renamed to "Voynix (2)".
    starting: bool,
    pub port: u16,
    pub ip: String,
    token: String,
    snapshot: Option<SyncSnapshot>,
    inbox: Vec<IncomingStats>,
    activity: Activity,
    /// Live mDNS advertisement; dropped/shut down when the server stops.
    mdns: Option<ServiceDaemon>,
    /// Handle for emitting pairing prompts to the frontend. `None` in the
    /// headless e2e server, where there's no UI to approve from.
    app: Option<AppHandle>,
    /// In-flight `POST /pair` requests waiting on the owner's decision.
    pending_pairs: HashMap<u64, oneshot::Sender<bool>>,
    /// When the owner last declined a pairing request (see `PAIR_DECLINE_COOLDOWN`).
    pair_declined_at: Option<Instant>,
    /// SHA-256 of the current TLS identity's SPKI, lowercase hex. Shown to the
    /// user so they can visually compare it against what the phone observes.
    fingerprint: String,
}

#[derive(Default, Clone, Serialize)]
pub struct Activity {
    /** Epoch ms of the last /api/manifest request. */
    pub last_manifest_at: Option<i64>,
    /** Epoch ms of the last /api/sync/stats push. */
    pub last_stats_at: Option<i64>,
    /** device_ids of peers that have pushed stats this session. */
    pub peers: Vec<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl SyncServer {
    pub fn new() -> Self {
        Self {
            shutdown_tx: None,
            starting: false,
            port: 0,
            ip: String::new(),
            token: String::new(),
            snapshot: None,
            inbox: Vec::new(),
            activity: Activity::default(),
            mdns: None,
            app: None,
            pending_pairs: HashMap::new(),
            pair_declined_at: None,
            fingerprint: String::new(),
        }
    }

    pub fn set_snapshot(&mut self, snapshot: SyncSnapshot) {
        self.snapshot = Some(snapshot);
    }

    pub fn take_inbox(&mut self) -> Vec<IncomingStats> {
        std::mem::take(&mut self.inbox)
    }

    /// Puts items the frontend failed to apply back at the front of the inbox
    /// (ahead of anything pushed meanwhile) so the next drain retries them.
    pub fn requeue_inbox(&mut self, items: Vec<IncomingStats>) {
        self.inbox.splice(0..0, items);
    }

    pub fn activity(&self) -> Activity {
        self.activity.clone()
    }

    /// Withdraws the mDNS advertisement, blocking until the "goodbye" packets
    /// are sent. Called on app exit (see `lib.rs`'s `RunEvent::Exit` handler)
    /// so quitting the app doesn't leave a stale "Voynix" entry in other
    /// devices' mDNS caches to collide with the next launch's registration.
    pub fn shutdown_mdns(&mut self) {
        if let Some(daemon) = self.mdns.take() {
            shutdown_mdns_blocking(daemon);
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ServerStatus {
    pub running: bool,
    pub ip: String,
    pub port: u16,
    pub url: String,
    pub token: String,
    /// SHA-256 of the server's TLS public key (SPKI), lowercase hex. Shown
    /// next to the pairing UI so the user can compare it against what the
    /// phone observed during its own TLS handshake.
    pub fingerprint: String,
    /// False on a non-Mac host: no `afconvert`, so ALAC/AIFF/etc. sources are
    /// served untranscoded and Android won't be able to play them.
    pub transcode_available: bool,
}

type Shared = Arc<Mutex<SyncServer>>;

fn build_router(state: Shared) -> Router {
    let api = Router::new()
        .route("/manifest", get(get_manifest))
        .route("/file/:key", get(get_file))
        .route("/artwork/:key", get(get_artwork))
        .route("/album-art/:key", get(get_album_art))
        .route("/sync/stats", post(post_stats))
        // Cheap auth-gated liveness check the Android client uses to
        // re-validate a saved peer URL before falling back to mDNS rediscovery.
        .route("/ping", get(|| async { StatusCode::NO_CONTENT }))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth));

    Router::new()
        .route("/", get(serve_index))
        // Unauthenticated by design: this is how a phone *gets* the token, gated
        // by the Mac owner tapping "Allow" on the prompt it triggers.
        .route("/pair", post(post_pair))
        .nest("/api", api)
        .with_state(state)
}

/// The LAN address to advertise, or `None` when there isn't one right now (Wi-Fi
/// dropped, no interface up). Callers decide what that means: `start()` falls back
/// to loopback so the server still comes up, while the IP poller must *keep* the
/// last good address — a transient failure there used to rewrite it to 127.0.0.1,
/// which the pairing URL and QR code then handed to phones.
async fn get_local_ip() -> Option<String> {
    local_ip().ok().map(|ip| ip.to_string())
}

/// What the periodic IP check should do with the address it just read: the new
/// address to re-advertise under, or `None` to leave everything alone.
fn ip_republish_target(running: bool, known_ip: &str, current_ip: Option<String>) -> Option<String> {
    // A tick can be waiting on the state lock while `stop()` tears the server
    // down; acting on it afterwards would advertise a server that no longer exists.
    if !running {
        return None;
    }
    current_ip.filter(|ip| !ip.is_empty() && ip != known_ip)
}

/// Advertise this server over mDNS as `_voynix._tcp.local.` so the phone can find
/// it without the user typing the LAN IP. Best-effort — a failure here just means
/// the phone falls back to manual entry.
fn mdns_service_info(ip: &str, port: u16, fingerprint: &str) -> Result<ServiceInfo, String> {
    // The fingerprint TXT record is a discovery hint only — mDNS TXT records
    // aren't authenticated, so it can save a phone a failed connection but
    // must never be trusted as the pin itself (that comes from `/pair`'s
    // response body, over the TLS connection being pinned).
    ServiceInfo::new(
        MDNS_SERVICE_TYPE,
        "Voynix",
        "voynix.local.",
        ip,
        port,
        &[("path", "/api"), ("fp", fingerprint)][..],
    )
    .map_err(|e| e.to_string())
}

fn publish_mdns(ip: &str, port: u16, fingerprint: &str) -> Result<ServiceDaemon, String> {
    let daemon = ServiceDaemon::new().map_err(|e| e.to_string())?;
    // mdns-sd advertises on every multicast-capable interface by default —
    // on macOS that includes AWDL, internal bridges, VPN utuns, etc. alongside
    // the real Wi-Fi/Ethernet interface. Each of those ends up registering the
    // same instance name and colliding with itself, so the daemon renames the
    // later ones to "Voynix (2)", "Voynix (3)", ... and a phone on the actual
    // LAN sees duplicate/confusing entries. Restrict advertising to just the
    // interface matching the IP we're actually telling the phone to connect to.
    if let Ok(addr) = ip.parse::<std::net::IpAddr>() {
        daemon
            .disable_interface(mdns_sd::IfKind::All)
            .map_err(|e| e.to_string())?;
        daemon
            .enable_interface(mdns_sd::IfKind::Addr(addr))
            .map_err(|e| e.to_string())?;
    }
    daemon
        .register(mdns_service_info(ip, port, fingerprint)?)
        .map_err(|e| e.to_string())?;
    Ok(daemon)
}

fn status_from(server: &SyncServer, running: bool) -> ServerStatus {
    let url = format!("https://{}:{}", server.ip, server.port);
    ServerStatus {
        running,
        ip: server.ip.clone(),
        port: server.port,
        url,
        token: server.token.clone(),
        fingerprint: server.fingerprint.clone(),
        transcode_available: crate::transcode::transcode_available(),
    }
}

/// Clears `starting` when dropped, so a bind/TLS/mDNS failure (an early `?`
/// return) can't leave the server permanently stuck refusing to start.
struct StartingGuard(Shared);
impl Drop for StartingGuard {
    fn drop(&mut self) {
        self.0.lock().unwrap().starting = false;
    }
}

pub async fn start(
    state: Shared,
    token: String,
    app: Option<AppHandle>,
    preferred_port: Option<u16>,
) -> Result<ServerStatus, String> {
    {
        let mut server = state.lock().unwrap();
        if server.shutdown_tx.is_some() {
            return Ok(status_from(&server, true));
        }
        if server.starting {
            return Err("Sync server is already starting".to_string());
        }
        server.starting = true;
    }
    let _starting_guard = StartingGuard(state.clone());

    let ip = get_local_ip().await.unwrap_or_else(|| "127.0.0.1".to_string());
    // Reuse the last port we bound so a paired phone's saved URL survives a Mac
    // restart. Best-effort: if it's taken (another instance, a race with another
    // app), fall back to an ephemeral port like before.
    let listener = match preferred_port.filter(|p| *p != 0) {
        Some(p) => match TcpListener::bind(("0.0.0.0", p)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?,
        },
        None => TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let identity = crate::tls::load_or_create(&tls_identity_dir(app.as_ref()), &ip)?;
    let acceptor = tokio_rustls::TlsAcceptor::from(identity.config);

    let (tx, rx) = oneshot::channel();
    let router = build_router(state.clone());
    let ip_check_state = state.clone();

    tokio::spawn(async move {
        let mut rx = rx;
        // The listener binds "0.0.0.0" so it keeps accepting across an IP
        // change on its own; only the *advertised* address (mDNS, the URL
        // shown to the user) goes stale, since `start()` only reads the IP
        // once. Re-check periodically and re-publish mDNS under the new
        // address so a Wi-Fi network switch doesn't quietly strand the
        // server at an IP nobody can reach anymore (this is what made the
        // Mac briefly "disappear" from Android's discovery after an AP
        // change). Not `select!`-driven by network-change events because
        // std has no cross-platform notification for that; polling is the
        // simplest thing that works.
        let mut ip_check = tokio::time::interval(std::time::Duration::from_secs(15));
        ip_check.tick().await; // first tick fires immediately; skip it
        loop {
            tokio::select! {
                _ = &mut rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    let acceptor = acceptor.clone();
                    let router = router.clone();
                    // A single connection's handshake/serve failure must not
                    // kill the accept loop for every other client.
                    tokio::spawn(async move {
                        let Ok(tls_stream) = acceptor.accept(stream).await else { return };
                        let service = hyper_util::service::TowerToHyperService::new(router);
                        let _ = hyper_util::server::conn::auto::Builder::new(
                            hyper_util::rt::TokioExecutor::new(),
                        )
                        .serve_connection(hyper_util::rt::TokioIo::new(tls_stream), service)
                        .await;
                    });
                }
                _ = ip_check.tick() => {
                    let current_ip = get_local_ip().await;
                    let republish = {
                        let mut server = ip_check_state.lock().unwrap();
                        match ip_republish_target(server.shutdown_tx.is_some(), &server.ip, current_ip) {
                            None => None,
                            Some(new_ip) => {
                                server.ip = new_ip.clone();
                                Some((new_ip, server.port, server.fingerprint.clone(), server.mdns.take()))
                            }
                        }
                    };
                    let Some((current_ip, port, fingerprint, old_daemon)) = republish else { continue };
                    if let Some(old) = old_daemon {
                        shutdown_mdns_blocking(old);
                    }
                    match publish_mdns(&current_ip, port, &fingerprint) {
                        Ok(new_daemon) => {
                            ip_check_state.lock().unwrap().mdns = Some(new_daemon);
                        }
                        Err(e) => eprintln!("mDNS re-advertise after IP change failed: {e}"),
                    }
                }
            }
        }
    });

    let mdns = publish_mdns(&ip, port, &identity.fingerprint)
        .map_err(|e| eprintln!("mDNS advertise failed: {e}"))
        .ok();

    let status = {
        let mut server = state.lock().unwrap();
        server.shutdown_tx = Some(tx);
        server.port = port;
        server.ip = ip;
        server.token = token;
        server.mdns = mdns;
        server.app = app;
        server.fingerprint = identity.fingerprint;
        status_from(&server, true)
    };

    Ok(status)
}

/// The live server state, so the frontend can re-sync its view after a reload
/// (webview HMR drops React state while the Rust server keeps running).
pub fn status(state: &Shared) -> Option<ServerStatus> {
    let s = state.lock().unwrap();
    s.shutdown_tx.is_some().then(|| status_from(&s, true))
}

/// Shuts a daemon down and blocks until it confirms, so the mDNS "goodbye"
/// (TTL=0) packets are actually on the wire before the caller moves on —
/// discarding `shutdown()`'s receiver lets the process (or the app) exit
/// before the daemon's background thread gets scheduled, leaving other
/// mDNS caches (including the phone's) holding a stale "Voynix" entry that
/// then collides with — and gets renamed by — the next run's registration.
fn shutdown_mdns_blocking(daemon: ServiceDaemon) {
    if let Ok(rx) = daemon.shutdown() {
        let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
    }
}

pub async fn stop(state: Shared) -> Result<(), String> {
    let mut server = state.lock().unwrap();
    if let Some(tx) = server.shutdown_tx.take() {
        let _ = tx.send(());
    }
    server.port = 0;
    server.ip = String::new();
    if let Some(daemon) = server.mdns.take() {
        shutdown_mdns_blocking(daemon);
    }
    // Drop any senders for in-flight pair requests; their handlers unblock and
    // return a timeout to the phone.
    server.pending_pairs.clear();
    server.app = None;
    server.fingerprint = String::new();
    // Don't serve a stale manifest or replay stale inbox items after a restart.
    server.snapshot = None;
    server.inbox.clear();
    server.activity = Activity::default();
    Ok(())
}

async fn auth(State(state): State<Shared>, headers: HeaderMap, req: Request, next: Next) -> Response {
    let token = { state.lock().unwrap().token.clone() };
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));

    // `ConstantTimeEq` still short-circuits on a length mismatch (that only
    // leaks the token's length, not its content), then compares in time
    // independent of *where* the bytes differ.
    match provided {
        Some(p)
            if !token.is_empty()
                && p.len() == token.len()
                && bool::from(p.as_bytes().ct_eq(token.as_bytes())) =>
        {
            next.run(req).await
        }
        _ => (StatusCode::UNAUTHORIZED, "Unauthorized").into_response(),
    }
}

async fn serve_index() -> Html<&'static str> {
    // Unauthenticated: reveal nothing about the library.
    Html(
        "<!doctype html><meta charset=utf-8><title>Voynix Sync</title>\
         <body style=\"font-family:system-ui;background:#1a1a1a;color:#eee;padding:2rem\">\
         <h1>Voynix Sync</h1>\
         <p>Pair from the Voynix app on your Android device.</p></body>",
    )
}

/// Copy of the snapshot with host-only fields (absolute paths) removed.
fn sanitize_snapshot(snap: &SyncSnapshot) -> SyncSnapshot {
    SyncSnapshot {
        device_id: snap.device_id.clone(),
        generated_at: snap.generated_at,
        playlists: snap.playlists.clone(),
        tracks: snap
            .tracks
            .iter()
            .map(|t| SnapshotTrack {
                file_path: String::new(),
                ..t.clone()
            })
            .collect(),
        play_events: snap.play_events.clone(),
        album_covers: snap.album_covers.clone(),
        artist_covers: snap.artist_covers.clone(),
    }
}

async fn get_manifest(State(state): State<Shared>) -> Response {
    // Clone out of the lock so serialization doesn't block auth / other requests.
    let snapshot = {
        let mut s = state.lock().unwrap();
        s.activity.last_manifest_at = Some(now_ms());
        s.snapshot.clone()
    };
    match snapshot {
        Some(snap) => Json(sanitize_snapshot(&snap)).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "No snapshot yet").into_response(),
    }
}

fn file_path_for(state: &Shared, key: &str) -> Option<String> {
    let s = state.lock().unwrap();
    s.snapshot.as_ref().and_then(|snap| {
        snap.tracks
            .iter()
            .find(|t| t.track_key == key)
            .map(|t| t.file_path.clone())
    })
}

async fn get_file(
    State(state): State<Shared>,
    AxumPath(key): AxumPath<String>,
    req: Request,
) -> Response {
    let Some(path) = file_path_for(&state, &key) else {
        return (StatusCode::NOT_FOUND, "Unknown track").into_response();
    };
    let path = PathBuf::from(path);
    if !path.is_file() {
        return (StatusCode::NOT_FOUND, "File missing on host").into_response();
    }
    // ServeFile streams via tokio::fs and handles Content-Type, Range and 206.
    match ServeFile::new(&path).oneshot(req).await {
        Ok(res) => res.map(Body::new).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "Read error").into_response(),
    }
}

async fn get_artwork(State(state): State<Shared>, AxumPath(key): AxumPath<String>) -> Response {
    let Some(path) = file_path_for(&state, &key) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Tag parsing is blocking; keep it off the async runtime threads.
    let art = tokio::task::spawn_blocking(move || crate::read_embedded_artwork(Path::new(&path)))
        .await
        .ok()
        .flatten();
    match art {
        Some((mime, bytes)) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Serves a resolved album cover from the Mac's `artwork/<key>.jpg` cache —
/// the same cache `ensure_album_art`/`fetch_album_art` (metadata.rs) populate.
/// `key` is `metadata::cache_key(&[artist, album])`, computed identically on
/// both ends so this never needs the manifest to look anything up.
async fn get_album_art(State(state): State<Shared>, AxumPath(key): AxumPath<String>) -> Response {
    // `key` is always a lowercase hex SHA-256 digest (see `metadata::cache_key`).
    // Reject anything else before it reaches the filesystem join below — axum
    // percent-decodes path segments, so an unvalidated `key` could otherwise
    // carry `../` or an absolute path out of the artwork cache dir.
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let app = { state.lock().unwrap().app.clone() };
    let Some(app) = app else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = match crate::metadata::cache_subdir(&app, "artwork") {
        Ok(dir) => dir.join(format!("{key}.jpg")),
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn post_stats(State(state): State<Shared>, Json(payload): Json<IncomingStats>) -> Response {
    let mut s = state.lock().unwrap();
    s.activity.last_stats_at = Some(now_ms());
    if !s.activity.peers.contains(&payload.device_id) {
        s.activity.peers.push(payload.device_id.clone());
    }
    s.inbox.push(payload);
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// A phone that found this Mac over mDNS calls this to pair without anyone typing
/// a code: it blocks while the Mac's owner approves or denies the on-screen
/// prompt, then returns the bearer token (or 403 / 408).
async fn post_pair(State(state): State<Shared>, Json(body): Json<PairRequestBody>) -> Response {
    let device_name = sanitize_device_name(body.device_name);

    let id = NEXT_PAIR_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel::<bool>();

    let (app, url, fingerprint) = {
        let mut s = state.lock().unwrap();
        if s.token.is_empty() {
            return (StatusCode::SERVICE_UNAVAILABLE, "Server not ready").into_response();
        }
        match pair_admission(s.pending_pairs.len(), s.pair_declined_at, Instant::now()) {
            PairAdmission::Admit => {}
            PairAdmission::Busy => {
                return (StatusCode::TOO_MANY_REQUESTS, "Another pairing request is already waiting").into_response();
            }
            PairAdmission::CoolingDown => {
                return (StatusCode::TOO_MANY_REQUESTS, "Pairing was just declined. Try again shortly").into_response();
            }
        }
        s.pending_pairs.insert(id, tx);
        (s.app.clone(), format!("https://{}:{}", s.ip, s.port), s.fingerprint.clone())
    };
    let _pending = PendingPairGuard { state: state.clone(), id };

    let Some(app) = app else {
        // Headless server (e2e): no UI to approve from.
        return (StatusCode::NOT_IMPLEMENTED, "No approval UI on this host").into_response();
    };
    let prompt = PairPrompt { id, device_name, fingerprint: crate::tls::short_fingerprint(&fingerprint) };
    let _ = app.emit("sync-pair-request", prompt);

    let decision = tokio::time::timeout(PAIR_APPROVAL_TIMEOUT, rx).await;

    match decision {
        Ok(Ok(true)) => {
            let token = state.lock().unwrap().token.clone();
            Json(PairGranted { url, token, fingerprint }).into_response()
        }
        Ok(Ok(false)) => {
            state.lock().unwrap().pair_declined_at = Some(Instant::now());
            (StatusCode::FORBIDDEN, "Pairing request declined").into_response()
        }
        // Timed out, or the server stopped and dropped the sender.
        _ => (StatusCode::REQUEST_TIMEOUT, "Pairing request timed out").into_response(),
    }
}

/// Deliver the owner's approve/deny decision to a waiting `POST /pair` handler.
pub fn respond_pairing(state: &Shared, id: u64, approve: bool) -> Result<(), String> {
    let tx = state.lock().unwrap().pending_pairs.remove(&id);
    match tx {
        Some(tx) => {
            let _ = tx.send(approve);
            Ok(())
        }
        None => Err("That pairing request is no longer waiting (it may have timed out).".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mdns_service_info_is_well_formed() {
        let info = mdns_service_info("192.168.1.42", 5599, "deadbeef").expect("valid service info");
        assert_eq!(info.get_type(), MDNS_SERVICE_TYPE);
        assert_eq!(info.get_port(), 5599);
        assert!(info.get_fullname().starts_with("Voynix."));
        assert_eq!(info.get_property_val_str("fp"), Some("deadbeef"));
    }

    fn sample_snapshot() -> SyncSnapshot {
        SyncSnapshot {
            device_id: "mac-1".into(),
            generated_at: 1,
            playlists: vec![SnapshotPlaylist {
                id: "p1".into(),
                name: "Car".into(),
                kind: "music".into(),
                track_keys: vec!["k1".into()],
            }],
            tracks: vec![SnapshotTrack {
                track_key: "k1".into(),
                title: "Song".into(),
                artist: None,
                album: None,
                duration: None,
                file_name: "song.mp3".into(),
                file_path: "/Users/me/Music/song.mp3".into(),
                content_hash: "h".into(),
                size: 0,
                favorite: 0,
                favorite_updated_at: None,
                kind: "music".into(),
                disc_no: None,
                track_no: None,
                play_state: "unplayed".into(),
                resume_position: 0.0,
                play_state_updated_at: None,
                added_at: None,
            }],
            play_events: vec![],
            album_covers: vec![],
            artist_covers: vec![],
        }
    }

    #[test]
    fn sanitize_strips_absolute_paths() {
        let clean = sanitize_snapshot(&sample_snapshot());
        assert_eq!(clean.tracks[0].file_path, "");
        assert_eq!(clean.tracks[0].track_key, "k1");
        assert_eq!(clean.playlists[0].track_keys, vec!["k1".to_string()]);
    }

    #[test]
    fn requeue_puts_items_back_ahead_of_newer_ones() {
        let mut srv = SyncServer::new();
        let item = |id: &str| IncomingStats {
            device_id: id.into(),
            events: vec![],
            favorites: vec![],
            play_states: vec![],
        };
        srv.inbox.push(item("newer"));
        srv.requeue_inbox(vec![item("failed")]);
        let got = srv.take_inbox();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].device_id, "failed");
        assert_eq!(got[1].device_id, "newer");
    }

    #[test]
    fn inbox_take_drains() {
        let mut srv = SyncServer::new();
        srv.set_snapshot(sample_snapshot());
        srv.inbox.push(IncomingStats {
            device_id: "phone-1".into(),
            events: vec![IncomingEvent { track_key: "k1".into(), played_at: 5 }],
            favorites: vec![],
            play_states: vec![],
        });
        assert_eq!(srv.take_inbox().len(), 1);
        assert_eq!(srv.take_inbox().len(), 0);
    }

    #[test]
    fn status_is_none_until_started() {
        let shared = Arc::new(Mutex::new(SyncServer::new()));
        assert!(status(&shared).is_none());
    }

    /// An older peer's JSON predates the podcast fields entirely. `#[serde(default)]`
    /// must fill them in rather than fail deserialization.
    #[test]
    fn old_peer_json_defaults_missing_play_state_fields() {
        let track: SnapshotTrack = serde_json::from_str(
            r#"{"track_key":"k1","title":"Song","artist":null,"album":null,
                "duration":null,"file_name":"song.mp3","file_path":"/x/song.mp3",
                "content_hash":"h","favorite":0,"favorite_updated_at":null}"#,
        )
        .unwrap();
        assert_eq!(track.play_state, "unplayed");
        assert_eq!(track.resume_position, 0.0);
        assert_eq!(track.play_state_updated_at, None);

        let stats: IncomingStats = serde_json::from_str(
            r#"{"device_id":"phone-1","events":[],"favorites":[]}"#,
        )
        .unwrap();
        assert!(stats.play_states.is_empty());
    }

    // --- HTTP contract (router driven directly, no socket) ---

    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn serving(token: &str, snap: SyncSnapshot) -> Shared {
        let s = Arc::new(Mutex::new(SyncServer::new()));
        {
            let mut g = s.lock().unwrap();
            g.token = token.into();
            g.set_snapshot(snap);
        }
        s
    }

    async fn body_string(resp: axum::response::Response) -> String {
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        String::from_utf8_lossy(&bytes).to_string()
    }

    #[tokio::test]
    async fn manifest_requires_the_token_and_strips_paths() {
        let state = serving("secret", sample_snapshot());
        let app = build_router(state);

        let unauthed = app
            .clone()
            .oneshot(Request::get("/api/manifest").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(unauthed.status(), StatusCode::UNAUTHORIZED);

        let wrong = app
            .clone()
            .oneshot(
                Request::get("/api/manifest")
                    .header("authorization", "Bearer nope")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);

        let ok = app
            .oneshot(
                Request::get("/api/manifest")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let json = body_string(ok).await;
        assert!(json.contains("\"track_key\":\"k1\""));
        assert!(json.contains("\"file_path\":\"\""));
        assert!(!json.contains("/Users/me/Music"));
    }

    #[tokio::test]
    async fn file_endpoint_serves_bytes_and_honours_range() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("song.mp3");
        std::fs::write(&path, b"0123456789").unwrap();

        let mut snap = sample_snapshot();
        snap.tracks[0].file_path = path.to_string_lossy().to_string();
        let app = build_router(serving("secret", snap));

        let full = app
            .clone()
            .oneshot(
                Request::get("/api/file/k1")
                    .header("authorization", "Bearer secret")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(body_string(full).await, "0123456789");

        let ranged = app
            .oneshot(
                Request::get("/api/file/k1")
                    .header("authorization", "Bearer secret")
                    .header("range", "bytes=2-5")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(body_string(ranged).await, "2345");
    }

    #[tokio::test]
    async fn stats_endpoint_queues_the_inbox() {
        let state = serving("secret", sample_snapshot());
        let app = build_router(state.clone());

        let resp = app
            .oneshot(
                Request::post("/api/sync/stats")
                    .header("authorization", "Bearer secret")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"device_id":"phone-1","events":[{"track_key":"k1","played_at":9}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let mut g = state.lock().unwrap();
        assert_eq!(g.activity.peers, vec!["phone-1".to_string()]);
        assert!(g.activity.last_stats_at.is_some());
        assert_eq!(g.take_inbox().len(), 1);
    }

    /// Full round-trip over a real TCP socket: start the server, then drive it
    /// with a real HTTP client the way the Android side does (bearer auth,
    /// manifest, ranged file GET, stats push). Catches bind/serve/reqwest
    /// interplay the `oneshot` contract tests can't.
    #[tokio::test]
    async fn real_socket_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let song_a = dir.path().join("a.flac");
        let song_b = dir.path().join("b.mp3");
        std::fs::write(&song_a, b"AAAAAAAAAA-song-a-bytes").unwrap();
        std::fs::write(&song_b, vec![7u8; 5000]).unwrap();

        let hash_a = crate::compute_content_hash(&song_a).unwrap();
        let hash_b = crate::compute_content_hash(&song_b).unwrap();

        let mut snap = sample_snapshot();
        snap.tracks = vec![
            SnapshotTrack {
                track_key: "key-a".into(),
                title: "A".into(),
                artist: None,
                album: None,
                duration: None,
                file_name: "a.flac".into(),
                file_path: song_a.to_string_lossy().to_string(),
                content_hash: hash_a.clone(),
                size: 22,
                favorite: 0,
                favorite_updated_at: None,
                kind: "music".into(),
                disc_no: None,
                track_no: None,
                play_state: "unplayed".into(),
                resume_position: 0.0,
                play_state_updated_at: None,
                added_at: None,
            },
            SnapshotTrack {
                track_key: "key-b".into(),
                title: "B".into(),
                artist: None,
                album: None,
                duration: None,
                file_name: "b.mp3".into(),
                file_path: song_b.to_string_lossy().to_string(),
                content_hash: hash_b.clone(),
                size: 5000,
                favorite: 0,
                favorite_updated_at: None,
                kind: "music".into(),
                disc_no: None,
                track_no: None,
                play_state: "unplayed".into(),
                resume_position: 0.0,
                play_state_updated_at: None,
                added_at: None,
            },
        ];
        snap.playlists = vec![SnapshotPlaylist {
            id: "p1".into(),
            name: "Car".into(),
            kind: "music".into(),
            track_keys: vec!["key-a".into(), "key-b".into()],
        }];

        let state = Arc::new(Mutex::new(SyncServer::new()));
        {
            let mut g = state.lock().unwrap();
            g.set_snapshot(snap);
        }
        let status = start(state.clone(), "tok-123".into(), None, None).await.unwrap();
        assert_eq!(status.fingerprint.len(), 64, "fingerprint should be a SHA-256 hex digest");
        assert!(status.url.starts_with("https://"), "sync must not fall back to plaintext");
        let root = format!("https://127.0.0.1:{}", status.port);
        // The server's cert is self-signed; a real client pins the SPKI
        // fingerprint instead of validating the chain (see `tls.rs`).
        let http = reqwest::Client::builder().danger_accept_invalid_certs(true).build().unwrap();

        // Wrong token is rejected.
        let bad = http
            .get(format!("{root}/api/manifest"))
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), reqwest::StatusCode::UNAUTHORIZED);

        // Manifest: real JSON, absolute paths stripped.
        let manifest: SyncSnapshot = http
            .get(format!("{root}/api/manifest"))
            .bearer_auth("tok-123")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(manifest.tracks.len(), 2);
        assert!(manifest.tracks.iter().all(|t| t.file_path.is_empty()));
        assert_eq!(manifest.playlists[0].track_keys.len(), 2);

        // Whole file, byte-exact, and the fingerprint matches what the client verifies.
        let bytes = http
            .get(format!("{root}/api/file/key-a"))
            .bearer_auth("tok-123")
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"AAAAAAAAAA-song-a-bytes");
        let staged = dir.path().join("staged-a");
        std::fs::write(&staged, &bytes).unwrap();
        assert_eq!(crate::compute_content_hash(&staged).unwrap(), hash_a);

        // Range request → 206 with just the asked-for slice (resume support).
        let ranged = http
            .get(format!("{root}/api/file/key-b"))
            .header(header::RANGE, "bytes=100-199")
            .bearer_auth("tok-123")
            .send()
            .await
            .unwrap();
        assert_eq!(ranged.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.bytes().await.unwrap().len(), 100);

        // Open-ended `bytes=N-` is what `sync_download_file` sends to resume a
        // partial `.part`: 206 with the tail, and prefix + tail rebuilds the file.
        let head_len = 1234usize;
        let head = http
            .get(format!("{root}/api/file/key-b"))
            .header(header::RANGE, format!("bytes=0-{}", head_len - 1))
            .bearer_auth("tok-123")
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        let head_bytes = head.bytes().await.unwrap();

        let tail = http
            .get(format!("{root}/api/file/key-b"))
            .header(header::RANGE, format!("bytes={head_len}-"))
            .bearer_auth("tok-123")
            .send()
            .await
            .unwrap();
        assert_eq!(tail.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        let mut rebuilt = head_bytes.to_vec();
        rebuilt.extend_from_slice(&tail.bytes().await.unwrap());
        assert_eq!(rebuilt.len(), 5000);
        let resumed = dir.path().join("resumed-b");
        std::fs::write(&resumed, &rebuilt).unwrap();
        assert_eq!(crate::compute_content_hash(&resumed).unwrap(), hash_b);

        // Unknown key → 404.
        let missing = http
            .get(format!("{root}/api/file/nope"))
            .bearer_auth("tok-123")
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);

        // Stats push lands in the inbox and is reflected in activity.
        let posted = http
            .post(format!("{root}/api/sync/stats"))
            .bearer_auth("tok-123")
            .json(&IncomingStats {
                device_id: "phone-9".into(),
                events: vec![IncomingEvent { track_key: "key-a".into(), played_at: 42 }],
                favorites: vec![FavoriteUpdate {
                    track_key: "key-b".into(),
                    favorite: 1,
                    updated_at: 99,
                }],
                play_states: vec![PlayStateUpdate {
                    track_key: "key-a".into(),
                    play_state: "in_progress".into(),
                    resume_position: 61.5,
                    updated_at: 100,
                }],
            })
            .send()
            .await
            .unwrap();
        assert_eq!(posted.status(), reqwest::StatusCode::OK);
        {
            let mut g = state.lock().unwrap();
            assert_eq!(g.activity().peers, vec!["phone-9".to_string()]);
            let inbox = g.take_inbox();
            assert_eq!(inbox.len(), 1);
            assert_eq!(inbox[0].events[0].played_at, 42);
            assert_eq!(inbox[0].favorites[0].favorite, 1);
            assert_eq!(inbox[0].play_states[0].play_state, "in_progress");
            assert_eq!(inbox[0].play_states[0].resume_position, 61.5);
        }

        // After stop, the manifest is no longer served.
        stop(state.clone()).await.unwrap();
        let after = http
            .get(format!("{root}/api/manifest"))
            .bearer_auth("tok-123")
            .send()
            .await;
        // A refused connection is also fine; only a 200 would be wrong.
        if let Ok(r) = after {
            assert_ne!(r.status(), reqwest::StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn stop_clears_snapshot_and_inbox() {
        let shared = Arc::new(Mutex::new(SyncServer::new()));
        {
            let mut s = shared.lock().unwrap();
            s.set_snapshot(sample_snapshot());
            s.inbox.push(IncomingStats {
                device_id: "phone-1".into(),
                events: vec![],
                favorites: vec![],
                play_states: vec![],
            });
        }
        stop(shared.clone()).await.unwrap();
        let s = shared.lock().unwrap();
        assert!(s.snapshot.is_none());
        assert!(s.inbox.is_empty());
    }

    #[test]
    fn ip_check_keeps_the_known_address_through_a_failed_lookup_and_after_stop() {
        // A failed lookup must not turn into a new (loopback) address.
        assert_eq!(ip_republish_target(true, "192.168.1.10", None), None);
        assert_eq!(ip_republish_target(true, "192.168.1.10", Some(String::new())), None);
        // Unchanged.
        assert_eq!(ip_republish_target(true, "192.168.1.10", Some("192.168.1.10".into())), None);
        // A genuine change on a running server.
        assert_eq!(
            ip_republish_target(true, "192.168.1.10", Some("10.0.0.7".into())),
            Some("10.0.0.7".to_string())
        );
        // The server was stopped while the tick waited for the lock.
        assert_eq!(ip_republish_target(false, "", Some("10.0.0.7".into())), None);
    }

    #[test]
    fn pair_admission_allows_one_waiting_request_and_cools_down_after_a_decline() {
        let now = Instant::now();
        assert_eq!(pair_admission(0, None, now), PairAdmission::Admit);
        assert_eq!(pair_admission(1, None, now), PairAdmission::Busy);
        assert_eq!(pair_admission(0, Some(now), now + Duration::from_secs(1)), PairAdmission::CoolingDown);
        assert_eq!(pair_admission(0, Some(now), now + PAIR_DECLINE_COOLDOWN), PairAdmission::Admit);
    }

    #[test]
    fn sanitize_device_name_strips_control_chars_and_caps_the_length() {
        assert_eq!(sanitize_device_name(None), "An Android device");
        assert_eq!(sanitize_device_name(Some("   \n\t ".into())), "An Android device");
        assert_eq!(sanitize_device_name(Some("Pixel\n 8\u{202e}  Pro".into())), "Pixel 8 Pro");
        let long = "あ".repeat(100);
        assert_eq!(sanitize_device_name(Some(long)).chars().count(), MAX_DEVICE_NAME_CHARS);
    }

    #[tokio::test]
    async fn pending_pair_guard_removes_the_entry_when_the_handler_is_dropped() {
        let state: Shared = Arc::new(Mutex::new(SyncServer::new()));
        let (tx, _rx) = oneshot::channel::<bool>();
        state.lock().unwrap().pending_pairs.insert(7, tx);
        {
            let _guard = PendingPairGuard { state: state.clone(), id: 7 };
            assert_eq!(state.lock().unwrap().pending_pairs.len(), 1);
        }
        assert!(state.lock().unwrap().pending_pairs.is_empty());
    }

    #[test]
    fn respond_pairing_errors_when_no_request_waits() {
        let shared = serving("tok", sample_snapshot());
        let err = respond_pairing(&shared, 999, true).expect_err("nothing is pending");
        assert!(err.contains("no longer waiting"), "unexpected: {err}");
    }

    #[tokio::test]
    async fn pair_endpoint_is_unavailable_without_an_approval_ui() {
        // The headless server (app: None) can't raise a prompt, so it must fail
        // fast rather than hang the phone for the approval timeout.
        let state = Arc::new(Mutex::new(SyncServer::new()));
        let status = start(state.clone(), "tok-123".into(), None, None).await.unwrap();
        let resp = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap()
            .post(format!("https://127.0.0.1:{}/pair", status.port))
            .json(&serde_json::json!({ "device_name": "Pixel 8" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::NOT_IMPLEMENTED);
        assert!(state.lock().unwrap().pending_pairs.is_empty());
    }

    #[tokio::test]
    async fn ping_requires_the_token() {
        let state = serving("tok-ping", sample_snapshot());
        let app = build_router(state);

        let unauthed = app
            .clone()
            .oneshot(Request::get("/api/ping").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(unauthed.status(), StatusCode::UNAUTHORIZED);

        let ok = app
            .oneshot(
                Request::get("/api/ping")
                    .header("authorization", "Bearer tok-ping")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn album_art_is_not_found_without_an_app_handle() {
        // The headless test/e2e server has no AppHandle (see `app: None` in
        // `SyncServer::new`), so it can't resolve a cache dir — must 404, not
        // panic, exactly like a genuinely-uncached album would.
        let state = serving("tok-art", sample_snapshot());
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::get("/api/album-art/some-key")
                    .header("authorization", "Bearer tok-art")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn album_art_rejects_keys_that_are_not_a_hex_digest() {
        // `key` is joined straight into a filesystem path (`{key}.jpg`), and
        // axum percent-decodes path segments before routing gets it — so a
        // non-hex key must be rejected before any filesystem access, not just
        // happen to 404 because no such file exists.
        let state = serving("tok-art", sample_snapshot());
        for key in ["..%2f..%2fsecret", "../../etc/passwd", "not-hex!", ""] {
            let app = build_router(state.clone());
            let resp = app
                .oneshot(
                    Request::get(format!("/api/album-art/{key}"))
                        .header("authorization", "Bearer tok-art")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "key {key:?} should be rejected");
        }
    }

    #[tokio::test]
    async fn start_reuses_the_preferred_port_when_free() {
        let state = Arc::new(Mutex::new(SyncServer::new()));
        let first = start(state.clone(), "tok".into(), None, None).await.unwrap();
        stop(state.clone()).await.unwrap();
        // `stop()` only signals the serving task; the listening socket is
        // released asynchronously when that task actually exits.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let second = start(state.clone(), "tok".into(), None, Some(first.port)).await.unwrap();
        assert_eq!(second.port, first.port);
    }

    #[tokio::test]
    async fn start_falls_back_to_an_ephemeral_port_when_preferred_is_taken() {
        // Occupy a port first, then ask the server to bind that exact port.
        let blocker = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let taken_port = blocker.local_addr().unwrap().port();

        let state = Arc::new(Mutex::new(SyncServer::new()));
        let status = start(state.clone(), "tok".into(), None, Some(taken_port)).await.unwrap();
        assert_ne!(status.port, taken_port);

        drop(blocker);
    }
}
