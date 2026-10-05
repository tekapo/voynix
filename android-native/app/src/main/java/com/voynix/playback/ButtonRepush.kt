package com.voynix.playback

// Pure schedule for re-pushing the Android Auto custom buttons after a car
// controller connects — kept free of media3/coroutine types so it runs in a
// plain JVM test like AutoButtons.kt / CarDisconnect.kt.
//
// Why a ladder of session-wide pushes instead of one per-controller push
// (verified by decompiling media3-session 1.11.0):
//  - MediaSession.setCustomLayout(controller, …) / setMediaButtonPreferences(
//    controller, …) reach the target controller's ControllerCb, and Auto's
//    legacy callbacks (ControllerLegacyCb / BrowserLegacyCb) don't implement
//    those methods — the per-controller call is a no-op for Auto. Only the
//    list-only overloads republish the PlaybackStateCompat custom actions.
//  - MediaSessionLegacyStub only turns a button into a custom action when
//    its command is in the stub's own availableSessionCommands, which starts
//    as DEFAULT_SESSION_AND_LIBRARY_COMMANDS (no CMD_* of ours) and is only
//    replaced once media3's media-notification controller connects. A push
//    that lands before that is silently dropped, so it's retried a few times.

/** Elapsed times (ms) after a car controller connects at which the buttons are re-pushed. */
val BUTTON_REPUSH_SCHEDULE_MS: List<Long> = listOf(0, 700, 1_500, 3_000, 6_000, 12_000)

/**
 * The incremental delay() amounts a coroutine sleeps to hit [schedule]'s
 * elapsed-time marks in order. [schedule] must be non-negative and strictly
 * increasing.
 */
fun repushStepsMs(schedule: List<Long> = BUTTON_REPUSH_SCHEDULE_MS): List<Long> {
    var previous = 0L
    return schedule.mapIndexed { i, mark ->
        require(mark >= 0) { "negative mark $mark" }
        require(i == 0 || mark > previous) { "schedule must be strictly increasing: $previous then $mark" }
        (mark - previous).also { previous = mark }
    }
}
