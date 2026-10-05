package com.voynix.logic

import com.voynix.data.db.TrackEntity
import com.voynix.data.db.TrackWithStats
import org.junit.Assert.assertEquals
import org.junit.Test

private fun track(
    id: String,
    playCount: Int = 0,
    lastPlayed: Long? = null,
    addedAt: Long? = null,
    kind: String = "music",
): TrackWithStats =
    TrackWithStats(
        track = TrackEntity(
            id = id,
            title = id,
            artist = null,
            album = null,
            filePath = "content://$id",
            fileName = "$id.mp3",
            duration = null,
            kind = kind,
            addedAt = addedAt,
        ),
        playCount = playCount,
        lastPlayed = lastPlayed,
    )

class SmartListsTest {
    @Test
    fun `mostPlayed excludes zero-play tracks and sorts descending`() {
        val tracks = listOf(track("a", playCount = 0), track("b", playCount = 5), track("c", playCount = 10))
        assertEquals(listOf("c", "b"), mostPlayed(tracks).map { it.track.id })
    }

    @Test
    fun `mostPlayed caps at 100`() {
        val tracks = (0 until 150).map { track("t$it", playCount = it + 1) }
        assertEquals(100, mostPlayed(tracks).size)
    }

    @Test
    fun `recentlyAdded excludes podcasts and tracks with no addedAt, sorts newest first`() {
        val tracks = listOf(
            track("a", addedAt = 100),
            track("b", addedAt = 300),
            track("c", addedAt = 200, kind = "podcast"),
            track("d"),
        )
        assertEquals(listOf("b", "a"), recentlyAdded(tracks).map { it.track.id })
    }

    @Test
    fun `recentlyPlayed excludes never-played tracks and sorts newest first`() {
        val tracks = listOf(track("a", lastPlayed = 100), track("b", lastPlayed = 300), track("c"))
        assertEquals(listOf("b", "a"), recentlyPlayed(tracks).map { it.track.id })
    }
}
