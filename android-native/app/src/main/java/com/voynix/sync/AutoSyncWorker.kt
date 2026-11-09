package com.voynix.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.shouldAutoSync

const val AUTO_SYNC_ENABLED_KEY = "auto_sync_enabled"
const val AUTO_SYNC_CHARGING_ONLY_KEY = "auto_sync_charging_only"
/** "0" = metadata-only sync (no song files); anything else, including unset, syncs files too. */
const val SYNC_FILES_KEY = "sync_files"

/**
 * Periodic background sync with the paired Mac, scheduled by AutoSyncScheduler
 * whenever it's enabled in settings. Runs through SyncRunner — the same
 * lock/orchestration the manual Sync button uses — so a background run and a
 * user-triggered one never overlap. Not finding the Mac (it's off, or not on
 * this Wi-Fi right now) is an ordinary, expected outcome for a periodic job,
 * not a failure: this returns success either way so WorkManager doesn't retry
 * aggressively or treat a normal "Mac wasn't around this hour" as an error.
 *
 * Deliberately not a foreground service: Play only accepts a dataSync
 * foreground service for work the user starts, and this runs on its own. So
 * Android may stop a long run (WorkManager's ~10 minute limit); that is fine,
 * because a half-finished download resumes from its `.part` file, finished
 * tracks are already saved, and the interrupted run doesn't count as a
 * sync (see SyncEngine.runSync), so the next hourly check retries it.
 */
class AutoSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val db = VoynixDatabase.get(applicationContext)
        val settings = db.settingsDao()
        val enabled = settings.get(AUTO_SYNC_ENABLED_KEY) == "1"
        val peerStore = SyncPeerStore(db)
        val peer = peerStore.get()

        if (!shouldAutoSync(enabled, hasPeer = peer != null, lastSyncAt = peer?.lastSyncAt, now = System.currentTimeMillis())) {
            return Result.success()
        }
        checkNotNull(peer)

        val syncFiles = settings.get(SYNC_FILES_KEY) != "0"

        val api = SyncApi()
        val nsd = NsdDiscovery(applicationContext)
        val engine = SyncEngine(applicationContext, db, api)
        val result = SyncRunner.sync(
            peer = peer,
            probe = { url, token, pin -> api.ping(url, token, pin) },
            discover = { nsd.discover() },
            runSync = { p, onProgress -> engine.runSync(p, onProgress, syncFiles) },
            onPeerMoved = { moved -> peerStore.save(moved.url, moved.token, moved.pin.orEmpty()) },
        )
        return when (result) {
            is SyncRunResult.Success -> Result.success()
            // The Mac being unreachable/unauthorized, or another sync already
            // running, are routine outcomes for a periodic job — not retryable
            // failures. WorkManager tries again on its next hourly tick anyway.
            is SyncRunResult.Failed, SyncRunResult.AlreadyRunning -> Result.success()
        }
    }
}
