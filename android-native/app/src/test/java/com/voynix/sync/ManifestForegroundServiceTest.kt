package com.voynix.sync

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Keeps Play's foreground-service declaration to mediaPlayback only. Play
 * accepts a dataSync foreground service only for work the user starts, and the
 * periodic AutoSyncWorker is automatic, so it must not run as one.
 */
class ManifestForegroundServiceTest {
    private val manifest = File("src/main/AndroidManifest.xml").readText()

    @Test
    fun `does not declare the dataSync foreground service type or permission`() {
        assertFalse(manifest.contains("FOREGROUND_SERVICE_DATA_SYNC"))
        assertFalse(manifest.contains("\"dataSync\""))
    }

    @Test
    fun `still declares the mediaPlayback foreground service`() {
        assertTrue(manifest.contains("FOREGROUND_SERVICE_MEDIA_PLAYBACK"))
        assertTrue(manifest.contains("foregroundServiceType=\"mediaPlayback\""))
    }
}
