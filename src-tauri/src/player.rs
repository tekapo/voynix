//! Native gapless playback engine for music (see `src/player/nativeEngine.ts`
//! on the frontend). Podcasts stay on the frontend's `<audio>` element —
//! podcast playback needs pitch-preserving speed change, which this engine
//! doesn't attempt — see `DualEngine` on the JS side for that split.
//!
//! The actual gapless-aware decoding (symphonia wrapped as a `rodio::Source`,
//! iTunSMPB trimming) lives in the Tauri-independent [`gapless`] submodule.
//! Everything in *this* file is the Tauri-facing half: the dedicated OS
//! thread, its command channel, and the `player-*` events sent back to the
//! frontend.
//!
//! Everything here runs on one dedicated OS thread. Opening an output device
//! hands back a `cpal::Stream` that isn't `Send` on every platform, so it —
//! and the `rodio::Player` built on it — must never move between threads.
//! Tauri's (async) command handlers post `Command`s to that thread over an
//! `mpsc` channel and `player-*` events go back to the frontend via
//! `AppHandle::emit`.

mod gapless;

use gapless::SymphoniaSource;
use rodio::{DeviceSinkBuilder, Player};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Commands sent to the dedicated playback thread.
enum Command {
    Load { track_id: String, path: PathBuf, autoplay: bool, seek: f64 },
    SetNext { track_id: Option<String>, path: Option<PathBuf> },
    Play,
    Pause,
    Stop,
    Seek(f64),
    SetVolume(f32),
}

/// Shared handle managed by Tauri (`app.manage(...)`) and used by the
/// `player_*` commands in `lib.rs` to talk to the dedicated thread.
pub struct PlayerHandle {
    tx: Sender<Command>,
}

impl PlayerHandle {
    pub fn spawn(app: AppHandle) -> Self {
        let (tx, rx) = channel::<Command>();
        std::thread::Builder::new()
            .name("voynix-player".into())
            .spawn(move || run(app, rx))
            .expect("failed to spawn playback thread");
        PlayerHandle { tx }
    }

    fn send(&self, cmd: Command) {
        // The playback thread only ever exits if the process is shutting
        // down, so a failed send here has nothing meaningful left to do.
        let _ = self.tx.send(cmd);
    }

    pub fn load(&self, track_id: String, path: PathBuf, autoplay: bool, seek: f64) {
        self.send(Command::Load { track_id, path, autoplay, seek });
    }

    pub fn set_next(&self, track_id: Option<String>, path: Option<PathBuf>) {
        self.send(Command::SetNext { track_id, path });
    }

    pub fn play(&self) {
        self.send(Command::Play);
    }

    pub fn pause(&self) {
        self.send(Command::Pause);
    }

    pub fn stop(&self) {
        self.send(Command::Stop);
    }

    pub fn seek(&self, position: f64) {
        self.send(Command::Seek(position));
    }

    pub fn set_volume(&self, volume: f32) {
        self.send(Command::SetVolume(volume));
    }
}

#[derive(Serialize, Clone)]
struct PositionPayload {
    #[serde(rename = "trackId")]
    track_id: String,
    position: f64,
    duration: f64,
}

#[derive(Serialize, Clone)]
struct AdvancedPayload {
    #[serde(rename = "trackId")]
    track_id: String,
}

#[derive(Serialize, Clone)]
struct ErrorPayload {
    message: String,
}

/// What's queued behind the currently-loaded track, for a gapless hand-off.
/// `id` lets `set_next` no-op on a redundant call.
#[derive(Debug, PartialEq)]
struct Pending {
    id: String,
    duration: f64,
}

/// What (if anything) happened between two `player.len()` polls.
#[derive(Debug, PartialEq)]
enum Transition {
    /// Nothing to report — still on the same loaded track (or nothing was
    /// loaded to begin with).
    None,
    /// The loaded track finished and rodio moved on to this queued one, all
    /// on its own — the audio itself never gapped; this is the app
    /// catching its own bookkeeping up to what already happened.
    AdvancedTo(Pending),
    /// The loaded track finished with nothing queued behind it.
    Ended,
}

