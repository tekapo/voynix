package com.voynix.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ButtonRepushTest {

    @Test
    fun `an empty schedule has no steps`() {
        assertEquals(emptyList<Long>(), repushStepsMs(emptyList()))
    }

    @Test
    fun `a single mark is its own step`() {
        assertEquals(listOf(0L), repushStepsMs(listOf(0)))
        assertEquals(listOf(500L), repushStepsMs(listOf(500)))
    }

    @Test
    fun `steps are the differences between successive marks`() {
        assertEquals(listOf(0L, 700L, 800L, 1_500L), repushStepsMs(listOf(0, 700, 1_500, 3_000)))
    }

    @Test
    fun `steps add up to the last mark`() {
        assertEquals(BUTTON_REPUSH_SCHEDULE_MS.last(), repushStepsMs().sum())
    }

    @Test
    fun `a schedule that does not strictly increase is rejected`() {
        assertThrowsIllegalArgument { repushStepsMs(listOf(0, 500, 500)) }
        assertThrowsIllegalArgument { repushStepsMs(listOf(100, 50)) }
    }

    @Test
    fun `a negative mark is rejected`() {
        assertThrowsIllegalArgument { repushStepsMs(listOf(-1, 100)) }
    }

    @Test
    fun `the default schedule pushes immediately, several times, and outlasts startup`() {
        assertEquals(0L, BUTTON_REPUSH_SCHEDULE_MS.first())
        assertTrue(BUTTON_REPUSH_SCHEDULE_MS.size >= 4)
        // Must outlive restoreLastPlayback() plus a browse-tree burst at connect.
        assertTrue(BUTTON_REPUSH_SCHEDULE_MS.last() >= 10_000L)
    }

    private fun assertThrowsIllegalArgument(block: () -> Unit) {
        try {
            block()
        } catch (_: IllegalArgumentException) {
            return
        }
        throw AssertionError("expected IllegalArgumentException")
    }
}
