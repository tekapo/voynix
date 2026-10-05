package com.voynix.logic

// Play-count / podcast-state accounting, ported from src/playback.ts. Kept
// pure and separate so it can be unit-tested without a real player or the DB.

data class ListenProgress(
    /** Last observed position (seconds), to measure deltas against. */
    val last: Double,
    /** Seconds actually heard (sum of forward playback, seeks excluded). */
    val secs: Double,
) {
    companion object {
        fun empty() = ListenProgress(0.0, 0.0)
    }
}

/**
 * Fold one playback-position observation into the running total. A normal
 * tick advances a fraction of a second; a larger jump (or any rewind) is a
 * seek and is not counted.
 */
fun accumulateListened(prev: ListenProgress, currentTime: Double): ListenProgress {
    val delta = currentTime - prev.last
    val heard = if (delta > 0 && delta < 2) delta else 0.0
    return ListenProgress(last = currentTime, secs = prev.secs + heard)
}

/** A play counts once the listener has actually heard 30s or 50% of the track. */
fun shouldCountPlay(listenedSecs: Double, durationSecs: Double): Boolean {
    if (listenedSecs >= 30) return true
    return durationSecs > 0 && listenedSecs / durationSecs >= 0.5
}

/**
 * Target time for a +/-N-second skip button, clamped to the track. A
 * non-positive [duration] (metadata not loaded yet) only clamps the lower bound.
 */
fun skipTarget(currentTime: Double, delta: Double, duration: Double): Double {
    val t = maxOf(0.0, currentTime + delta)
    return if (duration > 0) minOf(duration, t) else t
}

// --- Per-file kind + podcast playback state -----------------------------------

enum class TrackKind { MUSIC, PODCAST, OTHER }
enum class PlayState { UNPLAYED, IN_PROGRESS, PLAYED }

/** Near the end = within 30s of the end, or past 95% — either counts as "finished". */
fun isNearEnd(position: Double, duration: Double): Boolean {
    if (!(duration > 0)) return false
    return position >= duration - 30 || position / duration >= 0.95
}

/** DB representation of [PlayState] — matches the raw strings used by TrackEntity/TrackDao. */
fun PlayState.toDbString(): String = when (this) {
    PlayState.UNPLAYED -> "unplayed"
    PlayState.IN_PROGRESS -> "in_progress"
    PlayState.PLAYED -> "played"
}

fun playStateFromDb(value: String?): PlayState = when (value) {
    "in_progress" -> PlayState.IN_PROGRESS
    "played" -> PlayState.PLAYED
    else -> PlayState.UNPLAYED
}

data class NextPlayState(val state: PlayState, val resume: Double)

/**
 * Given where playback is now, return the podcast's next status and the
 * position to persist for resuming. Reaching the end lands on PLAYED and
 * rewinds the saved position to 0 (so the next play starts fresh); PLAYED is
 * sticky unless the listener deliberately scrubs back before the end.
 */
fun nextPlayState(prev: PlayState, position: Double, duration: Double): NextPlayState {
    if (isNearEnd(position, duration)) return NextPlayState(PlayState.PLAYED, 0.0)
    if (position <= 1) {
        return NextPlayState(if (prev == PlayState.PLAYED) PlayState.UNPLAYED else prev, 0.0)
    }
    return NextPlayState(PlayState.IN_PROGRESS, position)
}
