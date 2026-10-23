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

    @Test
    fun `marks a disconnect while playing`() {
        assertTrue(shouldMarkCarPausedOnDisconnect(isPlaying = true, lastPlayingAt = null, now = now))
    }

    @Test
    fun `marks a disconnect shortly after playback stopped`() {
        assertTrue(shouldMarkCarPausedOnDisconnect(false, lastPlayingAt = now - 2000, now = now))
        assertTrue(shouldMarkCarPausedOnDisconnect(false, lastPlayingAt = now - CAR_STOP_GRACE_MS, now = now))
    }

    @Test
    fun `does not mark a disconnect long after playback stopped or never played`() {
        assertFalse(shouldMarkCarPausedOnDisconnect(false, lastPlayingAt = now - CAR_STOP_GRACE_MS - 1, now = now))
        assertFalse(shouldMarkCarPausedOnDisconnect(false, lastPlayingAt = null, now = now))
    }

    @Test
    fun `retries a car resume only after audio focus loss while the car is connected`() {
        val focusLoss = androidx.media3.common.Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS
        val user = androidx.media3.common.Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST
        assertTrue(shouldRetryCarResume(isPlaying = false, lastPauseReason = focusLoss, carConnected = true))
        assertFalse(shouldRetryCarResume(isPlaying = true, lastPauseReason = focusLoss, carConnected = true))
        assertFalse(shouldRetryCarResume(isPlaying = false, lastPauseReason = user, carConnected = true))
        assertFalse(shouldRetryCarResume(isPlaying = false, lastPauseReason = null, carConnected = true))
        assertFalse(shouldRetryCarResume(isPlaying = false, lastPauseReason = focusLoss, carConnected = false))
    }
}
