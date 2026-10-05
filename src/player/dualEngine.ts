// Routes playback to HtmlAudioEngine for podcasts (pitch-preserving speed) and
// NativeEngine for everything else (true gapless). Both underlying engines are
// long-lived — switching kinds doesn't tear anything down beyond unloading the
// one that was active — so a library that mixes podcasts and music keeps
// gapless transitions within each run of music tracks.

import { createEventBus } from "../lib/eventBus";
import { EngineTrack, LoadOptions, PlayerEngine, PlayerEngineEvents } from "./engine";
import { HtmlAudioEngine } from "./htmlAudioEngine";
import { NativeEngine } from "./nativeEngine";

export class DualEngine implements PlayerEngine {
  private html: PlayerEngine;
  private native: PlayerEngine;
  private active: PlayerEngine;
  private unsubscribers: (() => void)[] = [];
  private bus = createEventBus<PlayerEngineEvents>();

  constructor(html: PlayerEngine = new HtmlAudioEngine(), native: PlayerEngine = new NativeEngine()) {
    this.html = html;
    this.native = native;
    this.active = this.native;
    this.attach(this.html);
    this.attach(this.native);
  }

  private attach(engine: PlayerEngine) {
    const relay: Partial<PlayerEngineEvents> = {
      onPosition: (t) => { if (engine === this.active) this.bus.emit("onPosition", t); },
      onDuration: (d) => { if (engine === this.active) this.bus.emit("onDuration", d); },
      onAdvanced: (id) => { if (engine === this.active) this.bus.emit("onAdvanced", id); },
      onEnded: () => { if (engine === this.active) this.bus.emit("onEnded"); },
      onPlay: () => { if (engine === this.active) this.bus.emit("onPlay"); },
      onPause: () => { if (engine === this.active) this.bus.emit("onPause"); },
      onError: (m) => { if (engine === this.active) this.bus.emit("onError", m); },
    };
    this.unsubscribers.push(engine.subscribe(relay));
  }

  private engineFor(track: EngineTrack): PlayerEngine {
    return track.kind === "podcast" ? this.html : this.native;
  }

  async load(track: EngineTrack, opts: LoadOptions): Promise<void> {
    const next = this.engineFor(track);
    if (next !== this.active) {
      this.active.unload();
      this.active = next;
    }
    await this.active.load(track, opts);
  }

  unload(): void {
    this.active.unload();
  }

  play(): Promise<void> {
    return this.active.play();
  }

  pause(): void {
    this.active.pause();
  }

  seek(seconds: number): void {
    this.active.seek(seconds);
  }

  setVolume(volume: number): void {
    // Applied to both, not just `active` — a mid-session switch (music ->
    // podcast or back) shouldn't jump volume before the next load() call.
    this.html.setVolume(volume);
    this.native.setVolume(volume);
  }

  setRate(rate: number): void {
    this.active.setRate(rate);
  }

  setNext(track: EngineTrack | null): void {
    if (track && this.engineFor(track) === this.active) {
      this.active.setNext(track);
    } else {
      // Either clearing the hint, or the next track needs the other engine —
      // no engine can gaplessly bridge podcast <-> music, so don't pretend to.
      this.active.setNext(null);
    }
  }

  getCurrentTime(): number {
    return this.active.getCurrentTime();
  }

  getDuration(): number {
    return this.active.getDuration();
  }

  isPaused(): boolean {
    return this.active.isPaused();
  }

  isEnded(): boolean {
    return this.active.isEnded();
  }

  subscribe(events: Partial<PlayerEngineEvents>): () => void {
    return this.bus.subscribe(events);
  }

  dispose(): void {
    for (const un of this.unsubscribers) un();
    this.unsubscribers = [];
    this.html.dispose();
    this.native.dispose();
    this.bus.clear();
  }
}
