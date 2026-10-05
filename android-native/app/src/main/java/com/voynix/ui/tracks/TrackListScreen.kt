package com.voynix.ui.tracks

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.artwork.AlbumArtResolver
import com.voynix.data.db.TrackWithStats
import com.voynix.library.LibraryViewModel
import com.voynix.logic.NowPlayingDirection
import com.voynix.logic.isPodcastQueue
import com.voynix.logic.markerFraction
import com.voynix.logic.nowPlayingDirection
import com.voynix.playback.PlayerController
import com.voynix.playback.PlayerUiState
import com.voynix.ui.components.CollectionHeader
import com.voynix.ui.components.EmptyState
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * A flat track list — songs / favorites / most-played (no [CollectionHeader])
 * or one artist / album / playlist ([collectionMeta] != null shows the header
 * with Play/Shuffle). Search is scoped to this destination via a locally-
 * saved query so navigating back to a previous list doesn't lose it, even
 * though re-entering re-runs [onSelectLibrary] against the shared
 * [LibraryViewModel] view state.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackListScreen(
    title: String,
    vm: LibraryViewModel,
    player: PlayerController,
    playerUiState: PlayerUiState,
    albumArt: AlbumArtResolver,
    onBack: () -> Unit,
    onSelectLibrary: () -> Unit,
    collectionMeta: ((List<TrackWithStats>) -> String)? = null,
) {
    var query by rememberSaveable { mutableStateOf("") }
    var searchOpen by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(Unit) { onSelectLibrary() }
    LaunchedEffect(query) { vm.setSearch(query) }

    val displayTracks by vm.displayTracks.collectAsState()
    val podcastNoShuffle by player.podcastNoShuffle.collectAsState()
    // Shuffling this collection would be a no-op once podcastNoShuffle forces it back
    // into order, so the button is hidden rather than left to silently do nothing.
    val showShuffle = !(podcastNoShuffle && isPodcastQueue(displayTracks.map { it.track.kind }))
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())

    var actionsFor by remember { mutableStateOf<TrackWithStats?>(null) }

    // Where the currently-loaded track sits in the LazyColumn — +1 when a
    // CollectionHeader item precedes the tracks. -1 (nothing to point at)
    // when it isn't in this list at all (a different view, a search filter…).
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val headerOffset = if (collectionMeta != null) 1 else 0
    val playingTrackIndex = displayTracks.indexOfFirst { it.track.id == playerUiState.currentTrack?.id }
    val nowPlayingItemIndex = if (playingTrackIndex >= 0) playingTrackIndex + headerOffset else -1

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.track_list_back))
                    }
                },
                actions = {
                    IconButton(onClick = { searchOpen = !searchOpen; if (!searchOpen) query = "" }) {
                        Icon(Icons.Filled.Search, contentDescription = stringResource(R.string.track_list_search))
                    }
                },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (searchOpen) {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                    label = { Text(stringResource(R.string.track_list_search)) },
                    singleLine = true,
                )
            }

            if (displayTracks.isEmpty()) {
                EmptyState(
                    icon = Icons.AutoMirrored.Filled.QueueMusic,
                    title = if (query.isNotEmpty()) stringResource(R.string.track_list_no_songs_match, query) else stringResource(R.string.track_list_no_songs),
                    modifier = Modifier.padding(top = 24.dp),
                )
            } else {
                Box(modifier = Modifier.fillMaxSize()) {
                    LazyColumn(modifier = Modifier.fillMaxSize(), state = listState) {
                        if (collectionMeta != null) {
                            item {
                                CollectionHeader(
                                    title = title,
                                    meta = collectionMeta(displayTracks),
                                    tracks = displayTracks.map { it.track },
                                    albumArt = albumArt,
                                    isPlaying = playingTrackIndex >= 0 && playerUiState.isPlaying,
                                    onPlay = {
                                        if (playingTrackIndex >= 0) {
                                            player.togglePlayPause()
                                        } else {
                                            player.setQueueAndPlay(displayTracks.map { it.track }, 0)
                                        }
                                    },
                                    onToggleShuffle = { player.toggleShuffle() },
                                    shuffleOn = playerUiState.shuffle,
                                    showShuffle = showShuffle,
                                )
                            }
                        }
                        items(displayTracks, key = { it.track.id }) { item ->
                            TrackRow(
                                item = item,
                                isCurrent = playerUiState.currentTrack?.id == item.track.id,
                                albumArt = albumArt,
                                onClick = {
                                    val all = displayTracks.map { it.track }
                                    val index = all.indexOfFirst { it.id == item.track.id }
                                    if (index >= 0) player.setQueueAndPlay(all, index)
                                },
                                onLongClick = { actionsFor = item },
                            )
                        }
                    }
                    NowPlayingIndicator(
                        listState = listState,
                        itemIndex = nowPlayingItemIndex,
                        totalItemCount = displayTracks.size + headerOffset,
                        scope = scope,
                    )
                }
            }
        }
    }

    actionsFor?.let { item ->
        TrackActionsSheet(
            item = item,
            albumArt = albumArt,
            onDismiss = { actionsFor = null },
            onToggleFavorite = { vm.toggleFavorite(item.track) },
            onEnqueue = { player.enqueue(item.track) },
            onTogglePlayed = { vm.togglePlayed(item.track) },
        )
    }
}

