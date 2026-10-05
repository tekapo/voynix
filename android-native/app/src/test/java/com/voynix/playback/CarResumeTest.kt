package com.voynix.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CarResumeTest {

    private val car = "com.google.android.projection.gearhead"
    private val now = 1_000_000_000L

    @Test
    fun `does not resume a non-car controller`() {
        assertFalse(shouldResumeOnCarConnect("com.tekapo.voynix", carPausedAt = now - 1000, now = now))
    }

    @Test
    fun `does not resume when no car-caused pause was ever recorded`() {
        assertFalse(shouldResumeOnCarConnect(car, carPausedAt = null, now = now))
    }

    @Test
    fun `resumes within the window`() {
        assertTrue(shouldResumeOnCarConnect(car, carPausedAt = now - 5000, now = now))
    }

    @Test
    fun `resumes right at the window edge`() {
        assertTrue(shouldResumeOnCarConnect(car, carPausedAt = now - CAR_RESUME_WINDOW_MS, now = now))
    }

    @Test
    fun `does not resume once the window has elapsed`() {
        assertFalse(shouldResumeOnCarConnect(car, carPausedAt = now - CAR_RESUME_WINDOW_MS - 1, now = now))
    }

    @Test
    fun `does not resume when the marker is in the future (clock rewound)`() {
        assertFalse(shouldResumeOnCarConnect(car, carPausedAt = now + 1000, now = now))
    }

    @Test
    fun `extends the foreground timeout while a car controller is connected`() {
        assertEquals(CAR_PAUSED_FOREGROUND_TIMEOUT_MS, foregroundTimeoutFor(listOf(car)))
        assertEquals(
            CAR_PAUSED_FOREGROUND_TIMEOUT_MS,
            foregroundTimeoutFor(listOf("com.tekapo.voynix", car)),
        )
    }

    @Test
    fun `uses the platform default once no car controller remains`() {
        assertEquals(
            androidx.media3.session.MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS,
            foregroundTimeoutFor(emptyList()),
        )
        assertEquals(
            androidx.media3.session.MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS,
            foregroundTimeoutFor(listOf("com.tekapo.voynix")),
        )
    }
}
