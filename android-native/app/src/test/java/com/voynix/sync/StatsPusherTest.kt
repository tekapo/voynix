package com.voynix.sync

import com.voynix.logic.SyncPeer
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class StatsPusherTest {
    private val peer = SyncPeer("https://mac.local:1234", "tok", null, "pin")

    @Test
    fun `no paired peer is a no-op`() = runTest {
        var pushes = 0
        val p = StatsPusher(peerProvider = { null }, push = { pushes++ })
        p.pushIfDue()
        assertEquals(0, pushes)
    }

    @Test
    fun `a second push inside the min interval is skipped, then allowed after it`() = runTest {
        var now = 1_000L
        var pushes = 0
        val p = StatsPusher(peerProvider = { peer }, push = { pushes++ }, clock = { now }, minIntervalMs = 60_000)
        p.pushIfDue()
        now += 59_000
        p.pushIfDue()
        assertEquals(1, pushes)
        now += 1_000
        p.pushIfDue()
        assertEquals(2, pushes)
    }

    @Test
    fun `a failing push is swallowed`() = runTest {
        val p = StatsPusher(peerProvider = { peer }, push = { error("unreachable") })
        p.pushIfDue() // must not throw
    }
}
