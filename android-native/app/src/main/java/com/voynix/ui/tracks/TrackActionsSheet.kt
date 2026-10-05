package com.voynix.ui.tracks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.artwork.AlbumArtImage
import com.voynix.artwork.AlbumArtResolver
import com.voynix.data.db.TrackWithStats

/** Long-press actions for one track — replaces the old anchored DropdownMenu with a bottom sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackActionsSheet(
    item: TrackWithStats,
    albumArt: AlbumArtResolver,
    onDismiss: () -> Unit,
    onToggleFavorite: () -> Unit,
    onEnqueue: () -> Unit,
    onTogglePlayed: () -> Unit,
) {
    val track = item.track
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AlbumArtImage(
                resolver = albumArt,
                artist = track.artist,
                album = track.album,
                filePath = track.filePath,
                size = 44.dp,
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.padding(end = 14.dp),
            )
            Column {
                Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                Text(
                    track.artist ?: "",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        SheetActionRow(
            icon = if (track.favorite) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
            label = if (track.favorite) stringResource(R.string.track_actions_remove_favorite) else stringResource(R.string.track_actions_add_favorite),
            tint = if (track.favorite) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
            onClick = { onDismiss(); onToggleFavorite() },
        )
        SheetActionRow(
            icon = Icons.AutoMirrored.Filled.QueueMusic,
            label = stringResource(R.string.track_actions_add_to_queue),
            onClick = { onDismiss(); onEnqueue() },
        )
        if (track.kind == "podcast") {
            SheetActionRow(
                icon = Icons.Filled.CheckCircle,
                label = if (track.playState == "played") stringResource(R.string.track_actions_mark_unplayed) else stringResource(R.string.track_actions_mark_played),
                onClick = { onDismiss(); onTogglePlayed() },
            )
        }
    }
}

@Composable
private fun SheetActionRow(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.padding(end = 20.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}
