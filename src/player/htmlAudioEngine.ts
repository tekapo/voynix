// PlayerEngine backed by a plain <audio> element. Used for every podcast
// (needs pitch-preserving speed, which rodio's `Sink::set_speed` does not
// give us — see src-tauri/src/player.rs) and, until the native engine lands,
// nothing else. Ports the old inline App.tsx load-and-play effect + <audio>
// JSX handlers verbatim; behavior is unchanged from before this file existed.
//
// The element is created detached (`new Audio()`, never inserted into the
// DOM) — Chromium/WebKit play a detached element identically to a mounted
// one, and user-activation for `play()` depends on the call happening inside
// a user-gesture handler, not on the element's attachment.

import { readFile } from "@tauri-apps/plugin-fs";
import { createEventBus } from "../lib/eventBus";
import { EngineTrack, LoadOptions, PlayerEngine, PlayerEngineEvents } from "./engine";

function mimeTypeFor(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "m4a") return "audio/mp4";
  if (ext === "flac") return "audio/flac";
  if (ext === "wav") return "audio/wav";
  return "audio/mpeg";
}

export class HtmlAudioEngine implements PlayerEngine {
  private el: HTMLAudioElement;
  private objectUrl: string | null = null;
  private bus = createEventBus<PlayerEngineEvents>();
  private loadSeq = 0;

  constructor() {
    this.el = new Audio();
    this.el.addEventListener("ended", () => this.bus.emit("onEnded"));
    this.el.addEventListener("play", () => this.bus.emit("onPlay"));
    this.el.addEventListener("pause", () => this.bus.emit("onPause"));
    this.el.addEventListener("timeupdate", () => this.bus.emit("onPosition", this.el.currentTime));
    this.el.addEventListener("loadedmetadata", () => this.bus.emit("onDuration", this.el.duration || 0));
    this.el.addEventListener("durationchange", () => this.bus.emit("onDuration", this.el.duration || 0));
    this.el.addEventListener("error", () => {
      const err = this.el.error;
      this.bus.emit("onError", `Code ${err?.code} - ${err?.message}`);
    });
  }

  private revokeObjectUrl() {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  async load(track: EngineTrack, opts: LoadOptions): Promise<void> {
    const seq = ++this.loadSeq;
    this.el.pause();
    this.revokeObjectUrl();

    const data = await readFile(track.filePath);
    if (seq !== this.loadSeq) return; // superseded by a newer load() while awaiting readFile

    const blob = new Blob([data], { type: mimeTypeFor(track.fileName) });
    this.objectUrl = URL.createObjectURL(blob);
    this.el.src = this.objectUrl;
    this.el.load();
    // Assigning `src` resets playbackRate to 1.
    this.el.playbackRate = opts.rate ?? 1;

    if (opts.autoplay) {
      await this.el.play();
      if (seq !== this.loadSeq) return;
    }
    // Seeking must happen after play() — assigning currentTime before the
    // source is ready is silently ignored on some WebViews.
    if (opts.seekTo && opts.seekTo > 1) {
      try { this.el.currentTime = opts.seekTo; } catch { /* not seekable yet */ }
    }
  }

  unload(): void {
    this.loadSeq++; // invalidate any in-flight load()
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
    this.revokeObjectUrl();
  }

  async play(): Promise<void> {
    await this.el.play();
  }

  pause(): void {
    this.el.pause();
  }

  seek(seconds: number): void {
    this.el.currentTime = seconds;
  }

  setVolume(volume: number): void {
    this.el.volume = volume;
  }

  setRate(rate: number): void {
    this.el.playbackRate = rate;
  }

  setNext(_track: EngineTrack | null): void {
    // Not supported: an <audio> element can't queue a second source without a
    // gap. Podcasts (the only user of this engine) don't need gapless.
  }

  getCurrentTime(): number {
    return this.el.currentTime;
  }

  getDuration(): number {
    return this.el.duration || 0;
  }

  isPaused(): boolean {
    return this.el.paused;
  }

  isEnded(): boolean {
    return this.el.ended;
  }

  subscribe(events: Partial<PlayerEngineEvents>): () => void {
    return this.bus.subscribe(events);
  }

  dispose(): void {
    this.unload();
    this.bus.clear();
  }
}
