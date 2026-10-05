// Play-count accounting. Kept pure and separate so it can be unit-tested without
// a real <audio> element or the DB.

export interface ListenProgress {
    /** Last observed currentTime, to measure deltas against. */
    last: number;
    /** Seconds actually heard (sum of forward playback, seeks excluded). */
    secs: number;
}

export const emptyListenProgress = (): ListenProgress => ({ last: 0, secs: 0 });

/**
 * Fold one `timeupdate` observation into the running total. A normal tick advances
 * a fraction of a second; a larger jump (or any rewind) is a seek and is not counted.
 */
export function accumulateListened(prev: ListenProgress, currentTime: number): ListenProgress {
    const delta = currentTime - prev.last;
    const heard = delta > 0 && delta < 2 ? delta : 0;
    return { last: currentTime, secs: prev.secs + heard };
}

/** A play counts once the listener has actually heard 30s or 50% of the track. */
export function shouldCountPlay(listenedSecs: number, durationSecs: number): boolean {
    if (listenedSecs >= 30) return true;
    return durationSecs > 0 && listenedSecs / durationSecs >= 0.5;
}

/**
 * Target time for a ±N-second skip button, clamped to the track. A non-positive
 * `duration` (metadata not loaded yet) only clamps the lower bound.
 */
export function skipTarget(currentTime: number, delta: number, duration: number): number {
    const t = Math.max(0, currentTime + delta);
    return duration > 0 ? Math.min(duration, t) : t;
}

// --- Per-file kind + podcast playback state -----------------------------------

export type TrackKind = 'music' | 'podcast' | 'other';
export type PlayState = 'unplayed' | 'in_progress' | 'played';

/** Near the end = within 30s of the end, or past 95% — either counts as "finished". */
export function isNearEnd(position: number, duration: number): boolean {
    if (!(duration > 0)) return false;
    return position >= duration - 30 || position / duration >= 0.95;
}

/**
 * Given where playback is now, return the podcast's next status and the position
 * to persist for resuming. Reaching the end lands on 'played' and rewinds the
 * saved position to 0 (so the next play starts fresh); 'played' is sticky unless
 * the listener deliberately scrubs back before the end.
 */
export function nextPlayState(
    prev: PlayState,
    position: number,
    duration: number,
): { state: PlayState; resume: number } {
    if (isNearEnd(position, duration)) return { state: 'played', resume: 0 };
    if (position <= 1) return { state: prev === 'played' ? 'unplayed' : prev, resume: 0 };
    return { state: 'in_progress', resume: position };
}

// --- Podcast playback speed -----------------------------------------------
// One shared speed setting applies to every podcast (not per-episode); music
// always plays at 1.0x. Persisted as the "podcast_speed" setting.

export const SPEED_PRESETS = [0.8, 1.0, 1.25, 1.5, 1.75, 2.0] as const;

/** Parses a stored speed string; anything invalid or outside the preset range falls back to 1.0. */
export function parseSpeed(raw: string | null | undefined): number {
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return 1.0;
    return SPEED_PRESETS.includes(n as (typeof SPEED_PRESETS)[number]) ? n : 1.0;
}

/** Cycles to the next preset, wrapping back to the first after the last. */
export function nextSpeed(current: number): number {
    const i = SPEED_PRESETS.indexOf(current as (typeof SPEED_PRESETS)[number]);
    return SPEED_PRESETS[(i + 1 + SPEED_PRESETS.length) % SPEED_PRESETS.length];
}

/** Human-readable label, e.g. "1.25x". */
export function formatSpeed(speed: number): string {
    return `${speed}x`;
}

/** Music always plays at 1.0x; only a podcast uses the stored speed. */
export function effectiveSpeed(kind: TrackKind | string | undefined, podcastSpeed: number): number {
    return kind === 'podcast' ? podcastSpeed : 1.0;
}
