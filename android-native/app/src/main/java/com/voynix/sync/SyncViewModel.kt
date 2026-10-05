package com.voynix.sync

import android.content.Context
import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voynix.data.db.SettingEntity
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.DiscoveredPeer
import com.voynix.logic.PeerConnection
import com.voynix.logic.SyncPeer
import com.voynix.logic.SyncProgress
import com.voynix.logic.SyncSummary
import com.voynix.logic.checkPeerConnection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

/**
 * A pairing that passed its TLS/token checks but hasn't been saved yet — the
 * UI must show [shortFingerprint] next to the Mac's own on-screen code and
 * get the user to confirm they match before [SyncViewModel.confirmPendingPairing]
 * persists it as the pin. This is TOFU: nothing validates the fingerprint
 * against anything but the user's own eyes at this point.
 */
data class PendingPairing(
    val url: String,
    val token: String,
    val fingerprint: String,
    val shortFingerprint: String,
    /** True for manual pairing: the token hasn't been sent yet and is only
     *  verified (over a connection pinned to [fingerprint]) once the user confirms. */
    val needsTokenCheck: Boolean = false,
)

/** Drives pairing + sync for the settings/sync screen. */
class SyncViewModel(private val context: Context, private val db: VoynixDatabase) : ViewModel() {
    private val api = SyncApi()
    private val engine = SyncEngine(context, db, api)
    private val peerStore = SyncPeerStore(db)
    private val nsd = NsdDiscovery(context)

    private val _peer = MutableStateFlow<SyncPeer?>(null)
    val peer: StateFlow<SyncPeer?> = _peer.asStateFlow()

    // Whether the saved peer actually answers right now. Saved ≠ reachable (the
    // Mac's IP changes with the network), so the screen shows this, not just
    // "a peer is stored". Null while nothing is paired.
    private val _connection = MutableStateFlow<PeerConnection?>(null)
    val connection: StateFlow<PeerConnection?> = _connection.asStateFlow()

    private val _discoveredPeers = MutableStateFlow<List<DiscoveredPeer>>(emptyList())
    val discoveredPeers: StateFlow<List<DiscoveredPeer>> = _discoveredPeers.asStateFlow()

    private val _isDiscovering = MutableStateFlow(false)
    val isDiscovering: StateFlow<Boolean> = _isDiscovering.asStateFlow()

    private val _isPairing = MutableStateFlow(false)
    val isPairing: StateFlow<Boolean> = _isPairing.asStateFlow()

    private val _pairError = MutableStateFlow<String?>(null)
    val pairError: StateFlow<String?> = _pairError.asStateFlow()

    private val _pendingPairing = MutableStateFlow<PendingPairing?>(null)
    val pendingPairing: StateFlow<PendingPairing?> = _pendingPairing.asStateFlow()

    private val _needsRepairAfterUpdate = MutableStateFlow(false)
    val needsRepairAfterUpdate: StateFlow<Boolean> = _needsRepairAfterUpdate.asStateFlow()

    // Backed by SyncRunner (not a local flag) so the screen also reflects a
    // sync that AutoSyncWorker started in the background, not just one
    // triggered by this screen's own button.
    val isSyncing: StateFlow<Boolean> = SyncRunner.isSyncing
    val syncProgress: StateFlow<SyncProgress?> = SyncRunner.progress

    private val _lastSummary = MutableStateFlow<SyncSummary?>(null)
    val lastSummary: StateFlow<SyncSummary?> = _lastSummary.asStateFlow()

    private val _syncError = MutableStateFlow<String?>(null)
    val syncError: StateFlow<String?> = _syncError.asStateFlow()

    // Auto-sync: roughly-hourly background sync via WorkManager while the
    // paired Mac is reachable on the same Wi-Fi (see AutoSyncWorker/Scheduler).
    // Off by default; charging-only defaults on once enabled.
    private val _autoSyncEnabled = MutableStateFlow(false)
    val autoSyncEnabled: StateFlow<Boolean> = _autoSyncEnabled.asStateFlow()

    private val _autoSyncChargingOnly = MutableStateFlow(true)
    val autoSyncChargingOnly: StateFlow<Boolean> = _autoSyncChargingOnly.asStateFlow()

    init {
        viewModelScope.launch {
            val existing = peerStore.get()
            _peer.value = existing
            if (existing == null) _needsRepairAfterUpdate.value = peerStore.hasStaleHttpPeer()
            else checkConnection()
        }
        viewModelScope.launch {
            _autoSyncEnabled.value = db.settingsDao().get(AUTO_SYNC_ENABLED_KEY) == "1"
            _autoSyncChargingOnly.value = db.settingsDao().get(AUTO_SYNC_CHARGING_ONLY_KEY) != "0"
            AutoSyncScheduler.reschedule(context, _autoSyncEnabled.value, _autoSyncChargingOnly.value)
        }
    }

