package com.voynix.logic

/** Six hours: an auto-sync run (manual or scheduled) within this window suppresses another. */
const val AUTO_SYNC_MIN_INTERVAL_MS: Long = 6 * 60 * 60 * 1000

/**
 * Whether AutoSyncWorker should actually run a sync this cycle. Wi-Fi/charging
 * constraints are enforced by WorkManager itself (see AutoSyncScheduler) — this
 * only covers what's left: the user's toggle, whether a Mac is even paired, and
 * not re-syncing too soon after the last one (manual or automatic).
 */
fun shouldAutoSync(
    enabled: Boolean,
    hasPeer: Boolean,
    lastSyncAt: Long?,
    now: Long,
    minIntervalMs: Long = AUTO_SYNC_MIN_INTERVAL_MS,
): Boolean {
    if (!enabled || !hasPeer) return false
    if (lastSyncAt != null && now - lastSyncAt < minIntervalMs) return false
    return true
}
