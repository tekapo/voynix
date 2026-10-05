package com.voynix.playback

import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import com.voynix.logic.RepeatMode

/**
 * Wraps the raw ExoPlayer for the MediaSession so external controllers
 * (Android Auto, the lock screen, Bluetooth AVRCP) drive our own
 * queue/shuffle/repeat rules (logic/Queue.kt) instead of ExoPlayer's native
 * single-item "queue" — [PlayerController] never puts more than one
 * MediaItem on the underlying player at a time (see playOrderPos), so the
 * standard Player seek-to-next/previous calls would otherwise be no-ops.
 */
class QueuePlayer(
    basePlayer: Player,
    private val controller: PlayerController,
) : ForwardingPlayer(basePlayer) {

    override fun seekToNext() { controller.next() }
    override fun seekToNextMediaItem() { controller.next() }
    override fun seekToPrevious() { controller.previous() }
    override fun seekToPreviousMediaItem() { controller.previous() }

    // A plain positional seek (the Auto/lock-screen/AVRCP scrubber, or our
    // own ±10s custom command) would otherwise fall straight through
    // ForwardingPlayer to ExoPlayer, bypassing PlayerController.seekTo — and
    // with it, listenProgress/lastSavedPodcastPos. That silently breaks
    // podcast resume position and play-count accounting for any seek that
    // didn't originate from the NowPlaying slider.
    override fun seekTo(positionMs: Long) = controller.seekTo(positionMs / 1000.0)
    override fun seekTo(mediaItemIndex: Int, positionMs: Long) = controller.seekTo(positionMs / 1000.0)

    override fun hasNextMediaItem(): Boolean = controller.uiState.value.queue.size > 1
    override fun hasPreviousMediaItem(): Boolean = controller.uiState.value.queue.size > 1

    override fun getShuffleModeEnabled(): Boolean = controller.uiState.value.shuffle
    override fun setShuffleModeEnabled(shuffleModeEnabled: Boolean) = controller.setShuffle(shuffleModeEnabled)

    override fun getRepeatMode(): Int = when (controller.uiState.value.repeat) {
        RepeatMode.OFF -> Player.REPEAT_MODE_OFF
        RepeatMode.ALL -> Player.REPEAT_MODE_ALL
        RepeatMode.ONE -> Player.REPEAT_MODE_ONE
    }

    override fun setRepeatMode(repeatMode: Int) {
        controller.setRepeat(
            when (repeatMode) {
                Player.REPEAT_MODE_ALL -> RepeatMode.ALL
                Player.REPEAT_MODE_ONE -> RepeatMode.ONE
                else -> RepeatMode.OFF
            }
        )
    }

    override fun getAvailableCommands(): Player.Commands {
        val builder = super.getAvailableCommands().buildUpon()
            .add(Player.COMMAND_SET_SHUFFLE_MODE)
            .add(Player.COMMAND_SET_REPEAT_MODE)
        if (controller.uiState.value.queue.size > 1) {
            builder
                .add(Player.COMMAND_SEEK_TO_NEXT)
                .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        }
        if (controller.uiState.value.currentTrack?.kind == "podcast") {
            builder
                .add(Player.COMMAND_SEEK_BACK)
                .add(Player.COMMAND_SEEK_FORWARD)
        }
        return builder.build()
    }

    // Advertised only while a podcast is current (see getAvailableCommands
    // above) — this is the standard media3/Auto "±10s" affordance, rendered
    // by the platform itself from the increment value with no CommandButton
    // needed, unlike the custom-SessionCommand approach that never rendered
    // on a real DHU 2.1 session no matter what was tried.
    override fun getSeekBackIncrement(): Long = (PODCAST_SKIP_SECS * 1000).toLong()
    override fun getSeekForwardIncrement(): Long = (PODCAST_SKIP_SECS * 1000).toLong()
    override fun seekBack() = controller.skipBy(-PODCAST_SKIP_SECS)
    override fun seekForward() = controller.skipBy(PODCAST_SKIP_SECS)

    override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)
}