/// Pure decision at the core of `run`'s poll loop: `player.len()` (the count
/// of not-yet-finished appended sounds) only ever drops when the sound
/// currently at the front finishes, whether or not anything was behind it —
/// so a drop while a track is loaded is exactly the "did it finish" signal,
/// and whether something was queued (`pending`) says what it turned into.
fn detect_transition(loaded: bool, last_len: usize, len: usize, pending: &mut Option<Pending>) -> Transition {
    if !loaded || len >= last_len {
        return Transition::None;
    }
    match pending.take() {
        Some(p) => Transition::AdvancedTo(p),
        None => Transition::Ended,
    }
}

#[cfg(test)]
mod transition_tests {
    use super::*;

    #[test]
    fn no_change_while_len_holds_or_grows() {
        let mut pending = None;
        assert_eq!(detect_transition(true, 1, 1, &mut pending), Transition::None);
        let mut pending = Some(Pending { id: "b".into(), duration: 10.0 });
        assert_eq!(detect_transition(true, 1, 2, &mut pending), Transition::None);
        assert!(pending.is_some()); // untouched — no transition happened
    }

    #[test]
    fn nothing_loaded_is_never_a_transition_even_if_len_drops() {
        // e.g. a stray tick right after an explicit Stop already cleared
        // current_id, while rodio is still draining the old queue to 0.
        let mut pending = None;
        assert_eq!(detect_transition(false, 2, 0, &mut pending), Transition::None);
    }

    #[test]
    fn a_drop_with_nothing_queued_is_a_true_end() {
        let mut pending = None;
        assert_eq!(detect_transition(true, 1, 0, &mut pending), Transition::Ended);
    }

    #[test]
    fn a_drop_with_something_queued_is_a_gapless_advance() {
        let mut pending = Some(Pending { id: "next".into(), duration: 42.0 });
        let t = detect_transition(true, 2, 1, &mut pending);
        assert_eq!(t, Transition::AdvancedTo(Pending { id: "next".into(), duration: 42.0 }));
        assert!(pending.is_none()); // consumed — it's current now, not pending
    }
}

/// Owns the `Player` and everything about "what's currently loaded" for the
/// life of the playback thread. Not `Send`/`Sync` as a whole (the `Player`
/// isn't), which is fine — it's only ever touched from `run`'s own thread.
struct Engine {
    player: Player,
    current_id: Option<String>,
    current_path: Option<PathBuf>,
    current_duration: f64,
    pending: Option<Pending>,
    /// `player.len()` as of the last tick — a *drop* in this, checked every
    /// poll, is how a gapless hand-off (or true end-of-media) is detected.
    /// rodio itself already made the audio transition seamlessly by the time
    /// we notice; this only catches the app-level bookkeeping up to it.
    last_len: usize,
}

impl Engine {
    fn load(&mut self, app: &AppHandle, track_id: String, path: PathBuf, autoplay: bool, seek: f64) {
        self.pending = None;
        // Flushes whatever was playing/queued — append() below blocks
        // (briefly; this thread, never the audio callback thread) until that
        // flush completes before appending the new track. See rodio::Player
        // docs / its own stop()+append() pattern.
        self.player.stop();
        match SymphoniaSource::open(&path) {
            Ok(source) => {
                let duration = source.total_duration.map(|d| d.as_secs_f64()).unwrap_or(0.0);
                self.player.append(source);
                if seek > 0.0 {
                    let _ = self.player.try_seek(Duration::from_secs_f64(seek));
                }
                if autoplay {
                    self.player.play();
                } else {
                    self.player.pause();
                }
                self.current_id = Some(track_id.clone());
                self.current_path = Some(path);
                self.current_duration = duration;
                self.last_len = self.player.len();
                let _ = app.emit("player-position", PositionPayload { track_id, position: seek, duration });
            }
            Err(message) => {
                self.current_id = None;
                let _ = app.emit("player-error", ErrorPayload { message });
            }
        }
    }

    /// rodio's `Player` can't un-append one specific queued item, so a stale
    /// pending track (queue/order changed mid-track) is removed by rebuilding
    /// the player with just the current track, resumed at its position.
    /// Leaves `pending` as-is only if the rebuild failed.
    fn drop_pending(&mut self, app: &AppHandle) {
        if self.pending.is_none() {
            return;
        }
        let Some(path) = self.current_path.clone() else {
            self.pending = None;
            return;
        };
        let pos = self.player.get_pos();
        let was_paused = self.player.is_paused();
        self.player.stop();
        match SymphoniaSource::open(&path) {
            Ok(source) => {
                self.player.append(source);
                let _ = self.player.try_seek(pos);
                if was_paused {
                    self.player.pause();
                } else {
                    self.player.play();
                }
                self.pending = None;
                self.last_len = self.player.len();
            }
            Err(message) => {
                self.pending = None;
                self.current_id = None;
                let _ = app.emit("player-error", ErrorPayload { message });
            }
        }
    }

