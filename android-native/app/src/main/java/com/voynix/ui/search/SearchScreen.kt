package com.voynix.ui.search

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.artwork.AlbumArtResolver
import com.voynix.artwork.ArtistArtResolver
import com.voynix.artwork.ArtistImage
import com.voynix.data.db.PlaylistEntity
import com.voynix.data.db.TrackWithStats
import com.voynix.library.LibraryViewModel
import com.voynix.logic.albumOf
import com.voynix.logic.artistOf
import com.voynix.logic.filterPlaylists
import com.voynix.logic.filterStrings
import com.voynix.logic.filterTracks
import com.voynix.playback.PlayerController
import com.voynix.playback.PlayerUiState
import com.voynix.ui.components.EmptyState
import com.voynix.ui.tracks.TrackActionsSheet
import com.voynix.ui.tracks.TrackRow

// Caps per section so a broad query (e.g. a single common letter) doesn't
// dump the whole library onto one screen — this is a jump-to-it index, not
// another full list view. TrackListScreen/NameListScreen's own in-list search
// exists for exhaustively filtering the library.
private const val MAX_TRACKS = 20
private const val MAX_NAMES = 8

/**
 * Home's search entry point: one query box against songs, artists, albums
 * and playlists (podcasts included) at once. Unlike TrackListScreen/
 * NameListScreen's search, this doesn't touch [LibraryViewModel]'s shared
 * `_search`/view state — it reads [LibraryViewModel.allTracks]/[LibraryViewModel.playlists]
 * directly and filters locally, so it can't leak a stale query into whatever
 * view the user navigates to next.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(
    vm: LibraryViewModel,
    player: PlayerController,
    playerUiState: PlayerUiState,
    albumArt: AlbumArtResolver,
    artistArt: ArtistArtResolver,
    onBack: () -> Unit,
    onOpenArtist: (String) -> Unit,
    onOpenAlbum: (String) -> Unit,
    onOpenPlaylist: (String) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }

    val allTracks by vm.allTracks.collectAsState()
    val playlists by vm.playlists.collectAsState()

    val matchedTracks by remember { derivedStateOf { filterTracks(allTracks, query).take(MAX_TRACKS) } }
    val matchedArtists by remember {
        derivedStateOf { filterStrings(allTracks.map(::artistOf).distinct().sorted(), query).take(MAX_NAMES) }
    }
    val matchedAlbums by remember {
        derivedStateOf { filterStrings(allTracks.map(::albumOf).distinct().sorted(), query).take(MAX_NAMES) }
    }
    val matchedPlaylists by remember { derivedStateOf { filterPlaylists(playlists, query).take(MAX_NAMES) } }

    val hasQuery = query.isNotBlank()
    val hasResults = matchedTracks.isNotEmpty() || matchedArtists.isNotEmpty() ||
        matchedAlbums.isNotEmpty() || matchedPlaylists.isNotEmpty()

    var actionsFor by remember { mutableStateOf<TrackWithStats?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
                        placeholder = { Text(stringResource(R.string.search_placeholder)) },
                        singleLine = true,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.search_back))
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (!hasQuery) {
                EmptyState(
                    icon = Icons.Filled.Search,
                    title = stringResource(R.string.search_your_library),
                    detail = stringResource(R.string.search_your_library_detail),
                    modifier = Modifier.padding(top = 24.dp),
                )
            } else if (!hasResults) {
                EmptyState(
                    icon = Icons.Filled.Search,
                    title = stringResource(R.string.search_no_results, query),
                    modifier = Modifier.padding(top = 24.dp),
                )
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    if (matchedPlaylists.isNotEmpty()) {
                        item { SearchSectionLabel(stringResource(R.string.search_section_playlists)) }
                        items(matchedPlaylists, key = { "pl-${it.id}" }) { playlist ->
                            PlaylistResultRow(playlist, onClick = { onOpenPlaylist(playlist.id) })
                        }
                    }
                    if (matchedArtists.isNotEmpty()) {
                        item { SearchSectionLabel(stringResource(R.string.search_section_artists)) }
                        items(matchedArtists, key = { "ar-$it" }) { name ->
                            ListItem(
                                leadingContent = { ArtistImage(resolver = artistArt, artist = name, size = 40.dp) },
                                headlineContent = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                                modifier = Modifier.fillMaxWidth().clickable { onOpenArtist(name) },
                            )
                        }
                    }
                    if (matchedAlbums.isNotEmpty()) {
                        item { SearchSectionLabel(stringResource(R.string.search_section_albums)) }
                        items(matchedAlbums, key = { "al-$it" }) { name ->
                            ListItem(
                                headlineContent = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                                modifier = Modifier.fillMaxWidth().clickable { onOpenAlbum(name) },
                            )
                        }
                    }
                    if (matchedTracks.isNotEmpty()) {
                        item { SearchSectionLabel(stringResource(R.string.search_section_songs)) }
                        items(matchedTracks, key = { "tr-${it.track.id}" }) { item ->
                            TrackRow(
                                item = item,
                                isCurrent = playerUiState.currentTrack?.id == item.track.id,
                                albumArt = albumArt,
                                onClick = {
                                    val index = matchedTracks.indexOfFirst { it.track.id == item.track.id }
                                    if (index >= 0) player.setQueueAndPlay(matchedTracks.map { it.track }, index)
                                },
                                onLongClick = { actionsFor = item },
                            )
                        }
                    }
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

@Composable
private fun SearchSectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun PlaylistResultRow(playlist: PlaylistEntity, onClick: () -> Unit) {
    val isPodcast = playlist.kind == "podcast"
    ListItem(
        leadingContent = {
            Icon(
                if (isPodcast) Icons.Filled.Podcasts else Icons.AutoMirrored.Filled.PlaylistPlay,
                contentDescription = if (isPodcast) stringResource(R.string.search_podcast) else null,
            )
        },
        headlineContent = { Text(playlist.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    )
}
