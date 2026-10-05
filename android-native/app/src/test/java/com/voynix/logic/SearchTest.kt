package com.voynix.logic

import com.voynix.data.db.PlaylistEntity
import com.voynix.data.db.TrackEntity
import com.voynix.data.db.TrackWithStats
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun track(title: String, artist: String? = null, album: String? = null): TrackWithStats =
    TrackWithStats(
        track = TrackEntity(
            id = title,
            title = title,
            artist = artist,
            album = album,
            filePath = "content://$title",
            fileName = "$title.mp3",
            duration = null,
        ),
        playCount = 0,
    )

class SearchTest {
    @Test
    fun `haystackMatches requires every term, case-insensitive`() {
        assertTrue(haystackMatches("The Beatles - Yellow Submarine", listOf("beatles", "yellow")))
        assertFalse(haystackMatches("The Beatles - Yellow Submarine", listOf("beatles", "abbey")))
    }

    @Test
    fun `empty query matches everything`() {
        assertTrue(haystackMatches("anything", queryTerms("   ")))
    }

    @Test
    fun `matches a half-width query against a full-width tag, and vice versa`() {
        // NFKC folds full-width Latin/digits and half-width katakana to their
        // canonical form — mirrors textNormalize.test.ts on the desktop side.
        assertTrue(haystackMatches("ｱｲｳｴｵ", queryTerms("アイウエオ")))
        assertTrue(haystackMatches("Ｔｒａｃｋ１", queryTerms("Track1")))
    }

    @Test
    fun `filterTracks matches title artist or album but not file path`() {
        val tracks = listOf(
            track("Yellow Submarine", artist = "The Beatles", album = "Revolver"),
            track("Something Else", artist = "Other Artist", album = "Other Album"),
        )
        val result = filterTracks(tracks, "beatles yellow")
        assertEquals(listOf("Yellow Submarine"), result.map { it.track.title })
    }

    @Test
    fun `filterStrings narrows artist or album card lists`() {
        val items = listOf("The Beatles", "Pink Floyd", "Beach Boys")
        assertEquals(listOf("The Beatles", "Beach Boys"), filterStrings(items, "b"))
    }

    @Test
    fun `filterPlaylists narrows by name, including podcast shows`() {
        val playlists = listOf(
            PlaylistEntity(id = "1", name = "Road Trip", type = "manual"),
            PlaylistEntity(id = "2", name = "Tech News Weekly", type = "manual", kind = "podcast"),
        )
        assertEquals(listOf("Tech News Weekly"), filterPlaylists(playlists, "news").map { it.name })
    }
}
