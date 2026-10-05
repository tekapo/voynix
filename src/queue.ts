// Pure play-queue navigation. The queue is an ordered track list; `buildOrder`
// decides the order it's actually played in (identity, or a shuffled
// permutation) and `stepOrder` moves the cursor through that order. No DOM or
// React state here so the rules can be unit-tested directly.

export type RepeatMode = "off" | "all" | "one";

export interface BuildOrderOpts {
    shuffle: boolean;
    /** Index pinned to position 0 — keeps the current track playing when shuffle
     *  is switched on mid-song. Ignored when `shuffle` is false or out of range. */
    first?: number;
    /** Index kept *out* of position 0 — so a reshuffle at the end of a pass
     *  doesn't immediately replay the track that just finished. Ignored when
     *  `first` is given, when out of range, or when length < 2. */
    avoidFirst?: number;
    /** Injectable for deterministic tests; defaults to Math.random. */
    rng?: () => number;
}

export interface StepResult {
    /** New cursor position within the play order. */
    pos: number;
    /** True when a forward pass wrapped: the caller should deal a fresh
     *  permutation (only meaningful while shuffle is on). */
    reshuffle: boolean;
}

/** True for a queue made up entirely of podcast tracks (a Podcast playlist —
 *  the playlist's kind is stamped onto every one of its tracks). */
export function isPodcastQueue(tracks: readonly { kind?: string }[]): boolean {
    return tracks.length > 0 && tracks.every(t => t.kind === "podcast");
}

/**
 * Whether `tracks` should actually be played shuffled. The user's shuffle
 * toggle is global (it stays on for the next music playlist), but a Podcast
 * queue plays in order when `podcastInOrder` is set.
 */
export function effectiveShuffle(
    shuffle: boolean,
    podcastInOrder: boolean,
    tracks: readonly { kind?: string }[],
): boolean {
    return shuffle && !(podcastInOrder && isPodcastQueue(tracks));
}

/**
 * The order `queue` indices are played in: identity `[0, 1, … length-1]` when
 * `shuffle` is off, a full Fisher–Yates permutation when it's on. Always a
 * complete permutation of `[0, length)` — so a pass never repeats a track and,
 * on a 2–3 track queue, is visibly not sequential.
 */
export function buildOrder(length: number, opts: BuildOrderOpts): number[] {
    if (length <= 0) return [];
    const order = Array.from({ length }, (_, i) => i);
    if (!opts.shuffle) return order;

    const rng = opts.rng ?? Math.random;
    for (let i = length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }

    const inRange = (n: number | undefined): n is number =>
        n != null && n >= 0 && n < length;

    if (inRange(opts.first)) {
        const p = order.indexOf(opts.first);
        [order[0], order[p]] = [order[p], order[0]];
    } else if (inRange(opts.avoidFirst) && length >= 2 && order[0] === opts.avoidFirst) {
        const p = 1 + Math.floor(rng() * (length - 1));
        [order[0], order[p]] = [order[p], order[0]];
    }
    return order;
}

/**
 * Move the play cursor by `dir`. `null` means stop (forward past the end with
 * repeat "off"). A backward step inside the order lands on the track that
 * actually just played, since normal playback only moves the cursor forward.
 * `reshuffle` is set only when a *forward* pass wraps.
 */
export function stepOrder(
    pos: number,
    length: number,
    dir: 1 | -1,
    opts: { repeat: RepeatMode },
): StepResult | null {
    if (length <= 0) return null;
    const next = pos + dir;
    if (next >= 0 && next < length) return { pos: next, reshuffle: false };

    if (next >= length) {
        // Off the end going forward. "one" wraps like "all" — an explicit ⏭
        // always advances; the natural-end replay for "one" is handled by the caller.
        return opts.repeat === "off" ? null : { pos: 0, reshuffle: true };
    }
    // Off the start going backward: clamp with "off", jump to the tail otherwise.
    // No reshuffle — entering a fresh permutation from its end isn't history.
    return opts.repeat === "off"
        ? { pos: 0, reshuffle: false }
        : { pos: length - 1, reshuffle: false };
}

/**
 * Swap the upcoming entry at `from` with its neighbour in `dir` — the queue
 * panel's ▲/▼ buttons. Only entries strictly after `orderPos` can move (the
 * played history and the current track are fixed) and they can't cross the
 * cursor. Returns the same array reference when the move isn't allowed, so a
 * no-op doesn't trigger a re-render.
 */
export function reorderUpcoming(
    order: number[],
    orderPos: number,
    from: number,
    dir: 1 | -1,
): number[] {
    const to = from + dir;
    if (from <= orderPos || to <= orderPos || from >= order.length || to >= order.length) {
        return order;
    }
    const next = order.slice();
    [next[from], next[to]] = [next[to], next[from]];
    return next;
}

/**
 * Drop the upcoming entry at `at` from the play order — the queue panel's ✕
 * button. Played history and the current track can't be removed. The removal
 * lasts the current pass only: a repeat-"all" wrap deals a fresh permutation
 * over the whole queue. Returns the same array reference when `at` isn't a
 * removable position.
 */
export function removeUpcoming(order: number[], orderPos: number, at: number): number[] {
    if (at <= orderPos || at >= order.length) return order;
    return order.filter((_, i) => i !== at);
}

/**
 * Non-destructive lookahead: which queue index would play next if the current
 * track ended right now, without any of stepOrder's side effects (no deal of
 * a fresh shuffle, cursor left untouched). Used to hand a player engine the
 * track to queue for a gapless transition (see PlayerEngine.setNext).
 *
 * Returns `null` when the next step genuinely can't be known yet: past the
 * end of the queue with repeat "off", or a forward wrap under shuffle — that
 * boundary deals a *fresh* random permutation only once playback actually
 * gets there (see playAdjacent), so there's nothing valid to preload.
 */
export function peekNext(
    pos: number,
    order: number[],
    opts: { repeat: RepeatMode; shuffled: boolean },
): number | null {
    if (order.length <= 0) return null;
    if (opts.repeat === "one") return order[pos] ?? null;
    const next = pos + 1;
    if (next < order.length) return order[next];
    if (opts.repeat === "off") return null;
    // repeat "all" wraps. Unshuffled, that's just the same order's start — known
    // in advance. Shuffled, the wrap deals a fresh permutation at the real
    // boundary, so nothing here can be predicted.
    return opts.shuffled ? null : order[0] ?? null;
}

/** Next mode when the ⏁ repeat button is pressed: off → all → one → off. */
export function cycleRepeat(mode: RepeatMode): RepeatMode {
    return mode === "off" ? "all" : mode === "all" ? "one" : "off";
}
