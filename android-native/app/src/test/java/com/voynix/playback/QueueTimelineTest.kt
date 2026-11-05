package com.voynix.playback

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Timeline
import com.voynix.data.db.TrackEntity
import org.junit.Assert.assertEquals
import org.junit.Test

class QueueTimelineTest {
    private fun track(id: String, duration: Double? = 120.0) = TrackEntity(
        id = id, title = "t$id", artist = null, album = null,
        filePath = "/$id.mp3", fileName = "$id.mp3", duration = duration,
    )

    private fun item(track: TrackEntity) = MediaItem.Builder().setMediaId(track.id).build()

    private fun timeline(
        queue: List<TrackEntity>,
        order: List<Int>,
        pos: Int,
        currentItem: () -> MediaItem? = { null },
    ): QueueTimeline {
        val (start, count) = QueueTimeline.sliceAround(pos, order.size)
        return QueueTimeline(queue, order, start, count, ::item, pos, currentItem)
    }

    private fun mediaIds(t: Timeline): List<String> =
        (0 until t.windowCount).map { t.getWindow(it, Timeline.Window()).mediaItem.mediaId }

    @Test
    fun `lists every entry in play order, not queue order`() {
        val queue = listOf(track("a"), track("b"), track("c"))
        val t = timeline(queue, order = listOf(2, 0, 1), pos = 1)

        assertEquals(listOf("c", "a", "b"), mediaIds(t))
        assertEquals(3, t.periodCount)
    }

    @Test
    fun `the current entry keeps the player's own item (with its artwork), others are built`() {
        val queue = listOf(track("a"), track("b"))
        val playerItem = MediaItem.Builder().setMediaId("b").setMediaMetadata(androidx.media3.common.MediaMetadata.Builder().setTitle("with artwork").build()).build()
        val t = timeline(queue, listOf(0, 1), pos = 1) { playerItem }

        assertEquals(playerItem, t.getWindow(1, Timeline.Window()).mediaItem)
        assertEquals(item(queue[0]), t.getWindow(0, Timeline.Window()).mediaItem)
    }

    @Test
    fun `a stale player item for another track is ignored`() {
        val queue = listOf(track("a"), track("b"))
        val stale = MediaItem.Builder().setMediaId("a").build()
        val t = timeline(queue, listOf(0, 1), pos = 1) { stale }

        assertEquals("b", t.getWindow(1, Timeline.Window()).mediaItem.mediaId)
    }

    @Test
    fun `duration comes from the track, unset when unknown`() {
        val queue = listOf(track("a", 90.0), track("b", null))
        val t = timeline(queue, listOf(0, 1), pos = 0)

        assertEquals(90_000_000L, t.getWindow(0, Timeline.Window()).durationUs)
        assertEquals(C.TIME_UNSET, t.getWindow(1, Timeline.Window()).durationUs)
    }

    @Test
    fun `period uids round-trip through getIndexOfPeriod`() {
        val t = timeline(listOf(track("a"), track("b")), listOf(0, 1), pos = 0)

        assertEquals(1, t.getIndexOfPeriod(t.getUidOfPeriod(1)))
        assertEquals(C.INDEX_UNSET, t.getIndexOfPeriod("nope"))
        assertEquals(C.INDEX_UNSET, t.getIndexOfPeriod(5))
    }

    @Test
    fun `a long queue only exposes a slice around the cursor`() {
        val n = 1000
        val queue = (0 until n).map { track("t$it") }
        val order = (0 until n).toList()

        val middle = QueueTimeline.sliceAround(500, n)
        assertEquals(500 - QUEUE_WINDOW_BEFORE, middle.first)
        assertEquals(QUEUE_WINDOW_BEFORE + 1 + QUEUE_WINDOW_AFTER, middle.second)

        assertEquals(0 to (QUEUE_WINDOW_AFTER + 1), QueueTimeline.sliceAround(0, n))

        val end = QueueTimeline.sliceAround(n - 1, n)
        assertEquals(n - 1 - QUEUE_WINDOW_BEFORE, end.first)
        assertEquals(n, end.first + end.second)

        // Window 0 is order position `start`.
        val t = timeline(queue, order, pos = 500)
        assertEquals("t${500 - QUEUE_WINDOW_BEFORE}", t.getWindow(0, Timeline.Window()).mediaItem.mediaId)
    }

    @Test
    fun `an empty queue has an empty slice`() {
        assertEquals(0 to 0, QueueTimeline.sliceAround(0, 0))
    }
}
