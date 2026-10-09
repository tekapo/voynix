package com.voynix.ui

import android.net.Uri
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.voynix.artwork.AlbumArtResolver
import com.voynix.artwork.ArtistArtResolver
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.effectiveShuffle
import com.voynix.logic.shouldShowWelcome
import com.voynix.lyrics.LrclibApi
import com.voynix.playback.PlayerController
import com.voynix.sync.SyncPeerStore
import com.voynix.sync.SyncViewModel
import com.voynix.ui.components.MiniPlayer
import com.voynix.library.LibraryViewModel

/** App root: hosts the [VoynixNavGraph] plus a [MiniPlayer] that hides itself on Now Playing / Lyrics. */
@Composable
fun VoynixApp(
    db: VoynixDatabase,
    player: PlayerController,
    vm: LibraryViewModel,
    syncVm: SyncViewModel,
    albumArt: AlbumArtResolver,
    artistArt: ArtistArtResolver,
    lrclibApi: LrclibApi,
    onImportTrack: (Uri) -> Unit,
) {
    val playerUiState by player.uiState.collectAsState()
    val podcastNoShuffle by player.podcastNoShuffle.collectAsState()
    val shuffleOn = effectiveShuffle(playerUiState.shuffle, podcastNoShuffle, playerUiState.queue.map { it.kind })
    val navController = rememberNavController()

    // First launch: show the welcome guide once, unless a Mac is already paired.
    // Marked seen as soon as it opens so quitting mid-guide doesn't bring it back.
    var showWelcome by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val welcomeStore = WelcomeStore(db)
        if (shouldShowWelcome(welcomeStore.isSeen(), SyncPeerStore(db).get() != null)) {
            showWelcome = true
            welcomeStore.markSeen()
        }
    }
    val backStackEntry by navController.currentBackStackEntryAsState()
    val hideMiniPlayer = backStackEntry?.destination?.let {
        it.hasRoute(Route.NowPlaying::class) || it.hasRoute(Route.Lyrics::class)
    } ?: false

    Scaffold(
        // Zeroed out: each screen's own Scaffold (TopAppBar) already consumes the
        // top status-bar inset itself. Reserving it again here would double-pad —
        // exactly the gap that used to appear above "Voynix" on HOME. MiniPlayer
        // handles the bottom nav-bar inset itself via navigationBarsPadding().
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            if (!hideMiniPlayer && playerUiState.currentTrack != null) {
                MiniPlayer(
                    state = playerUiState,
                    albumArt = albumArt,
                    shuffleOn = shuffleOn,
                    onTogglePlayPause = { player.togglePlayPause() },
                    onPrevious = { player.previous() },
                    onNext = { player.next() },
                    onOpen = { navController.navigate(Route.NowPlaying) },
                )
            }
        },
    ) { innerPadding ->
        VoynixNavGraph(
            navController = navController,
            db = db,
            player = player,
            playerUiState = playerUiState,
            vm = vm,
            syncVm = syncVm,
            albumArt = albumArt,
            artistArt = artistArt,
            lrclibApi = lrclibApi,
            onImportTrack = onImportTrack,
            onShowWelcome = { showWelcome = true },
            modifier = Modifier.padding(innerPadding),
        )
    }

    if (showWelcome) {
        WelcomeDialog(
            onDismiss = { showWelcome = false },
            onOpenSync = {
                showWelcome = false
                navController.navigate(Route.Sync)
            },
        )
    }
}
