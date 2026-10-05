package com.voynix.playback

/** Settings-table key for PlaybackService.markCarPaused()'s "playback was stopped because the car left" marker. */
const val CAR_PAUSED_AT_KEY = "car_paused_at"

/**
 * The counterpart to [shouldPauseOnCarDisconnect] (CarDisconnect.kt): whether
 * a car controller reconnecting should resume playback that was paused
 * because the car went away — "エンジンを入れたら続きが鳴り出す".
 * [carPausedAt] is null when playback was never paused for
 * that reason (a plain user pause, or nothing was playing).
 */
const val CAR_RESUME_WINDOW_MS = 12L * 60 * 60 * 1000 // 12 hours

/**
 * A time window rather than an unconditional resume: without one, getting
 * back in the car a day (or a week) after the last drive would suddenly
 * blast whatever was playing when the engine was last turned off.
 */
fun shouldResumeOnCarConnect(
    connectedPackage: String,
    carPausedAt: Long?,
    now: Long,
): Boolean {
    if (!isCarController(connectedPackage) || carPausedAt == null) return false
    val elapsed = now - carPausedAt
    return elapsed in 0..CAR_RESUME_WINDOW_MS
}

/**
 * media3's [androidx.media3.session.MediaSessionService] only keeps the
 * foreground service alive for
 * [androidx.media3.session.MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS]
 * (10 minutes) after playback pauses, then drops it. A car controller
 * reconnecting *after* that drop calls [androidx.media3.MediaSession]'s
 * play() from onConnect — not from a user gesture the OS recognizes as
 * exempt — so Android 12+'s background-start restrictions block starting a
 * new foreground service and the resume silently does nothing. This was
 * "しばらく経つと自動再生が始まらない": it worked for a quick
 * stop (within 10 minutes) and failed once the car sat longer.
 *
 * The fix: while a car controller is connected, keep the foreground service
 * alive for as long as [shouldResumeOnCarConnect] is willing to resume
 * ([CAR_RESUME_WINDOW_MS]) instead of the 10-minute default, so the pause
 * from the engine turning off never lets the service drop out from under a
 * later reconnect. Once no car controller remains, drop back to the
 * platform default so a plain phone-only session doesn't hold a foreground
 * service for 12 hours after the user stops listening.
 */
const val CAR_PAUSED_FOREGROUND_TIMEOUT_MS = CAR_RESUME_WINDOW_MS

fun foregroundTimeoutFor(connectedPackages: Collection<String>): Long =
    if (connectedPackages.any(::isCarController)) {
        CAR_PAUSED_FOREGROUND_TIMEOUT_MS
    } else {
        androidx.media3.session.MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS
    }
