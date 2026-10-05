package com.voynix.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackTest {
    @Test
    fun `accumulateListened counts a normal forward tick`() {
        val p = accumulateListened(ListenProgress(last = 10.0, secs = 5.0), 10.5)
        assertEquals(10.5, p.last, 0.0001)
        assertEquals(5.5, p.secs, 0.0001)
    }

    @Test
    fun `accumulateListened ignores a seek jump`() {
        val p = accumulateListened(ListenProgress(last = 10.0, secs = 5.0), 40.0)
        assertEquals(5.0, p.secs, 0.0001)
    }

    @Test
    fun `accumulateListened ignores rewind`() {
        val p = accumulateListened(ListenProgress(last = 10.0, secs = 5.0), 3.0)
        assertEquals(5.0, p.secs, 0.0001)
    }

    @Test
    fun `shouldCountPlay at 30s threshold`() {
        assertTrue(shouldCountPlay(30.0, 1000.0))
        assertFalse(shouldCountPlay(29.9, 1000.0))
    }

    @Test
    fun `shouldCountPlay at 50 percent threshold`() {
        assertTrue(shouldCountPlay(10.0, 20.0))
        assertFalse(shouldCountPlay(9.0, 20.0))
    }

    @Test
    fun `skipTarget clamps to 0 and duration`() {
        assertEquals(0.0, skipTarget(5.0, -30.0, 100.0), 0.0001)
        assertEquals(100.0, skipTarget(90.0, 30.0, 100.0), 0.0001)
        assertEquals(45.0, skipTarget(30.0, 15.0, 100.0), 0.0001)
    }

    @Test
    fun `isNearEnd within 30s of the end`() {
        assertTrue(isNearEnd(75.0, 100.0))
        assertFalse(isNearEnd(60.0, 100.0))
    }

    @Test
    fun `isNearEnd past 95 percent`() {
        assertTrue(isNearEnd(96.0, 100.0))
    }

    @Test
    fun `nextPlayState reaching the end marks played and resets resume`() {
        val r = nextPlayState(PlayState.IN_PROGRESS, 99.0, 100.0)
        assertEquals(PlayState.PLAYED, r.state)
        assertEquals(0.0, r.resume, 0.0001)
    }

    @Test
    fun `nextPlayState at the very start resets a played track to unplayed`() {
        val r = nextPlayState(PlayState.PLAYED, 0.5, 100.0)
        assertEquals(PlayState.UNPLAYED, r.state)
    }

    @Test
    fun `nextPlayState at the very start keeps a non-played state as-is`() {
        val r = nextPlayState(PlayState.IN_PROGRESS, 0.5, 100.0)
        assertEquals(PlayState.IN_PROGRESS, r.state)
    }

    @Test
    fun `nextPlayState mid-track is in_progress with resume position`() {
        val r = nextPlayState(PlayState.UNPLAYED, 42.0, 100.0)
        assertEquals(PlayState.IN_PROGRESS, r.state)
        assertEquals(42.0, r.resume, 0.0001)
    }
}
