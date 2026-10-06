package com.voynix.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.SyncPeer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.kotlin.any
import org.mockito.kotlin.anyOrNull
import org.mockito.kotlin.doAnswer
import org.mockito.kotlin.mock
import org.mockito.kotlin.wheneverBlocking
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.io.IOException

/** End-to-end of [SyncEngine.runSync] against a mocked [SyncApi]: manifest -> DB + files on disk. */
@RunWith(RobolectricTestRunner::class)
class SyncEngineRunSyncTest {
    private lateinit var context: Context
    private lateinit var db: VoynixDatabase
    private lateinit var engine: SyncEngine
    private lateinit var api: SyncApi
    private val peer = SyncPeer("https://mac.local:1234", "tok", null, "pin")

    private var manifest = SyncSnapshotDto(deviceId = "mac", generatedAt = 1L)

    /** Track keys passed to downloadFile, in call order. */
    private val downloaded = mutableListOf<String>()

    /** Track keys whose download should fail. */
    private val failing = mutableSetOf<String>()

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase("voynix.db")
        db = VoynixDatabase.get(context)
        runBlocking(Dispatchers.IO) { db.clearAllTables() }
        File(context.filesDir, "synced").deleteRecursively()

        api = mock()
        // Mockito defaults a boxed Long to 0 ("disk full"); the real API returns null when unknown.
        wheneverBlocking { api.freeSpaceBytes(any()) }.doAnswer { null }
        wheneverBlocking { api.fetchManifest(any(), any(), anyOrNull()) }.doAnswer { manifest }
        wheneverBlocking {
            api.downloadFile(any(), any(), any(), anyOrNull(), any(), any(), any())
        }.doAnswer { call ->
            val dir: File = call.getArgument(0)
            val key: String = call.getArgument(4)
            if (key in failing) throw IOException("download failed")
            synchronized(downloaded) { downloaded.add(key) }
            dir.mkdirs()
            File(dir, "$key.mp3").also { it.writeText(call.getArgument<String>(6)) }.absolutePath
        }
        engine = SyncEngine(context, db, api)
    }

    @After
    fun tearDown() {
        context.deleteDatabase("voynix.db")
    }

    private fun track(key: String, hash: String = "h-$key", title: String = "Song $key", size: Long = 0) =
        SnapshotTrackDto(trackKey = key, title = title, fileName = "$key.mp3", filePath = "/Music/$key.mp3", contentHash = hash, size = size)

    @Test
    fun `a sync stops before downloading when the tracks do not fit in the free space`() = runTest {
        wheneverBlocking { api.freeSpaceBytes(any()) }.doAnswer { 10L * 1024 * 1024 }
        manifest = manifest.copy(tracks = listOf(track("a", size = 100L * 1024 * 1024)))

        val e = runCatching { engine.runSync(peer) }.exceptionOrNull()

        assertTrue(e is InsufficientSpaceException)
        assertTrue(downloaded.isEmpty())
    }

    @Test
    fun `a full disk is refused rather than treated as unknown`() = runTest {
        wheneverBlocking { api.freeSpaceBytes(any()) }.doAnswer { 0L }
        manifest = manifest.copy(tracks = listOf(track("a", size = 1L)))

        assertTrue(runCatching { engine.runSync(peer) }.exceptionOrNull() is InsufficientSpaceException)
        assertTrue(downloaded.isEmpty())
    }

    @Test
    fun `bytes already in a partial download are not counted as needed`() = runTest {
        wheneverBlocking { api.freeSpaceBytes(any()) }.doAnswer { 60L * 1024 * 1024 }
        wheneverBlocking { api.partialBytes(any(), any(), any()) }.doAnswer { 90L * 1024 * 1024 }
        manifest = manifest.copy(tracks = listOf(track("a", size = 100L * 1024 * 1024)))

        assertEquals(1, engine.runSync(peer).added)
    }

    @Test
    fun `a duplicated track key is downloaded once`() = runTest {
        manifest = manifest.copy(tracks = listOf(track("a"), track("a")))

        engine.runSync(peer)

        assertEquals(listOf("a"), downloaded)
    }

    @Test
    fun `many parallel downloads keep the summary counts exact`() = runTest {
        manifest = manifest.copy(tracks = (1..40).map { track("k$it") })

        val summary = withContext(Dispatchers.Default) { engine.runSync(peer) }

        assertEquals(40, summary.added)
        assertEquals(40, downloaded.size)
    }

    @Test
    fun `a first sync stores the tracks in the DB and the files on disk`() = runTest {
        manifest = manifest.copy(tracks = listOf(track("a"), track("b")))

        val summary = engine.runSync(peer)

        assertEquals(2, summary.added)
        assertEquals(0, summary.deleted)
        assertTrue(summary.errors.isEmpty())
        val rows = db.trackDao().getMirrorTracks()
        assertEquals(setOf("a", "b"), rows.map { it.trackKey }.toSet())
        assertTrue(rows.all { File(it.filePath).isFile })
    }

    @Test
    fun `a second sync downloads only tracks whose content hash changed`() = runTest {
        manifest = manifest.copy(tracks = listOf(track("a"), track("b")))
        engine.runSync(peer)
        downloaded.clear()

        manifest = manifest.copy(tracks = listOf(track("a"), track("b", hash = "h-b-v2")))
        val summary = engine.runSync(peer)

        assertEquals(listOf("b"), downloaded)
        assertEquals(1, summary.refetched)
        assertEquals(0, summary.added)
        assertEquals("h-b-v2", db.trackDao().getMirrorTracks().first { it.trackKey == "b" }.contentHash)
    }

    @Test
    fun `tracks removed from the manifest are deleted from the DB and from disk`() = runTest {
        manifest = manifest.copy(tracks = listOf(track("a"), track("b")))
        engine.runSync(peer)
        val bPath = db.trackDao().getMirrorTracks().first { it.trackKey == "b" }.filePath
        assertTrue(File(bPath).isFile)

        manifest = manifest.copy(tracks = listOf(track("a")))
        val summary = engine.runSync(peer)

        assertEquals(1, summary.deleted)
        assertEquals(listOf("a"), db.trackDao().getMirrorTracks().map { it.trackKey })
        assertFalse(File(bPath).exists())
    }

    @Test
    fun `a failed download is reported and does not stop the other tracks`() = runTest {
        failing.add("a")
        manifest = manifest.copy(tracks = listOf(track("a"), track("b")))

        val summary = engine.runSync(peer)

        assertEquals(1, summary.added)
        assertEquals(1, summary.errors.size)
        assertTrue(summary.errors.single().startsWith("Song a"))
        assertEquals(listOf("b"), db.trackDao().getMirrorTracks().map { it.trackKey })
    }

    @Test
    fun `playlists are mirrored with the manifest's track order and removed when gone`() = runTest {
        manifest = manifest.copy(
            tracks = listOf(track("a"), track("b")),
            playlists = listOf(SnapshotPlaylistDto(id = "p1", name = "Mix", trackKeys = listOf("b", "a"))),
        )
        val summary = engine.runSync(peer)

        assertEquals(1, summary.playlists)
        assertEquals(listOf("p1"), db.playlistDao().getMirrorPlaylists().map { it.id })
        val idByKey = db.trackDao().getMirrorTracks().associate { it.trackKey to it.id }
        val order = db.playlistDao().getMirrorPlaylistTrackIds().map { it.trackId }
        assertEquals(listOf(idByKey["b"], idByKey["a"]), order)

        manifest = manifest.copy(playlists = emptyList())
        engine.runSync(peer)
        assertTrue(db.playlistDao().getMirrorPlaylists().isEmpty())
    }
}
