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
//!
//! The output stream is bound to whichever device was the system default
//! when it was opened. If that device goes away (Bluetooth speaker turned
//! off, a monitor's DisplayPort audio vanishing as it sleeps) CoreAudio stops
//! the stream for good, so the output is reopened on the current default —
//! and likewise when the default itself changes — carrying the loaded track
//! over at its position. Without this, playback silently stayed dead until
//! the app was restarted.

mod gapless;

use gapless::SymphoniaSource;
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::cpal::{self, DeviceId, StreamError};
use rodio::{DeviceSinkBuilder, MixerDeviceSink, Player};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::time::{Duration, Instant};
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
    /// Sent from cpal's error callback (another thread) when the output
    /// device behind the stream opened as generation `.0` disappears. Older
    /// generations are ignored — that stream has already been replaced.
    DeviceLost(u64),
}

/// How often the poll loop checks whether the system default output device
/// changed. Reading the default is a single CoreAudio property query.
const DEFAULT_DEVICE_CHECK_INTERVAL: Duration = Duration::from_secs(2);

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
            .spawn({
                let tx = tx.clone();
                move || run(app, tx, rx)
            })
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
/// `id` lets `set_next` no-op on a redundant call; `path` becomes the
/// current path once it's handed off to, and lets it be re-queued when the
/// output is reopened.
#[derive(Debug, PartialEq)]
struct Pending {
    id: String,
    path: PathBuf,
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
        let mut pending = Some(Pending { id: "b".into(), path: "b.m4a".into(), duration: 10.0 });
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
        let mut pending = Some(Pending { id: "next".into(), path: "next.m4a".into(), duration: 42.0 });
        let t = detect_transition(true, 2, 1, &mut pending);
        assert_eq!(t, Transition::AdvancedTo(Pending { id: "next".into(), path: "next.m4a".into(), duration: 42.0 }));
        assert!(pending.is_none()); // consumed — it's current now, not pending
    }
}

/// Whether the system default output device has moved away from the one the
/// stream was opened on. Unknown ids on either side (a query that failed)
/// never count as a change — reopening on a guess could only hurt.
fn default_changed(opened: Option<&DeviceId>, default: Option<&DeviceId>) -> bool {
    matches!((opened, default), (Some(a), Some(b)) if a != b)
}

#[cfg(test)]
mod default_device_tests {
    use super::*;

    fn id(name: &str) -> DeviceId {
        DeviceId(cpal::default_host().id(), name.into())
    }

    #[test]
    fn same_device_is_no_change() {
        assert!(!default_changed(Some(&id("a")), Some(&id("a"))));
    }

    #[test]
    fn different_device_is_a_change() {
        assert!(default_changed(Some(&id("a")), Some(&id("b"))));
    }

    #[test]
    fn unknown_ids_are_never_a_change() {
        assert!(!default_changed(None, Some(&id("b"))));
        assert!(!default_changed(Some(&id("a")), None));
        assert!(!default_changed(None, None));
    }
}

/// An open output stream plus what's needed to tell whether it's stale.
struct Output {
    sink: MixerDeviceSink,
    device_id: Option<DeviceId>,
    generation: u64,
}

/// Opens the current system default output device. Its error callback posts
/// `DeviceLost(generation)` back to the playback thread, since the callback
/// itself runs on a cpal thread that can't touch the `Player`.
fn open_output(tx: &Sender<Command>, generation: u64) -> Result<Output, String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or_else(|| "no audio output device".to_string())?;
    let device_id = device.id().ok();
    let tx = tx.clone();
    let on_error = move |err: StreamError| {
        eprintln!("audio stream error: {err}");
        if err == StreamError::DeviceNotAvailable {
            let _ = tx.send(Command::DeviceLost(generation));
        }
    };
    let sink = DeviceSinkBuilder::from_device(device)
        .and_then(|b| b.with_error_callback(on_error).open_sink_or_fallback())
        .map_err(|e| format!("couldn't open audio output: {e}"))?;
    Ok(Output { sink, device_id, generation })
}

