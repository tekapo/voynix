package com.voynix.sync

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

private const val WORK_NAME = "auto_sync"

/**
 * Schedules/cancels the periodic background sync with WorkManager. `UPDATE`
 * makes re-enqueuing on every app start (and every settings change) a cheap
 * no-op when nothing actually changed, so callers don't need to track whether
 * they're scheduling for the first time.
 */
object AutoSyncScheduler {
    fun reschedule(context: Context, enabled: Boolean, chargingOnly: Boolean) {
        val workManager = WorkManager.getInstance(context)
        if (!enabled) {
            workManager.cancelUniqueWork(WORK_NAME)
            return
        }
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresCharging(chargingOnly)
            .build()
        val request = PeriodicWorkRequestBuilder<AutoSyncWorker>(1, TimeUnit.HOURS)
            .setConstraints(constraints)
            .build()
        workManager.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
    }
}
