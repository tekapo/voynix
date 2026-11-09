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
    /** [viaBluetooth] is true when the Mac wasn't reachable on the network and this sync went through the Bluetooth tunnel. */
    data class Success(val summary: SyncSummary, val viaBluetooth: Boolean = false) : SyncRunResult()
    /** [connection] is set when the failure says the saved Mac itself is unreachable / no longer accepts our token. */
    data class Failed(val message: String, val connection: PeerConnection? = null) : SyncRunResult()
    data object AlreadyRunning : SyncRunResult()
}

/**
 * A way to sync with the Mac when it can't be reached on the network.
 * [open] finds the paired Mac and returns a tunnel (null if it isn't around);
 * [runSync] then syncs through the tunnel's local URL, so it can pick
 * Bluetooth-specific options (no song files, no album art).
 */
class BluetoothTransport(
    val open: suspend (SyncPeer) -> SyncTunnel?,
    val runSync: suspend (SyncPeer, onProgress: (SyncProgress) -> Unit) -> SyncSummary,
)

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
        scan: suspend (port: Int) -> List<String> = { emptyList() },
        bluetooth: BluetoothTransport? = null,
    ): SyncRunResult {
        if (!mutex.tryLock()) return SyncRunResult.AlreadyRunning
        try {
            _isSyncing.value = true
            _progress.value = SyncProgress("manifest", "Checking connection to Mac")
            val resolved = try {
                resolvePeer(peer, probe = probe, discover = discover, scan = scan)
            } catch (e: PeerUnreachableError) {
                // Not on any network we can see: try Bluetooth, if it's turned on.
                if (bluetooth == null) throw e
                return syncOverBluetooth(peer, bluetooth) ?: throw e
            }
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

    /**
     * Null when the Mac isn't found over Bluetooth either. The tunnel's local
     * URL is deliberately never passed to `onPeerMoved`: it only exists for
     * this sync, and saving it would break every later one.
     */
    private suspend fun syncOverBluetooth(peer: SyncPeer, bluetooth: BluetoothTransport): SyncRunResult? {
        _progress.value = SyncProgress("manifest", "Looking for the Mac over Bluetooth")
        val tunnel = bluetooth.open(peer) ?: return null
        try {
            val summary = bluetooth.runSync(peer.copy(url = tunnel.url)) { p -> _progress.value = p }
            return SyncRunResult.Success(summary, viaBluetooth = true)
        } finally {
            tunnel.close()
        }
    }
}
