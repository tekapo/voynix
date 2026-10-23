//! macOS Now Playing integration: registers Voynix with MPRemoteCommandCenter
//! / MPNowPlayingInfoCenter so the keyboard media keys, Control Center and
//! headphone buttons reach the app.
//!
//! Music plays through the Rust engine (player.rs), so WebKit never sees an
//! `<audio>` element playing and `navigator.mediaSession` isn't published to
//! the OS — the media keys then fall to whichever app last was (e.g. a
//! background browser tab). Registering natively fixes that. Remote commands
//! are forwarded to the frontend as a `media-action` event whose payload is
//! "play" | "pause" | "toggle" | "next" | "previous" | { "seek": seconds }.
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_app_kit::NSImage;
use objc2_foundation::{NSData, NSDictionary, NSNumber, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPMediaItemPropertyAlbumTitle,
    MPMediaItemPropertyArtist, MPMediaItemPropertyArtwork, MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
    MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyPlaybackRate,
    MPNowPlayingPlaybackState, MPRemoteCommand, MPRemoteCommandCenter, MPRemoteCommandEvent,
    MPRemoteCommandHandlerStatus,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Encoded image bytes (JPEG/PNG) of the current track's cover. Kept apart
/// from `set_now_playing` so the (large) image crosses IPC only when it
/// changes, not on every pause/seek republish.
static ARTWORK: Mutex<Option<Vec<u8>>> = Mutex::new(None);

#[derive(Deserialize)]
pub struct NowPlayingInfo {
    title: String,
    artist: String,
    album: String,
    duration: f64,
    position: f64,
    rate: f64,
    playing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
enum MediaAction {
    Play,
    Pause,
    Toggle,
    Next,
    Previous,
    Seek(f64),
}

fn emit(action: MediaAction) {
    if let Some(app) = APP.get() {
        let _ = app.emit("media-action", action);
    }
}

fn number(v: f64) -> Retained<AnyObject> {
    unsafe { Retained::cast_unchecked(NSNumber::new_f64(v)) }
}

fn string(v: &str) -> Retained<AnyObject> {
    unsafe { Retained::cast_unchecked(NSString::from_str(v)) }
}

/// Tauri command: sets (or with `None` clears) the cover shown by the next
/// `set_now_playing`. Takes the `data:` URI the frontend already holds.
#[tauri::command]
pub fn set_now_playing_artwork(data_uri: Option<String>) {
    *ARTWORK.lock().unwrap() = data_uri.as_deref().and_then(decode_data_uri);
}

fn decode_data_uri(uri: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let (_, b64) = uri.strip_prefix("data:")?.split_once(";base64,")?;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

/// Wraps `bytes` as an `MPMediaItemArtwork`; `None` if they aren't an image.
fn make_artwork(bytes: &[u8]) -> Option<Retained<AnyObject>> {
    unsafe {
        let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes))?;
        let size = image.size();
        // The OS asks for a rendition at some size; one image serves them all.
        let handler = RcBlock::new(move |_: objc2_foundation::NSSize| {
            NonNull::from(&*image)
        });
        let artwork = MPMediaItemArtwork::initWithBoundsSize_requestHandler(
            MPMediaItemArtwork::alloc(),
            size,
            &handler,
        );
        Some(Retained::cast_unchecked(artwork))
    }
}

/// Tauri command: publishes the current track (or clears it with `None`).
#[tauri::command]
pub fn set_now_playing(info: Option<NowPlayingInfo>) {
    unsafe {
        let center = MPNowPlayingInfoCenter::defaultCenter();
        let Some(i) = info else {
            center.setNowPlayingInfo(None);
            center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
            return;
        };
        let mut keys: Vec<&NSString> = vec![
            MPMediaItemPropertyTitle,
            MPMediaItemPropertyArtist,
            MPMediaItemPropertyAlbumTitle,
            MPMediaItemPropertyPlaybackDuration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime,
            MPNowPlayingInfoPropertyPlaybackRate,
        ];
        // A paused track reports rate 0 so the OS stops advancing its scrubber.
        let rate = if i.playing { i.rate } else { 0.0 };
        let mut values = vec![
            string(&i.title),
            string(&i.artist),
            string(&i.album),
            number(i.duration),
            number(i.position),
            number(rate),
        ];
        let artwork = ARTWORK.lock().unwrap().as_deref().and_then(make_artwork);
        if let Some(artwork) = artwork {
            keys.push(MPMediaItemPropertyArtwork);
            values.push(artwork);
        }
        let dict = NSDictionary::from_retained_objects(&keys, &values);
        center.setNowPlayingInfo(Some(&dict));
        center.setPlaybackState(if i.playing {
            MPNowPlayingPlaybackState::Playing
        } else {
            MPNowPlayingPlaybackState::Paused
        });
    }
}

fn register(command: &MPRemoteCommand, action: fn() -> MediaAction) {
    let handler = RcBlock::new(move |_: NonNull<MPRemoteCommandEvent>| {
        emit(action());
        MPRemoteCommandHandlerStatus::Success
    });
    unsafe {
        command.setEnabled(true);
        // The command center retains the block; the returned target token is
        // never needed since we don't remove handlers.
        let _ = command.addTargetWithHandler(&handler);
    }
}

/// Call after the app is built, before `run`.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    unsafe {
        let c = MPRemoteCommandCenter::sharedCommandCenter();
        register(&c.playCommand(), || MediaAction::Play);
        register(&c.pauseCommand(), || MediaAction::Pause);
        register(&c.togglePlayPauseCommand(), || MediaAction::Toggle);
        register(&c.nextTrackCommand(), || MediaAction::Next);
        register(&c.previousTrackCommand(), || MediaAction::Previous);

        let seek = c.changePlaybackPositionCommand();
        let handler = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
            let event = event.cast::<MPChangePlaybackPositionCommandEvent>();
            emit(MediaAction::Seek(event.as_ref().positionTime()));
            MPRemoteCommandHandlerStatus::Success
        });
        seek.setEnabled(true);
        let _ = seek.addTargetWithHandler(&handler);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_data_uri_returns_the_bytes_and_rejects_anything_else() {
        assert_eq!(decode_data_uri("data:image/jpeg;base64,AQID"), Some(vec![1, 2, 3]));
        assert_eq!(decode_data_uri("https://example.com/a.jpg"), None);
        assert_eq!(decode_data_uri("data:image/jpeg,not-base64"), None);
        assert_eq!(decode_data_uri("data:image/jpeg;base64,***"), None);
    }
}
