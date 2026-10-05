package com.voynix.logic

import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

// Pure play-queue navigation, ported from src/queue.ts. The queue is an
// ordered track list; buildOrder decides the order it's actually played in
// (identity, or a shuffled permutation) and stepOrder moves the cursor
// through that order. No Android dependencies here so the rules stay
// unit-testable in plain JVM tests.

enum class RepeatMode {
    OFF, ALL, ONE;

    /** Next mode when the repeat button is pressed: off -> all -> one -> off. */
    fun cycle(): RepeatMode = when (this) {
        OFF -> ALL
        ALL -> ONE
        ONE -> OFF
    }
}

data class BuildOrderOpts(
    val shuffle: Boolean,
    /** Index pinned to position 0 — keeps the current track playing when shuffle
     *  is switched on mid-song. Ignored when [shuffle] is false or out of range. */
    val first: Int? = null,
    /** Index kept *out* of position 0 — so a reshuffle at the end of a pass
     *  doesn't immediately replay the track that just finished. Ignored when
     *  [first] is given, when out of range, or when length < 2. */
    val avoidFirst: Int? = null,
    /** Injectable for deterministic tests; defaults to Math.random. */
    val rng: () -> Double = Math::random,
)

data class StepResult(
    /** New cursor position within the play order. */
    val pos: Int,
    /** True when a forward pass wrapped: the caller should deal a fresh
     *  permutation (only meaningful while shuffle is on). */
    val reshuffle: Boolean,
)

/** True for a non-empty queue made up entirely of podcast tracks (a Podcast
 *  playlist — the playlist's kind is stamped onto every one of its tracks). */
fun isPodcastQueue(kinds: List<String>): Boolean = kinds.isNotEmpty() && kinds.all { it == "podcast" }

/**
 * Whether a queue should actually be played shuffled. The shuffle toggle is
 * global (it stays on for the next music playlist), but a Podcast queue plays
 * in order when [podcastInOrder] is set. Mirrors src/queue.ts's effectiveShuffle.
 */
fun effectiveShuffle(shuffle: Boolean, podcastInOrder: Boolean, kinds: List<String>): Boolean =
    shuffle && !(podcastInOrder && isPodcastQueue(kinds))

/**
 * The order queue indices are played in: identity [0, 1, … length-1] when
 * [BuildOrderOpts.shuffle] is off, a full Fisher-Yates permutation when it's
 * on. Always a complete permutation of [0, length) — so a pass never repeats
 * a track and, on a 2-3 track queue, is visibly not sequential.
 */
fun buildOrder(length: Int, opts: BuildOrderOpts): List<Int> {
    if (length <= 0) return emptyList()
    val order = IntArray(length) { it }
    if (!opts.shuffle) return order.toList()

    for (i in length - 1 downTo 1) {
        val j = (opts.rng() * (i + 1)).toInt()
        val tmp = order[i]
        order[i] = order[j]
        order[j] = tmp
    }

    fun inRange(n: Int?): Boolean = n != null && n >= 0 && n < length

    if (inRange(opts.first)) {
        val p = order.indexOf(opts.first!!)
        val tmp = order[0]
        order[0] = order[p]
        order[p] = tmp
    } else if (inRange(opts.avoidFirst) && length >= 2 && order[0] == opts.avoidFirst) {
        val p = 1 + (opts.rng() * (length - 1)).toInt()
        val tmp = order[0]
        order[0] = order[p]
        order[p] = tmp
    }
    return order.toList()
}

/**
 * Move the play cursor by [dir]. `null` means stop (forward past the end with
 * repeat OFF). A backward step inside the order lands on the track that
 * actually just played, since normal playback only moves the cursor forward.
 * `reshuffle` is set only when a *forward* pass wraps.
 */
fun stepOrder(pos: Int, length: Int, dir: Int, repeat: RepeatMode): StepResult? {
    if (length <= 0) return null
    val next = pos + dir
    if (next in 0 until length) return StepResult(next, reshuffle = false)

    if (next >= length) {
        // Off the end going forward. ONE wraps like ALL — an explicit skip
        // always advances; the natural-end replay for ONE is handled by the caller.
        return if (repeat == RepeatMode.OFF) null else StepResult(0, reshuffle = true)
    }
    // Off the start going backward: clamp with OFF, jump to the tail otherwise.
    // No reshuffle — entering a fresh permutation from its end isn't history.
    return if (repeat == RepeatMode.OFF) StepResult(0, reshuffle = false)
    else StepResult(length - 1, reshuffle = false)
}

