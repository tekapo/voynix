package com.voynix.playback

import androidx.media3.common.Player
import org.junit.Test
import org.mockito.kotlin.mock
import org.mockito.kotlin.verify

/**
 * QueuePlayer only exists to reroute transport calls a MediaSession
 * controller (Android Auto, lock screen, AVRCP) makes onto PlayerController's
 * own queue/shuffle/repeat rules instead of the raw ExoPlayer — see the class
 * doc. No Robolectric needed: [player] and [controller] are both mocked, so
 * this never touches real Android/ExoPlayer internals.
 */
class QueuePlayerTest {
    private val player: Player = mock()
    private val controller: PlayerController = mock()
    private val queuePlayer = QueuePlayer(player, controller)

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
}