    fn set_next(&mut self, app: &AppHandle, track_id: Option<String>, path: Option<PathBuf>) {
        // Nothing is actually loaded yet (e.g. a track is merely armed/cued,
        // never played) — queuing a "next" makes no sense without a current
        // track to hand off from, and appending it here would make it the
        // *first* thing the player ever plays instead of staying silent.
        if self.current_id.is_none() {
            return;
        }
        match (track_id, path) {
            (Some(id), Some(path)) => {
                if self.pending.as_ref().map(|p| &p.id) == Some(&id) {
                    return; // already queued — avoid re-decoding from scratch
                }
                // A different track is already appended: it can't be removed
                // individually, and would play before the new one (audio no
                // longer matching what the UI shows). Drop it first.
                self.drop_pending(app);
                if self.pending.is_some() {
                    return;
                }
                match SymphoniaSource::open(&path) {
                    Ok(source) => {
                        let duration = source.total_duration.map(|d| d.as_secs_f64()).unwrap_or(0.0);
                        self.player.append(source);
                        self.pending = Some(Pending { id, duration });
                    }
                    Err(message) => {
                        let _ = app.emit("player-error", ErrorPayload { message });
                    }
                }
            }
            _ => {
                self.drop_pending(app);
            }
        }
    }
}

fn run(app: AppHandle, rx: std::sync::mpsc::Receiver<Command>) {
    let device_sink = match DeviceSinkBuilder::open_default_sink() {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit("player-error", ErrorPayload { message: format!("no audio output device: {e}") });
            return;
        }
    };
    let player = Player::connect_new(device_sink.mixer());
    // `Player` starts *unpaused* — with nothing appended yet that's silent,
    // but the moment anything is appended (e.g. `set_next` queuing a track
    // for a merely-armed, not-yet-playing selection) it would start playing
    // immediately. Pause up front so only an explicit `load(autoplay: true)`
    // or `play()` command ever starts sound.
    player.pause();
    let mut engine = Engine {
        player,
        current_id: None,
        current_path: None,
        current_duration: 0.0,
        pending: None,
        last_len: 0,
    };

    loop {
        // Poll for a command without blocking forever, so position ticks and
        // the "did the loaded track just finish/hand off" check keep running
        // even when nothing new arrives from the frontend.
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Command::Load { track_id, path, autoplay, seek }) => {
                engine.load(&app, track_id, path, autoplay, seek)
            }
            Ok(Command::SetNext { track_id, path }) => engine.set_next(&app, track_id, path),
            Ok(Command::Play) => engine.player.play(),
            Ok(Command::Pause) => engine.player.pause(),
            Ok(Command::Stop) => {
                engine.player.stop();
                engine.current_id = None;
                engine.pending = None;
                engine.last_len = 0;
            }
            Ok(Command::Seek(pos)) => {
                let _ = engine.player.try_seek(Duration::from_secs_f64(pos));
            }
            Ok(Command::SetVolume(v)) => engine.player.set_volume(v),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return, // app shutting down
        }

        let len = engine.player.len();
        match detect_transition(engine.current_id.is_some(), engine.last_len, len, &mut engine.pending) {
            Transition::None => {}
            Transition::AdvancedTo(next) => {
                engine.current_id = Some(next.id.clone());
                engine.current_duration = next.duration;
                let _ = app.emit("player-advanced", AdvancedPayload { track_id: next.id });
            }
            Transition::Ended => {
                engine.current_id = None;
                let _ = app.emit("player-ended", ());
            }
        }
        engine.last_len = len;

        if let Some(id) = &engine.current_id {
            let position = engine.player.get_pos().as_secs_f64();
            let _ = app.emit(
                "player-position",
                PositionPayload { track_id: id.clone(), position, duration: engine.current_duration },
            );
        }
    }
}
