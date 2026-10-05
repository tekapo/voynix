package com.voynix.widget

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.KeyEvent
import androidx.media3.session.MediaButtonReceiver
import com.voynix.playback.PlaybackService

/**
 * Builds the same MEDIA_BUTTON broadcast Bluetooth/AVRCP and hardware media
 * keys send — [MediaButtonReceiver] is already registered in the manifest and
 * routes it into whichever [com.voynix.playback.PlaybackService]'s
 * MediaSession is current, starting the (foreground) service if it isn't
 * running. Widget taps (via Glance's actionSendBroadcast) reuse this instead
 * of a separate control path so they get exactly the same play/pause/skip
 * behavior (queue restore included) as every other transport surface.
 *
 * Only safe for KEYCODE_MEDIA_PLAY_PAUSE (see [mediaButtonServiceIntent] for
 * why next/previous can't go through this receiver).
 */
fun mediaButtonIntent(context: Context, keyCode: Int): Intent =
    Intent(Intent.ACTION_MEDIA_BUTTON).apply {
        component = ComponentName(context, MediaButtonReceiver::class.java)
        putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
    }

/**
 * Same MEDIA_BUTTON intent as [mediaButtonIntent], but addressed straight at
 * PlaybackService instead of MediaButtonReceiver.
 *
 * media3's MediaButtonReceiver silently drops every key except play/pause/
 * headsethook on API 26+ (to avoid a ForegroundServiceDidNotStartInTimeException
 * from an arbitrary cold-start key) — regardless of whether the service is
 * already running. That makes it unusable for the widget's next/previous
 * buttons even while playback is active. PlaybackService (a MediaLibraryService
 * with no onStartCommand override) applies the framework's default
 * ACTION_MEDIA_BUTTON handling instead, which has no such allowlist — used
 * with Glance's actionStartService rather than actionSendBroadcast.
 */
fun mediaButtonServiceIntent(context: Context, keyCode: Int): Intent =
    Intent(Intent.ACTION_MEDIA_BUTTON).apply {
        component = ComponentName(context, PlaybackService::class.java)
        putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_DOWN, keyCode))
    }
