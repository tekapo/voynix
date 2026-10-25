package com.voynix.ui

import com.voynix.playback.ALL_SONGS_ID
import com.voynix.playback.FAVORITES_ID
import com.voynix.playback.MOST_PLAYED_ID
import com.voynix.playback.RECENTLY_ADDED_ID
import com.voynix.playback.RECENTLY_PLAYED_ID
import com.voynix.playback.albumNameOfFolder
import com.voynix.playback.artistNameOfFolder
import com.voynix.playback.playlistIdOfFolder
import kotlinx.serialization.Serializable

/** Type-safe navigation-compose destinations. HOME is the start destination; every drill-in stacks on top of it. */
sealed interface Route {
    @Serializable data object Home : Route

    @Serializable data object Search : Route
    @Serializable data object Songs : Route
    @Serializable data object Artists : Route
    @Serializable data class ArtistDetail(val name: String) : Route
    @Serializable data object Albums : Route
    @Serializable data class AlbumDetail(val name: String) : Route
    @Serializable data object Favorites : Route
    @Serializable data object MostPlayed : Route
    @Serializable data object RecentlyAdded : Route
    @Serializable data object RecentlyPlayed : Route
    @Serializable data class PlaylistDetail(val id: String) : Route

    @Serializable data object NowPlaying : Route
    @Serializable data object Lyrics : Route
    @Serializable data object Settings : Route
    @Serializable data object Sync : Route
    @Serializable data object Licenses : Route
}

/** The list screen a queue's source folder id (see playback/BrowseTree.kt) belongs to, or null if it has none. */
fun routeOfSource(sourceId: String?): Route? {
    if (sourceId == null) return null
    return when {
        sourceId == ALL_SONGS_ID -> Route.Songs
        sourceId == FAVORITES_ID -> Route.Favorites
        sourceId == MOST_PLAYED_ID -> Route.MostPlayed
        sourceId == RECENTLY_ADDED_ID -> Route.RecentlyAdded
        sourceId == RECENTLY_PLAYED_ID -> Route.RecentlyPlayed
        artistNameOfFolder(sourceId) != null -> Route.ArtistDetail(artistNameOfFolder(sourceId)!!)
        albumNameOfFolder(sourceId) != null -> Route.AlbumDetail(albumNameOfFolder(sourceId)!!)
        playlistIdOfFolder(sourceId) != null -> Route.PlaylistDetail(playlistIdOfFolder(sourceId)!!)
        else -> null
    }
}
