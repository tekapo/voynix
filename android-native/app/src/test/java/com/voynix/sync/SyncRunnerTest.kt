package com.voynix.sync

import com.voynix.logic.DiscoveredPeer
import com.voynix.logic.PeerConnection
import com.voynix.logic.PeerProbeResult
import com.voynix.logic.SyncPeer
import com.voynix.logic.SyncSummary
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncRunnerTest {
    private val peer = SyncPeer(url = "https://mac.local:1234", token = "tok", lastSyncAt = null, pin = "pin")
    private val okProbe: suspend (String, String, String?) -> PeerProbeResult = { _, _, _ -> PeerProbeResult.OK }
    private val noDiscover: suspend () -> List<DiscoveredPeer> = { emptyList() }
    private val emptySummary = SyncSummary(added = 0, refetched = 0, deleted = 0, playlists = 0, errors = emptyList())

    @Test
    fun `only one concurrent sync succeeds, the second gets AlreadyRunning`() = runTest {
        val runSyncStarted = CompletableDeferred<Unit>()
        val releaseRunSync = CompletableDeferred<Unit>()
        val first = async {
            SyncRunner.sync(
                peer = peer,
                probe = okProbe,
                discover = noDiscover,
                runSync = { _, _ ->
                    runSyncStarted.complete(Unit)
                    releaseRunSync.await()
                    emptySummary
                },
            )
        }
        runSyncStarted.await()

        val second = SyncRunner.sync(peer = peer, probe = okProbe, discover = noDiscover, runSync = { _, _ -> emptySummary })
        assertEquals(SyncRunResult.AlreadyRunning, second)

        releaseRunSync.complete(Unit)
        val firstResult = first.await()
        assertTrue(firstResult is SyncRunResult.Success)
    }

    @Test
    fun `the lock releases after an exception so a later call can proceed`() = runTest {
        val failed = SyncRunner.sync(
            peer = peer,
            probe = okProbe,
            discover = noDiscover,
            runSync = { _, _ -> throw RuntimeException("boom") },
        )
        assertTrue(failed is SyncRunResult.Failed)
        assertEquals("boom", (failed as SyncRunResult.Failed).message)

        val next = SyncRunner.sync(peer = peer, probe = okProbe, discover = noDiscover, runSync = { _, _ -> emptySummary })
        assertTrue(next is SyncRunResult.Success)
    }

    @Test
    fun `a moved peer URL is reported through onPeerMoved`() = runTest {
        val moved = DiscoveredPeer(name = "Mac", host = "10.0.0.5", port = 5678, url = "https://10.0.0.5:5678")
        var savedPeer: SyncPeer? = null

        val result = SyncRunner.sync(
            peer = peer,
            probe = { url, _, _ -> if (url == peer.url) PeerProbeResult.UNREACHABLE else PeerProbeResult.OK },
            discover = { listOf(moved) },
            runSync = { resolved, _ -> savedPeer = resolved; emptySummary },
            onPeerMoved = { savedPeer = it },
        )

        assertTrue(result is SyncRunResult.Success)
        assertEquals(moved.url, savedPeer?.url)
    }

    @Test
    fun `an unreachable Mac fails the sync with an UNREACHABLE connection`() = runTest {
        val result = SyncRunner.sync(
            peer = peer,
            probe = { _, _, _ -> PeerProbeResult.UNREACHABLE },
            discover = noDiscover,
            runSync = { _, _ -> throw AssertionError("must not sync an unreachable Mac") },
        )
        assertEquals(PeerConnection.UNREACHABLE, (result as SyncRunResult.Failed).connection)
    }

    @Test
    fun `a rejected token fails the sync with an UNAUTHORIZED connection`() = runTest {
        val result = SyncRunner.sync(
            peer = peer,
            probe = { _, _, _ -> PeerProbeResult.UNAUTHORIZED },
            discover = noDiscover,
            runSync = { _, _ -> throw AssertionError("must not sync with a rejected token") },
        )
        assertEquals(PeerConnection.UNAUTHORIZED, (result as SyncRunResult.Failed).connection)
    }

    @Test
    fun `a failure after the Mac answered carries no connection verdict`() = runTest {
        val result = SyncRunner.sync(
            peer = peer,
            probe = okProbe,
            discover = noDiscover,
            runSync = { _, _ -> throw RuntimeException("boom") },
        )
        assertEquals(null, (result as SyncRunResult.Failed).connection)
    }

    private val unreachable: suspend (String, String, String?) -> PeerProbeResult = { _, _, _ -> PeerProbeResult.UNREACHABLE }

    private class FakeTunnel(override val url: String = "https://127.0.0.1:55555") : SyncTunnel {
        var closed = false
        override fun close() { closed = true }
    }

    @Test
    fun `an unreachable Mac is synced over Bluetooth when it is turned on, through the tunnel URL`() = runTest {
        val tunnel = FakeTunnel()
        var syncedUrl: String? = null
        var moved = false

        val result = SyncRunner.sync(
            peer = peer,
            probe = unreachable,
            discover = noDiscover,
            runSync = { _, _ -> throw AssertionError("the network path must not run") },
            onPeerMoved = { moved = true },
            bluetooth = BluetoothTransport(
                open = { tunnel },
                runSync = { p, _ -> syncedUrl = p.url; emptySummary },
            ),
        )

        assertTrue(result is SyncRunResult.Success)
        assertTrue((result as SyncRunResult.Success).viaBluetooth)
        assertEquals(tunnel.url, syncedUrl)
        // The tunnel's local URL must never be saved as the Mac's address.
        assertEquals(false, moved)
        assertTrue(tunnel.closed)
    }

    @Test
    fun `the Bluetooth tunnel is closed even when the sync through it fails`() = runTest {
        val tunnel = FakeTunnel()

        val result = SyncRunner.sync(
            peer = peer,
            probe = unreachable,
            discover = noDiscover,
            runSync = { _, _ -> emptySummary },
            bluetooth = BluetoothTransport(open = { tunnel }, runSync = { _, _ -> throw RuntimeException("link dropped") }),
        )

        assertEquals("link dropped", (result as SyncRunResult.Failed).message)
        assertTrue(tunnel.closed)
    }

    @Test
    fun `when the Mac isn't found over Bluetooth either, the sync fails as unreachable`() = runTest {
        val result = SyncRunner.sync(
            peer = peer,
            probe = unreachable,
            discover = noDiscover,
            runSync = { _, _ -> emptySummary },
            bluetooth = BluetoothTransport(open = { null }, runSync = { _, _ -> throw AssertionError("no tunnel, no sync") }),
        )

        assertEquals(PeerConnection.UNREACHABLE, (result as SyncRunResult.Failed).connection)
    }

    @Test
    fun `Bluetooth is not tried when the Mac is reachable on the network`() = runTest {
        val result = SyncRunner.sync(
            peer = peer,
            probe = okProbe,
            discover = noDiscover,
            runSync = { _, _ -> emptySummary },
            bluetooth = BluetoothTransport(open = { throw AssertionError("must not open Bluetooth") }, runSync = { _, _ -> emptySummary }),
        )

        assertEquals(false, (result as SyncRunResult.Success).viaBluetooth)
    }

    @Test
    fun `a rejected token does not fall back to Bluetooth`() = runTest {
        val result = SyncRunner.sync(
            peer = peer,
            probe = { _, _, _ -> PeerProbeResult.UNAUTHORIZED },
            discover = noDiscover,
            runSync = { _, _ -> emptySummary },
            bluetooth = BluetoothTransport(open = { throw AssertionError("must not open Bluetooth") }, runSync = { _, _ -> emptySummary }),
        )

        assertEquals(PeerConnection.UNAUTHORIZED, (result as SyncRunResult.Failed).connection)
    }
}
