package com.voynix.logic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SleepTimerTest {
    @Test
    fun `sleepTimerDeadlineMs adds minutes to now`() {
        assertEquals(1_000L + 15 * 60_000L, sleepTimerDeadlineMs(nowMs = 1_000L, minutes = 15))
    }

    @Test
    fun `sleepTimerEndOfTrackDeadlineMs lands on the remaining time`() {
        // 120s track, 90s in -> 30s left.
        val deadline = sleepTimerEndOfTrackDeadlineMs(nowMs = 1_000L, positionSecs = 90.0, durationSecs = 120.0)
        assertEquals(1_000L + 30_000L, deadline)
    }

    @Test
    fun `sleepTimerEndOfTrackDeadlineMs halves the wait at 2x speed`() {
        // 120s of audio, 90s in -> 30s of audio left, but at 2x that's 15s of wall-clock time.
        val deadline = sleepTimerEndOfTrackDeadlineMs(nowMs = 1_000L, positionSecs = 90.0, durationSecs = 120.0, speed = 2.0)
        assertEquals(1_000L + 15_000L, deadline)
    }

    @Test
    fun `sleepTimerEndOfTrackDeadlineMs is null with no duration yet`() {
        assertNull(sleepTimerEndOfTrackDeadlineMs(nowMs = 1_000L, positionSecs = 0.0, durationSecs = 0.0))
    }

    @Test
    fun `sleepTimerEndOfTrackDeadlineMs is null at or past the end`() {
        assertNull(sleepTimerEndOfTrackDeadlineMs(nowMs = 1_000L, positionSecs = 120.0, durationSecs = 120.0))
        assertNull(sleepTimerEndOfTrackDeadlineMs(nowMs = 1_000L, positionSecs = 130.0, durationSecs = 120.0))
    }

    @Test
    fun `sleepTimerRemainingMs counts down and floors at zero`() {
        assertEquals(4_000L, sleepTimerRemainingMs(deadlineMs = 10_000L, nowMs = 6_000L))
        assertEquals(0L, sleepTimerRemainingMs(deadlineMs = 10_000L, nowMs = 15_000L))
    }

    @Test
    fun `sleepTimerFired at and past the deadline`() {
        assertFalse(sleepTimerFired(deadlineMs = 10_000L, nowMs = 9_999L))
        assertTrue(sleepTimerFired(deadlineMs = 10_000L, nowMs = 10_000L))
        assertTrue(sleepTimerFired(deadlineMs = 10_000L, nowMs = 10_001L))
    }

    @Test
    fun `formatSleepTimerRemaining pads seconds`() {
        assertEquals("0:00", formatSleepTimerRemaining(0L))
        assertEquals("1:05", formatSleepTimerRemaining(65_000L))
        assertEquals("12:34", formatSleepTimerRemaining(754_000L))
    }
}
