package com.voynix.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.ShuffleOn
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.artwork.AlbumArtResolver
import com.voynix.artwork.AlbumArtImage
import com.voynix.playback.PlayerUiState

/** Compact now-playing strip pinned above the bottom of the screen. Tap to open Now Playing. */
@Composable
fun MiniPlayer(
    state: PlayerUiState,
    albumArt: AlbumArtResolver,
    shuffleOn: Boolean,
    onTogglePlayPause: () -> Unit,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val track = state.currentTrack ?: return

    Surface(
        modifier = modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 8.dp, vertical = 4.dp)
            .clickable(onClick = onOpen),
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AlbumArtImage(
                    resolver = albumArt,
                    artist = track.artist,
                    album = track.album,
                    filePath = track.filePath,
                    size = 36.dp,
                    modifier = Modifier.padding(end = 10.dp),
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        track.title,
                        style = MaterialTheme.typography.labelLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (shuffleOn) {
                            Icon(
                                Icons.Filled.ShuffleOn,
                                contentDescription = stringResource(R.string.collection_header_shuffle_on),
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.padding(end = 4.dp).size(14.dp),
                            )
                        }
                        Text(
                            track.artist ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                val hasSiblings = state.queue.size > 1
                if (hasSiblings) {
                    IconButton(onClick = onPrevious) {
                        Icon(Icons.Filled.SkipPrevious, contentDescription = stringResource(R.string.now_playing_previous))
                    }
                }
                IconButton(onClick = onTogglePlayPause) {
                    Icon(
                        if (state.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        contentDescription = if (state.isPlaying) stringResource(R.string.player_pause) else stringResource(R.string.player_play),
                    )
                }
                if (hasSiblings) {
                    IconButton(onClick = onNext) {
                        Icon(Icons.Filled.SkipNext, contentDescription = stringResource(R.string.now_playing_next))
                    }
                }
            }
            val fraction = if (state.durationSecs > 0) (state.positionSecs / state.durationSecs).toFloat().coerceIn(0f, 1f) else 0f
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                trackColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            )
        }
    }
}
