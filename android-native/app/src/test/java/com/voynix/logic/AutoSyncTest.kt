package com.voynix.logic

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AutoSyncTest {
    private val now = 10_000_000L

    @Test
    fun `false when disabled`() {
        assertFalse(shouldAutoSync(enabled = false, hasPeer = true, lastSyncAt = null, now = now))
    }

    @Test
    fun `false with no paired peer`() {
        assertFalse(shouldAutoSync(enabled = true, hasPeer = false, lastSyncAt = null, now = now))
    }

    @Test
    fun `false when the last sync was within the interval`() {
        val lastSyncAt = now - AUTO_SYNC_MIN_INTERVAL_MS + 1
        assertFalse(shouldAutoSync(enabled = true, hasPeer = true, lastSyncAt = lastSyncAt, now = now))
    }

    @Test
    fun `true once the interval has passed`() {
        val lastSyncAt = now - AUTO_SYNC_MIN_INTERVAL_MS - 1
        assertTrue(shouldAutoSync(enabled = true, hasPeer = true, lastSyncAt = lastSyncAt, now = now))
    }

    @Test
    fun `true when there's never been a sync`() {
        assertTrue(shouldAutoSync(enabled = true, hasPeer = true, lastSyncAt = null, now = now))
    }

    @Test
    fun `a custom interval is respected`() {
        val lastSyncAt = now - 1000
        assertFalse(shouldAutoSync(enabled = true, hasPeer = true, lastSyncAt = lastSyncAt, now = now, minIntervalMs = 2000))
        assertTrue(shouldAutoSync(enabled = true, hasPeer = true, lastSyncAt = lastSyncAt, now = now, minIntervalMs = 500))
    }
}
