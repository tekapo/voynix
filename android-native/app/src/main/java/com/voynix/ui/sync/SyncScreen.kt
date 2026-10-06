package com.voynix.ui.sync

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.voynix.R
import com.voynix.logic.DiscoveredPeer
import com.voynix.logic.PeerConnection
import com.voynix.sync.SyncViewModel
import java.text.DateFormat
import java.util.Date
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncScreen(vm: SyncViewModel, onBack: () -> Unit) {
    val peer by vm.peer.collectAsState()

    // The saved peer's reachability goes stale while the screen is away (a new
    // network, the Mac asleep), so re-check each time the user comes back to it.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, vm) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.checkConnection()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.sync_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.sync_back))
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState())) {
            if (peer == null) {
                PairingSection(vm)
            } else {
                PairedSection(vm, peerUrl = peer!!.url, lastSyncAt = peer!!.lastSyncAt)
            }
        }
    }

    val pending by vm.pendingPairing.collectAsState()
    pending?.let { p ->
        AlertDialog(
            onDismissRequest = { vm.cancelPendingPairing() },
            title = { Text(stringResource(R.string.sync_is_this_right_mac)) },
            text = {
                Column {
                    Text(stringResource(R.string.sync_check_security_code))
                    Spacer(Modifier.height(12.dp))
                    Text(p.shortFingerprint, style = MaterialTheme.typography.titleLarge)
                }
            },
            confirmButton = {
                TextButton(onClick = { vm.confirmPendingPairing() }) { Text(stringResource(R.string.sync_matches_pair)) }
            },
            dismissButton = {
                TextButton(onClick = { vm.cancelPendingPairing() }) { Text(stringResource(R.string.sync_cancel)) }
            },
        )
    }
}

@Composable
private fun PairingSection(vm: SyncViewModel) {
    val discovered by vm.discoveredPeers.collectAsState()
    val isDiscovering by vm.isDiscovering.collectAsState()
    val isPairing by vm.isPairing.collectAsState()
    val pairError by vm.pairError.collectAsState()
    val needsRepairAfterUpdate by vm.needsRepairAfterUpdate.collectAsState()
    var manualUrl by remember { mutableStateOf("") }
    var manualToken by remember { mutableStateOf("") }

    if (needsRepairAfterUpdate) {
        Text(
            stringResource(R.string.sync_repair_required),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )
        Spacer(Modifier.height(12.dp))
    }

    Text(stringResource(R.string.sync_pair_with_mac), style = MaterialTheme.typography.bodyMedium)
    Spacer(Modifier.height(12.dp))

    // Progress and errors sit right under the intro, not under the manual-entry
    // form: they must stay on screen however tall the form is (large fonts, the
    // keyboard open), or a failed pairing looks like nothing happened.
    if (isPairing) {
        CircularProgressIndicator()
        Spacer(Modifier.height(12.dp))
    }
    pairError?.let {
        Text(it, color = MaterialTheme.colorScheme.error)
        Spacer(Modifier.height(12.dp))
    }

    val context = LocalContext.current
    val scanFailedMessage = stringResource(R.string.sync_qr_scan_failed)
    Button(
        onClick = {
            val options = GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build()
            GmsBarcodeScanning.getClient(context, options)
                .startScan()
                .addOnSuccessListener { barcode -> vm.pairWithQr(barcode.rawValue.orEmpty()) }
                .addOnFailureListener { e ->
                    // The user backing out of the scanner isn't an error worth showing.
                    if (e !is com.google.mlkit.common.MlKitException || e.errorCode != com.google.mlkit.common.MlKitException.CODE_SCANNER_CANCELLED) {
                        vm.reportPairError(scanFailedMessage)
                    }
                }
        },
        enabled = !isPairing,
    ) {
        Text(stringResource(R.string.sync_scan_qr))
    }
    Text(stringResource(R.string.sync_scan_qr_hint), style = MaterialTheme.typography.bodySmall)
    Spacer(Modifier.height(16.dp))

    OutlinedButton(onClick = { vm.discover() }, enabled = !isDiscovering) {
        Text(if (isDiscovering) stringResource(R.string.sync_searching) else stringResource(R.string.sync_find_mac))
    }

    if (discovered.isNotEmpty()) {
        Spacer(Modifier.height(12.dp))
        // A plain Column, not a LazyColumn: the screen already scrolls, and a lazy
        // list can't be nested in a vertically scrolling parent.
        Column {
            discovered.forEach { p ->
                key(p.url) {
                    DiscoveredPeerRow(p, enabled = !isPairing, onClick = { vm.pairWithDiscovered(p) })
                }
            }
        }
    }

    Spacer(Modifier.height(20.dp))
    HorizontalDivider()
    Spacer(Modifier.height(20.dp))
    Text(stringResource(R.string.sync_enter_manually), style = MaterialTheme.typography.bodyMedium)
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = manualUrl,
        onValueChange = { manualUrl = it },
        label = { Text(stringResource(R.string.sync_url_label)) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    OutlinedTextField(
        value = manualToken,
        onValueChange = { manualToken = it },
        label = { Text(stringResource(R.string.sync_token_label)) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    Button(
        onClick = { vm.pairManually(manualUrl, manualToken) },
        enabled = !isPairing && manualUrl.isNotBlank() && manualToken.isNotBlank(),
    ) {
        Text(stringResource(R.string.sync_pair_manually))
    }
}

@Composable
private fun DiscoveredPeerRow(peer: DiscoveredPeer, enabled: Boolean, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(peer.name) },
        supportingContent = { Text(peer.url) },
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick),
    )
}

