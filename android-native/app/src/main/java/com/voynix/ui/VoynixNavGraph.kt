package com.voynix.ui

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.voynix.R
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import com.voynix.artwork.AlbumArtResolver
import com.voynix.artwork.ArtistArtResolver
import com.voynix.data.db.TrackWithStats
import com.voynix.data.db.VoynixDatabase
import com.voynix.library.LibraryViewModel
import com.voynix.library.ViewMode
import com.voynix.lyrics.LrclibApi
import com.voynix.playback.PlayerController
import com.voynix.playback.PlayerUiState
import com.voynix.sync.SyncViewModel
import com.voynix.ui.home.HomeScreen
import com.voynix.ui.library.NameListScreen
import com.voynix.ui.lyrics.LyricsScreen
import com.voynix.ui.nowplaying.NowPlayingScreen
import com.voynix.ui.search.SearchScreen
import com.voynix.ui.settings.LicensesScreen
import com.voynix.ui.settings.SettingsScreen
import com.voynix.ui.sync.SyncScreen
import com.voynix.ui.tracks.TrackListScreen
import kotlin.math.roundToInt

@Composable
fun VoynixNavGraph(
    navController: NavHostController,
    db: VoynixDatabase,
    player: PlayerController,
    playerUiState: PlayerUiState,
    vm: LibraryViewModel,
    syncVm: SyncViewModel,
    albumArt: AlbumArtResolver,
    artistArt: ArtistArtResolver,
    lrclibApi: LrclibApi,
    onImportTrack: (Uri) -> Unit,
    onShowWelcome: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val back: () -> Unit = { navController.popBackStack() }
    val metaTemplate = stringResource(R.string.collection_meta)

    NavHost(navController = navController, startDestination = Route.Home, modifier = modifier) {
        composable<Route.Home> {
            HomeScreen(
                vm = vm,
                syncVm = syncVm,
                onNavigate = { route -> navController.navigate(route) },
                onOpenSettings = { navController.navigate(Route.Settings) },
                onOpenSync = { navController.navigate(Route.Sync) },
                onOpenSearch = { navController.navigate(Route.Search) },
            )
        }

        composable<Route.Search> {
            SearchScreen(
                vm = vm,
                player = player,
                playerUiState = playerUiState,
                albumArt = albumArt,
                artistArt = artistArt,
                onBack = back,
                onOpenArtist = { name -> navController.navigate(Route.ArtistDetail(name)) },
                onOpenAlbum = { name -> navController.navigate(Route.AlbumDetail(name)) },
                onOpenPlaylist = { id -> navController.navigate(Route.PlaylistDetail(id)) },
            )
        }

        composable<Route.Songs> {
            TrackListScreen(
                title = stringResource(R.string.home_songs_all),
                vm = vm, player = player, playerUiState = playerUiState, albumArt = albumArt,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.ALL_SONGS) },
            )
        }

        composable<Route.Artists> {
            NameListScreen(
                title = stringResource(R.string.home_artists),
                names = vm.artists,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.ARTISTS) },
                onClick = { name -> navController.navigate(Route.ArtistDetail(name)) },
                vm = vm,
                artistArt = artistArt,
            )
        }
        composable<Route.ArtistDetail> { entry ->
            val route: Route.ArtistDetail = entry.toRoute()
            TrackListScreen(
                title = route.name,
                vm = vm, player = player, playerUiState = playerUiState, albumArt = albumArt,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.ARTISTS); vm.selectFilter(route.name) },
                collectionMeta = { tracks -> collectionMeta(tracks, metaTemplate) },
            )
        }

        composable<Route.Albums> {
            NameListScreen(
                title = stringResource(R.string.home_albums),
                names = vm.albums,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.ALBUMS) },
                onClick = { name -> navController.navigate(Route.AlbumDetail(name)) },
                vm = vm,
            )
        }
        composable<Route.AlbumDetail> { entry ->
            val route: Route.AlbumDetail = entry.toRoute()
            TrackListScreen(
                title = route.name,
                vm = vm, player = player, playerUiState = playerUiState, albumArt = albumArt,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.ALBUMS); vm.selectFilter(route.name) },
                collectionMeta = { tracks -> collectionMeta(tracks, metaTemplate) },
            )
        }

        composable<Route.Favorites> {
            TrackListScreen(
                title = stringResource(R.string.home_favorites),
                vm = vm, player = player, playerUiState = playerUiState, albumArt = albumArt,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.FAVORITES) },
            )
        }

        composable<Route.MostPlayed> {
            TrackListScreen(
                title = stringResource(R.string.home_most_played),
                vm = vm, player = player, playerUiState = playerUiState, albumArt = albumArt,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.MOST_PLAYED) },
            )
        }

        composable<Route.RecentlyAdded> {
            TrackListScreen(
                title = stringResource(R.string.home_recently_added),
                vm = vm, player = player, playerUiState = playerUiState, albumArt = albumArt,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.RECENTLY_ADDED) },
            )
        }

        composable<Route.RecentlyPlayed> {
            TrackListScreen(
                title = stringResource(R.string.home_recently_played),
                vm = vm, player = player, playerUiState = playerUiState, albumArt = albumArt,
                onBack = back,
                onSelectLibrary = { vm.selectLibrary(ViewMode.RECENTLY_PLAYED) },
            )
        }

        composable<Route.PlaylistDetail> { entry ->
            val route: Route.PlaylistDetail = entry.toRoute()
            val playlists by vm.playlists.collectAsState()
            val title = playlists.find { it.id == route.id }?.name ?: stringResource(R.string.home_playlists)
            TrackListScreen(
                title = title,
                vm = vm, player = player, playerUiState = playerUiState, albumArt = albumArt,
                onBack = back,
                onSelectLibrary = { vm.selectPlaylist(route.id) },
                collectionMeta = { tracks -> collectionMeta(tracks, metaTemplate) },
            )
        }

        composable<Route.NowPlaying> {
            // playerUiState.currentTrack is a snapshot from when playback started,
            // so favorite changes never show up in it — read the live DB row.
            val allTracks by vm.allTracks.collectAsState()
            val freshTrack = playerUiState.currentTrack?.let { c ->
                allTracks.find { it.track.id == c.id }?.track ?: c
            }
            NowPlayingScreen(
                state = playerUiState.copy(currentTrack = freshTrack),
                player = player,
                albumArt = albumArt,
                onBack = back,
                onOpenLyrics = { navController.navigate(Route.Lyrics) },
                onToggleFavorite = { freshTrack?.let(vm::toggleFavorite) },
            )
        }

        composable<Route.Lyrics> {
            playerUiState.currentTrack?.let { track ->
                LyricsScreen(db = db, lrclibApi = lrclibApi, track = track, onBack = back)
            }
        }

        composable<Route.Settings> {
            SettingsScreen(
                context = androidx.compose.ui.platform.LocalContext.current,
                db = db,
                player = player,
                onBack = back,
                onOpenSync = { navController.navigate(Route.Sync) },
                onOpenLicenses = { navController.navigate(Route.Licenses) },
                onShowWelcome = onShowWelcome,
            )
        }

        composable<Route.Licenses> {
            LicensesScreen(
                context = androidx.compose.ui.platform.LocalContext.current,
                onBack = back,
            )
        }

        composable<Route.Sync> {
            SyncScreen(vm = syncVm, onBack = back)
        }
    }
}

// `collectionMeta` is a plain (non-@Composable) function reference passed down
// to TrackListScreen, but stringResource() only works inside composition — so
// the format template is resolved once, in VoynixNavGraph's own composable
// scope, and threaded through instead of read directly here.
private fun collectionMeta(tracks: List<TrackWithStats>, template: String): String {
    val totalMinutes = (tracks.sumOf { it.track.duration ?: 0.0 } / 60).roundToInt()
    return String.format(template, tracks.size, totalMinutes)
}
