package com.voynix.sync

import com.voynix.logic.SyncPeer
import com.voynix.playback.playbackLog
import kotlinx.coroutines.CancellationException

/**
 * Best-effort "push stats only" for podcast settle points (pause / ended), so a
 * listened position reaches the Mac without the user opening the sync screen.
 *
 * Deliberately never resolves/heals the peer (no mDNS): a stale saved URL just
 * fails quietly and the next manual sync's resolvePeer repairs it. Rate-limited
 * so pause/play mashing doesn't burst requests.
 */
class StatsPusher(
    private val peerProvider: suspend () -> SyncPeer?,
    private val push: suspend (SyncPeer) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
    private val minIntervalMs: Long = MIN_INTERVAL_MS,
) {
    private var lastAttemptAt = Long.MIN_VALUE

    suspend fun pushIfDue() {
        val now = clock()
        if (lastAttemptAt != Long.MIN_VALUE && now - lastAttemptAt < minIntervalMs) {
            playbackLog("stats push skipped: rate-limited")
            return
        }
        val peer = peerProvider()
        if (peer == null) {
            playbackLog("stats push skipped: no paired Mac")
            return
        }
        lastAttemptAt = now
        try {
            push(peer)
            playbackLog("stats push ok -> ${peer.url}")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            playbackLog("stats push failed: ${e.message}")
        }
    }

    companion object {
        const val MIN_INTERVAL_MS = 60_000L
    }
}
