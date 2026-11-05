package com.voynix.playback

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Timeline
import com.voynix.data.db.TrackEntity

/** How many already-played / upcoming entries around the cursor the session exposes. */
internal const val QUEUE_WINDOW_BEFORE = 20
internal const val QUEUE_WINDOW_AFTER = 179

/**
 * The play queue as a MediaSession sees it (Android Auto's queue, the system
 * media UI). ExoPlayer itself only ever holds "current + next" (see
 * PlayerController.syncNextItem), so [QueuePlayer] reports this instead.
 *
 * One window per play-order entry, in *play* order (so a shuffled queue lists
 * the order it will actually be played). Only a slice around the cursor is
 * exposed — a whole library queue would be thousands of entries pushed over
 * binder on every change. Window `w` is order position `start + w`.
 *
 * Media items are built on demand, and the current entry comes from
 * [currentItem] so it keeps the artwork ExoPlayer's own item carries.
 */
internal class QueueTimeline(
    private val queue: List<TrackEntity>,
    private val order: List<Int>,
    val start: Int,
    private val count: Int,
    private val buildItem: (TrackEntity) -> MediaItem,
    private val currentPos: Int,
    private val currentItem: () -> MediaItem?,
) : Timeline() {

    override fun getWindowCount(): Int = count

    override fun getWindow(windowIndex: Int, window: Window, defaultPositionProjectionUs: Long): Window {
        val track = trackAt(windowIndex)
        val builtItem = buildItem(track)
        // The player's own item for the current entry carries the artwork.
        val item = if (start + windowIndex == currentPos) {
            currentItem()?.takeIf { it.mediaId == builtItem.mediaId } ?: builtItem
        } else {
            builtItem
        }
        val durationUs = track.duration?.takeIf { it > 0 }?.let { (it * 1_000_000).toLong() } ?: C.TIME_UNSET
        return window.set(
            /* uid = */ windowIndex,
            /* mediaItem = */ item,
            /* manifest = */ null,
            /* presentationStartTimeMs = */ C.TIME_UNSET,
            /* windowStartTimeMs = */ C.TIME_UNSET,
            /* elapsedRealtimeEpochOffsetMs = */ C.TIME_UNSET,
            /* isSeekable = */ true,
            /* isDynamic = */ false,
            /* liveConfiguration = */ null,
            /* defaultPositionUs = */ 0L,
            /* durationUs = */ durationUs,
            /* firstPeriodIndex = */ windowIndex,
            /* lastPeriodIndex = */ windowIndex,
            /* positionInFirstPeriodUs = */ 0L,
        )
    }

    override fun getPeriodCount(): Int = count

    override fun getPeriod(periodIndex: Int, period: Period, setIds: Boolean): Period {
        val track = trackAt(periodIndex)
        val durationUs = track.duration?.takeIf { it > 0 }?.let { (it * 1_000_000).toLong() } ?: C.TIME_UNSET
        return period.set(
            /* id = */ if (setIds) periodIndex else null,
            /* uid = */ if (setIds) periodIndex else null,
            /* windowIndex = */ periodIndex,
            /* durationUs = */ durationUs,
            /* positionInWindowUs = */ 0L,
        )
    }

    override fun getIndexOfPeriod(uid: Any): Int =
        (uid as? Int)?.takeIf { it in 0 until count } ?: C.INDEX_UNSET

    override fun getUidOfPeriod(periodIndex: Int): Any = periodIndex

    private fun trackAt(windowIndex: Int): TrackEntity {
        require(windowIndex in 0 until count) { "window $windowIndex out of 0 until $count" }
        return queue[order[start + windowIndex]]
    }

    companion object {
        /** The slice of [orderSize] entries to expose around [pos]: `start` and `count`. */
        fun sliceAround(pos: Int, orderSize: Int): Pair<Int, Int> {
            if (orderSize <= 0) return 0 to 0
            val cursor = pos.coerceIn(0, orderSize - 1)
            val start = (cursor - QUEUE_WINDOW_BEFORE).coerceAtLeast(0)
            val end = (cursor + QUEUE_WINDOW_AFTER + 1).coerceAtMost(orderSize)
            return start to (end - start)
        }
    }
}
