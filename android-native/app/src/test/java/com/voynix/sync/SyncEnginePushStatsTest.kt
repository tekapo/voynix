package com.voynix.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.voynix.data.db.PlayEventEntity
import com.voynix.data.db.SettingEntity
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.SyncPeer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.kotlin.any
import org.mockito.kotlin.anyOrNull
import org.mockito.kotlin.doAnswer
import org.mockito.kotlin.mock
import org.mockito.kotlin.wheneverBlocking
import org.robolectric.RobolectricTestRunner
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
class SyncEnginePushStatsTest {
    private lateinit var context: Context
    private lateinit var db: VoynixDatabase
    private lateinit var engine: SyncEngine
    private val peer = SyncPeer("https://mac.local:1234", "tok", null, "pin")

    /** Every payload handed to SyncApi.postStats, in order. */
    private val posted = mutableListOf<IncomingStatsDto>()

    /** 1-based number of the postStats call that should fail, if any. */
    private var failCall: Int? = null

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase("voynix.db")
        db = VoynixDatabase.get(context)
        // VoynixDatabase.get is a process-wide singleton that can outlive the deleted
        // file between test methods, so start each test from empty tables.
        runBlocking(Dispatchers.IO) { db.clearAllTables() }

        val api = mock<SyncApi>()
        wheneverBlocking { api.postStats(any(), any(), anyOrNull(), any()) }.doAnswer { call ->
            posted.add(call.getArgument(3))
            if (posted.size == failCall) throw IOException("Stats push returned 500")
            Unit
        }
        engine = SyncEngine(context, db, api)
    }

    @After
    fun tearDown() {
        context.deleteDatabase("voynix.db")
    }

    private suspend fun addEvents(count: Int, firstAt: Long) {
        db.settingsDao().set(SettingEntity("device_id", "dev-1"))
        db.playEventDao().insertAll(
            (0 until count).map { PlayEventEntity("e-$firstAt-$it", "key-$it", firstAt + it, "dev-1") },
        )
    }

    @Test
    fun `the first push sends the whole log and a push right after sends only new events`() = runTest {
        addEvents(3, firstAt = 1_000L)
        engine.pushStats(peer)
        assertEquals(listOf(3), posted.map { it.events.size })

        // Within the full-push interval: only events newer than the watermark.
        addEvents(2, firstAt = System.currentTimeMillis() + 10_000)
        engine.pushStats(peer)
        assertEquals(listOf(3, 2), posted.map { it.events.size })
    }

    @Test
    fun `the whole log is resent once the full-push interval has passed`() = runTest {
        addEvents(3, firstAt = 1_000L)
        val longAgo = System.currentTimeMillis() - SyncEngine.FULL_PUSH_INTERVAL_MS - 1
        db.settingsDao().set(SettingEntity(SyncEngine.LAST_STATS_PUSH_KEY, System.currentTimeMillis().toString()))
        db.settingsDao().set(SettingEntity(SyncEngine.LAST_STATS_FULL_PUSH_KEY, longAgo.toString()))
        engine.pushStats(peer)
        // The incremental watermark alone would have skipped all of them.
        assertEquals(listOf(3), posted.map { it.events.size })
    }

    @Test
    fun `a long log is split into batches and the watermark only advances after all succeed`() = runTest {
        addEvents(SyncEngine.EVENTS_PER_REQUEST + 1, firstAt = 1_000L)
        failCall = 2
        try {
            engine.pushStats(peer)
            org.junit.Assert.fail("expected the second batch to fail")
        } catch (e: IOException) {
            // expected
        }
        assertEquals(listOf(SyncEngine.EVENTS_PER_REQUEST, 1), posted.map { it.events.size })
        assertNull(db.settingsDao().get(SyncEngine.LAST_STATS_PUSH_KEY))

        posted.clear()
        failCall = null
        engine.pushStats(peer)
        assertEquals(listOf(SyncEngine.EVENTS_PER_REQUEST, 1), posted.map { it.events.size })
        assertNotNull(db.settingsDao().get(SyncEngine.LAST_STATS_PUSH_KEY))
    }

    @Test
    fun `pairing with a different Mac or unpairing resets the push watermarks`() = runTest {
        val store = SyncPeerStore(db)
        store.save("https://a:1", "t", "pin-a")
        db.settingsDao().set(SettingEntity(SyncEngine.LAST_STATS_PUSH_KEY, "123"))
        db.settingsDao().set(SettingEntity(SyncEngine.LAST_STATS_FULL_PUSH_KEY, "123"))

        // Same Mac re-saved (e.g. its URL moved): keep the watermark.
        store.save("https://a:2", "t", "pin-a")
        assertEquals("123", db.settingsDao().get(SyncEngine.LAST_STATS_PUSH_KEY))

        // A different pin = a different Mac.
        store.save("https://b:1", "t", "pin-b")
        assertNull(db.settingsDao().get(SyncEngine.LAST_STATS_PUSH_KEY))
        assertNull(db.settingsDao().get(SyncEngine.LAST_STATS_FULL_PUSH_KEY))

        db.settingsDao().set(SettingEntity(SyncEngine.LAST_STATS_PUSH_KEY, "456"))
        store.clear()
        assertNull(db.settingsDao().get(SyncEngine.LAST_STATS_PUSH_KEY))
    }
}
