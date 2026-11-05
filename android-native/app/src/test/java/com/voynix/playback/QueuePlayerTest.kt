package com.voynix.playback

import androidx.media3.common.Player
import com.voynix.data.db.TrackEntity
import com.voynix.logic.RepeatMode
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Test
import org.mockito.kotlin.mock
import org.mockito.kotlin.never
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever

/**
 * QueuePlayer only exists to reroute transport calls a MediaSession
 * controller (Android Auto, lock screen, AVRCP) makes onto PlayerController's
 * own queue/shuffle/repeat rules instead of the raw ExoPlayer — see the class
 * doc. No Robolectric needed: [player] and [controller] are both mocked, so
 * this never touches real Android/ExoPlayer internals.
 */
class QueuePlayerTest {
    private val player: Player = mock()
    private val state = MutableStateFlow(PlayerUiState())
    private val controller: PlayerController = mock<PlayerController>().also { whenever(it.uiState).thenReturn(state) }
    private val queuePlayer = QueuePlayer(player, controller)

    private fun track(id: String) = TrackEntity(
        id = id, title = id, artist = null, album = null,
        filePath = "/$id.mp3", fileName = "$id.mp3", duration = 60.0,
    )

    /** A 3-track queue played c, a, b with the cursor on [pos]. */
    private fun playQueue(pos: Int, repeat: RepeatMode = RepeatMode.OFF) {
        val queue = listOf(track("a"), track("b"), track("c"))
        state.value = PlayerUiState(
            queue = queue, order = listOf(2, 0, 1), orderPos = pos,
            currentTrack = queue[listOf(2, 0, 1)[pos]], repeat = repeat,
        )
        whenever(controller.buildMediaItem(org.mockito.kotlin.any())).thenAnswer {
            androidx.media3.common.MediaItem.Builder().setMediaId((it.arguments[0] as TrackEntity).id).build()
        }
    }

    @Test
    fun `seekTo(positionMs) routes through the controller instead of the raw player`() {
        queuePlayer.seekTo(42_000L)

        verify(controller).seekTo(42.0)
    }

    @Test
    fun `seekTo(mediaItemIndex, positionMs) also routes through the controller`() {
        queuePlayer.seekTo(0, 15_000L)

        verify(controller).seekTo(15.0)
    }

    @Test
    fun `seekBack and seekForward route through the controller's skipBy`() {
        queuePlayer.seekBack()
        queuePlayer.seekForward()

        verify(controller).skipBy(-PODCAST_SKIP_SECS)
        verify(controller).skipBy(PODCAST_SKIP_SECS)
    }

    @Test
    fun `seek increments are 10 seconds`() {
        org.junit.Assert.assertEquals(10_000L, queuePlayer.seekBackIncrement)
        org.junit.Assert.assertEquals(10_000L, queuePlayer.seekForwardIncrement)
    }

    @Test
    fun `without a queue it falls back to the raw player's seek`() {
        queuePlayer.seekTo(3, 5_000L)

        verify(controller).seekTo(5.0)
        verify(controller, never()).jumpToOrderPos(org.mockito.kotlin.any())
    }

    @Test
    fun `reports the whole queue in play order with the cursor on the current entry`() {
        playQueue(pos = 1)

        assertEquals(3, queuePlayer.mediaItemCount)
        assertEquals(listOf("c", "a", "b"), (0 until 3).map { queuePlayer.getMediaItemAt(it).mediaId })
        assertEquals(1, queuePlayer.currentMediaItemIndex)
        assertEquals(1, queuePlayer.currentPeriodIndex)
    }

    @Test
    fun `picking another queue entry jumps there instead of seeking`() {
        playQueue(pos = 1)

        queuePlayer.seekTo(2, 0L)
        queuePlayer.seekToDefaultPosition(0)

        verify(controller).jumpToOrderPos(2)
        verify(controller).jumpToOrderPos(0)
        verify(controller, never()).seekTo(org.mockito.kotlin.any())
    }

    @Test
    fun `seeking within the current entry stays a plain seek`() {
        playQueue(pos = 1)

        queuePlayer.seekTo(1, 7_000L)
        queuePlayer.seekToDefaultPosition(1)

        verify(controller).seekTo(7.0)
        verify(controller).seekTo(0.0)
        verify(controller, never()).jumpToOrderPos(org.mockito.kotlin.any())
    }

    @Test
    fun `next and previous indexes follow repeat mode and the ends of the queue`() {
        playQueue(pos = 0)
        assertEquals(androidx.media3.common.C.INDEX_UNSET, queuePlayer.previousMediaItemIndex)
        assertEquals(1, queuePlayer.nextMediaItemIndex)

        playQueue(pos = 2)
        assertEquals(androidx.media3.common.C.INDEX_UNSET, queuePlayer.nextMediaItemIndex)

        playQueue(pos = 2, repeat = RepeatMode.ALL)
        assertEquals(0, queuePlayer.nextMediaItemIndex)
        playQueue(pos = 0, repeat = RepeatMode.ALL)
        assertEquals(2, queuePlayer.previousMediaItemIndex)

        playQueue(pos = 1, repeat = RepeatMode.ONE)
        assertEquals(1, queuePlayer.nextMediaItemIndex)
    }

    @Test
    fun `notifyQueueChanged tells listeners the timeline changed`() {
        playQueue(pos = 0)
        val listener: Player.Listener = mock()
        queuePlayer.addListener(listener)

        queuePlayer.notifyQueueChanged()

        verify(listener).onTimelineChanged(org.mockito.kotlin.any(), org.mockito.kotlin.eq(Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED))
        verify(listener).onEvents(org.mockito.kotlin.eq(queuePlayer), org.mockito.kotlin.any())
    }
}
