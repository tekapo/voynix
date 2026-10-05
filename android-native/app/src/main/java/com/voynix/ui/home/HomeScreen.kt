package com.voynix.ui.home

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.Album
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.NewReleases
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.voynix.R
import com.voynix.data.db.PlaylistEntity
import com.voynix.library.LibraryViewModel
import com.voynix.sync.SyncViewModel
import com.voynix.ui.Route
import com.voynix.ui.components.EmptyState

/** The default screen: one scroll with a LIBRARY section and a PLAYLISTS section. No bottom tab bar. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    vm: LibraryViewModel,
    syncVm: SyncViewModel,
    onNavigate: (Route) -> Unit,
    onOpenSettings: () -> Unit,
    onOpenSync: () -> Unit,
    onOpenSearch: () -> Unit,
) {
    val peer by syncVm.peer.collectAsState()
    val isSyncing by syncVm.isSyncing.collectAsState()
    val summary by syncVm.lastSummary.collectAsState()
    val syncError by syncVm.syncError.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    // Resolved outside the effect: stringResource() only works in composition,
    // and LaunchedEffect's body is a plain suspend block, not composable.
    val syncCompleteTemplate = stringResource(R.string.home_sync_complete)
    // Surface the outcome of a sync started from here (isSyncing true -> false).
    var wasSyncing by remember { mutableStateOf(false) }
    LaunchedEffect(isSyncing) {
        if (wasSyncing && !isSyncing) {
            val message = syncError ?: summary?.let {
                String.format(syncCompleteTemplate, it.added, it.refetched, it.deleted)
            }
            if (message != null) snackbarHostState.showSnackbar(message)
        }
        wasSyncing = isSyncing
    }
    val playlists by vm.playlists.collectAsState()
    var libraryExpanded by rememberSaveable { mutableStateOf(false) }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall) },
                actions = {
                    IconButton(onClick = onOpenSearch) {
                        Icon(Icons.Filled.Search, contentDescription = stringResource(R.string.home_search))
                    }
                    if (isSyncing) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(horizontal = 12.dp).size(24.dp),
                            strokeWidth = 2.dp,
                        )
                    } else {
                        IconButton(onClick = { if (peer == null) onOpenSync() else syncVm.sync() }) {
                            Icon(Icons.Filled.Sync, contentDescription = stringResource(R.string.home_sync_now))
                        }
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.home_settings))
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(modifier = Modifier.padding(padding).fillMaxSize()) {
            item {
                CollapsibleSectionLabel(
                    text = stringResource(R.string.home_library),
                    expanded = libraryExpanded,
                    onClick = { libraryExpanded = !libraryExpanded },
                )
            }
            if (libraryExpanded) {
                item { HomeRow(Icons.Filled.LibraryMusic, stringResource(R.string.home_songs)) { onNavigate(Route.Songs) } }
                item { HomeRow(Icons.Filled.Person, stringResource(R.string.home_artists)) { onNavigate(Route.Artists) } }
                item { HomeRow(Icons.Filled.Album, stringResource(R.string.home_albums)) { onNavigate(Route.Albums) } }
                item { HomeRow(Icons.Filled.Star, stringResource(R.string.home_favorites)) { onNavigate(Route.Favorites) } }
                item { HomeRow(Icons.AutoMirrored.Filled.QueueMusic, stringResource(R.string.home_most_played)) { onNavigate(Route.MostPlayed) } }
                item { HomeRow(Icons.Filled.NewReleases, stringResource(R.string.home_recently_added)) { onNavigate(Route.RecentlyAdded) } }
                item { HomeRow(Icons.Filled.History, stringResource(R.string.home_recently_played)) { onNavigate(Route.RecentlyPlayed) } }
            }

            item { SectionLabel(stringResource(R.string.home_playlists)) }
            if (playlists.isEmpty()) {
                item {
                    EmptyState(
                        icon = Icons.AutoMirrored.Filled.PlaylistPlay,
                        title = stringResource(R.string.home_no_playlists_title),
                        detail = stringResource(R.string.home_no_playlists_detail),
                        modifier = Modifier.padding(vertical = 8.dp),
                    )
                }
            } else {
                items(playlists, key = { it.id }) { playlist: PlaylistEntity ->
                    val isPodcast = playlist.kind == "podcast"
                    HomeRow(
                        icon = if (isPodcast) Icons.Filled.Podcasts else Icons.AutoMirrored.Filled.PlaylistPlay,
                        label = playlist.name,
                        iconDescription = if (isPodcast) stringResource(R.string.home_podcast) else null,
                    ) {
                        onNavigate(Route.PlaylistDetail(playlist.id))
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 4.dp),
    )
}

@Composable
private fun CollapsibleSectionLabel(text: String, expanded: Boolean, onClick: () -> Unit) {
    val rotation by animateFloatAsState(if (expanded) 0f else -90f, label = "sectionArrow")
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.weight(1f),
        )
        Icon(
            Icons.Filled.ExpandMore,
            contentDescription = if (expanded) stringResource(R.string.home_collapse) else stringResource(R.string.home_expand),
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.rotate(rotation),
        )
    }
}

@Composable
private fun HomeRow(icon: ImageVector, label: String, iconDescription: String? = null, onClick: () -> Unit) {
    ListItem(
        modifier = Modifier
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClick = onClick),
        leadingContent = {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = iconDescription, tint = MaterialTheme.colorScheme.onPrimaryContainer)
            }
        },
        headlineContent = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
    )
}
