package com.voynix.widget

import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/** Registered in AndroidManifest.xml as the "now_playing_widget_info.xml" provider. */
class NowPlayingWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NowPlayingWidget()
}
