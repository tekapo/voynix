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
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSDictionary, NSNumber, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPMediaItemPropertyAlbumTitle, MPMediaItemPropertyArtist,
    MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
    MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyPlaybackRate,
    MPNowPlayingPlaybackState, MPRemoteCommand, MPRemoteCommandCenter, MPRemoteCommandEvent,
    MPRemoteCommandHandlerStatus,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

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
        let keys: [&NSString; 6] = [
            MPMediaItemPropertyTitle,
            MPMediaItemPropertyArtist,
            MPMediaItemPropertyAlbumTitle,
            MPMediaItemPropertyPlaybackDuration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime,
            MPNowPlayingInfoPropertyPlaybackRate,
        ];
        // A paused track reports rate 0 so the OS stops advancing its scrubber.
        let rate = if i.playing { i.rate } else { 0.0 };
        let values = [
            string(&i.title),
            string(&i.artist),
            string(&i.album),
            number(i.duration),
            number(i.position),
            number(rate),
        ];
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
