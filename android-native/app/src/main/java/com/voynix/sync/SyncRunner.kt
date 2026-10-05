package com.voynix.sync

import com.voynix.logic.DiscoveredPeer
import com.voynix.logic.PeerConnection
import com.voynix.logic.PeerProbeResult
import com.voynix.logic.PeerUnauthorizedError
import com.voynix.logic.PeerUnreachableError
import com.voynix.logic.SyncPeer
import com.voynix.logic.SyncProgress
import com.voynix.logic.SyncSummary
import com.voynix.logic.resolvePeer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex

sealed class SyncRunResult {
    data class Success(val summary: SyncSummary) : SyncRunResult()
    /** [connection] is set when the failure says the saved Mac itself is unreachable / no longer accepts our token. */
    data class Failed(val message: String, val connection: PeerConnection? = null) : SyncRunResult()
    data object AlreadyRunning : SyncRunResult()
}

/**
 * Process-wide orchestration for one Mac sync ("resolvePeer -> save moved
 * URL -> runSync"). Shared by the manual Sync button (SyncViewModel) and the
 * periodic AutoSyncWorker so at most one sync ever runs at a time: SyncEngine
 * itself has no locking, and without this a background sync and a
 * user-triggered one could race.
 *
 * Callers inject `probe`/`discover`/`runSync` as suspend functions (same
 * shape resolvePeer already uses) rather than concrete SyncApi/SyncEngine/
 * NsdDiscovery instances, so this is testable with plain lambdas.
 */
object SyncRunner {
    private val mutex = Mutex()

    private val _isSyncing = MutableStateFlow(false)
    val isSyncing: StateFlow<Boolean> = _isSyncing.asStateFlow()

    private val _progress = MutableStateFlow<SyncProgress?>(null)
    val progress: StateFlow<SyncProgress?> = _progress.asStateFlow()

    suspend fun sync(
        peer: SyncPeer,
        probe: suspend (url: String, token: String, pin: String?) -> PeerProbeResult,
        discover: suspend () -> List<DiscoveredPeer>,
        runSync: suspend (SyncPeer, onProgress: (SyncProgress) -> Unit) -> SyncSummary,
        onPeerMoved: suspend (SyncPeer) -> Unit = {},
    ): SyncRunResult {
        if (!mutex.tryLock()) return SyncRunResult.AlreadyRunning
        try {
            _isSyncing.value = true
            _progress.value = SyncProgress("manifest", "Checking connection to Mac")
            val resolved = resolvePeer(peer, probe = probe, discover = discover)
            if (resolved.changed) onPeerMoved(resolved.peer)
            val summary = runSync(resolved.peer) { p -> _progress.value = p }
            return SyncRunResult.Success(summary)
        } catch (e: PeerUnauthorizedError) {
            return SyncRunResult.Failed(e.message ?: "Pairing was reset on the Mac. Please pair again.", PeerConnection.UNAUTHORIZED)
        } catch (e: PeerUnreachableError) {
            return SyncRunResult.Failed(e.message ?: "Mac not found. Check that the sync server is running on the Mac.", PeerConnection.UNREACHABLE)
        } catch (e: Exception) {
            return SyncRunResult.Failed(e.message ?: "Sync failed: ${e::class.simpleName}")
        } finally {
            _isSyncing.value = false
            mutex.unlock()
        }
    }
}
