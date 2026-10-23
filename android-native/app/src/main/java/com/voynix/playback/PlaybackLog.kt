package com.voynix.playback

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.Player
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

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
    appendToLogFile(msg)
}

// A drive's logcat is gone by the time the phone is next on a cable, so the
// same lines also go to a small rotating file in the app's external files dir
// (`adb pull /sdcard/Android/data/com.tekapo.voynix/files/playback.log`).
// Null until PlaybackService.onCreate calls [initPlaybackLogFile] (and in unit tests).
private const val LOG_FILE_NAME = "playback.log"
private const val LOG_FILE_MAX_BYTES = 256 * 1024L

@Volatile
private var logFile: File? = null
private val logExecutor = Executors.newSingleThreadExecutor()

fun initPlaybackLogFile(context: Context) {
    logFile = context.getExternalFilesDir(null)?.let { File(it, LOG_FILE_NAME) }
}

private fun appendToLogFile(msg: String) {
    val file = logFile ?: return
    val line = "${SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())} $msg\n"
    logExecutor.execute {
        try {
            if (file.length() > LOG_FILE_MAX_BYTES) file.renameTo(File(file.parentFile, "$LOG_FILE_NAME.1"))
            file.appendText(line)
        } catch (_: Exception) {
            // Diagnostics only; never let a full disk or missing dir affect playback.
        }
    }
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
