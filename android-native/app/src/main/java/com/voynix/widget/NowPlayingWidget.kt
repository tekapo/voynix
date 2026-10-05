package com.voynix.widget

import android.content.Context
import android.graphics.Bitmap
import android.view.KeyEvent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionSendBroadcast
import androidx.glance.appwidget.action.actionStartService
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.voynix.MainActivity
import com.voynix.R
import com.voynix.artwork.AlbumArtResolver
import com.voynix.data.db.TrackEntity
import com.voynix.data.db.VoynixDatabase

private val COMPACT = DpSize(120.dp, 56.dp)
private val WIDE = DpSize(250.dp, 56.dp)
private val TALL = DpSize(120.dp, 110.dp)
private val TALL_WIDE = DpSize(250.dp, 110.dp)

// The widget never shows art above ArtworkTile's largest size (64.dp, see
// NowPlayingColumn), so anything past a couple of times that in real pixels
// is pure waste — and, past a few thousand px on a side, dangerous: a single
// full-resolution embedded cover sent through RemoteViews (baked into all 4
// SizeMode.Responsive buckets) can exceed Android's per-update bitmap-memory
// budget and throw, which Glance doesn't recover from until the widget is
// re-added (see NowPlayingContent's doc for how this was confirmed).
private const val MAX_WIDGET_ART_PX = 256

/** Downscales [bitmap] so neither side exceeds [MAX_WIDGET_ART_PX], preserving aspect ratio. */
internal fun scaledForWidget(bitmap: Bitmap): Bitmap {
    val longSide = maxOf(bitmap.width, bitmap.height)
    if (longSide <= MAX_WIDGET_ART_PX) return bitmap
    val scale = MAX_WIDGET_ART_PX.toFloat() / longSide
    val width = (bitmap.width * scale).toInt().coerceAtLeast(1)
    val height = (bitmap.height * scale).toInt().coerceAtLeast(1)
    return Bitmap.createScaledBitmap(bitmap, width, height, true)
}

/**
 * Home-screen "now playing" widget: cover art, title/artist, and transport
 * buttons that broadcast the same MEDIA_BUTTON events Bluetooth/hardware keys
 * send (see WidgetIntents.kt) — no separate control path into PlaybackService.
 *
 * State (track id + isPlaying) is written by [pushWidgetState] from
 * PlaybackService's uiState collector; this class only reads it back and
 * resolves the track/artwork from Room, so it renders correctly even when
 * the service isn't running (last-played track, paused).
 */
class NowPlayingWidget : GlanceAppWidget() {
    override val stateDefinition = PreferencesGlanceStateDefinition

