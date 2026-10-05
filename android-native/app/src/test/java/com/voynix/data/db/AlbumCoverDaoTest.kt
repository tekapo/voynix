package com.voynix.data.db

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AlbumCoverDaoTest {
    private lateinit var db: VoynixDatabase
    private lateinit var dao: AlbumCoverDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), VoynixDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = db.albumCoverDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `getImageDataUri returns null when no cover is cached`() = runTest {
        assertNull(dao.getImageDataUri("artist", "album"))
    }

    @Test
    fun `upsertIfNewer inserts a first-time cover`() = runTest {
        dao.upsertIfNewer("artist", "album", "data:image/jpeg;base64,AAA", 1000L)
        assertEquals("data:image/jpeg;base64,AAA", dao.getImageDataUri("artist", "album"))
    }

    @Test
    fun `upsertIfNewer ignores an older or equal update`() = runTest {
        dao.upsertIfNewer("artist", "album", "new", 1000L)
        dao.upsertIfNewer("artist", "album", "stale", 500L)
        assertEquals("new", dao.getImageDataUri("artist", "album"))
        dao.upsertIfNewer("artist", "album", "same-timestamp", 1000L)
        assertEquals("new", dao.getImageDataUri("artist", "album"))
    }

    @Test
    fun `upsertIfNewer applies a strictly newer update`() = runTest {
        dao.upsertIfNewer("artist", "album", "old", 1000L)
        dao.upsertIfNewer("artist", "album", "fresh", 2000L)
        assertEquals("fresh", dao.getImageDataUri("artist", "album"))
    }
}
