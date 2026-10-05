package com.voynix.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NowPlayingLocatorTest {
    @Test
    fun `nowPlayingDirection is null when the track isn't in the list`() {
        assertNull(nowPlayingDirection(-1, 0, 10))
    }

    @Test
    fun `nowPlayingDirection is null when already within the visible range`() {
        assertNull(nowPlayingDirection(5, 0, 10))
        assertNull(nowPlayingDirection(0, 0, 10))
        assertNull(nowPlayingDirection(10, 0, 10))
    }

    @Test
    fun `nowPlayingDirection is ABOVE when the index precedes the visible range`() {
        assertEquals(NowPlayingDirection.ABOVE, nowPlayingDirection(3, 10, 20))
    }

    @Test
    fun `nowPlayingDirection is BELOW when the index follows the visible range`() {
        assertEquals(NowPlayingDirection.BELOW, nowPlayingDirection(25, 10, 20))
    }

    @Test
    fun `markerFraction is 0 for the first item`() {
        assertEquals(0f, markerFraction(0, 100), 0.0001f)
    }

    @Test
    fun `markerFraction is 1 for the last item`() {
        assertEquals(1f, markerFraction(99, 100), 0.0001f)
    }

    @Test
    fun `markerFraction is proportional in between`() {
        assertEquals(0.5f, markerFraction(50, 101), 0.0001f)
    }

    @Test
    fun `markerFraction is 0 for a negative index or a degenerate list`() {
        assertEquals(0f, markerFraction(-1, 100), 0.0001f)
        assertEquals(0f, markerFraction(0, 1), 0.0001f)
        assertEquals(0f, markerFraction(0, 0), 0.0001f)
    }
}
