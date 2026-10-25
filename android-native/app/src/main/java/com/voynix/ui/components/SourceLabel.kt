package com.voynix.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.voynix.R
import com.voynix.data.db.PlaylistEntity
import com.voynix.playback.SourceNames
import com.voynix.playback.sourceLabel

/** The display name of the folder the queue is playing from, or null when unknown (see sourceLabel). */
@Composable
fun playSourceLabel(sourceId: String?, playlists: List<PlaylistEntity>): String? {
    val names = SourceNames(
        allSongs = stringResource(R.string.home_songs_all),
        favorites = stringResource(R.string.home_favorites),
        mostPlayed = stringResource(R.string.home_most_played),
        recentlyAdded = stringResource(R.string.home_recently_added),
        recentlyPlayed = stringResource(R.string.home_recently_played),
    )
    return sourceLabel(sourceId, names) { id -> playlists.find { it.id == id }?.name }
}
