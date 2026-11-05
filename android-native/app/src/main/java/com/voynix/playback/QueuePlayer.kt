package com.voynix.playback

import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.FlagSet
import com.voynix.logic.RepeatMode
import java.util.concurrent.CopyOnWriteArraySet
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Wraps the raw ExoPlayer for the MediaSession so external controllers
 * (Android Auto, the lock screen, Bluetooth AVRCP) drive our own
 * queue/shuffle/repeat rules (logic/Queue.kt) instead of ExoPlayer's native
 * single-item "queue" — [PlayerController] never puts more than one
 * MediaItem on the underlying player at a time (see playOrderPos), so the
 * standard Player seek-to-next/previous calls would otherwise be no-ops.
 *
 * For the same reason the raw timeline is only "current + next", so the
 * session (Android Auto's queue, the system media UI) would list two entries.
 * This wrapper reports the real play queue instead (see [QueueTimeline]) and
 * routes a pick from it to [PlayerController.jumpToOrderPos]. Pass [scope]
 * (the service's main-thread scope) so listeners hear about queue changes
 * that don't touch ExoPlayer's own two-item timeline (enqueue, reorder).
 */
class QueuePlayer(
    basePlayer: Player,
    private val controller: PlayerController,
    scope: CoroutineScope? = null,
) : ForwardingPlayer(basePlayer) {

    private val listeners = CopyOnWriteArraySet<Player.Listener>()
    private var cachedTimeline: QueueTimeline? = null
    private var cachedKey: QueueKey? = null

    init {
        scope?.launch {
            controller.uiState
                .map { QueueKey(it.queue, it.order, it.orderPos) }
                .distinctUntilChanged()
                .drop(1) // the initial value isn't a change
                .collect { notifyQueueChanged() }
        }
    }

    override fun addListener(listener: Player.Listener) {
        listeners.add(listener)
        super.addListener(listener)
    }

    override fun removeListener(listener: Player.Listener) {
        listeners.remove(listener)
        super.removeListener(listener)
    }

    /** Tells listeners (the session) to re-read the timeline and current index. */
    internal fun notifyQueueChanged() {
        val timeline = currentTimeline
        val events = Player.Events(FlagSet.Builder().add(Player.EVENT_TIMELINE_CHANGED).build())
        for (listener in listeners) {
            listener.onTimelineChanged(timeline, Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED)
            listener.onEvents(this, events)
        }
    }

    /** The queue as the session should see it, or null to fall back to ExoPlayer's own timeline. */
    private fun queueTimeline(): QueueTimeline? {
        val s = controller.uiState.value
        if (s.order.isEmpty() || s.currentTrack == null) return null
        val key = QueueKey(s.queue, s.order, s.orderPos)
        cachedTimeline?.let { if (key == cachedKey) return it }
        val (start, count) = QueueTimeline.sliceAround(s.orderPos, s.order.size)
        val timeline = QueueTimeline(
            queue = s.queue,
            order = s.order,
            start = start,
            count = count,
            buildItem = controller::buildMediaItem,
            currentPos = s.orderPos,
            currentItem = { super.getCurrentMediaItem() },
        )
        cachedTimeline = timeline
        cachedKey = key
        return timeline
    }

    override fun getCurrentTimeline(): Timeline = queueTimeline() ?: super.getCurrentTimeline()

    override fun getMediaItemCount(): Int = queueTimeline()?.windowCount ?: super.getMediaItemCount()

    override fun getMediaItemAt(index: Int): MediaItem =
        queueTimeline()?.getWindow(index, Timeline.Window())?.mediaItem ?: super.getMediaItemAt(index)

    override fun getCurrentMediaItemIndex(): Int =
        queueTimeline()?.let { controller.uiState.value.orderPos - it.start } ?: super.getCurrentMediaItemIndex()

    override fun getCurrentPeriodIndex(): Int = currentMediaItemIndex

    override fun getNextMediaItemIndex(): Int {
        val timeline = queueTimeline() ?: return super.getNextMediaItemIndex()
        val s = controller.uiState.value
        val pos = when {
            s.repeat == RepeatMode.ONE -> s.orderPos
            s.orderPos + 1 < s.order.size -> s.orderPos + 1
            s.repeat == RepeatMode.ALL -> 0
            else -> return C.INDEX_UNSET
        }
        return windowOf(timeline, pos)
    }

    override fun getPreviousMediaItemIndex(): Int {
        val timeline = queueTimeline() ?: return super.getPreviousMediaItemIndex()
        val s = controller.uiState.value
        val pos = when {
            s.repeat == RepeatMode.ONE -> s.orderPos
            s.orderPos > 0 -> s.orderPos - 1
            s.repeat == RepeatMode.ALL -> s.order.size - 1
            else -> return C.INDEX_UNSET
        }
        return windowOf(timeline, pos)
    }

    private fun windowOf(timeline: QueueTimeline, orderPos: Int): Int =
        (orderPos - timeline.start).takeIf { it in 0 until timeline.windowCount } ?: C.INDEX_UNSET

    /**
     * A pick of another entry from the exposed queue: start playing it. Returns
     * false when [mediaItemIndex] is the current entry (or there's no queue),
     * so the caller treats it as a plain seek within the current track.
     */
    private fun jumpToOtherEntry(mediaItemIndex: Int): Boolean {
        val timeline = queueTimeline() ?: return false
        val pos = timeline.start + mediaItemIndex
        if (pos == controller.uiState.value.orderPos) return false
        controller.jumpToOrderPos(pos)
        return true
    }

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
    override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
        if (!jumpToOtherEntry(mediaItemIndex)) controller.seekTo(positionMs / 1000.0)
    }

    override fun seekToDefaultPosition(mediaItemIndex: Int) {
        if (!jumpToOtherEntry(mediaItemIndex)) controller.seekTo(0.0)
    }

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
                .add(Player.COMMAND_SEEK_TO_MEDIA_ITEM)
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

/** Identity-based key for "has the queue or cursor changed" — comparing the lists by value would walk every track. */
private class QueueKey(val queue: Any, val order: Any, val pos: Int) {
    override fun equals(other: Any?): Boolean =
        other is QueueKey && queue === other.queue && order === other.order && pos == other.pos

    override fun hashCode(): Int = 31 * (31 * System.identityHashCode(queue) + System.identityHashCode(order)) + pos
}