    fun setAutoSyncEnabled(enabled: Boolean) {
        _autoSyncEnabled.value = enabled
        viewModelScope.launch {
            db.settingsDao().set(SettingEntity(AUTO_SYNC_ENABLED_KEY, if (enabled) "1" else "0"))
        }
        AutoSyncScheduler.reschedule(context, enabled, _autoSyncChargingOnly.value)
    }

    fun setAutoSyncChargingOnly(chargingOnly: Boolean) {
        _autoSyncChargingOnly.value = chargingOnly
        viewModelScope.launch {
            db.settingsDao().set(SettingEntity(AUTO_SYNC_CHARGING_ONLY_KEY, if (chargingOnly) "1" else "0"))
        }
        AutoSyncScheduler.reschedule(context, _autoSyncEnabled.value, chargingOnly)
    }

    /** Pings the saved peer (re-finding it over mDNS if it moved) and updates [connection]. */
    fun checkConnection() {
        val currentPeer = _peer.value ?: return
        // A running sync reports its own outcome; a second check would also race it for the mDNS lookup.
        if (isSyncing.value || _connection.value == PeerConnection.CHECKING) return
        _connection.value = PeerConnection.CHECKING
        viewModelScope.launch {
            _connection.value = checkPeerConnection(
                peer = currentPeer,
                probe = { url, token, pin -> api.ping(url, token, pin) },
                discover = { nsd.discover() },
                onPeerMoved = { moved -> peerStore.save(moved.url, moved.token, moved.pin.orEmpty()) },
            )
            _peer.value = peerStore.get()
        }
    }

    fun discover() {
        viewModelScope.launch {
            _isDiscovering.value = true
            _discoveredPeers.value = runCatching { nsd.discover() }.getOrDefault(emptyList())
            _isDiscovering.value = false
        }
    }

    /** Pairs with a Mac found over mDNS — blocks (in the background) on the owner's on-screen approval. */
    fun pairWithDiscovered(discovered: DiscoveredPeer) {
        viewModelScope.launch {
            _isPairing.value = true
            _pairError.value = null
            try {
                val observed = AtomicReference<String>()
                val granted = api.requestPairing(discovered.url, deviceName(), observed)
                // The TLS layer saw `observed`; the JSON body claims `granted.fingerprint`.
                // A proxy that terminates TLS itself could make these disagree even
                // though each individually looks like a normal response.
                if (observed.get().isNullOrEmpty() || observed.get() != granted.fingerprint) {
                    _pairError.value = "Certificate verification failed. Aborted because the connection may not be secure."
                    return@launch
                }
                _pendingPairing.value = PendingPairing(
                    url = granted.url,
                    token = granted.token,
                    fingerprint = granted.fingerprint,
                    shortFingerprint = shortFingerprint(granted.fingerprint),
                )
            } catch (e: Exception) {
                _pairError.value = e.message ?: "Pairing failed"
            } finally {
                _isPairing.value = false
            }
        }
    }

    /**
     * Manual fallback — no approval round-trip needed. Only the certificate
     * fingerprint is fetched here (unauthenticated); the token is sent in
     * [confirmPendingPairing], after the user has compared the fingerprint with
     * the Mac's own display, over a connection pinned to it. Sending the bearer
     * token before that would hand it to anything answering at the typed address.
     */
    fun pairManually(rawUrl: String, rawToken: String) {
        val url = com.voynix.logic.normalizePairingInput(rawUrl)
        val token = com.voynix.logic.normalizePairingInput(rawToken)
        viewModelScope.launch {
            _isPairing.value = true
            _pairError.value = null
            try {
                val fingerprint = api.fetchFingerprint(url)
                if (fingerprint == null) {
                    _pairError.value = "Can't connect to Mac"
                    return@launch
                }
                _pendingPairing.value = PendingPairing(
                    url = url,
                    token = token,
                    fingerprint = fingerprint,
                    shortFingerprint = shortFingerprint(fingerprint),
                    needsTokenCheck = true,
                )
            } finally {
                _isPairing.value = false
            }
        }
    }

