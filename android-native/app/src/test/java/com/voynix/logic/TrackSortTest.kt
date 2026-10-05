package com.voynix.logic

import com.voynix.data.db.TrackEntity
import com.voynix.data.db.TrackWithStats
import com.voynix.testutil.testVectorFile
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@Serializable
private data class NaturalSortDivergenceVector(
    val titles: List<String>,
    val plain_text_order: List<String>,
)

private val vectorJson = Json { ignoreUnknownKeys = true }

private fun track(
    id: String,
    title: String,
    artist: String? = null,
    album: String? = null,
    discNo: Int? = null,
    trackNo: Int? = null,
    playCount: Int = 0,
    duration: Double? = null,
): TrackWithStats = TrackWithStats(
    track = TrackEntity(
        id = id,
        title = title,
        artist = artist,
        album = album,
        filePath = "content://$id",
        fileName = "$id.mp3",
        duration = duration,
        discNo = discNo,
        trackNo = trackNo,
    ),
    playCount = playCount,
)

class TrackSortTest {
    @Test
    fun `nextSort cycles asc, desc, then clears`() {
        val a = nextSort(null, SortKey.TITLE)
        assertEquals(SortState(SortKey.TITLE, SortDir.ASC), a)
        val b = nextSort(a, SortKey.TITLE)
        assertEquals(SortState(SortKey.TITLE, SortDir.DESC), b)
        assertNull(nextSort(b, SortKey.TITLE))
    }

    @Test
    fun `nextSort switching column starts ascending`() {
        val a = SortState(SortKey.TITLE, SortDir.DESC)
        assertEquals(SortState(SortKey.ARTIST, SortDir.ASC), nextSort(a, SortKey.ARTIST))
    }

    @Test
    fun `sortTracks by plays descending`() {
        val tracks = listOf(track("1", "A", playCount = 3), track("2", "B", playCount = 10))
        val sorted = sortTracks(tracks, SortState(SortKey.PLAYS, SortDir.DESC))
        assertEquals(listOf("2", "1"), sorted.map { it.track.id })
    }

    @Test
    fun `sortTracks null returns input unchanged`() {
        val tracks = listOf(track("1", "A"), track("2", "B"))
        assertEquals(tracks, sortTracks(tracks, null))
    }

    @Test
    fun `compareNatural orders by artist album disc track title`() {
        val t1 = track("1", "Zeta", artist = "Aardvark", album = "Album", discNo = 1, trackNo = 2)
        val t2 = track("2", "Alpha", artist = "Aardvark", album = "Album", discNo = 1, trackNo = 1)
        val sorted = sortNatural(listOf(t1, t2))
        assertEquals(listOf("2", "1"), sorted.map { it.track.id })
    }

    @Test
    fun `compareNatural sorts blank artist last`() {
        val withArtist = track("1", "Song", artist = "Someone")
        val blank = track("2", "Song", artist = "")
        val sorted = sortNatural(listOf(blank, withArtist))
        assertEquals(listOf("1", "2"), sorted.map { it.track.id })
    }

    @Test
    fun `compareNatural falls back to track_no 999999 when missing`() {
        val numbered = track("1", "Song", artist = "A", album = "B", trackNo = 5)
        val unnumbered = track("2", "Song", artist = "A", album = "B", trackNo = null)
        val sorted = sortNatural(listOf(unnumbered, numbered))
        assertEquals(listOf("1", "2"), sorted.map { it.track.id })
    }

    // Pinned to docs/test-vectors/natural-sort-divergence.json: unlike
    // trackSort.ts's compareNatural, this one is NOT numeric-aware (Collator
    // has no numeric mode), so same-album title tiebreaks sort as plain text.
    // Documents the known, not-yet-fixed gap; not the desired end state.
    @Test
    fun `compareNatural title tiebreak sorts as plain text, not numeric (documented divergence from JS)`() {
        val vector = vectorJson.decodeFromString<NaturalSortDivergenceVector>(
            testVectorFile("natural-sort-divergence.json").readText()
        )
        val tracks = vector.titles.map { track(it, it, artist = "A", album = "A") }
        val sorted = sortNatural(tracks)
        assertEquals(vector.plain_text_order, sorted.map { it.track.id })
    }
}
