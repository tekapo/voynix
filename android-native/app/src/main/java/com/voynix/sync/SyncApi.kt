package com.voynix.sync

import android.util.Log
import com.voynix.logic.PeerProbeResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

private val JSON_MEDIA_TYPE = "application/json".toMediaType()
private val json = Json { ignoreUnknownKeys = true }

class PairingDeclinedException : Exception("The Mac declined the pairing request.")
class PairingTimeoutException : Exception("No response from the Mac. Approve the prompt there, then try again.")
class PairingBusyException : Exception("The Mac is busy with another pairing request, or one was just declined. Try again in a few seconds.")
class PairingUnavailableException : Exception("This Mac can't show a pairing prompt. Enter the pairing code instead.")
class ManifestUnavailableException : Exception("Mac is still preparing files — try again shortly")
class StalePartialDownloadException : Exception("Stale partial download — will retry from scratch")

/** Talks to the Mac's LAN sync server (src-tauri/src/server.rs). Mirrors client.rs 1:1. */
class SyncApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private fun base(url: String) = url.trimEnd('/')

    /**
     * Cheap liveness/auth check against /api/ping, used to validate a saved peer
     * URL before falling back to mDNS rediscovery. Never throws.
     *
     * [pin] is the SPKI fingerprint recorded at pairing time; null bootstraps
     * TOFU trust for the manual-pairing flow, where nothing has been pinned yet
     * — [observedPin], if given, captures what the server presented either way.
     */
    suspend fun ping(
        url: String,
        token: String,
        pin: String?,
        observedPin: AtomicReference<String>? = null,
        timeoutMs: Long = 2000,
    ): PeerProbeResult =
        withContext(Dispatchers.IO) {
            try {
                val shortClient = pinnedClient(client, pin, observedPin)
                    .newBuilder()
                    .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    // Hard cap on the whole call (connect + TLS + response): the
                    // per-phase timeouts alone don't bound a half-open connection.
                    .callTimeout(timeoutMs * 3, TimeUnit.MILLISECONDS)
                    .build()
                val req = Request.Builder()
                    .url("${base(url)}/api/ping")
                    .header("Authorization", "Bearer $token")
                    .build()
                shortClient.newCall(req).execute().use { resp ->
                    when {
                        resp.code == 401 -> PeerProbeResult.UNAUTHORIZED
                        resp.isSuccessful -> PeerProbeResult.OK
                        else -> PeerProbeResult.UNREACHABLE
                    }
                }
            } catch (e: IOException) {
                Log.w("SyncApi", "ping($url) failed", e)
                PeerProbeResult.UNREACHABLE
            }
        }

    /**
     * TOFU bootstrap for manual pairing: completes the TLS handshake with an
     * unauthenticated `GET /` and returns the fingerprint of the certificate the
     * server presented, or null if it can't be reached. No token is sent — the
     * connection isn't pinned yet, so anything on the LAN could be answering,
     * and the bearer token must only travel over a connection pinned to a
     * fingerprint the user has confirmed (see [ping]).
     */
    suspend fun fetchFingerprint(url: String, timeoutMs: Long = 5000): String? =
        withContext(Dispatchers.IO) {
            try {
                val observed = AtomicReference<String>()
                val shortClient = pinnedClient(client, expectedSpkiHex = null, observed = observed)
                    .newBuilder()
                    .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .callTimeout(timeoutMs * 2, TimeUnit.MILLISECONDS)
                    .build()
                // Any HTTP status will do — the handshake is what we're after.
                shortClient.newCall(Request.Builder().url("${base(url)}/").build()).execute().use { }
                observed.get()?.takeIf { it.isNotEmpty() }
            } catch (e: IOException) {
                Log.w("SyncApi", "fetchFingerprint($url) failed", e)
                null
            } catch (e: IllegalArgumentException) {
                null // malformed URL
            }
        }

    /**
     * Blocks (up to the Mac's own 60s approval window, plus slack) while the
     * Mac's owner approves or denies an on-screen prompt.
     *
     * There's no pin yet at this point — this is TOFU: [observedPin] captures
     * whatever certificate the server presents, so the caller can show it to
     * the user for comparison before trusting it as the pin going forward.
     */
    suspend fun requestPairing(url: String, deviceName: String, observedPin: AtomicReference<String>): PairGrantedDto =
        withContext(Dispatchers.IO) {
            val longClient = pinnedClient(client, expectedSpkiHex = null, observed = observedPin)
                .newBuilder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(75, TimeUnit.SECONDS)
                .build()
            val body = json.encodeToString(PairRequestDto.serializer(), PairRequestDto(deviceName))
                .toRequestBody(JSON_MEDIA_TYPE)
            val req = Request.Builder().url("${base(url)}/pair").post(body).build()
            longClient.newCall(req).execute().use { resp ->
                when (resp.code) {
                    in 200..299 -> json.decodeFromString(PairGrantedDto.serializer(), resp.body!!.string())
                    403 -> throw PairingDeclinedException()
                    408 -> throw PairingTimeoutException()
                    429 -> throw PairingBusyException()
                    501 -> throw PairingUnavailableException()
                    else -> throw IOException("Pairing failed (${resp.code}).")
                }
            }
        }

    /** Retries on 503 (Mac still transcoding) for up to ~60s, matching client.rs. */
    suspend fun fetchManifest(url: String, token: String, pin: String?): SyncSnapshotDto {
        val endpoint = "${base(url)}/api/manifest"
        val pinned = pinnedClient(client, pin)
        repeat(20) { attempt ->
            // The whole response — status check AND body read — must stay
            // inside withContext(IO): a suspend function resumes on its
            // caller's dispatcher once withContext returns, so reading the
            // body (real socket I/O) outside it throws NetworkOnMainThreadException
            // when this runs from a Main-dispatched scope (e.g. viewModelScope).
            val result = withContext(Dispatchers.IO) {
                pinned.newCall(
                    Request.Builder().url(endpoint).header("Authorization", "Bearer $token").build()
                ).execute().use<okhttp3.Response, SyncSnapshotDto?> { resp ->
                    if (resp.code == 503) return@use null
                    if (!resp.isSuccessful) throw IOException("Manifest request returned ${resp.code}")
                    json.decodeFromString(SyncSnapshotDto.serializer(), resp.body!!.string())
                }
            }
            if (result != null) return result
            if (attempt == 19) throw ManifestUnavailableException()
            delay(3000)
        }
        throw ManifestUnavailableException()
    }

    suspend fun postStats(url: String, token: String, pin: String?, payload: IncomingStatsDto) =
        withContext(Dispatchers.IO) {
            val body = json.encodeToString(IncomingStatsDto.serializer(), payload).toRequestBody(JSON_MEDIA_TYPE)
            val req = Request.Builder()
                .url("${base(url)}/api/sync/stats")
                .header("Authorization", "Bearer $token")
                .post(body)
                .build()
            pinnedClient(client, pin).newCall(req).execute().use {
                if (!it.isSuccessful) throw IOException("Stats push returned ${it.code}")
            }
        }

    /**
     * Bytes free where [dir] lives, or null if the directory can't be created.
     * A full disk reports 0 (not null) so the caller refuses to download
     * instead of treating "no space" as "unknown".
     */
    fun freeSpaceBytes(dir: File): Long? {
        dir.mkdirs()
        return if (dir.isDirectory) dir.usableSpace else null
    }

    /** Bytes of an interrupted download of this track already on disk (its `.part`), 0 if none. */
    fun partialBytes(dir: File, trackKey: String, fileName: String): Long =
        withExtension(destFile(dir, trackKey, fileName), "part").let { if (it.isFile) it.length() else 0L }

    /**
     * Downloads one track into [dir], resuming a `.part` left by an interrupted
     * transfer via `Range`, verifying the byte fingerprint against
     * [expectedHash] before committing. Returns the final file's absolute path.
     */
    suspend fun downloadFile(
        dir: File,
        url: String,
        token: String,
        pin: String?,
        trackKey: String,
        fileName: String,
        expectedHash: String,
    ): String = withContext(Dispatchers.IO) {
        dir.mkdirs()
        val dest = destFile(dir, trackKey, fileName)
        val part = withExtension(dest, "part")

        val have = if (part.isFile) part.length() else 0L

        val reqBuilder = Request.Builder()
            .url("${base(url)}/api/file/$trackKey")
            .header("Authorization", "Bearer $token")
        if (have > 0) reqBuilder.header("Range", "bytes=$have-")

        pinnedClient(client, pin).newCall(reqBuilder.build()).execute().use { resp ->
            if (resp.code == 416) {
                part.delete()
                throw StalePartialDownloadException()
            }
            if (!resp.isSuccessful) throw IOException("File request returned ${resp.code}")

            val resuming = have > 0 && resp.code == 206
            val body = resp.body ?: throw IOException("Empty response body")

            if (resuming) {
                RandomAccessFile(part, "rw").use { raf ->
                    raf.seek(raf.length())
                    body.byteStream().use { input ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            raf.write(buf, 0, n)
                        }
                    }
                }
            } else {
                part.outputStream().use { out ->
                    body.byteStream().use { input -> input.copyTo(out) }
                }
            }
        }

        if (expectedHash.isNotEmpty()) {
            val got = computeContentHash(part)
            if (got != expectedHash) {
                part.delete()
                throw IOException("Downloaded file failed integrity check")
            }
        }

        if (dest.exists()) dest.delete()
        if (!part.renameTo(dest)) throw IOException("Couldn't finalize download for $fileName")
        dest.absolutePath
    }

    /**
     * Best-effort: caches the Mac's resolved album cover for (artist, album)
     * into [cacheDir]/<key>.jpg. Returns true if a cover ends up cached
     * (already there, or freshly fetched); false on a confirmed miss.
     */
    suspend fun fetchAlbumArt(cacheDir: File, url: String, token: String, pin: String?, artist: String, album: String): Boolean =
        withContext(Dispatchers.IO) {
            cacheDir.mkdirs()
            val key = albumArtCacheKey(artist, album)
            val dest = File(cacheDir, "$key.jpg")
            if (dest.isFile) return@withContext true

            val req = Request.Builder()
                .url("${base(url)}/api/album-art/$key")
                .header("Authorization", "Bearer $token")
                .build()
            pinnedClient(client, pin).newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext false
                val body = resp.body ?: return@withContext false
                dest.outputStream().use { out -> body.byteStream().use { input -> input.copyTo(out) } }
                true
            }
        }
}

private fun destFile(dir: File, trackKey: String, fileName: String): File {
    val safeName = fileName.replace('/', '_').replace('\\', '_')
    return File(dir, "${trackKey.take(16)}_$safeName")
}

private fun withExtension(file: File, ext: String): File {
    val name = file.name
    val dot = name.lastIndexOf('.')
    val base = if (dot >= 0) name.substring(0, dot) else name
    return File(file.parentFile, "$base.$ext")
}
