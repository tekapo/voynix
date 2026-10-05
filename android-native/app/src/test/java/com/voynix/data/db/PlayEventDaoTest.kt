package com.voynix.data.db

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PlayEventDaoTest {
    private lateinit var db: VoynixDatabase
    private lateinit var dao: PlayEventDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), VoynixDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = db.playEventDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `insertAll dedupes on the (device_id, played_at, track_key) unique index`() = runTest {
        val e = PlayEventEntity("e1", "k1", 1000L, "device-a")
        dao.insert(e)
        // A re-push of the same logical event (e.g. duplicate id after a retry)
        // must be silently ignored, not crash — the union is grow-only and
        // dedup is keyed on (device_id, played_at, track_key), not id.
        dao.insertAll(listOf(e.copy(id = "e1-dup")))
        assertEquals(1, dao.getLocalPlayEvents("device-a").size)
    }

    @Test
    fun `getLocalPlayEvents only returns this device's own events`() = runTest {
        dao.insertAll(
            listOf(
                PlayEventEntity("e1", "k1", 1L, "device-a"),
                PlayEventEntity("e2", "k1", 2L, "device-b"),
            )
        )
        val rows = dao.getLocalPlayEvents("device-a")
        assertEquals(1, rows.size)
        assertEquals("k1", rows[0].trackKey)
    }

    @Test
    fun `getLocalPlayEventsSince only returns events strictly after the marker`() = runTest {
        dao.insertAll(
            listOf(
                PlayEventEntity("e1", "k1", 1000L, "device-a"),
                PlayEventEntity("e2", "k1", 2000L, "device-a"),
                PlayEventEntity("e3", "k1", 3000L, "device-a"),
            )
        )
        val rows = dao.getLocalPlayEventsSince("device-a", 1000L)
        assertEquals(listOf(2000L, 3000L), rows.map { it.playedAt }.sorted())
    }
}
