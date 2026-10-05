package com.voynix.data.db

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PlaylistDaoTest {
    private lateinit var db: VoynixDatabase
    private lateinit var dao: PlaylistDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), VoynixDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = db.playlistDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    private suspend fun track(id: String) = db.trackDao().insert(
        TrackEntity(id = id, title = id, artist = null, album = null, filePath = "/mac/$id.mp3", fileName = "$id.mp3", duration = 100.0, trackKey = "k$id", origin = "mirror")
    )

    @Test
    fun `upsertMirrorPlaylistRow does not violate NOT NULL on sync_to_device or manual_order`() = runTest {
        // Regression test: the Kotlin-side defaults on PlaylistEntity are not
        // applied to this hand-written raw INSERT — they must be listed
        // explicitly in the SQL, or this throws SQLiteConstraintException.
        dao.upsertMirrorPlaylistRow("p1", "My Playlist", "music")
        val rows = dao.getMirrorPlaylists()
        assertEquals(listOf("p1"), rows.map { it.id })
    }

    @Test
    fun `upsertMirrorPlaylistRow on conflict updates name and kind only`() = runTest {
        dao.upsertMirrorPlaylistRow("p1", "Old Name", "music")
        dao.upsertMirrorPlaylistRow("p1", "New Name", "podcast")
        val rows = dao.getMirrorPlaylists()
        assertEquals(1, rows.size)
        assertEquals("New Name", rows[0].name)
    }

    @Test
    fun `upsertMirrorPlaylist replaces track membership and preserves order`() = runTest {
        track("t1")
        track("t2")
        track("t3")

        dao.upsertMirrorPlaylist("p1", "Playlist", "music", listOf("t1", "t2", "t3"))
        var tracks = dao.observePlaylistTracks("p1").first()
        assertEquals(listOf("t1", "t2", "t3"), tracks.map { it.track.id })

        // A re-sync with a reordered/shrunk track list must fully replace membership.
        dao.upsertMirrorPlaylist("p1", "Playlist", "music", listOf("t3", "t1"))
        tracks = dao.observePlaylistTracks("p1").first()
        assertEquals(listOf("t3", "t1"), tracks.map { it.track.id })
    }

    @Test
    fun `deleting a track cascades out of playlist_tracks`() = runTest {
        track("t1")
        dao.upsertMirrorPlaylist("p1", "Playlist", "music", listOf("t1"))
        db.trackDao().deleteMirrorTrack("t1")
        assertEquals(emptyList<String>(), dao.observePlaylistTracks("p1").first().map { it.track.id })
    }

    @Test
    fun `deletePlaylist removes the playlist row`() = runTest {
        dao.upsertMirrorPlaylistRow("p1", "Playlist", "music")
        dao.deletePlaylist("p1")
        assertEquals(emptyList<String>(), dao.getMirrorPlaylists().map { it.id })
    }

    @Test
    fun `getMirrorPlaylists returns kind`() = runTest {
        dao.upsertMirrorPlaylistRow("p1", "Pods", "podcast")
        assertEquals("podcast", dao.getMirrorPlaylists().single().kind)
    }

    @Test
    fun `getMirrorPlaylistTrackIds groups by playlist in position order and omits empty playlists`() = runTest {
        track("t1"); track("t2"); track("t3")
        dao.upsertMirrorPlaylist("pB", "B", "music", listOf("t3", "t1"))
        dao.upsertMirrorPlaylist("pA", "A", "music", listOf("t2", "t3", "t1"))
        dao.upsertMirrorPlaylist("pEmpty", "E", "music", emptyList())

        val byPlaylist = dao.getMirrorPlaylistTrackIds().groupBy({ it.playlistId }, { it.trackId })
        assertEquals(mapOf("pA" to listOf("t2", "t3", "t1"), "pB" to listOf("t3", "t1")), byPlaylist)
    }

    @Test
    fun `getMirrorPlaylistTrackIds excludes non-mirror playlists`() = runTest {
        track("t1")
        db.openHelper.writableDatabase.execSQL(
            "INSERT INTO playlists (id, name, type, kind, sync_to_device, manual_order) VALUES ('m', 'Manual', 'manual', 'music', 0, 0)"
        )
        dao.insertPlaylistTracks(listOf(PlaylistTrackEntity("m", "t1", 0)))
        dao.upsertMirrorPlaylist("p1", "Mirror", "music", listOf("t1"))

        assertEquals(listOf("p1"), dao.getMirrorPlaylistTrackIds().map { it.playlistId })
    }

    @Test
    fun `upsertMirrorPlaylist dedupes a repeated track id keeping the first position`() = runTest {
        track("t1"); track("t2")
        dao.upsertMirrorPlaylist("p1", "P", "music", listOf("t1", "t2", "t1"))
        assertEquals(listOf("t1", "t2"), dao.observePlaylistTracks("p1").first().map { it.track.id })
        assertEquals(listOf("t1", "t2"), dao.getMirrorPlaylistTrackIds().map { it.trackId })
    }
}
