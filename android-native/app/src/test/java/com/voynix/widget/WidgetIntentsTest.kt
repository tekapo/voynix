package com.voynix.widget

import android.content.Intent
import android.view.KeyEvent
import androidx.media3.session.MediaButtonReceiver
import androidx.test.core.app.ApplicationProvider
import com.voynix.playback.PlaybackService
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class WidgetIntentsTest {

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun `targets MediaButtonReceiver with ACTION_MEDIA_BUTTON`() {
        val intent = mediaButtonIntent(context, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
        assertEquals(Intent.ACTION_MEDIA_BUTTON, intent.action)
        assertEquals(MediaButtonReceiver::class.java.name, intent.component?.className)
    }

    @Test
    fun `carries the requested key code as a KeyEvent extra`() {
        val intent = mediaButtonIntent(context, KeyEvent.KEYCODE_MEDIA_NEXT)
        val keyEvent = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
        assertEquals(KeyEvent.ACTION_DOWN, keyEvent?.action)
        assertEquals(KeyEvent.KEYCODE_MEDIA_NEXT, keyEvent?.keyCode)
    }

    @Test
    fun `each key code produces its own KeyEvent extra`() {
        val play = mediaButtonIntent(context, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)
        val prev = mediaButtonIntent(context, KeyEvent.KEYCODE_MEDIA_PREVIOUS)
        assertEquals(
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
            play.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)?.keyCode,
        )
        assertEquals(
            KeyEvent.KEYCODE_MEDIA_PREVIOUS,
            prev.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)?.keyCode,
        )
    }

    // ---- mediaButtonServiceIntent (widget next/previous) -------------------
    // MediaButtonReceiver silently drops next/previous on API 26+ regardless
    // of whether the service is running (see WidgetIntents.kt's doc), so
    // those two keys must target PlaybackService directly instead.

    @Test
    fun `service intent targets PlaybackService with ACTION_MEDIA_BUTTON`() {
        val intent = mediaButtonServiceIntent(context, KeyEvent.KEYCODE_MEDIA_NEXT)
        assertEquals(Intent.ACTION_MEDIA_BUTTON, intent.action)
        assertEquals(PlaybackService::class.java.name, intent.component?.className)
    }

    @Test
    fun `service intent carries the requested key code as a KeyEvent extra`() {
        val intent = mediaButtonServiceIntent(context, KeyEvent.KEYCODE_MEDIA_PREVIOUS)
        val keyEvent = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
        assertEquals(KeyEvent.ACTION_DOWN, keyEvent?.action)
        assertEquals(KeyEvent.KEYCODE_MEDIA_PREVIOUS, keyEvent?.keyCode)
    }
}
