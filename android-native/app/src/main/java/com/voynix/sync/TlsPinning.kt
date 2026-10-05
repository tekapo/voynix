package com.voynix.sync

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient

// TLS trust for the Mac's LAN sync server (self-signed, IP-addressed, see
// src-tauri/src/tls.rs). Two things make the usual TLS trust model unusable
// here: the certificate isn't CA-signed, and its IP can change (Wi-Fi
// switch, DHCP renewal) so there's nothing stable to hostname-verify against.
//
// Instead this pins the server's *public key* (SPKI), not the certificate:
// the Mac keeps the same key pair across restarts/IP changes and only
// re-issues the (otherwise disposable) leaf certificate, so a pin recorded
// once at pairing keeps matching indefinitely. Hostname verification is
// disabled outright — identity is the pin, not the name in the cert.

/** SHA-256 of a certificate's SubjectPublicKeyInfo, as lowercase hex. Matches
 *  `tls::short_fingerprint`'s input format (Rust) so the two sides compare
 *  identically. */
fun spkiFingerprint(cert: X509Certificate): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
    return digest.joinToString("") { "%02x".format(it) }
}

private fun constantTimeEquals(a: String, b: String): Boolean {
    if (a.length != b.length) return false
    var diff = 0
    for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
    return diff == 0
}

/**
 * Accepts any certificate chain (self-signed included) but enforces
 * [expectedSpkiHex] against the leaf's public key when it's non-null.
 *
 * A null [expectedSpkiHex] is trust-on-first-use: only valid while pairing,
 * where there's nothing to pin against yet. The observed fingerprint is
 * written to [observed] either way, so a pairing flow can capture it.
 */
private class PinningTrustManager(
    private val expectedSpkiHex: String?,
    private val observed: AtomicReference<String>?,
) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) {
        throw CertificateException("Client certificates are not used for LAN sync.")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
        val leaf = chain.firstOrNull() ?: throw CertificateException("No certificate presented.")
        val fingerprint = spkiFingerprint(leaf)
        observed?.set(fingerprint)
        val expected = expectedSpkiHex ?: return // TOFU bootstrap: accept, caller decides trust.
        if (!constantTimeEquals(fingerprint, expected)) {
            throw CertificateException(
                "The Mac's TLS certificate changed — refusing to connect. Re-pair if this Mac was reinstalled."
            )
        }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/** Formats a fingerprint for on-screen comparison, e.g. "a1b2 c3d4 e5f6 0789"
 *  — mirrors `tls::short_fingerprint` (Rust) so both sides show the same text. */
fun shortFingerprint(fingerprint: String): String = fingerprint.take(16).chunked(4).joinToString(" ")

/**
 * Derives a client from [base] that pins [expectedSpkiHex] instead of using
 * the system trust store. Never apply this to a client that also talks to a
 * real internet host (e.g. [com.voynix.lyrics.LrclibApi]) — only the LAN
 * sync server's self-signed cert should ever be trusted this way.
 */
fun pinnedClient(
    base: OkHttpClient,
    expectedSpkiHex: String?,
    observed: AtomicReference<String>? = null,
): OkHttpClient {
    val trustManager = PinningTrustManager(expectedSpkiHex, observed)
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf<TrustManager>(trustManager), null)
    return base.newBuilder()
        .sslSocketFactory(sslContext.socketFactory, trustManager)
        .hostnameVerifier { _, _ -> true }
        .build()
}
