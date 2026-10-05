package com.voynix.logic

// Sleep-timer time math, kept pure and separate (like Playback.kt) so it can
// be unit-tested without a real player, clock, or coroutine scope. The
// timer is wall-clock based (a deadline in epoch ms), not tied to playback
// ticks — it keeps counting down whether or not something is actually
// playing, same as any other sleep timer.

/** Deadline for a fixed-duration timer ("15分" etc.). */
fun sleepTimerDeadlineMs(nowMs: Long, minutes: Int): Long = nowMs + minutes * 60_000L

/**
 * Deadline that lands exactly when the current track/episode finishes, from
 * its playback position right now. Null when there's nothing left to play
 * (no duration yet, or already at/past the end) — the caller shouldn't arm a
 * timer that would never fire. [speed] is the current playback speed (1.0 for
 * normal speed, >1.0 for sped-up podcasts) — the wall-clock time left is the
 * remaining *audio* time divided by speed, since a 2x podcast reaches its end
 * in half the real time.
 */
fun sleepTimerEndOfTrackDeadlineMs(
    nowMs: Long,
    positionSecs: Double,
    durationSecs: Double,
    speed: Double = 1.0,
): Long? {
    if (durationSecs <= 0) return null
    val remainingSecs = durationSecs - positionSecs
    if (remainingSecs <= 0) return null
    return nowMs + (remainingSecs / speed * 1000).toLong()
}

/** Time left until [deadlineMs], never negative. */
fun sleepTimerRemainingMs(deadlineMs: Long, nowMs: Long): Long = (deadlineMs - nowMs).coerceAtLeast(0)

/** Whether the timer should fire (pause playback) by now. */
fun sleepTimerFired(deadlineMs: Long, nowMs: Long): Boolean = nowMs >= deadlineMs

/** "MM:SS" for the remaining time, e.g. for a NowPlayingScreen label. */
fun formatSleepTimerRemaining(remainingMs: Long): String {
    val totalSecs = (remainingMs / 1000).coerceAtLeast(0)
    val mins = totalSecs / 60
    val secs = totalSecs % 60
    return "$mins:${secs.toString().padStart(2, '0')}"
}
