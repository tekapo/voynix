package com.voynix.ui

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
