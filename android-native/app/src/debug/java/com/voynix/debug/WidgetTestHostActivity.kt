package com.voynix.debug

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import android.util.Log
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.voynix.widget.NowPlayingWidget
import com.voynix.widget.pushWidgetState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Debug-only harness for [NowPlayingWidget] that bypasses the launcher's own
 * AppWidgetHost entirely — dragging it onto a real home screen via adb
 * `input` events turned out to be too flaky to script reliably (the Pixel
 * Launcher's widget-picker drag needs a real, continuously-sampled touch
 * stream that synthetic `input swipe`/`draganddrop` couldn't reproduce
 * consistently).
 *
 * This hosts the widget itself instead: `adb shell appwidget grantbind
 * --package com.tekapo.voynix` lets it bind without a user confirmation dialog,
 * and any RemoteViews exception during a later update (e.g. exceeding the
 * per-update bitmap-memory budget with an oversized cover) surfaces as a
 * normal logged exception for this process, same as it would for the
 * launcher's host — this is how the "コンテンツを表示できません" /
 * "Can't show content" widget bug was actually reproduced and confirmed
 * fixed (see NowPlayingWidget's scaledForWidget).
 *
 * Launch with: adb shell am start -n com.tekapo.voynix/com.voynix.debug.WidgetTestHostActivity
 */
class WidgetTestHostActivity : Activity() {
    private lateinit var host: AppWidgetHost

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val container = FrameLayout(this)
        setContentView(container)

        val appWidgetManager = AppWidgetManager.getInstance(this)
        host = AppWidgetHost(this, HOST_ID)
        host.startListening()

        val provider = ComponentName(this, NowPlayingWidget::class.java)
        // NowPlayingWidgetReceiver is the actual manifest-declared provider;
        // NowPlayingWidget itself has no receiver, so bind against the
        // receiver's component instead.
        val providerReceiver = ComponentName(this, "com.voynix.widget.NowPlayingWidgetReceiver")

        // Reuse the same widget id across relaunches (persisted in prefs) —
        // each `am start` used to allocate a fresh id and never release the
        // previous one, leaving more and more live Glance sessions running
        // for the same provider until the emulator ANR'd under the load.
        // Force the TALL_WIDE bucket (see NowPlayingWidget's SizeMode.Responsive
        // options) regardless of what this plain FrameLayout host would report
        // on its own — that's the layout with artwork, the one most likely to
        // hit a RemoteViews bitmap-size limit, which a bare host's default
        // min/max size options wouldn't reliably select. Passed at BIND time
        // (not via a separate updateAppWidgetOptions after) — Glance's first
        // composition races a plain post-bind update and can win, rendering
        // the initial (wrong) size bucket once before ever picking up ours.
        val options = Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 260)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, 260)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 120)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 120)
            // Glance's SizeMode.Responsive picks its bucket from the
            // OPTION_APPWIDGET_SIZES list (a List<SizeF>, the modern
            // per-size hint real launchers populate during resize) — NOT
            // from the legacy min/max width/height above, which it only
            // falls back to via the provider's declared minWidth/minHeight
            // when this list is absent (confirmed: without it, Glance kept
            // rendering the COMPACT bucket no matter what the legacy
            // options or the host view's real measured size were).
            putParcelableArrayList(
                AppWidgetManager.OPTION_APPWIDGET_SIZES,
                arrayListOf(android.util.SizeF(260f, 120f)),
            )
        }

        val prefs = getSharedPreferences("widget_test_host", Context.MODE_PRIVATE)
        var appWidgetId = prefs.getInt(PREF_WIDGET_ID, -1)
        val alreadyBound = appWidgetId != -1 &&
            appWidgetManager.getAppWidgetInfo(appWidgetId)?.provider == providerReceiver
        if (!alreadyBound) {
            appWidgetId = host.allocateAppWidgetId()
            val bound = appWidgetManager.bindAppWidgetIdIfAllowed(appWidgetId, providerReceiver, options)
            Log.i(TAG, "bindAppWidgetIdIfAllowed id=$appWidgetId bound=$bound provider=$provider")
            if (!bound) {
                Log.e(TAG, "bind failed — did you run: adb shell appwidget grantbind --package com.tekapo.voynix ?")
                return
            }
            prefs.edit().putInt(PREF_WIDGET_ID, appWidgetId).apply()
        } else {
            Log.i(TAG, "reusing already-bound widget id=$appWidgetId")
        }
        // bindAppWidgetIdIfAllowed's own `options` argument only seeds
        // AppWidgetManager's record — it doesn't reliably fire
        // onAppWidgetOptionsChanged for the provider's first composition
        // (confirmed: without this, Glance still rendered the COMPACT
        // bucket despite a 260x120dp bind-time option). An explicit
        // updateAppWidgetOptions call does trigger it.
        appWidgetManager.updateAppWidgetOptions(appWidgetId, options)

        val info = appWidgetManager.getAppWidgetInfo(appWidgetId)
        val hostView = host.createView(this, appWidgetId, info)
        hostView.setAppWidget(appWidgetId, info)
        val density = resources.displayMetrics.density
        container.addView(
            hostView,
            FrameLayout.LayoutParams((260 * density).toInt(), (120 * density).toInt()),
        )
        // The RemoteViews size-bucket AppWidgetHostView actually *displays*
        // is picked from this host-reported size, independent of the
        // options bundle passed at bind/update time (which only reaches the
        // provider's own composition) and independent of the view's real
        // measured pixel bounds — without this call it kept rendering the
        // COMPACT bucket no matter how big the container was.
        hostView.updateAppWidgetSize(options, 260, 120, 260, 120)
        hostView.post {
            Log.i(TAG, "hostView measured ${hostView.width}x${hostView.height}px density=$density " +
                "= ${hostView.width / density}x${hostView.height / density}dp")
        }

        // Drives the widget's Glance state directly with pushWidgetState —
        // the same call PlaybackService makes — instead of going through
        // real playback/MediaSession resumption, whose queue-restore logic
        // turned out to be a confusing second variable to control in this
        // harness. One button per known test track id (see the plan's
        // widget_repro insert.sql): wrepro-1 (no art), wrepro-2 (small
        // embedded art), wrepro-3 (large embedded art, the crash suspect).
        val buttons = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        for (trackId in listOf("wrepro-1", "wrepro-2", "wrepro-3")) {
            buttons.addView(TextView(this).apply {
                text = "push $trackId"
                setPadding(24, 24, 24, 24)
                setOnClickListener {
                    scope.launch { pushWidgetState(this@WidgetTestHostActivity, trackId, isPlaying = true) }
                }
            })
        }
        container.addView(
            buttons,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = (140 * density).toInt()
            },
        )
    }

    private val scope = CoroutineScope(Dispatchers.Main)

    override fun onDestroy() {
        host.stopListening()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "WidgetTestHost"
        private const val HOST_ID = 0x766e78 // "vnx"
        private const val PREF_WIDGET_ID = "widget_id"
    }
}
