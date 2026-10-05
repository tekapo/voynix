package com.voynix.logic

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackSpeedTest {
    @Test
    fun `parseSpeed parses a valid preset`() {
        assertEquals(1.5f, parseSpeed("1.5"))
        assertEquals(0.8f, parseSpeed("0.8"))
    }

    @Test
    fun `parseSpeed falls back to 1_0 for garbage, missing, or out-of-range values`() {
        assertEquals(1.0f, parseSpeed(null))
        assertEquals(1.0f, parseSpeed(""))
        assertEquals(1.0f, parseSpeed("not a number"))
        assertEquals(1.0f, parseSpeed("3.0"))
        assertEquals(1.0f, parseSpeed("-1"))
    }

    @Test
    fun `nextSpeed cycles through the presets in order`() {
        assertEquals(1.0f, nextSpeed(0.8f))
        assertEquals(1.25f, nextSpeed(1.0f))
        assertEquals(2.0f, nextSpeed(1.75f))
    }

    @Test
    fun `nextSpeed wraps from the last preset back to the first`() {
        assertEquals(0.8f, nextSpeed(2.0f))
    }

    @Test
    fun `nextSpeed wraps an unknown value back to the first preset`() {
        assertEquals(0.8f, nextSpeed(3.0f))
    }

    @Test
    fun `formatSpeed labels the speed with a trailing x`() {
        assertEquals("1x", formatSpeed(1.0f))
        assertEquals("1.25x", formatSpeed(1.25f))
        assertEquals("2x", formatSpeed(2.0f))
    }

    @Test
    fun `effectiveSpeed uses the stored speed for a podcast`() {
        assertEquals(1.5f, effectiveSpeed("podcast", 1.5f))
    }

    @Test
    fun `effectiveSpeed is always 1_0 for music, regardless of the stored speed`() {
        assertEquals(1.0f, effectiveSpeed("music", 1.5f))
        assertEquals(1.0f, effectiveSpeed(null, 1.5f))
    }
}
