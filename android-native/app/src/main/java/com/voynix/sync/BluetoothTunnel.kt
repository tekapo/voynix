package com.voynix.sync

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.coroutines.resume

private const val TAG = "BluetoothTunnel"

/** Must match `SERVICE_UUID` / `INFO_CHAR_UUID` in src-tauri/src/bt.rs. */
val BT_SERVICE_UUID: UUID = UUID.fromString("6B0C7F10-3A5D-4E8B-9C1F-7D2A5B9E4C01")
val BT_INFO_CHAR_UUID: UUID = UUID.fromString("6B0C7F11-3A5D-4E8B-9C1F-7D2A5B9E4C01")

/** A way to reach the Mac's sync server that is not a LAN address: [url] is a local address the HTTP client uses. */
interface SyncTunnel : Closeable {
    val url: String
}

/** The Mac's info characteristic: PSM (2 bytes, big-endian) then the first 8 bytes of its TLS fingerprint. */
data class MacChannelInfo(val psm: Int, val fingerprintPrefix: ByteArray)

fun parseChannelInfo(bytes: ByteArray?): MacChannelInfo? {
    if (bytes == null || bytes.size < 2) return null
    val psm = ((bytes[0].toInt() and 0xFF) shl 8) or (bytes[1].toInt() and 0xFF)
    if (psm == 0) return null
    return MacChannelInfo(psm, bytes.copyOfRange(2, bytes.size))
}

/**
 * True when the Mac is plausibly the paired one: its advertised fingerprint
 * prefix matches the start of our saved pin. Only a hint to avoid connecting
 * to somebody else's Mac; the TLS pin is what actually authenticates it. A
 * Mac that sent no prefix can't be told apart, so it is allowed through.
 */
fun fingerprintMatchesPin(prefix: ByteArray, pinHex: String?): Boolean {
    if (prefix.isEmpty()) return true
    val pin = pinHex?.lowercase() ?: return false
    val hex = prefix.joinToString("") { "%02x".format(it) }
    return pin.startsWith(hex)
}

/** One open L2CAP channel (or a stand-in for tests). */
interface TunnelChannel : Closeable {
    val input: InputStream
    val output: OutputStream
}

fun interface TunnelChannelFactory {
    /** Blocks until a channel to the Mac is open; throws [IOException] if it can't be. */
    fun open(): TunnelChannel
}

/**
 * A server on 127.0.0.1 that pipes every accepted connection to its own
 * channel. The HTTP client (OkHttp, with the TLS pin) just talks to [url]; it
 * keeps several connections open at once, so each one gets a channel.
 */
class LocalBridge(private val channels: TunnelChannelFactory) : SyncTunnel {
    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    private val closed = AtomicBoolean(false)
    private val live = java.util.Collections.synchronizedSet(HashSet<Closeable>())

    override val url: String = "https://127.0.0.1:${server.localPort}"

    init {
        thread(name = "bt-bridge-accept", isDaemon = true) {
            while (!closed.get()) {
                val local = try { server.accept() } catch (_: IOException) { break }
                serve(local)
            }
        }
    }

    private fun serve(local: Socket) {
        thread(name = "bt-bridge-conn", isDaemon = true) {
            val channel = try {
                channels.open()
            } catch (e: IOException) {
                Log.w(TAG, "channel open failed: ${e.message}")
                runCatching { local.close() }
                return@thread
            }
            live.add(local)
            live.add(channel)
            val shutdown = {
                runCatching { local.close() }
                runCatching { channel.close() }
                live.remove(local)
                live.remove(channel)
            }
            thread(name = "bt-bridge-up", isDaemon = true) {
                pipe(local.getInputStream(), channel.output)
                shutdown()
            }
            pipe(channel.input, local.getOutputStream())
            shutdown()
        }
    }

    private fun pipe(from: InputStream, to: OutputStream) {
        val buf = ByteArray(16 * 1024)
        try {
            while (true) {
                val n = from.read(buf)
                if (n < 0) break
                to.write(buf, 0, n)
                to.flush()
            }
        } catch (_: IOException) {
            // Either side going away ends the connection.
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { server.close() }
        synchronized(live) { live.toList() }.forEach { runCatching { it.close() } }
        live.clear()
    }
}

/** Finds the paired Mac over BLE and opens tunnels to it. Needs API 31+ (the new Bluetooth permissions). */
object BluetoothTunnels {
    val isSupported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    fun hasPermissions(context: Context): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        listOf(android.Manifest.permission.BLUETOOTH_SCAN, android.Manifest.permission.BLUETOOTH_CONNECT).all {
            context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }

