package com.voynix.playback

import android.os.SystemClock
import android.util.Log
import androidx.media3.common.Player

/**
 * Diagnostic logging for everything that can pause/stop playback in the car —
 * added for a report of "Android Auto で Podcast の再生が5分おきに停止する".
 * There's no DHU that speaks the current Android Auto protocol, so this has to
 * be confirmable from a single real drive via `adb logcat -s VoynixPlayback`.
 * Kept as plain Log.i (not BuildConfig.DEBUG-gated) since the call volume is
 * tiny — a handful of lines per connect/disconnect/state-change, not per tick.
 */
private const val TAG = "VoynixPlayback"

fun playbackLog(msg: String) {
    Log.i(TAG, "${SystemClock.elapsedRealtime() / 1000}s $msg")
}

/** Human-readable name for Player.PLAY_WHEN_READY_CHANGE_REASON_* — falls back to the raw code for anything new. */
fun playWhenReadyChangeReasonName(reason: Int): String = when (reason) {
    Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST -> "USER_REQUEST"
    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS -> "AUDIO_FOCUS_LOSS"
    Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY -> "AUDIO_BECOMING_NOISY"
    Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE -> "REMOTE"
    Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM -> "END_OF_MEDIA_ITEM"
    Player.PLAY_WHEN_READY_CHANGE_REASON_SUPPRESSED_TOO_LONG -> "SUPPRESSED_TOO_LONG"
    else -> "UNKNOWN($reason)"
}

/** Human-readable name for Player.PLAYBACK_SUPPRESSION_REASON_* — falls back to the raw code for anything new. */
fun playbackSuppressionReasonName(reason: Int): String = when (reason) {
    Player.PLAYBACK_SUPPRESSION_REASON_NONE -> "NONE"
    Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS -> "TRANSIENT_AUDIO_FOCUS_LOSS"
    Player.PLAYBACK_SUPPRESSION_REASON_UNSUITABLE_AUDIO_OUTPUT -> "UNSUITABLE_AUDIO_OUTPUT"
    Player.PLAYBACK_SUPPRESSION_REASON_SCRUBBING -> "SCRUBBING"
    else -> "UNKNOWN($reason)"
}

/** Human-readable name for Player.STATE_* — falls back to the raw code for anything new. */
fun playbackStateName(state: Int): String = when (state) {
    Player.STATE_IDLE -> "IDLE"
    Player.STATE_BUFFERING -> "BUFFERING"
    Player.STATE_READY -> "READY"
    Player.STATE_ENDED -> "ENDED"
    else -> "UNKNOWN($state)"
}