/// Owns the `Player` and everything about "what's currently loaded" for the
/// life of the playback thread. Not `Send`/`Sync` as a whole (the `Player`
/// isn't), which is fine — it's only ever touched from `run`'s own thread.
struct Engine {
    player: Player,
    /// Declared after `player` so the stream outlives it on drop.
    output: Output,
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
                        self.pending = Some(Pending { id, path, duration });
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

impl Engine {
    /// Moves playback onto a freshly opened stream on the current default
    /// device: a new `Player` on its mixer, the loaded track re-opened at the
    /// old position with the same paused/playing state and volume, and the
    /// queued next track (if any) re-appended behind it. If the new device
    /// can't be opened, everything stays as it was and the error is reported.
    fn reopen_output(&mut self, app: &AppHandle, tx: &Sender<Command>) {
        let output = match open_output(tx, self.output.generation + 1) {
            Ok(o) => o,
            Err(message) => {
                let _ = app.emit("player-error", ErrorPayload { message });
                return;
            }
        };
        let pos = self.player.get_pos();
        let was_paused = self.player.is_paused();
        let volume = self.player.volume();
        self.player.stop();
        let player = new_player(&output.sink);
        player.set_volume(volume);
        self.player = player;
        self.output = output;
        self.last_len = 0;

        let Some(path) = self.current_id.as_ref().and(self.current_path.clone()) else {
            self.pending = None;
            return;
        };
        match SymphoniaSource::open(&path) {
            Ok(source) => {
                self.player.append(source);
                let _ = self.player.try_seek(pos);
            }
            Err(message) => {
                self.current_id = None;
                self.pending = None;
                let _ = app.emit("player-error", ErrorPayload { message });
                return;
            }
        }
        if let Some(next) = &self.pending {
            match SymphoniaSource::open(&next.path) {
                Ok(source) => self.player.append(source),
                Err(_) => self.pending = None,
            }
        }
        if !was_paused {
            self.player.play();
        }
        self.last_len = self.player.len();
    }
}

/// `Player` starts *unpaused* — with nothing appended yet that's silent, but
/// the moment anything is appended (e.g. `set_next` queuing a track for a
/// merely-armed, not-yet-playing selection) it would start playing
/// immediately. Pause up front so only an explicit `load(autoplay: true)` or
/// `play()` command ever starts sound.
fn new_player(sink: &MixerDeviceSink) -> Player {
    let player = Player::connect_new(sink.mixer());
    player.pause();
    player
}

fn run(app: AppHandle, tx: Sender<Command>, rx: std::sync::mpsc::Receiver<Command>) {
    let output = match open_output(&tx, 0) {
        Ok(o) => o,
        Err(message) => {
            let _ = app.emit("player-error", ErrorPayload { message });
            return;
        }
    };
    let player = new_player(&output.sink);
    let mut engine = Engine {
        player,
        output,
        current_id: None,
        current_path: None,
        current_duration: 0.0,
        pending: None,
        last_len: 0,
    };
    let mut last_default_check = Instant::now();

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
            Ok(Command::DeviceLost(generation)) => {
                if generation == engine.output.generation {
                    engine.reopen_output(&app, &tx);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            // Unreachable while `tx` lives here, but harmless to keep.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        }

        if last_default_check.elapsed() >= DEFAULT_DEVICE_CHECK_INTERVAL {
            last_default_check = Instant::now();
            let default_id = cpal::default_host().default_output_device().and_then(|d| d.id().ok());
            if default_changed(engine.output.device_id.as_ref(), default_id.as_ref()) {
                engine.reopen_output(&app, &tx);
            }
        }

        let len = engine.player.len();
        match detect_transition(engine.current_id.is_some(), engine.last_len, len, &mut engine.pending) {
            Transition::None => {}
            Transition::AdvancedTo(next) => {
                engine.current_id = Some(next.id.clone());
                engine.current_path = Some(next.path);
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
