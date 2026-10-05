package com.voynix.ui.tracks

import android.content.Context
import com.voynix.R
import com.voynix.data.db.TrackEntity
import com.voynix.logic.PlayState
import com.voynix.logic.playStateFromDb

// Podcast play-state -> UI presentation, ported from src/components/trackFormat.tsx
// (podcastBadge / isPlayedPodcast). Kept pure so it's unit-testable without Compose.

/** Null when [track] isn't a podcast — music rows are unaffected. */
fun podcastStatus(track: TrackEntity): PlayState? {
    if (track.kind != "podcast") return null
    return playStateFromDb(track.playState)
}

/**
 * 0f..1f while in progress, else null — including for PLAYED, whose
 * resume_position is reset to 0 by nextPlayState() and would otherwise read
 * as "0% done" for a finished episode (see logic/Playback.kt:75-81).
 */
fun podcastProgress(track: TrackEntity): Float? {
    if (podcastStatus(track) != PlayState.IN_PROGRESS) return null
    val duration = track.duration ?: return null
    if (duration <= 0) return null
    return (track.resumePosition / duration).toFloat().coerceIn(0f, 1f)
}

/** "m:ss", or "h:mm:ss" from one hour up — same rule as src/format.ts's formatSeconds. */
fun formatPlaybackTime(secs: Double): String {
    val total = secs.toLong().coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val ss = (total % 60).toString().padStart(2, '0')
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:$ss" else "$m:$ss"
}

/** "10:23 / 1:30:30", or null when the duration is unknown. */
fun PodcastStatusLabel.InProgress.timeText(): String? =
    duration?.takeIf { it > 0 }?.let { "${formatPlaybackTime(position)} / ${formatPlaybackTime(it)}" }

/** A podcast row's subtitle, as data rather than localized text — the string
 *  resource lookup (locale-dependent) happens in the composable caller
 *  (TrackRow.kt's `podcastStatusText`), keeping this function pure/testable. */
sealed class PodcastStatusLabel {
    object Unplayed : PodcastStatusLabel()
    data class InProgress(val position: Double, val duration: Double?) : PodcastStatusLabel()
    object Played : PodcastStatusLabel()
}

/** null for a non-podcast track (music rows have no subtitle here). */
fun podcastStatusLabel(track: TrackEntity): PodcastStatusLabel? {
    return when (podcastStatus(track) ?: return null) {
        PlayState.UNPLAYED -> PodcastStatusLabel.Unplayed
        PlayState.IN_PROGRESS -> PodcastStatusLabel.InProgress(track.resumePosition, track.duration)
        PlayState.PLAYED -> PodcastStatusLabel.Played
    }
}

/** Non-Compose equivalent of TrackRow.kt's `podcastStatusText` — for callers
 *  with a plain [Context] instead of a composition (e.g. PlaybackService's
 *  Android Auto media items). */
fun PodcastStatusLabel.toText(context: Context): String = when (this) {
    PodcastStatusLabel.Unplayed -> context.getString(R.string.podcast_status_unplayed)
    is PodcastStatusLabel.InProgress -> timeText()
        ?: context.getString(R.string.podcast_status_in_progress)
    PodcastStatusLabel.Played -> context.getString(R.string.podcast_status_played)
}
