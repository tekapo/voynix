// PlayerEngine backed by the Rust/rodio engine (src-tauri/src/player.rs).
// Used for everything except podcasts: it decodes and mixes audio itself, so
// a track queued via `setNext` is appended to the *same* output sink and
// starts the instant the current one's samples run out — no readFile/Blob
// round-trip through JS, no <audio> reload, no gap.
//
// Position/duration aren't available synchronously (the decoder runs on a
// dedicated Rust thread), so this engine caches the last value it got from
// the `player-position`/`player-duration` events and serves getCurrentTime /
// getDuration from that cache.

import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { createEventBus } from "../lib/eventBus";
import { EngineTrack, LoadOptions, PlayerEngine, PlayerEngineEvents } from "./engine";

interface PositionPayload { trackId: string; position: number; duration: number }
interface AdvancedPayload { trackId: string }
interface ErrorPayload { message: string }

export class NativeEngine implements PlayerEngine {
  private bus = createEventBus<PlayerEngineEvents>();
  private unlistenFns: UnlistenFn[] = [];
  private ready: Promise<void>;
  private lastPosition = 0;
  private lastDuration = 0;
  private paused = true;
  private ended = false;
  /** The track id this engine currently considers loaded — guards a stale
   *  event from a track we've since moved past (e.g. a fast skip while an
   *  old position tick is still in flight). */
  private currentTrackId: string | null = null;

  constructor() {
    this.ready = this.attachListeners();
  }

  private async attachListeners() {
    this.unlistenFns.push(
      await listen<PositionPayload>("player-position", (e) => {
        if (e.payload.trackId !== this.currentTrackId) return;
        this.lastPosition = e.payload.position;
        this.lastDuration = e.payload.duration;
        this.bus.emit("onPosition", e.payload.position);
        if (e.payload.duration > 0) this.bus.emit("onDuration", e.payload.duration);
      }),
      await listen<AdvancedPayload>("player-advanced", (e) => {
        this.currentTrackId = e.payload.trackId;
        this.lastPosition = 0;
        this.paused = false;
        this.ended = false;
        this.bus.emit("onAdvanced", e.payload.trackId);
      }),
      await listen("player-ended", () => {
        this.paused = true;
        this.ended = true;
        this.bus.emit("onEnded");
      }),
      await listen("player-play", () => {
        this.paused = false;
        this.bus.emit("onPlay");
      }),
      await listen("player-pause", () => {
        this.paused = true;
        this.bus.emit("onPause");
      }),
      await listen<ErrorPayload>("player-error", (e) => {
        this.bus.emit("onError", e.payload.message);
      }),
    );
  }

  async load(track: EngineTrack, opts: LoadOptions): Promise<void> {
    await this.ready;
    this.currentTrackId = track.id;
    this.lastPosition = opts.seekTo ?? 0;
    this.lastDuration = 0;
    this.paused = !opts.autoplay;
    this.ended = false;
    await invoke("player_load", {
      trackId: track.id,
      path: track.filePath,
      autoplay: opts.autoplay,
      seekTo: opts.seekTo ?? 0,
    });
  }

  unload(): void {
    this.currentTrackId = null;
    invoke("player_stop").catch(() => {});
  }

  // The Rust side never emits `player-play` / `player-pause` (they're only listened for
  // above), so play()/pause() own the state and the events — otherwise isPaused() stays
  // stale and App's onPause handling (cursor flush, podcast settle) never runs.
  async play(): Promise<void> {
    await invoke("player_play");
    this.paused = false;
    this.ended = false;
    this.bus.emit("onPlay");
  }

  pause(): void {
    this.paused = true;
    invoke("player_pause").catch(() => {});
    this.bus.emit("onPause");
  }

  seek(seconds: number): void {
    this.lastPosition = seconds;
    invoke("player_seek", { position: seconds }).catch(() => {});
  }

  setVolume(volume: number): void {
    invoke("player_set_volume", { volume }).catch(() => {});
  }

  setRate(_rate: number): void {
    // Music always plays at 1.0 — the native engine doesn't support
    // pitch-preserving time-stretch (podcasts use HtmlAudioEngine instead).
  }

  setNext(track: EngineTrack | null): void {
    invoke("player_set_next", track ? { trackId: track.id, path: track.filePath } : { trackId: null, path: null })
      .catch(() => {});
  }

  getCurrentTime(): number {
    return this.lastPosition;
  }

  getDuration(): number {
    return this.lastDuration;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isEnded(): boolean {
    return this.ended;
  }

  subscribe(events: Partial<PlayerEngineEvents>): () => void {
    return this.bus.subscribe(events);
  }

  dispose(): void {
    for (const un of this.unlistenFns) un();
    this.unlistenFns = [];
    this.bus.clear();
  }
}