@Composable
private fun PairedSection(vm: SyncViewModel, peerUrl: String, lastSyncAt: Long?) {
    val isSyncing by vm.isSyncing.collectAsState()
    val progress by vm.syncProgress.collectAsState()
    val summary by vm.lastSummary.collectAsState()
    val syncError by vm.syncError.collectAsState()
    val connection by vm.connection.collectAsState()

    val statusColor = when (connection) {
        PeerConnection.CONNECTED -> MaterialTheme.colorScheme.primary
        PeerConnection.UNREACHABLE, PeerConnection.UNAUTHORIZED -> MaterialTheme.colorScheme.error
        PeerConnection.CHECKING, null -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val statusText = when (connection) {
        PeerConnection.CONNECTED -> stringResource(R.string.sync_status_connected)
        PeerConnection.UNREACHABLE -> stringResource(R.string.sync_status_unreachable)
        PeerConnection.UNAUTHORIZED -> stringResource(R.string.sync_status_unauthorized)
        PeerConnection.CHECKING, null -> stringResource(R.string.sync_status_checking)
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    modifier = Modifier.size(10.dp),
                    shape = CircleShape,
                    color = statusColor,
                ) {}
                Spacer(Modifier.width(10.dp))
                Text(statusText, style = MaterialTheme.typography.titleMedium, color = statusColor, modifier = Modifier.weight(1f))
            }
            if (connection == PeerConnection.UNREACHABLE) {
                Text(
                    stringResource(R.string.sync_status_unreachable_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
            Text(peerUrl, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
            Text(
                lastSyncAt?.let { stringResource(R.string.sync_last_sync, DateFormat.getDateTimeInstance().format(Date(it))) }
                    ?: stringResource(R.string.sync_not_synced_yet),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )

            if (isSyncing) {
                Spacer(Modifier.height(12.dp))
                val fraction = progress?.let { p -> p.total?.let { t -> if (t > 0) (p.current ?: 0).toFloat() / t else null } }
                if (fraction != null) {
                    LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth())
                } else {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                progress?.let {
                    Spacer(Modifier.height(6.dp))
                    val counts = if (it.total != null) stringResource(R.string.sync_progress_counts, it.current ?: 0, it.total) else ""
                    Text(
                        "${it.message}$counts",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }

    Spacer(Modifier.height(16.dp))
    Button(onClick = { vm.sync() }, enabled = !isSyncing) {
        Text(if (isSyncing) stringResource(R.string.sync_syncing) else stringResource(R.string.sync_now))
    }

    val autoSyncEnabled by vm.autoSyncEnabled.collectAsState()
    val autoSyncChargingOnly by vm.autoSyncChargingOnly.collectAsState()

    Spacer(Modifier.height(16.dp))
    Card(modifier = Modifier.fillMaxWidth()) {
        Column {
            ListItem(
                headlineContent = { Text(stringResource(R.string.sync_auto_sync)) },
                supportingContent = { Text(stringResource(R.string.sync_auto_sync_detail)) },
                trailingContent = {
                    Switch(checked = autoSyncEnabled, onCheckedChange = { vm.setAutoSyncEnabled(it) })
                },
                modifier = Modifier.clickable { vm.setAutoSyncEnabled(!autoSyncEnabled) },
            )
            ListItem(
                headlineContent = { Text(stringResource(R.string.sync_charging_only)) },
                trailingContent = {
                    Switch(
                        checked = autoSyncChargingOnly,
                        onCheckedChange = { vm.setAutoSyncChargingOnly(it) },
                        enabled = autoSyncEnabled,
                    )
                },
                modifier = Modifier
                    .clickable(enabled = autoSyncEnabled) { vm.setAutoSyncChargingOnly(!autoSyncChargingOnly) },
            )
        }
    }

    summary?.let {
        Spacer(Modifier.height(16.dp))
        Text(
            stringResource(R.string.sync_summary, it.added, it.refetched, it.deleted, it.playlists),
            style = MaterialTheme.typography.bodyMedium,
        )
        if (it.errors.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(stringResource(R.string.sync_errors), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            it.errors.forEach { err ->
                Text(stringResource(R.string.sync_error_bullet, err), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }

    syncError?.let {
        Spacer(Modifier.height(12.dp))
        Text(it, color = MaterialTheme.colorScheme.error)
    }

    Spacer(Modifier.height(24.dp))
    OutlinedButton(onClick = { vm.forgetPeer() }) {
        Text(stringResource(R.string.sync_unpair))
    }
}
