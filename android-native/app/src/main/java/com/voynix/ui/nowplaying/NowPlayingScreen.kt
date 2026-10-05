package com.voynix.ui.nowplaying

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Article
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.BedtimeOff
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Forward10
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOn
import androidx.compose.material.icons.filled.Replay10
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.ShuffleOn
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.artwork.AlbumArtImage
import com.voynix.artwork.AlbumArtResolver
import com.voynix.logic.RepeatMode
import com.voynix.logic.SPEED_PRESETS
import com.voynix.logic.effectiveShuffle
import com.voynix.logic.formatSleepTimerRemaining
import com.voynix.logic.formatSpeed
import com.voynix.logic.sleepTimerRemainingMs
import com.voynix.playback.PODCAST_SKIP_SECS
import com.voynix.playback.PlayerController
import com.voynix.playback.PlayerUiState
import com.voynix.ui.components.ModeToggleButton
import com.voynix.ui.theme.VoynixArtworkShape
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

@Composable
private fun repeatModeLabel(mode: RepeatMode): String = when (mode) {
    RepeatMode.OFF -> stringResource(R.string.now_playing_repeat_off)
    RepeatMode.ALL -> stringResource(R.string.now_playing_repeat_all)
    RepeatMode.ONE -> stringResource(R.string.now_playing_repeat_one)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NowPlayingScreen(
    state: PlayerUiState,
    player: PlayerController,
    albumArt: AlbumArtResolver,
    onBack: () -> Unit,
    onOpenLyrics: () -> Unit,
    onToggleFavorite: () -> Unit,
) {
    val track = state.currentTrack
    // Podcasts get a 10s-back/forward pair instead of shuffle/repeat — same
    // switch Android Auto's playback screen makes (see AutoButtons.kt).
    val isPodcast = track?.kind == "podcast"
    val podcastNoShuffle by player.podcastNoShuffle.collectAsState()
    // The raw toggle can be true while a podcast queue is actually playing in
    // order (podcastNoShuffle setting) — show the effective state, not the raw
    // flag, so the button never lights up while lying about playback order.
    val shuffleActive = effectiveShuffle(state.shuffle, podcastNoShuffle, state.queue.map { it.kind })
    val shuffleSuppressed = state.shuffle && !shuffleActive

    val podcastSpeed by player.podcastSpeed.collectAsState()
    var speedMenuOpen by remember { mutableStateOf(false) }

    val sleepTimerDeadline by player.sleepTimerDeadline.collectAsState()
    var sleepTimerMenuOpen by remember { mutableStateOf(false) }
    // Recomputed once a second while a timer is armed, independent of the
    // player's own ~500ms position tick (paused playback still counts down).
    var remainingMs by remember { mutableLongStateOf(0L) }
    LaunchedEffect(sleepTimerDeadline) {
        val deadline = sleepTimerDeadline ?: return@LaunchedEffect
        while (true) {
            remainingMs = sleepTimerRemainingMs(deadline, System.currentTimeMillis())
            if (remainingMs <= 0) break
            delay(1000)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (sleepTimerDeadline != null) {
                        Text(
                            formatSleepTimerRemaining(remainingMs),
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.now_playing_close))
                    }
                },
                actions = {
                    if (isPodcast) {
                        TextButton(onClick = { speedMenuOpen = true }) {
                            Text(formatSpeed(podcastSpeed))
                        }
                        DropdownMenu(expanded = speedMenuOpen, onDismissRequest = { speedMenuOpen = false }) {
                            for (speed in SPEED_PRESETS) {
                                DropdownMenuItem(
                                    text = { Text(formatSpeed(speed)) },
                                    onClick = { player.setPodcastSpeed(speed); speedMenuOpen = false },
                                )
                            }
                        }
                    }
                    IconButton(onClick = { sleepTimerMenuOpen = true }) {
                        Icon(
                            if (sleepTimerDeadline != null) Icons.Filled.Bedtime else Icons.Filled.BedtimeOff,
                            contentDescription = stringResource(R.string.now_playing_sleep_timer),
                            tint = if (sleepTimerDeadline != null) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    DropdownMenu(expanded = sleepTimerMenuOpen, onDismissRequest = { sleepTimerMenuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.now_playing_off)) },
                            onClick = { player.cancelSleepTimer(); sleepTimerMenuOpen = false },
                        )
                        for (minutes in listOf(15, 30, 60, 90)) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.now_playing_minutes, minutes)) },
                                onClick = { player.setSleepTimer(minutes); sleepTimerMenuOpen = false },
                            )
                        }
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text(if (isPodcast) stringResource(R.string.now_playing_end_of_episode) else stringResource(R.string.now_playing_end_of_track)) },
                            onClick = { player.setSleepTimerToEndOfTrack(); sleepTimerMenuOpen = false },
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier.padding(padding).fillMaxSize().padding(horizontal = 24.dp, vertical = 8.dp),
        ) {
            if (track == null) {
                Text(stringResource(R.string.now_playing_nothing_playing), style = MaterialTheme.typography.bodyLarge)
                return@Column
            }

            AlbumArtImage(
                resolver = albumArt,
                artist = track.artist,
                album = track.album,
                filePath = track.filePath,
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .padding(vertical = 12.dp),
                shape = VoynixArtworkShape,
                contentScale = ContentScale.Crop,
            )

            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        track.title,
                        style = MaterialTheme.typography.headlineSmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        track.artist ?: "",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (!track.album.isNullOrBlank()) {
                        Text(
                            track.album,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                IconButton(onClick = onToggleFavorite) {
                    Icon(
                        if (track.favorite) Icons.Filled.Favorite else Icons.Filled.FavoriteBorder,
                        contentDescription = stringResource(R.string.now_playing_favorites),
                        tint = if (track.favorite) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Slider(
                value = if (state.durationSecs > 0) (state.positionSecs / state.durationSecs).toFloat().coerceIn(0f, 1f) else 0f,
                onValueChange = { fraction -> if (state.durationSecs > 0) player.seekTo(fraction * state.durationSecs) },
                modifier = Modifier.padding(top = 12.dp),
            )
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(formatSecs(state.positionSecs), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    "-" + formatSecs((state.durationSecs - state.positionSecs).coerceAtLeast(0.0)),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (isPodcast) {
                    IconButton(onClick = { player.skipBy(-PODCAST_SKIP_SECS) }) {
                        Icon(Icons.Filled.Replay10, contentDescription = stringResource(R.string.now_playing_back_10), modifier = Modifier.size(32.dp))
                    }
                } else {
                    ModeToggleButton(
                        checked = shuffleActive,
                        icon = if (shuffleActive) Icons.Filled.ShuffleOn else Icons.Filled.Shuffle,
                        contentDescription = if (shuffleSuppressed) stringResource(R.string.now_playing_shuffle_on_ordered) else if (shuffleActive) stringResource(R.string.now_playing_shuffle_on) else stringResource(R.string.now_playing_shuffle_off),
                        onClick = { player.toggleShuffle() },
                    )
                }
                IconButton(onClick = { player.previous() }) {
                    Icon(Icons.Filled.SkipPrevious, contentDescription = stringResource(R.string.now_playing_previous), modifier = Modifier.size(32.dp))
                }
                FilledIconButton(onClick = { player.togglePlayPause() }, modifier = Modifier.size(68.dp)) {
                    Icon(
                        if (state.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                        contentDescription = if (state.isPlaying) stringResource(R.string.player_pause) else stringResource(R.string.player_play),
                        modifier = Modifier.size(32.dp),
                    )
                }
                IconButton(onClick = { player.next() }) {
                    Icon(Icons.Filled.SkipNext, contentDescription = stringResource(R.string.now_playing_next), modifier = Modifier.size(32.dp))
                }
                if (isPodcast) {
                    IconButton(onClick = { player.skipBy(PODCAST_SKIP_SECS) }) {
                        Icon(Icons.Filled.Forward10, contentDescription = stringResource(R.string.now_playing_forward_10), modifier = Modifier.size(32.dp))
                    }
                } else {
                    ModeToggleButton(
                        checked = state.repeat != RepeatMode.OFF,
                        icon = when (state.repeat) {
                            RepeatMode.ONE -> Icons.Filled.RepeatOn
                            RepeatMode.ALL -> Icons.Filled.RepeatOn
                            RepeatMode.OFF -> Icons.Filled.Repeat
                        },
                        contentDescription = stringResource(R.string.now_playing_repeat, repeatModeLabel(state.repeat)),
                        onClick = { player.cycleRepeat() },
                        badge = if (state.repeat == RepeatMode.ONE) "1" else null,
                    )
                }
            }

            OutlinedButton(onClick = onOpenLyrics, modifier = Modifier.padding(top = 20.dp)) {
                Icon(Icons.AutoMirrored.Filled.Article, contentDescription = null, modifier = Modifier.padding(end = 6.dp))
                Text(stringResource(R.string.now_playing_lyrics))
            }
        }
    }
}

private fun formatSecs(secs: Double): String {
    val total = secs.roundToInt().coerceAtLeast(0)
    return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
}