/**
 * Non-destructive lookahead: which queue index would play next if the current
 * track ended right now, without any of [stepOrder]'s side effects (no deal
 * of a fresh shuffle, cursor left untouched). Ported from src/queue.ts's
 * peekNext — used to hand ExoPlayer the track to queue as a second timeline
 * item for a gapless transition (see PlayerController.syncNextItem).
 *
 * Returns `null` when the next step genuinely can't be known yet: past the
 * end of the queue with repeat OFF, or a forward wrap under shuffle — that
 * boundary deals a *fresh* random permutation only once playback actually
 * gets there (see PlayerController.advance), so there's nothing valid to
 * preload.
 */
fun peekNext(pos: Int, order: List<Int>, repeat: RepeatMode, shuffled: Boolean): Int? {
    if (order.isEmpty()) return null
    if (repeat == RepeatMode.ONE) return order.getOrNull(pos)
    val next = pos + 1
    if (next < order.size) return order[next]
    if (repeat == RepeatMode.OFF) return null
    // repeat ALL wraps. Unshuffled, that's just the same order's start — known
    // in advance. Shuffled, the wrap deals a fresh permutation at the real
    // boundary, so nothing here can be predicted.
    return if (shuffled) null else order.getOrNull(0)
}

/**
 * Swap the upcoming entry at [from] with its neighbour in [dir] — the queue
 * panel's up/down buttons. Only entries strictly after [orderPos] can move
 * (the played history and the current track are fixed) and they can't cross
 * the cursor. Returns the same list when the move isn't allowed, so a no-op
 * doesn't trigger a re-render.
 */
fun reorderUpcoming(order: List<Int>, orderPos: Int, from: Int, dir: Int): List<Int> {
    val to = from + dir
    if (from <= orderPos || to <= orderPos || from >= order.size || to >= order.size) {
        return order
    }
    val next = order.toMutableList()
    val tmp = next[from]
    next[from] = next[to]
    next[to] = tmp
    return next
}

/**
 * Drop the upcoming entry at [at] from the play order — the queue panel's X
 * button. Played history and the current track can't be removed. The removal
 * lasts the current pass only: a repeat-ALL wrap deals a fresh permutation
 * over the whole queue. Returns the same list when [at] isn't a removable
 * position.
 */
fun removeUpcoming(order: List<Int>, orderPos: Int, at: Int): List<Int> {
    if (at <= orderPos || at >= order.size) return order
    return order.filterIndexed { i, _ -> i != at }
}

/**
 * The persisted shape of the play queue — track ids (queue order), the play
 * order over them, and the cursor — so a process restart resumes the same
 * playlist/shuffle pass instead of rebuilding from a browse folder.
 */
@Serializable
data class QueueSnapshot(val ids: List<String>, val order: List<Int>, val pos: Int)

private val snapshotJson = Json { ignoreUnknownKeys = true }

fun encodeQueueSnapshot(snapshot: QueueSnapshot): String = snapshotJson.encodeToString(snapshot)

/** Null for a missing or corrupt value — the caller falls back to folder/all-songs restore. */
fun decodeQueueSnapshot(raw: String?): QueueSnapshot? =
    raw?.let { runCatching { snapshotJson.decodeFromString<QueueSnapshot>(it) }.getOrNull() }

/**
 * Moves the cursor onto [trackId] (the last-played track) when the saved
 * cursor points elsewhere — a stale snapshot whose cursor wasn't advanced
 * along with playback. Unchanged when [trackId] is null/absent or already
 * under the cursor.
 */
fun alignSnapshotCursor(snapshot: QueueSnapshot, trackId: String?): QueueSnapshot {
    if (trackId == null) return snapshot
    if (snapshot.ids.getOrNull(snapshot.order.getOrNull(snapshot.pos) ?: return snapshot) == trackId) return snapshot
    val idx = snapshot.ids.indexOf(trackId)
    if (idx < 0) return snapshot
    val pos = snapshot.order.indexOf(idx)
    return if (pos < 0) snapshot else snapshot.copy(pos = pos)
}

/**
 * Drops tracks that no longer exist ([existingIds]) from a saved queue and
 * repairs the play order/cursor around them. When the track under the cursor
 * is gone, the cursor lands on the next surviving entry (or the last one).
 * Null when nothing survives.
 */
fun remapSnapshot(snapshot: QueueSnapshot, existingIds: Set<String>): QueueSnapshot? {
    val newIndexOf = HashMap<Int, Int>()
    val ids = ArrayList<String>()
    snapshot.ids.forEachIndexed { i, id ->
        if (id in existingIds) {
            newIndexOf[i] = ids.size
            ids.add(id)
        }
    }
    val order = ArrayList<Int>()
    var pos = 0
    snapshot.order.forEachIndexed { p, oldIdx ->
        val newIdx = newIndexOf[oldIdx] ?: return@forEachIndexed
        if (p < snapshot.pos) pos++
        order.add(newIdx)
    }
    if (order.isEmpty()) return null
    return QueueSnapshot(ids, order, pos.coerceAtMost(order.size - 1))
}