/**
 * Overlaid on the [LazyColumn][androidx.compose.foundation.lazy.LazyColumn]:
 * a "Now Playing" jump button when [itemIndex] has scrolled out of view, and
 * a marker on a rail along the right edge mirroring its position in the full
 * list — a miniature "you are here" for a list too long to eyeball. Reads
 * [listState]'s scroll position via `derivedStateOf` so it only triggers
 * recomposition here, not of the (possibly huge) list above it, and only
 * when the derived direction/scrollability actually changes.
 */
@Composable
private fun BoxScope.NowPlayingIndicator(
    listState: LazyListState,
    itemIndex: Int,
    totalItemCount: Int,
    scope: CoroutineScope,
) {
    val direction by remember(itemIndex) {
        derivedStateOf {
            if (itemIndex < 0) return@derivedStateOf null
            val visible = listState.layoutInfo.visibleItemsInfo
            if (visible.isEmpty()) null else nowPlayingDirection(itemIndex, visible.first().index, visible.last().index)
        }
    }
    val canScroll by remember { derivedStateOf { listState.canScrollForward || listState.canScrollBackward } }

    fun jumpToNowPlaying() {
        if (itemIndex < 0) return
        scope.launch {
            // A long jump (e.g. from the top of an "All Songs" list to a
            // track near the bottom) would otherwise animate through
            // thousands of rows — snap there instead and only animate the
            // last stretch.
            if (abs(listState.firstVisibleItemIndex - itemIndex) > 60) {
                listState.scrollToItem(itemIndex)
            } else {
                listState.animateScrollToItem(itemIndex)
            }
        }
    }

    AnimatedVisibility(
        visible = direction != null,
        modifier = Modifier
            .align(if (direction == NowPlayingDirection.ABOVE) Alignment.TopCenter else Alignment.BottomCenter)
            .padding(vertical = 12.dp),
        enter = fadeIn(),
        exit = fadeOut(),
    ) {
        ExtendedFloatingActionButton(
            onClick = { jumpToNowPlaying() },
            icon = {
                Icon(
                    if (direction == NowPlayingDirection.ABOVE) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                )
            },
            text = { Text(stringResource(R.string.track_list_now_playing)) },
        )
    }

    if (itemIndex >= 0 && canScroll) {
        BoxWithConstraints(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .fillMaxHeight()
                .width(24.dp),
        ) {
            val fraction = markerFraction(itemIndex, totalItemCount)
            val markerOffset = (maxHeight - 3.dp) * fraction
            Box(
                modifier = Modifier
                    .padding(top = markerOffset, end = 4.dp)
                    .size(width = 10.dp, height = 3.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(MaterialTheme.colorScheme.primary)
                    .clickable { jumpToNowPlaying() },
            )
        }
    }
}
