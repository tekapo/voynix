// Playback-engine abstraction. App.tsx drives playback entirely through this
// interface instead of touching an <audio> element directly, so the actual
// implementation can be swapped per track kind: `HtmlAudioEngine` (see
// htmlAudioEngine.ts) for podcasts (needs pitch-preserving playbackRate) and,
// once wired in, a native Rust engine for music (true sample-accurate gapless
// transitions — see src-tauri/src/player.rs).
//
// `setNext` is the piece that makes gapless possible: the caller tells the
// engine which track (if any) should play immediately after the current one
// ends, and the engine is responsible for queuing it so there's no gap — or,
// for an engine that can't do that (HtmlAudioEngine), ignoring the hint.
// `onAdvanced` fires when the engine itself transitioned to that queued next
// track (as opposed to the caller driving a manual skip/seek), so App.tsx can
// move its own queue cursor forward without re-issuing a load.

export interface EngineTrack {
  id: string;
  filePath: string;
  fileName: string;
  /** Podcast/music — HtmlAudioEngine only; a native engine plays at 1.0. */
  kind?: string;
}

export interface LoadOptions {
  /** Start playing as soon as enough of the track is available. */
  autoplay: boolean;
  /** Seek to this position (seconds) once playable. */
  seekTo?: number;
  /** Playback rate (pitch-preserving), e.g. podcast speed. Music is always 1.0. */
  rate?: number;
}

export interface PlayerEngineEvents {
  /** Position ticks, ~4/s, while a track is loaded. */
  onPosition: (seconds: number) => void;
  /** Duration becomes known/changes (metadata load, format probe). */
  onDuration: (seconds: number) => void;
  /** Engine transitioned on its own from the loaded track to the queued
   *  `setNext` track — the gapless case. The engine is now playing that
   *  track; the caller should update its own notion of "current" to match
   *  without calling `load()` again (which would restart it). */
  onAdvanced: (trackId: string) => void;
  /** The loaded track played to the end with no `setNext` queued (or the
   *  queued track failed to prepare in time). Distinct from `onAdvanced`:
   *  the caller must still decide + load whatever comes next. */
  onEnded: () => void;
  onPlay: () => void;
  onPause: () => void;
  onError: (message: string) => void;
}

/** Adapts App.tsx's DB-shaped Track into what an engine needs. */
export function toEngineTrack(track: { id: string; file_path: string; file_name: string; kind?: string }): EngineTrack {
  return { id: track.id, filePath: track.file_path, fileName: track.file_name, kind: track.kind };
}

export interface PlayerEngine {
  /** Load a track. Resolves once playback has started (if autoplay) or the
   *  track is ready to play. Rejects on a load/decode error. */
  load(track: EngineTrack, opts: LoadOptions): Promise<void>;
  /** Stop and release whatever is loaded, without emitting onEnded. */
  unload(): void;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  setRate(rate: number): void;
  /** Queue (or clear, with null) the track to play next for a gapless
   *  transition. Safe to call at any time; superseded by the next call. */
  setNext(track: EngineTrack | null): void;
  /** Current playback position, read synchronously (for the ±skip buttons,
   *  which need it before the next onPosition tick). */
  getCurrentTime(): number;
  getDuration(): number;
  isPaused(): boolean;
  /** True once the loaded track has played to its end. An <audio> element
   *  sets this (and fires its `pause` event) *before* firing `ended`, so a
   *  pause handler that needs to tell "the user paused" from "it just
   *  finished" has to check this rather than wait for onEnded. */
  isEnded(): boolean;
  subscribe(events: Partial<PlayerEngineEvents>): () => void;
  dispose(): void;
}
