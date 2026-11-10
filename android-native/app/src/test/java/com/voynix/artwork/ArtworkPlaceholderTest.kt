package com.voynix.artwork

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ArtworkPlaceholderTest {
    @Test
    fun hueIsStableAndInRange() {
        assertEquals(placeholderHue("Ann"), placeholderHue("Ann"))
        for (name in listOf("", "Ann", "THE BLUE HEARTS", "ザ・ブルーハーツ", "x".repeat(500))) {
            assertTrue(placeholderHue(name) in 0 until 360)
        }
    }

    @Test
    fun hueMatchesTheMacHash() {
        // JS: hash = (hash * 31 + charCodeAt(i)) >>> 0; hash % 360
        // "ab": 97 * 31 + 98 = 3105 -> 3105 % 360 = 225
        assertEquals(225, placeholderHue("ab"))
        // Long enough to overflow 32 bits, so the >>> 0 wrap matters:
        // computed with the same recurrence in 64-bit then masked.
        var h = 0L
        for (c in "Wrap around the unsigned 32-bit range") h = (h * 31 + c.code) and 0xFFFFFFFFL
        assertEquals((h % 360).toInt(), placeholderHue("Wrap around the unsigned 32-bit range"))
    }

    @Test
    fun initialIsUpperCasedTrimmedOrQuestionMark() {
        assertEquals("B", initialOf("  bob"))
        assertEquals("?", initialOf(""))
        assertEquals("?", initialOf("   "))
        assertEquals("ザ", initialOf("ザ・ブルーハーツ"))
    }

    @Test
    fun placeholderNameIsArtistElseTitleLikeMac() {
        assertEquals("Ann", placeholderName(artist = "Ann", title = "Song"))
        // No artist tag: the title, not the album (Mac: `track.artist || track.title`).
        assertEquals("Song", placeholderName(artist = null, title = "Song"))
        assertEquals("Song", placeholderName(artist = "", title = "Song"))
        assertEquals("Song", placeholderName(artist = "  ", title = "Song"))
    }
}
