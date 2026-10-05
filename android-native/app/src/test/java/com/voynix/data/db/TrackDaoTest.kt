package com.voynix.data.db

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TrackDaoTest {
    private lateinit var db: VoynixDatabase
    private lateinit var dao: TrackDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), VoynixDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = db.trackDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    private fun mirrorTrack(id: String = "t1", trackKey: String = "k1", filePath: String = "/mac/$id.mp3") = TrackEntity(
        id = id,
        title = "Title $id",
        artist = "Artist",
        album = "Album",
        filePath = filePath,
        fileName = "$id.mp3",
        duration = 180.0,
        trackKey = trackKey,
        contentHash = "hash-$id",
        origin = "mirror",
    )

    @Test
    fun `upsertMirrorTrack inserts a new row`() = runTest {
        val t = mirrorTrack()
        dao.upsertMirrorTrack(
            id = t.id, title = t.title, artist = t.artist, album = t.album, filePath = t.filePath,
            fileName = t.fileName, duration = t.duration, trackKey = t.trackKey!!, contentHash = t.contentHash!!,
            favorite = false, favoriteUpdatedAt = null, kind = t.kind, discNo = null, trackNo = null,
            playState = t.playState, resumePosition = 0.0, playStateUpdatedAt = null, addedAt = null,
        )
        val row = dao.getById("t1")
        assertEquals("Title t1", row?.title)
        assertEquals("mirror", row?.origin)
    }

    @Test
    fun `upsertMirrorTrack on re-fetch updates metadata but preserves local favorite and play_state`() = runTest {
        val t = mirrorTrack()
        dao.upsertMirrorTrack(
            id = t.id, title = "Old Title", artist = t.artist, album = t.album, filePath = t.filePath,
            fileName = t.fileName, duration = t.duration, trackKey = t.trackKey!!, contentHash = t.contentHash!!,
            favorite = false, favoriteUpdatedAt = null, kind = t.kind, discNo = null, trackNo = null,
            playState = t.playState, resumePosition = 0.0, playStateUpdatedAt = null, addedAt = null,
        )
        // Simulate a later local favorite before the next Mac refetch.
        dao.setFavorite("t1", favorite = true, updatedAt = 1000L)

        // Re-fetch from the Mac with a retagged title, but stale (favorite=false) stats — a
        // blind DO UPDATE SET on favorite/play_state would clobber the local LWW value.
        dao.upsertMirrorTrack(
            id = t.id, title = "New Title", artist = t.artist, album = t.album, filePath = t.filePath,
            fileName = t.fileName, duration = t.duration, trackKey = t.trackKey!!, contentHash = t.contentHash!!,
            favorite = false, favoriteUpdatedAt = null, kind = t.kind, discNo = null, trackNo = null,
            playState = t.playState, resumePosition = 0.0, playStateUpdatedAt = null, addedAt = null,
        )

        val row = dao.getById("t1")
        assertEquals("New Title", row?.title)
        assertEquals(true, row?.favorite)
    }

    @Test
    fun `deleteMirrorTrack removes the track and its playlist memberships`() = runTest {
        val t = mirrorTrack()
        dao.insert(t)
        db.playlistDao().let { pdao ->
            pdao.upsertMirrorPlaylistRow("p1", "My Playlist", "music")
            pdao.replacePlaylistTracks("p1", listOf(PlaylistTrackEntity("p1", "t1", 0)))
        }

        dao.deleteMirrorTrack("t1")

        assertNull(dao.getById("t1"))
        val tracks = db.playlistDao().observePlaylistTracks("p1").first()
        assertTrue(tracks.isEmpty())
    }

    @Test
    fun `applyFavoriteIfNewer only applies a strictly newer update`() = runTest {
        dao.insert(mirrorTrack())
        dao.setFavorite("t1", favorite = true, updatedAt = 1000L)

        // Older update must be ignored.
        dao.applyFavoriteIfNewer("k1", favorite = false, updatedAt = 500L)
        assertEquals(true, dao.getById("t1")?.favorite)

        // Newer update must win.
        dao.applyFavoriteIfNewer("k1", favorite = false, updatedAt = 1500L)
        assertEquals(false, dao.getById("t1")?.favorite)
    }

    @Test
    fun `applyPlayStateIfNewer respects LWW ordering`() = runTest {
        dao.insert(mirrorTrack())
        dao.setPlayState("t1", state = "played", resume = 10.0, updatedAt = 1000L)

        dao.applyPlayStateIfNewer("k1", state = "unplayed", resume = 0.0, updatedAt = 999L)
        assertEquals("played", dao.getById("t1")?.playState)

        dao.applyPlayStateIfNewer("k1", state = "in_progress", resume = 42.0, updatedAt = 2000L)
        val row = dao.getById("t1")
        assertEquals("in_progress", row?.playState)
        assertEquals(42.0, row?.resumePosition)
    }

    @Test
    fun `observeAllWithStats derives play_count from the play_events log`() = runTest {
        dao.insert(mirrorTrack())
        db.playEventDao().insertAll(
            listOf(
                PlayEventEntity("e1", "k1", 1L, "device-a"),
                PlayEventEntity("e2", "k1", 2L, "device-a"),
                PlayEventEntity("e3", "k1", 3L, "device-b"),
            )
        )

        val rows = dao.observeAllWithStats().first()
        assertEquals(1, rows.size)
        assertEquals(3, rows[0].playCount)
    }

    @Test
    fun `getMirrorTracks only returns mirror-origin rows with a track_key`() = runTest {
        dao.insert(mirrorTrack(id = "t1", trackKey = "k1"))
        dao.insert(mirrorTrack(id = "t2", trackKey = "k2").copy(origin = "local"))

        val rows = dao.getMirrorTracks()
        assertEquals(listOf("t1"), rows.map { it.id })
    }

    @Test
    fun `getMirrorTracks returns every column diffTracks compares`() = runTest {
        dao.insert(
            mirrorTrack(id = "t1", trackKey = "k1").copy(
                title = "T", artist = "A", album = "B", duration = 12.5, kind = "podcast", discNo = 2, trackNo = 7,
            )
        )
        val row = dao.getMirrorTracks().single()
        assertEquals("t1", row.id)
        assertEquals("k1", row.trackKey)
        assertEquals("hash-t1", row.contentHash)
        assertEquals("/mac/t1.mp3", row.filePath)
        assertEquals("T", row.title)
        assertEquals("A", row.artist)
        assertEquals("B", row.album)
        assertEquals(12.5, row.duration!!, 0.0)
        assertEquals("podcast", row.kind)
        assertEquals(2, row.discNo)
        assertEquals(7, row.trackNo)
    }

    @Test
    fun `updateMirrorTrackMeta leaves favorite and play_state untouched`() = runTest {
        dao.insert(mirrorTrack())
        dao.setFavorite("t1", favorite = true, updatedAt = 1000L)
        dao.setPlayState("t1", "in_progress", 42.0, 2000L)

        dao.updateMirrorTrackMeta("k1", "New Title", "New Artist", "New Album", 99.0, "music", 1, 3, null)

        val row = dao.getById("t1")!!
        assertEquals("New Title", row.title)
        assertEquals("New Artist", row.artist)
        assertEquals(1, row.discNo)
        // The convergence trap: these are LWW columns, written only by the stats pass.
        assertEquals(true, row.favorite)
        assertEquals(1000L, row.favoriteUpdatedAt)
        assertEquals("in_progress", row.playState)
        assertEquals(42.0, row.resumePosition, 0.0)
        assertEquals(2000L, row.playStateUpdatedAt)
    }

    @Test
    fun `setLyrics persists the cached lookup`() = runTest {
        dao.insert(mirrorTrack())
        dao.setLyrics("t1", "[00:00.00] la la la")
        assertEquals("[00:00.00] la la la", dao.getById("t1")?.lyrics)
    }
}
