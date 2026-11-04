package com.voynix.sync

import java.net.Inet4Address
import java.net.NetworkInterface

/** The phone's own IPv4 networks, for [com.voynix.logic.subnetCandidates]. */
object LocalSubnets {
    /**
     * Every up, non-loopback IPv4 address with its prefix length. Reads the interfaces
     * directly (not via ConnectivityManager) so a hotspot the phone is hosting — which
     * has no "network" of its own — is included too.
     */
    fun ipv4Addresses(): List<Pair<String, Int>> =
        runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { nif ->
                    nif.interfaceAddresses.mapNotNull { ia ->
                        val addr = ia.address as? Inet4Address ?: return@mapNotNull null
                        addr.hostAddress?.let { it to ia.networkPrefixLength.toInt() }
                    }
                }
        }.getOrDefault(emptyList())
}
