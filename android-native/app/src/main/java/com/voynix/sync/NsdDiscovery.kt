package com.voynix.sync

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import com.voynix.logic.DiscoveredPeer
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

private const val SERVICE_TYPE = "_voynix._tcp."
private const val TAG = "NsdDiscovery"

/**
 * Browses the LAN for a Mac advertising `_voynix._tcp.local.` (see
 * `mdns_service_info` in server.rs) so pairing doesn't require typing an IP.
 * Mirrors client.rs's `sync_discover_peers`: browse for [timeoutMs], resolve
 * every service seen, dedupe by URL, sort by URL.
 */
@Suppress("DEPRECATION") // minSdk 26 needs the pre-API-34 resolveService/host overloads.
class NsdDiscovery(context: Context) {
    private val nsdManager = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager

    private val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    suspend fun discover(timeoutMs: Long = 3000): List<DiscoveredPeer> {
        val found = ConcurrentHashMap<String, DiscoveredPeer>()
        val resolveQueue = ConcurrentLinkedQueue<NsdServiceInfo>()
        val resolving = AtomicBoolean(false)

        fun drainResolveQueue() {
            if (!resolving.compareAndSet(false, true)) return
            val next = resolveQueue.poll()
            if (next == null) {
                resolving.set(false)
                return
            }
            nsdManager.resolveService(next, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    Log.w(TAG, "resolve failed for ${serviceInfo.serviceName}: $errorCode")
                    resolving.set(false)
                    drainResolveQueue()
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val host = serviceInfo.host?.hostAddress
                    if (host != null) {
                        val url = "https://$host:${serviceInfo.port}"
                        found[url] = DiscoveredPeer(
                            name = serviceInfo.serviceName ?: "Voynix",
                            host = host,
                            port = serviceInfo.port,
                            url = url,
                        )
                    }
                    resolving.set(false)
                    drainResolveQueue()
                }
            })
        }

        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                resolveQueue.add(serviceInfo)
                drainResolveQueue()
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "start discovery failed: $errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        }

        // Some devices drop incoming multicast on Wi-Fi to save power unless a lock is held,
        // which silently breaks mDNS. Hold one only while browsing.
        val multicastLock = runCatching { wifiManager?.createMulticastLock("voynix-nsd")?.apply { setReferenceCounted(false); acquire() } }.getOrNull()
        try {
            startDiscovery(discoveryListener)
            withTimeoutOrNull(timeoutMs) {
                // Nothing to await on directly — just let the callbacks populate
                // [found] for the whole budget, same as client.rs's fixed browse window.
                kotlinx.coroutines.delay(timeoutMs)
            }
        } finally {
            runCatching { nsdManager.stopServiceDiscovery(discoveryListener) }
            runCatching { multicastLock?.takeIf { it.isHeld }?.release() }
        }

        return found.values.sortedBy { it.url }
    }

    private suspend fun startDiscovery(listener: NsdManager.DiscoveryListener) =
        suspendCancellableCoroutine<Unit> { cont ->
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
            cont.resume(Unit)
        }
}