    // Four fixed layouts rather than a continuous responsive scale — the
    // launcher only ever resizes this widget in whole grid cells, so there's
    // no in-between size to design for. Width picks compact-vs-wide content
    // (art visible or not, title truncation), height picks row-vs-column.
    override val sizeMode = SizeMode.Responsive(setOf(COMPACT, WIDE, TALL, TALL_WIDE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val db = VoynixDatabase.get(context)
        provideContent {
            NowPlayingContent(context, db)
        }
    }

    // Reads state reactively (currentState/produceState) rather than as a
    // one-shot snapshot in provideGlance — pushWidgetState's updateAppWidgetState
    // + updateAll() reuses the already-running Glance session instead of
    // restarting provideGlance, so a composable that only *read* the state
    // once at session start would never see a later play/pause or track
    // change (confirmed: the icon froze on the first render).
    @Composable
    private fun NowPlayingContent(context: Context, db: VoynixDatabase) {
        val isPlaying = currentState(IS_PLAYING_KEY) ?: false
        val storedTrackId = currentState(TRACK_ID_KEY)
        val fallbackTrackId by produceState<String?>(null, storedTrackId) {
            value = if (storedTrackId == null) db.settingsDao().get("last_track_id") else null
        }
        val trackId = storedTrackId ?: fallbackTrackId
        val track by produceState<TrackEntity?>(null, trackId) {
            value = trackId?.let { db.trackDao().getById(it) }
        }
        // AlbumArtResolver decodes embedded/override/cache art at whatever
        // resolution the source has (no downsampling — see its own doc), and
        // the widget shows it at 64dp at most. Sent as-is, a single large
        // cover (e.g. a 3000x3000 embedded tag) blows RemoteViews' bitmap
        // memory budget across the 4 SizeMode.Responsive buckets combined,
        // which Glance can't recover from on its own: confirmed via a
        // debug-only host harness that this throws
        // "RemoteViews for widget update exceeds maximum bitmap memory
        // usage" and leaves the widget stuck on "Can't show content" even
        // after later updates (a fresh provideGlance session never restarts
        // on its own). Downscaling here keeps the fix local to the widget
        // without touching the in-app artwork views that use the same
        // resolver at full size.
        val art by produceState<Bitmap?>(null, track) {
            value = track
                ?.let { AlbumArtResolver(context, db).resolve(it.artist, it.album, it.filePath) }
                ?.let { scaledForWidget(it) }
        }
        val size = androidx.glance.LocalSize.current
        if (size.height >= TALL.height) {
            NowPlayingColumn(track, art, isPlaying, wide = size.width >= TALL_WIDE.width)
        } else {
            NowPlayingRow(track, art, isPlaying, wide = size.width >= WIDE.width)
        }
    }

    // Single-row layout for the 1-cell-tall sizes. Narrow drops the artwork
    // (and the "previous" button) to leave room for the title/artist, since
    // there's no way to also show cover art at this width without truncating
    // the text to nothing.
    @Composable
    private fun NowPlayingRow(track: TrackEntity?, art: Bitmap?, isPlaying: Boolean, wide: Boolean) {
        val context = androidx.glance.LocalContext.current
        RootContainer {
            Row(
                modifier = GlanceModifier.fillMaxSize(),
                verticalAlignment = Alignment.Vertical.CenterVertically,
            ) {
                if (wide) {
                    ArtworkTile(art, 40.dp)
                    Spacer(modifier = GlanceModifier.width(8.dp))
                }
                TrackText(track, modifier = GlanceModifier.defaultWeight(), titleMaxLines = 1)
                Spacer(modifier = GlanceModifier.width(4.dp))
                if (wide) {
                    TransportButton(R.drawable.ic_widget_prev, KeyEvent.KEYCODE_MEDIA_PREVIOUS, context.getString(R.string.widget_previous))
                }
                TransportButton(
                    if (isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play,
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                    if (isPlaying) context.getString(R.string.widget_pause) else context.getString(R.string.widget_play),
                )
                TransportButton(R.drawable.ic_widget_next, KeyEvent.KEYCODE_MEDIA_NEXT, context.getString(R.string.widget_next))
            }
        }
    }

    // Two-row layout for the taller sizes: artwork + title/artist on top,
    // transport buttons spread evenly across the bottom.
    @Composable
    private fun NowPlayingColumn(track: TrackEntity?, art: Bitmap?, isPlaying: Boolean, wide: Boolean) {
        val context = androidx.glance.LocalContext.current
        RootContainer {
            Column(modifier = GlanceModifier.fillMaxSize()) {
                Row(
                    modifier = GlanceModifier.fillMaxWidth().defaultWeight(),
                    verticalAlignment = Alignment.Vertical.CenterVertically,
                ) {
                    ArtworkTile(art, if (wide) 64.dp else 48.dp)
                    Spacer(modifier = GlanceModifier.width(8.dp))
                    TrackText(track, modifier = GlanceModifier.defaultWeight(), titleMaxLines = if (wide) 2 else 1)
                }
                Spacer(modifier = GlanceModifier.height(4.dp))
                Row(
                    modifier = GlanceModifier.fillMaxWidth(),
                    verticalAlignment = Alignment.Vertical.CenterVertically,
                ) {
                    TransportButton(
                        R.drawable.ic_widget_prev,
                        KeyEvent.KEYCODE_MEDIA_PREVIOUS,
                        context.getString(R.string.widget_previous),
                        modifier = GlanceModifier.defaultWeight(),
                    )
                    TransportButton(
                        if (isPlaying) R.drawable.ic_widget_pause else R.drawable.ic_widget_play,
                        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                        if (isPlaying) context.getString(R.string.widget_pause) else context.getString(R.string.widget_play),
                        modifier = GlanceModifier.defaultWeight(),
                    )
                    TransportButton(
                        R.drawable.ic_widget_next,
                        KeyEvent.KEYCODE_MEDIA_NEXT,
                        context.getString(R.string.widget_next),
                        modifier = GlanceModifier.defaultWeight(),
                    )
                }
            }
        }
    }

    // Shared background/corner-radius/tap-to-open-app frame for both
    // layouts. The click lands on the root, not just the artwork, so tapping
    // the title or any empty space opens the app too — Glance still routes a
    // tap on a nested clickable (the transport buttons) to that child first.
    @Composable
    private fun RootContainer(content: @Composable () -> Unit) {
        Row(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(Color(0xFF1C1C1E))
                .cornerRadius(16.dp)
                .clickable(actionStartActivity<MainActivity>())
                .padding(8.dp),
        ) {
            content()
        }
    }

    @Composable
    private fun TrackText(track: TrackEntity?, modifier: GlanceModifier, titleMaxLines: Int) {
        val context = androidx.glance.LocalContext.current
        Column(modifier = modifier) {
            Text(
                text = track?.title ?: context.getString(R.string.widget_nothing_playing),
                style = TextStyle(color = ColorProvider(Color.White), fontWeight = FontWeight.Bold),
                maxLines = titleMaxLines,
            )
            Text(
                text = track?.artist ?: "",
                style = TextStyle(color = ColorProvider(Color(0xFFB0B0B0))),
                maxLines = 1,
            )
        }
    }

    @Composable
    private fun ArtworkTile(art: Bitmap?, size: Dp) {
        val modifier = GlanceModifier
            .size(size)
            .cornerRadius(6.dp)
            .background(Color(0xFF3A3A3C))
        if (art != null) {
            Image(
                provider = ImageProvider(art),
                contentDescription = null,
                modifier = modifier,
            )
        } else {
            Spacer(modifier = modifier)
        }
    }

    @Composable
    private fun TransportButton(
        iconRes: Int,
        keyCode: Int,
        description: String,
        modifier: GlanceModifier = GlanceModifier,
    ) {
        val ctx = androidx.glance.LocalContext.current
        // Play/pause can safely cold-start the service via MediaButtonReceiver
        // (media3's documented, allowlisted path). Next/previous can't:
        // MediaButtonReceiver silently drops those keys regardless of whether
        // the service is already running (see mediaButtonServiceIntent), so
        // they go straight to PlaybackService instead.
        val isSkip = keyCode == KeyEvent.KEYCODE_MEDIA_NEXT || keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS
        val action = if (isSkip) {
            actionStartService(mediaButtonServiceIntent(ctx, keyCode), isForegroundService = true)
        } else {
            actionSendBroadcast(mediaButtonIntent(ctx, keyCode))
        }
        Row(modifier = modifier, horizontalAlignment = Alignment.Horizontal.CenterHorizontally) {
            Image(
                provider = ImageProvider(iconRes),
                contentDescription = description,
                modifier = GlanceModifier
                    .size(40.dp)
                    .padding(4.dp)
                    .clickable(action),
            )
        }
    }
}
