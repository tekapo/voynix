package com.voynix.ui.tracks

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Equalizer
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.artwork.AlbumArtImage
import com.voynix.artwork.AlbumArtResolver
import com.voynix.data.db.TrackWithStats
import com.voynix.logic.PlayState

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TrackRow(
    item: TrackWithStats,
    isCurrent: Boolean,
    albumArt: AlbumArtResolver,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val track = item.track
    val podcastStatus = podcastStatus(track)
    val podcastLabel = podcastStatusLabel(track)
    val podcastLabelText = podcastStatusText(podcastLabel)
    val artistText = track.artist?.takeIf { it.isNotBlank() }
    val subtitle = if (podcastLabelText != null) {
        null
    } else {
        val playedText = if (item.playCount > 0) {
            stringResource(R.string.track_row_played_times, item.playCount)
        } else {
            stringResource(R.string.track_row_unplayed)
        }
        listOfNotNull(artistText, playedText).joinToString(" · ")
    }

    ListItem(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(16.dp))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .alpha(if (podcastStatus == PlayState.PLAYED) 0.55f else 1f),
        headlineContent = {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                if (podcastStatus == PlayState.UNPLAYED || podcastStatus == PlayState.IN_PROGRESS) {
                    PodcastStatusDot(podcastStatus, podcastLabelText)
                }
                Text(
                    track.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (isCurrent) MaterialTheme.colorScheme.primary else Color.Unspecified,
                    fontWeight = if (isCurrent) androidx.compose.ui.text.font.FontWeight.SemiBold else null,
                )
            }
        },
        supportingContent = {
            if (subtitle != null) {
                Text(subtitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
            } else if (podcastLabelText != null) {
                // Only the show name may be ellipsized: a long name must not push
                // the status / "10:23 / 1:30:30" off the row.
                Row {
                    if (artistText != null) {
                        Text(
                            artistText,
                            modifier = Modifier.weight(1f, fill = false),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(" · ", maxLines = 1)
                    }
                    Text(podcastLabelText, maxLines = 1, softWrap = false)
                }
            }
        },
        leadingContent = {
            AlbumArtImage(
                resolver = albumArt,
                artist = track.artist,
                album = track.album,
                filePath = track.filePath,
                size = 48.dp,
                shape = RoundedCornerShape(8.dp),
            )
        },
        trailingContent = {
            when {
                isCurrent -> Icon(Icons.Filled.Equalizer, contentDescription = stringResource(R.string.track_row_now_playing), tint = MaterialTheme.colorScheme.primary)
                track.favorite -> Icon(Icons.Filled.Favorite, contentDescription = stringResource(R.string.track_row_favorites), tint = MaterialTheme.colorScheme.tertiary)
            }
        },
        colors = ListItemDefaults.colors(
            containerColor = if (isCurrent) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f) else Color.Transparent,
        ),
        shadowElevation = 0.dp,
        tonalElevation = 0.dp,
    )
}

/** Resolves a [PodcastStatusLabel] to display text — kept separate from
 *  [podcastStatusLabel] itself (a plain, unit-testable function) since
 *  `stringResource()` only works inside composition. */
@Composable
fun podcastStatusText(label: PodcastStatusLabel?): String? = when (label) {
    null -> null
    PodcastStatusLabel.Unplayed -> stringResource(R.string.podcast_status_unplayed)
    is PodcastStatusLabel.InProgress -> label.timeText()
        ?: stringResource(R.string.podcast_status_in_progress)
    PodcastStatusLabel.Played -> stringResource(R.string.podcast_status_played)
}

/**
 * Podcast status dot for the title cell, mirroring src/App.css's
 * .podcast-badge: a filled dot for unplayed, a ring for in-progress. PLAYED
 * renders nothing here — the whole row is dimmed instead (see [TrackRow]).
 */
@Composable
private fun PodcastStatusDot(state: PlayState, label: String?) {
    val color = MaterialTheme.colorScheme.primary
    val description = stringResource(R.string.podcast_dot_description, label ?: "")
    val modifier = Modifier
        .padding(end = 6.dp)
        .size(8.dp)
        .semantics { contentDescription = description }
    if (state == PlayState.IN_PROGRESS) {
        androidx.compose.foundation.layout.Box(modifier.clip(CircleShape).border(2.dp, color, CircleShape))
    } else {
        androidx.compose.foundation.layout.Box(modifier.clip(CircleShape).background(color))
    }
}