    /**
     * Pairs from the Mac's QR code. The fingerprint comes from the QR (read off
     * the Mac's own screen), so — unlike [pairManually] — the connection is
     * pinned to it up front and there's no security-code comparison to do.
     */
    fun pairWithQr(raw: String) {
        val qr = com.voynix.logic.parsePairingQr(raw)
        if (qr == null) {
            _pairError.value = "Not a Voynix pairing QR code"
            return
        }
        viewModelScope.launch {
            _isPairing.value = true
            _pairError.value = null
            try {
                when (api.ping(qr.url, qr.token, pin = qr.fingerprint)) {
                    com.voynix.logic.PeerProbeResult.OK -> savePairedPeer(qr.url, qr.token, qr.fingerprint)
                    com.voynix.logic.PeerProbeResult.UNAUTHORIZED -> _pairError.value = "Invalid token"
                    // A fingerprint mismatch (pinned TLS handshake failing) lands here too.
                    com.voynix.logic.PeerProbeResult.UNREACHABLE -> _pairError.value = "Can't connect to Mac"
                }
            } catch (e: IllegalArgumentException) {
                _pairError.value = "Invalid URL or token"
            } finally {
                _isPairing.value = false
            }
        }
    }

    /** Surfaces a QR-scanner failure (e.g. Google Play services unavailable) in the pairing UI. */
    fun reportPairError(message: String) {
        _pairError.value = message
    }

    /** Confirms the fingerprint shown for [pendingPairing] matched the Mac's, and pins it. */
    fun confirmPendingPairing() {
        val pending = _pendingPairing.value ?: return
        viewModelScope.launch {
            _pendingPairing.value = null
            if (pending.needsTokenCheck) {
                _isPairing.value = true
                _pairError.value = null
                try {
                    // Pinned to the fingerprint the user just confirmed.
                    when (api.ping(pending.url, pending.token, pin = pending.fingerprint)) {
                        com.voynix.logic.PeerProbeResult.OK -> {}
                        com.voynix.logic.PeerProbeResult.UNAUTHORIZED -> {
                            _pairError.value = "Invalid token"
                            return@launch
                        }
                        com.voynix.logic.PeerProbeResult.UNREACHABLE -> {
                            _pairError.value = "Can't connect to Mac"
                            return@launch
                        }
                    }
                } catch (e: IllegalArgumentException) {
                    // A token OkHttp won't put in a header.
                    _pairError.value = "Invalid URL or token"
                    return@launch
                } finally {
                    _isPairing.value = false
                }
            }
            savePairedPeer(pending.url, pending.token, pending.fingerprint)
        }
    }

    private suspend fun savePairedPeer(url: String, token: String, fingerprint: String) {
        peerStore.save(url, token, fingerprint)
        _peer.value = peerStore.get()
        _needsRepairAfterUpdate.value = false
        // The pairing path just got an answer from this Mac.
        _connection.value = PeerConnection.CONNECTED
    }

    fun cancelPendingPairing() {
        _pendingPairing.value = null
    }

    fun forgetPeer() {
        viewModelScope.launch {
            peerStore.clear()
            _peer.value = null
            _connection.value = null
            _lastSummary.value = null
        }
    }

    fun sync() {
        val currentPeer = _peer.value ?: return
        if (isSyncing.value) return
        viewModelScope.launch {
            _syncError.value = null
            val connectionBefore = _connection.value
            _connection.value = PeerConnection.CHECKING
            // Self-heals a stale saved URL (the Mac's port changes every
            // restart unless it reclaims the old one) by re-resolving the
            // same Mac via mDNS before syncing, since the Mac's port can change
            // across restarts.
            when (val result = SyncRunner.sync(
                peer = currentPeer,
                probe = { url, token, pin -> api.ping(url, token, pin) },
                discover = { nsd.discover() },
                runSync = { peer, onProgress -> engine.runSync(peer, onProgress) },
                onPeerMoved = { moved -> peerStore.save(moved.url, moved.token, moved.pin.orEmpty()) },
            )) {
                is SyncRunResult.Success -> {
                    _lastSummary.value = result.summary
                    _connection.value = PeerConnection.CONNECTED
                }
                is SyncRunResult.Failed -> {
                    android.util.Log.e("SyncViewModel", "sync failed: ${result.message}")
                    _syncError.value = result.message
                    // A failure past the connection check (a download error, say) still reached the Mac.
                    _connection.value = result.connection ?: PeerConnection.CONNECTED
                }
                is SyncRunResult.AlreadyRunning -> _connection.value = connectionBefore // a background auto-sync is already running
            }
            _peer.value = peerStore.get()
        }
    }

    private fun deviceName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim().ifBlank { "Voynix" }
}
