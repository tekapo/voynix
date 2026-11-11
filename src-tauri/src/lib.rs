mod identity;
mod metadata;
mod player;
mod remote;
mod scan;
mod server;
mod tags;
mod tls;
mod transcode;
mod util;

// Other modules reach these through the crate root.
pub(crate) use identity::compute_content_hash;
pub(crate) use tags::{read_embedded_artwork, read_embedded_picture};

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;

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

/// Echo (Alexa) playback server — see remote.rs. Off unless the user enables it.
#[tauri::command]
async fn start_remote_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<remote::RemoteServer>>>,
    port: u16,
    secret: String,
    cert_path: String,
    key_path: String,
) -> Result<remote::RemoteStatus, String> {
    remote::start(state.inner().clone(), port, secret, cert_path, key_path, Some(app)).await
}

#[tauri::command]
async fn stop_remote_server(
    state: tauri::State<'_, Arc<Mutex<remote::RemoteServer>>>,
) -> Result<(), String> {
    remote::stop(state.inner().clone()).await
}

#[tauri::command]
fn remote_server_status(
    state: tauri::State<'_, Arc<Mutex<remote::RemoteServer>>>,
) -> Option<remote::RemoteStatus> {
    remote::status(state.inner())
}

#[tauri::command]
fn set_remote_library(
    state: tauri::State<'_, Arc<Mutex<remote::RemoteServer>>>,
    library: remote::RemoteLibraryIn,
) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.set_library(library);
    Ok(())
}

/// Applies a regenerated shared secret to a running server.
#[tauri::command]
fn set_remote_secret(
    state: tauri::State<'_, Arc<Mutex<remote::RemoteServer>>>,
    secret: String,
) -> Result<(), String> {
    state.lock().map_err(|e| e.to_string())?.set_secret(secret);
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

/// `/…/Voynix.app/Contents/MacOS/Voynix` -> `/…/Voynix.app`; `None` for a binary
/// that isn't inside an app bundle (`tauri:dev`, `cargo run`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_bundle_path(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// Restarts the app through LaunchServices (`open`) so the new instance is
/// activated and comes to the front. The plugin's `relaunch()` spawns the binary
/// directly, which on macOS leaves the new window behind whatever app was in
/// front (the self-update dialog's "Install" was clicked in this app, but by the
/// time the new process is up, nothing activates it). Returns `false` — and does
/// nothing — outside an app bundle or off macOS, so the caller falls back to
/// `relaunch()`.
#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn relaunch_app(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let Some(bundle) = app_bundle_path(&exe) else {
            return Ok(false);
        };
        // The delay lets this process finish exiting first: `open` on a running
        // app only activates it instead of starting the new copy. The bundle path
        // goes in as $1 so no quoting is needed.
        std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 1; exec /usr/bin/open \"$1\"")
            .arg("sh")
            .arg(&bundle)
            .spawn()
            .map_err(|e| e.to_string())?;
        app.exit(0);
        return Ok(true);
    }
    #[allow(unreachable_code)]
    Ok(false)
}

#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn show_in_finder(path: String) -> Result<(), String> {
    // Track paths are absolute; refuse anything else so a stray `-` prefix can
    // never be read by `open` as an option.
    if !Path::new(&path).is_absolute() {
        return Err("path must be absolute".to_string());
    }
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

#[cfg(target_os = "macos")]
mod dock;
#[cfg(target_os = "macos")]
mod menu;
#[cfg(target_os = "macos")]
mod now_playing;

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::default().build());

    let app = builder
        .manage(Arc::new(Mutex::new(server::SyncServer::new())))
        .manage(Arc::new(Mutex::new(remote::RemoteServer::new())))
        .manage(scan::ScanState::default())
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
            scan::scan_music_dir,
            scan::import_itunes_xml,
            scan::cancel_scan,
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
            start_remote_server,
            stop_remote_server,
            remote_server_status,
            set_remote_library,
            set_remote_secret,
            transcode::prepare_sync_media,
            show_in_finder,
            relaunch_app,
            tags::get_track_artwork,
            tags::set_track_artwork,
            tags::get_track_file_info,
            tags::write_track_tags,
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
            identity::compute_track_identity,
            identity::compute_track_identities,
            tags::read_track_numbers,
            tags::read_extra_tags,
            dock::set_dock_labels,
            menu::set_app_menu,
            now_playing::set_now_playing,
            now_playing::set_now_playing_artwork
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    #[cfg(target_os = "macos")]
    {
        dock::install(app.handle());
        menu::install(app.handle());
        now_playing::install(app.handle());
    }

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

    #[test]
    fn app_bundle_path_finds_the_bundle_around_the_binary() {
        assert_eq!(
            app_bundle_path(Path::new("/Applications/Voynix.app/Contents/MacOS/Voynix")),
            Some(PathBuf::from("/Applications/Voynix.app"))
        );
        // A bundle path with spaces survives intact.
        assert_eq!(
            app_bundle_path(Path::new("/Users/me/My Apps/Voynix.app/Contents/MacOS/voynix")),
            Some(PathBuf::from("/Users/me/My Apps/Voynix.app"))
        );
    }

    #[test]
    fn app_bundle_path_is_none_outside_a_bundle() {
        assert_eq!(app_bundle_path(Path::new("/repo/src-tauri/target/debug/voynix")), None);
        assert_eq!(app_bundle_path(Path::new("/Applications/Voynix.app/Contents/Resources/x")), None);
        assert_eq!(app_bundle_path(Path::new("/opt/tools/Contents/MacOS/voynix")), None);
        assert_eq!(app_bundle_path(Path::new("voynix")), None);
    }

    #[test]
    fn test_show_in_finder_rejects_relative_and_option_like_paths() {
        assert!(show_in_finder("song.mp3".to_string()).is_err());
        assert!(show_in_finder("-a/Calculator".to_string()).is_err());
        assert!(show_in_finder("../x.mp3".to_string()).is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_show_in_finder_nonexistent() {
        let result = show_in_finder("/nonexistent/voynix/test/file.mp3".to_string());
        assert!(result.is_err());
    }

}