    /** Scans for the Mac whose fingerprint matches [pinHex], then bridges to it. Null if none is found in time. */
    @SuppressLint("MissingPermission")
    suspend fun open(context: Context, pinHex: String?): SyncTunnel? = withContext(Dispatchers.IO) {
        if (!hasPermissions(context)) return@withContext null
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null || !adapter.isEnabled) return@withContext null
        val found = withTimeoutOrNull(SCAN_TIMEOUT_MS) { findMac(context, adapter.bluetoothLeScanner ?: return@withTimeoutOrNull null, pinHex) }
            ?: return@withContext null
        Log.i(TAG, "found the Mac (psm ${found.info.psm}); opening the bridge")
        LocalBridge { openChannel(found.device, found.info.psm) }
    }

    @SuppressLint("MissingPermission")
    private fun openChannel(device: BluetoothDevice, psm: Int): TunnelChannel {
        // Plain (unencrypted) channel: TLS on top provides the security, and this avoids an OS pairing prompt.
        val socket = device.createInsecureL2capChannel(psm)
        try {
            socket.connect()
        } catch (e: IOException) {
            runCatching { socket.close() }
            throw e
        }
        return object : TunnelChannel {
            override val input: InputStream get() = socket.inputStream
            override val output: OutputStream get() = socket.outputStream
            override fun close() = socket.close()
        }
    }

    private class Found(val device: BluetoothDevice, val info: MacChannelInfo)

    @SuppressLint("MissingPermission")
    private suspend fun findMac(
        context: Context,
        scanner: android.bluetooth.le.BluetoothLeScanner,
        pinHex: String?,
    ): Found? {
        val devices = Channel<BluetoothDevice>(Channel.UNLIMITED)
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                devices.trySend(result.device)
            }
            override fun onScanFailed(errorCode: Int) {
                Log.w(TAG, "scan failed: $errorCode")
                devices.close()
            }
        }
        val filter = ScanFilter.Builder().setServiceUuid(ParcelUuid(BT_SERVICE_UUID)).build()
        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
        scanner.startScan(listOf(filter), settings, callback)
        try {
            val tried = HashSet<String>()
            for (device in devices) {
                if (!tried.add(device.address)) continue
                val info = withTimeoutOrNull(GATT_TIMEOUT_MS) { readInfo(context, device) } ?: continue
                if (fingerprintMatchesPin(info.fingerprintPrefix, pinHex)) return Found(device, info)
                Log.i(TAG, "skipping a Voynix Mac that isn't the paired one")
            }
            return null
        } finally {
            runCatching { scanner.stopScan(callback) }
            devices.close()
        }
    }

    /** Connects over GATT, reads the info characteristic, and disconnects. Null on any failure. */
    @SuppressLint("MissingPermission")
    private suspend fun readInfo(context: Context, device: BluetoothDevice): MacChannelInfo? =
        suspendCancellableCoroutine { cont: CancellableContinuation<MacChannelInfo?> ->
            var gatt: BluetoothGatt? = null
            val done = AtomicBoolean(false)
            fun finish(result: MacChannelInfo?) {
                if (!done.compareAndSet(false, true)) return
                runCatching { gatt?.disconnect(); gatt?.close() }
                if (cont.isActive) cont.resume(result)
            }
            val callback = object : BluetoothGattCallback() {
                override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                    if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                        g.discoverServices()
                    } else {
                        finish(null)
                    }
                }
                override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                    val characteristic = g.getService(BT_SERVICE_UUID)?.getCharacteristic(BT_INFO_CHAR_UUID)
                    if (status != BluetoothGatt.GATT_SUCCESS || characteristic == null || !g.readCharacteristic(characteristic)) finish(null)
                }
                @Deprecated("Used below API 33")
                override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
                    @Suppress("DEPRECATION")
                    finish(if (status == BluetoothGatt.GATT_SUCCESS) parseChannelInfo(c.value) else null)
                }
                override fun onCharacteristicRead(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray, status: Int) {
                    finish(if (status == BluetoothGatt.GATT_SUCCESS) parseChannelInfo(value) else null)
                }
            }
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
            cont.invokeOnCancellation { finish(null) }
        }

    private const val SCAN_TIMEOUT_MS = 15_000L
    private const val GATT_TIMEOUT_MS = 8_000L
}
