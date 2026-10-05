package com.voynix.lyrics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LrclibApiTest {
    @Test
    fun `pickLyrics prefers plain over synced`() {
        val r = LrclibResult(plainLyrics = "plain text", syncedLyrics = "[00:01.00] synced")
        assertEquals("plain text", pickLyrics(r))
    }

    @Test
    fun `pickLyrics falls back to synced when plain is blank`() {
        val r = LrclibResult(plainLyrics = "  ", syncedLyrics = "[00:01.00] synced")
        assertEquals("[00:01.00] synced", pickLyrics(r))
    }

    @Test
    fun `pickLyrics returns null when both are blank or absent`() {
        assertNull(pickLyrics(LrclibResult(plainLyrics = null, syncedLyrics = null)))
        assertNull(pickLyrics(LrclibResult(plainLyrics = "", syncedLyrics = "   ")))
    }
}
