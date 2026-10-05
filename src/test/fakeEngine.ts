// Test double for PlayerEngine. No <audio> element, no Tauri IPC — App tests
// drive playback by calling the `fire*` helpers instead of dispatching DOM
// events on a mocked <audio> element. Call `installFakeEngine()` (anywhere
// before `render(<App/>)` — it only overrides createEngine()'s *next* call,
// which useAudioPlayer makes lazily at render time) and drive the instance it
// returns.

import { __setEngineFactoryForTests } from "../player/createEngine";
import { EngineTrack, LoadOptions, PlayerEngine, PlayerEngineEvents } from "../player/engine";

export class FakeEngine implements PlayerEngine {
  loaded: EngineTrack | null = null;
  lastLoadOpts: LoadOptions | null = null;
  loadCalls: { track: EngineTrack; opts: LoadOptions }[] = [];
  next: EngineTrack | null = null;
  currentTime = 0;
  duration = 0;
  volume = 1;
  rate = 1;
  private paused = true;
  private ended = false;
  private listeners = new Set<Partial<PlayerEngineEvents>>();

  async load(track: EngineTrack, opts: LoadOptions): Promise<void> {
    // A real microtask gap here, matching NativeEngine.load's leading
    // `await this.ready` — significant because setNext() below has no such
    // gap (mirroring the real engine, whose setNext() invoke() call has no
    // leading await either). A caller that fires both in the same render
    // (the norm: the load effect kicks this off, then the reactive setNext
    // effect runs synchronously right after) will have its setNext() land
    // *before* this resolves unless it also calls setNext again afterward —
    // exactly the race App.tsx's updateEngineNext() guards against.
    await Promise.resolve();
    this.loadCalls.push({ track, opts });
    this.loaded = track;
    this.lastLoadOpts = opts;
    this.currentTime = opts.seekTo ?? 0;
    this.rate = opts.rate ?? 1;
    this.ended = false;
    this.paused = !opts.autoplay;
    if (opts.autoplay) this.emit("onPlay");
  }

  unload(): void {
    this.loaded = null;
    this.paused = true;
  }

  async play(): Promise<void> {
    this.paused = false;
    this.emit("onPlay");
  }

  pause(): void {
    this.paused = true;
    this.emit("onPause");
  }

  seek(seconds: number): void {
    this.currentTime = seconds;
  }

  setVolume(volume: number): void {
    this.volume = volume;
  }

  setRate(rate: number): void {
    this.rate = rate;
  }

  setNext(track: EngineTrack | null): void {
    // Mirrors the real (Rust-side) engine's guard: queuing a "next" track
    // makes no sense before anything is actually loaded, and silently
    // dropping the call here is what makes the load-effect race above
    // observable in a test — a setNext() that arrives before load() has
    // resolved is simply lost, not queued for later.
    if (!this.loaded) return;
    this.next = track;
  }

  getCurrentTime(): number {
    return this.currentTime;
  }

  getDuration(): number {
    return this.duration;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isEnded(): boolean {
    return this.ended;
  }

  subscribe(events: Partial<PlayerEngineEvents>): () => void {
    this.listeners.add(events);
    return () => this.listeners.delete(events);
  }

  dispose(): void {
    this.listeners.clear();
  }

  private emit<K extends keyof PlayerEngineEvents>(event: K, ...args: Parameters<PlayerEngineEvents[K]>) {
    for (const l of this.listeners) (l[event] as any)?.(...args);
  }

  // --- Test-only helpers, not part of PlayerEngine ---

  /** Simulate a `timeupdate` tick (and, if given, a duration report). */
  fireTick(time: number, duration?: number): void {
    this.currentTime = time;
    if (duration != null) this.duration = duration;
    this.emit("onPosition", time);
    if (duration != null) this.emit("onDuration", duration);
  }

  /** Simulate the loaded track playing to its end with no `setNext` queued
   *  (or a queued one that didn't take over). */
  fireEnded(): void {
    this.ended = true;
    this.paused = true;
    this.emit("onEnded");
  }

  /** Simulate a gapless transition onto whatever `setNext` last queued. */
  fireAdvanced(): void {
    const nextTrack = this.next;
    if (!nextTrack) throw new Error("fireAdvanced() called with no track queued via setNext()");
    this.loaded = nextTrack;
    this.next = null;
    this.currentTime = 0;
    this.ended = false;
    this.paused = false;
    this.emit("onAdvanced", nextTrack.id);
  }

  fireError(message: string): void {
    this.emit("onError", message);
  }
}

/** Installs a fresh FakeEngine as the next thing useAudioPlayer's
 *  `createEngine()` call returns. Typically called once per test (e.g. in
 *  `beforeEach`), before rendering the component under test. */
export function installFakeEngine(): FakeEngine {
  const engine = new FakeEngine();
  __setEngineFactoryForTests(() => engine);
  return engine;
}
