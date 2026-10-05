package com.voynix.playback

import com.voynix.logic.RepeatMode

// Pure "what buttons does the Android Auto playback screen show right now"
// logic — kept free of media3/Android types (CommandButton, SessionCommand,
// Bundle, …) so it can run in a plain JVM test like BrowseTreeTest, without
// Robolectric. PlaybackService converts this list to real CommandButtons.
//
// Confirmed on a real DHU 2.1 session: standard Player commands
// (COMMAND_SET_SHUFFLE_MODE/REPEAT_MODE, COMMAND_SEEK_BACK/FORWARD) never
// render anything on their own — only custom SessionCommand-backed
// CommandButtons (pushed via the session-wide MediaSession.setCustomLayout /
// setMediaButtonPreferences, retried on a schedule after a car controller
// connects — see ButtonRepush.kt and PlaybackService.startAutoButtonRepush)
// actually show up. So both the shuffle/repeat pair and the podcast ±10s
// pair go through this same mechanism.

/** One Android Auto playback-screen button, independent of its current on/off icon. */
enum class AutoButton {
    SHUFFLE_ON,
    SHUFFLE_OFF,
    REPEAT_OFF,
    REPEAT_ALL,
    REPEAT_ONE,
    SKIP_BACK_10,
    SKIP_FORWARD_10,
}

/** How many seconds the podcast skip buttons move — shared with PlayerController.skipBy. */
const val PODCAST_SKIP_SECS = 10.0

// Custom SessionCommand action strings PlaybackService.onCustomCommand dispatches on.
const val CMD_TOGGLE_SHUFFLE = "com.voynix.TOGGLE_SHUFFLE"
const val CMD_CYCLE_REPEAT = "com.voynix.CYCLE_REPEAT"
const val CMD_SKIP_BACK_10 = "com.voynix.SKIP_BACK_10"
const val CMD_SKIP_FORWARD_10 = "com.voynix.SKIP_FORWARD_10"

/**
 * The buttons the Auto playback screen should show for the current track.
 * Podcasts get a 10s-back/forward pair; everything else gets shuffle/repeat,
 * mirroring NowPlayingScreen's own two toggles.
 */
fun autoButtons(isPodcast: Boolean, shuffle: Boolean, repeat: RepeatMode): List<AutoButton> {
    if (isPodcast) {
        return listOf(AutoButton.SKIP_BACK_10, AutoButton.SKIP_FORWARD_10)
    }
    val shuffleButton = if (shuffle) AutoButton.SHUFFLE_ON else AutoButton.SHUFFLE_OFF
    val repeatButton = when (repeat) {
        RepeatMode.OFF -> AutoButton.REPEAT_OFF
        RepeatMode.ALL -> AutoButton.REPEAT_ALL
        RepeatMode.ONE -> AutoButton.REPEAT_ONE
    }
    return listOf(shuffleButton, repeatButton)
}
