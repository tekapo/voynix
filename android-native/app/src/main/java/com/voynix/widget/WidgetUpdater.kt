package com.voynix.widget

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.appwidget.updateAll
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.booleanPreferencesKey

val TRACK_ID_KEY = stringPreferencesKey("track_id")
val IS_PLAYING_KEY = booleanPreferencesKey("is_playing")

/**
 * Pushes the current track id + playing state into every placed
 * [NowPlayingWidget] instance's Glance state and redraws them.
 *
 * Called from [com.voynix.playback.PlaybackService] whenever the current
 * track or play/pause state changes (see its uiState collector) — never on
 * every position tick, since [NowPlayingWidget.provideGlance] re-reads the
 * track/artwork from Room on each call.
 */
suspend fun pushWidgetState(context: Context, trackId: String?, isPlaying: Boolean) {
    val manager = GlanceAppWidgetManager(context)
    val ids = manager.getGlanceIds(NowPlayingWidget::class.java)
    if (ids.isEmpty()) return // no widget placed — skip the Room reads updateAll would trigger
    for (id in ids) {
        updateAppWidgetState(context, PreferencesGlanceStateDefinition, id) { prefs ->
            prefs.toMutablePreferences().apply {
                if (trackId != null) this[TRACK_ID_KEY] = trackId else remove(TRACK_ID_KEY)
                this[IS_PLAYING_KEY] = isPlaying
            }
        }
    }
    NowPlayingWidget().updateAll(context)
}
