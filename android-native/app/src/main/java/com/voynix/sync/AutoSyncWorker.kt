package com.voynix.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import com.voynix.R
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.shouldAutoSync

private const val CHANNEL_ID = "auto_sync"
private const val NOTIFICATION_ID = 4201
const val AUTO_SYNC_ENABLED_KEY = "auto_sync_enabled"
const val AUTO_SYNC_CHARGING_ONLY_KEY = "auto_sync_charging_only"

/**
 * Periodic background sync with the paired Mac, scheduled by AutoSyncScheduler
 * whenever it's enabled in settings. Runs through SyncRunner — the same
 * lock/orchestration the manual Sync button uses — so a background run and a
 * user-triggered one never overlap. Not finding the Mac (it's off, or not on
 * this Wi-Fi right now) is an ordinary, expected outcome for a periodic job,
 * not a failure: this returns success either way so WorkManager doesn't retry
 * aggressively or treat a normal "Mac wasn't around this hour" as an error.
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

        setForegroundAsync(getForegroundInfo())

        val api = SyncApi()
        val nsd = NsdDiscovery(applicationContext)
        val engine = SyncEngine(applicationContext, db, api)
        val result = SyncRunner.sync(
            peer = peer,
            probe = { url, token, pin -> api.ping(url, token, pin) },
            discover = { nsd.discover() },
            runSync = { p, onProgress -> engine.runSync(p, onProgress) },
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

    override suspend fun getForegroundInfo(): ForegroundInfo {
        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Background sync", NotificationManager.IMPORTANCE_MIN)
            )
        }
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setContentTitle("Syncing with Mac")
            .setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setOngoing(true)
            .setSilent(true)
            .build()
        return ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }
}
