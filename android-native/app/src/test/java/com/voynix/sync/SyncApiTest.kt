package com.voynix.sync

import com.voynix.logic.PeerProbeResult
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
class SyncApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: SyncApi
    private lateinit var tmpDir: File

    /** SHA-256 of the mock server's cert's public key — what a real client
     *  would have pinned at pairing time (see `TlsPinning.kt`). */
    private lateinit var pin: String

    @Before
    fun setUp() {
        // The mock server presents a self-signed cert, same as the real Mac
        // (see src-tauri/src/tls.rs) — everything here exercises the actual
        // pin-not-chain trust model instead of relying on Robolectric's JVM
        // trust store accepting anything.
        val heldCertificate = HeldCertificate.Builder()
            .addSubjectAlternativeName("localhost")
            .build()
        val serverCertificates = HandshakeCertificates.Builder()
            .heldCertificate(heldCertificate)
            .build()
        server = MockWebServer()
        server.useHttps(serverCertificates.sslSocketFactory(), false)
        server.start()
        api = SyncApi()
        pin = spkiFingerprint(heldCertificate.certificate)
        tmpDir = kotlin.io.path.createTempDirectory("sync-api-test").toFile()
    }

    @After
    fun tearDown() {
        server.shutdown()
        tmpDir.deleteRecursively()
    }

    private fun url() = server.url("/").toString()

    // ---- pinning --------------------------------------------------------------

    @Test
    fun `ping succeeds when the pin matches the server's certificate`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        assertEquals(PeerProbeResult.OK, api.ping(url(), "tok", pin))
    }

    @Test
    fun `ping is unreachable when the pin does not match`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        val wrongPin = "0".repeat(64)
        assertEquals(PeerProbeResult.UNREACHABLE, api.ping(url(), "tok", wrongPin))
    }

    @Test
    fun `ping with a null pin bootstraps TOFU and observes the certificate`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        val observed = AtomicReference<String>()
        assertEquals(PeerProbeResult.OK, api.ping(url(), "tok", pin = null, observedPin = observed))
        assertEquals(pin, observed.get())
    }

    @Test
    fun `different certificates produce different fingerprints`() {
        val other = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        assertNotEquals(pin, spkiFingerprint(other.certificate))
    }

    // ---- fetchFingerprint -----------------------------------------------------

    @Test
    fun `fetchFingerprint returns the presented certificate without sending any token`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("<html></html>"))
        assertEquals(pin, api.fetchFingerprint(url()))
        val recorded = server.takeRequest()
        assertEquals("/", recorded.path)
        assertEquals(null, recorded.getHeader("Authorization"))
    }

    @Test
    fun `fetchFingerprint still returns the fingerprint on a non-2xx response`() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(pin, api.fetchFingerprint(url()))
    }

    @Test
    fun `fetchFingerprint is null when the host is unreachable or the URL is malformed`() = runTest {
        server.shutdown()
        assertEquals(null, api.fetchFingerprint(url(), timeoutMs = 500))
        assertEquals(null, api.fetchFingerprint("not a url"))
    }

    // ---- ping ---------------------------------------------------------------

    @Test
    fun `ping returns OK on a successful response`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        assertEquals(PeerProbeResult.OK, api.ping(url(), "tok", pin))
    }

    @Test
    fun `ping returns UNAUTHORIZED on 401`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        assertEquals(PeerProbeResult.UNAUTHORIZED, api.ping(url(), "tok", pin))
    }

    @Test
    fun `ping returns UNREACHABLE on an unreachable host`() = runTest {
        server.shutdown()
        assertEquals(PeerProbeResult.UNREACHABLE, api.ping(url(), "tok", pin, timeoutMs = 500))
    }

    @Test
    fun `ping gives up in bounded time when the server accepts but never answers`() = runTest {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val start = System.nanoTime()
        assertEquals(PeerProbeResult.UNREACHABLE, api.ping(url(), "tok", pin, timeoutMs = 300))
        val elapsedMs = (System.nanoTime() - start) / 1_000_000
        // callTimeout is 3x the per-phase timeout; leave generous slack for slow CI.
        assertTrue("took ${elapsedMs}ms", elapsedMs < 3_000)
    }

    @Test
    fun `fetchFingerprint gives up in bounded time when the server never answers`() = runTest {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val start = System.nanoTime()
        api.fetchFingerprint(url(), timeoutMs = 300)
        val elapsedMs = (System.nanoTime() - start) / 1_000_000
        assertTrue("took ${elapsedMs}ms", elapsedMs < 3_000)
    }

    @Test
    fun `ping sends the bearer token`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        api.ping(url(), "secret-token", pin)
        val recorded = server.takeRequest()
        assertEquals("Bearer secret-token", recorded.getHeader("Authorization"))
        assertEquals("/api/ping", recorded.path)
    }

    // ---- requestPairing ---------------------------------------------------------

    @Test
    fun `requestPairing observes the server's fingerprint and parses the grant`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"url":"${url()}","token":"granted-tok","fingerprint":"$pin"}"""
            )
        )
        val observed = AtomicReference<String>()
        val granted = api.requestPairing(url(), "Pixel 8", observed)
        assertEquals("granted-tok", granted.token)
        assertEquals(pin, granted.fingerprint)
        assertEquals(pin, observed.get())
    }

    // ---- fetchManifest --------------------------------------------------------

    @Test
    fun `fetchManifest retries while the Mac returns 503 then succeeds`() = runTest {
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"device_id":"mac-1","generated_at":123,"playlists":[],"tracks":[],"play_events":[],"album_covers":[]}"""
            )
        )
        val snapshot = api.fetchManifest(url(), "tok", pin)
        assertEquals("mac-1", snapshot.deviceId)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `fetchManifest throws on a non-503 error status`() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        try {
            api.fetchManifest(url(), "tok", pin)
            fail("expected an IOException")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("500"))
        }
    }

    // ---- postStats --------------------------------------------------------

    @Test
    fun `postStats sends the device id and events as JSON`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200))
        api.postStats(
            url(), "tok", pin,
            IncomingStatsDto(deviceId = "dev-1", events = listOf(IncomingEventDto("k1", 111L))),
        )
        val recorded = server.takeRequest()
        assertEquals("/api/sync/stats", recorded.path)
        assertTrue(recorded.body.readUtf8().contains("\"device_id\":\"dev-1\""))
    }

    @Test
    fun `postStats throws on a failure status`() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        try {
            api.postStats(url(), "tok", pin, IncomingStatsDto(deviceId = "dev-1"))
            fail("expected an IOException")
        } catch (e: java.io.IOException) {
            // expected
        }
    }

    // ---- downloadFile -------------------------------------------------------

    @Test
    fun `downloadFile writes the body and verifies the content hash`() = runTest {
        val bytes = "hello world".toByteArray()
        val hashFile = File(tmpDir, "hash-source").apply { writeBytes(bytes) }
        val hash = computeContentHash(hashFile)
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(bytes)))

        val path = api.downloadFile(tmpDir, url(), "tok", pin, trackKey = "trackkey1234", fileName = "song.mp3", expectedHash = hash)

        val file = File(path)
        assertTrue(file.isFile)
        assertEquals("hello world", file.readText())
        assertFalse(File(path.removeSuffix(".mp3") + ".part").exists())
    }

    @Test
    fun `downloadFile deletes the part file and throws on a hash mismatch`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("corrupted"))
        try {
            api.downloadFile(tmpDir, url(), "tok", pin, trackKey = "trackkey1234", fileName = "song.mp3", expectedHash = "deadbeef")
            fail("expected an IOException")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("integrity"))
        }
        assertTrue(tmpDir.listFiles()?.none { it.name.endsWith(".part") } ?: true)
    }

    @Test
    fun `downloadFile resumes an interrupted part file via Range`() = runTest {
        val full = "0123456789ABCDEF"
        val already = "01234"
        val part = File(tmpDir, "trackkey12345678_song.part")
        part.writeText(already)

        server.enqueue(MockResponse().setResponseCode(206).setBody(full.substring(already.length)))

        val hashFile = File(tmpDir, "hash-source").apply { writeText(full) }
        val hash = computeContentHash(hashFile)
        val path = api.downloadFile(tmpDir, url(), "tok", pin, trackKey = "trackkey12345678", fileName = "song", expectedHash = hash)

        assertEquals(full, File(path).readText())
        val recorded = server.takeRequest()
        assertEquals("bytes=5-", recorded.getHeader("Range"))
    }

    @Test
    fun `downloadFile deletes a stale part and throws on 416`() = runTest {
        val part = File(tmpDir, "trackkey12345678_song.part")
        part.writeText("stale-partial-data")
        server.enqueue(MockResponse().setResponseCode(416))

        try {
            api.downloadFile(tmpDir, url(), "tok", pin, trackKey = "trackkey12345678", fileName = "song", expectedHash = "")
            fail("expected StalePartialDownloadException")
        } catch (e: StalePartialDownloadException) {
            // expected
        }
        assertFalse(part.exists())
    }

    // ---- fetchAlbumArt --------------------------------------------------------

    @Test
    fun `fetchAlbumArt caches the response and skips a second fetch`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody(Buffer().write(byteArrayOf(1, 2, 3))))
        val first = api.fetchAlbumArt(tmpDir, url(), "tok", pin, "Artist", "Album")
        assertTrue(first)
        assertEquals(1, server.requestCount)

        // Already cached on disk -> must not issue a second request.
        val second = api.fetchAlbumArt(tmpDir, url(), "tok", pin, "Artist", "Album")
        assertTrue(second)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `fetchAlbumArt returns false on a miss`() = runTest {
        server.enqueue(MockResponse().setResponseCode(404))
        assertFalse(api.fetchAlbumArt(tmpDir, url(), "tok", pin, "Artist", "Album"))
    }
}
