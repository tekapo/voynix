package com.voynix.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.testing.TestListenableWorkerBuilder
import com.voynix.data.db.SettingEntity
import com.voynix.data.db.VoynixDatabase
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * AutoSyncWorker checks `shouldAutoSync` before touching the network, so these
 * cases complete without a real sync attempt (there's no fake SyncRunner seam
 * on the worker itself — it builds its own SyncApi/SyncEngine/NsdDiscovery —
 * so anything that *would* reach SyncRunner is exercised by SyncRunnerTest
 * and AutoSyncTest instead).
 */
@RunWith(RobolectricTestRunner::class)
class AutoSyncWorkerTest {
    private lateinit var context: Context
    private lateinit var db: VoynixDatabase

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.deleteDatabase("voynix.db")
        db = VoynixDatabase.get(context)
    }

    @After
    fun tearDown() {
        // Not closing `db` here: AutoSyncWorker runs doWork() through
        // WorkManager's own coroutine dispatcher, which races Room's internal
        // connection-pool scope teardown if this test also closes it
        // explicitly, throwing a spurious JobCancellationException. Robolectric
        // gives each test method a fresh classloader/static state anyway, so
        // deleting the on-disk file is enough to isolate the next test.
        context.deleteDatabase("voynix.db")
    }

    @Test
    fun `no-op success when no peer is saved`() = runTest {
        db.settingsDao().set(SettingEntity(AUTO_SYNC_ENABLED_KEY, "1"))

        val worker = TestListenableWorkerBuilder<AutoSyncWorker>(context).build()
        val result = worker.doWork()

        assertTrue(result is androidx.work.ListenableWorker.Result.Success)
    }

    @Test
    fun `no-op success when auto-sync is disabled, even with a saved peer`() = runTest {
        db.settingsDao().set(SettingEntity("sync_peer_url", "https://mac.local:1234"))
        db.settingsDao().set(SettingEntity("sync_peer_token", "tok"))
        db.settingsDao().set(SettingEntity("sync_peer_pin", "pin"))
        db.settingsDao().set(SettingEntity(AUTO_SYNC_ENABLED_KEY, "0"))

        val worker = TestListenableWorkerBuilder<AutoSyncWorker>(context).build()
        val result = worker.doWork()

        assertTrue(result is androidx.work.ListenableWorker.Result.Success)
    }

    @Test
    fun `no-op success when the last sync was too recent`() = runTest {
        db.settingsDao().set(SettingEntity("sync_peer_url", "https://mac.local:1234"))
        db.settingsDao().set(SettingEntity("sync_peer_token", "tok"))
        db.settingsDao().set(SettingEntity("sync_peer_pin", "pin"))
        db.settingsDao().set(SettingEntity("sync_peer_last_sync", System.currentTimeMillis().toString()))
        db.settingsDao().set(SettingEntity(AUTO_SYNC_ENABLED_KEY, "1"))

        val worker = TestListenableWorkerBuilder<AutoSyncWorker>(context).build()
        val result = worker.doWork()

        assertTrue(result is androidx.work.ListenableWorker.Result.Success)
    }
}
