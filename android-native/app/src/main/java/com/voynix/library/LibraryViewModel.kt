package com.voynix.library

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.voynix.data.db.PlaylistEntity
import com.voynix.data.db.TrackEntity
import com.voynix.data.db.TrackWithStats
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.albumOf
import com.voynix.logic.artistOf
import com.voynix.logic.filterStrings
import com.voynix.logic.filterTracks
import com.voynix.logic.mostPlayed
import com.voynix.logic.recentlyAdded
import com.voynix.logic.recentlyPlayed
import com.voynix.logic.sortNatural
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

// Mirrors App.tsx's viewMode/viewFilter/currentPlaylistId/search state and the
// viewTracks/displayTracks derivation (see App.tsx:1759-1787). PLAYLIST,
// ALL_SONGS, ARTISTS, ALBUMS, FAVORITES, MOST_PLAYED, RECENTLY_ADDED,
// RECENTLY_PLAYED == the ViewMode union in types.ts, minus nothing — Voynix
// shows every view a mirror client can.
enum class ViewMode { PLAYLIST, ALL_SONGS, ARTISTS, ALBUMS, FAVORITES, MOST_PLAYED, RECENTLY_ADDED, RECENTLY_PLAYED }

private val whileUsed = SharingStarted.WhileSubscribed(5000)

@OptIn(ExperimentalCoroutinesApi::class)
class LibraryViewModel(private val db: VoynixDatabase) : ViewModel() {

    private val _viewMode = MutableStateFlow(ViewMode.ALL_SONGS)
    val viewMode: StateFlow<ViewMode> = _viewMode.asStateFlow()

    private val _viewFilter = MutableStateFlow<String?>(null)
    val viewFilter: StateFlow<String?> = _viewFilter.asStateFlow()

    private val _currentPlaylistId = MutableStateFlow<String?>(null)
    val currentPlaylistId: StateFlow<String?> = _currentPlaylistId.asStateFlow()

    private val _search = MutableStateFlow("")
    val search: StateFlow<String> = _search.asStateFlow()

    val playlists: StateFlow<List<PlaylistEntity>> =
        db.playlistDao().observeAll().stateIn(viewModelScope, whileUsed, emptyList())

    // No ORDER BY — same as getAllTracks() in db.ts; every view below applies
    // its own order in-memory.
    val allTracks: StateFlow<List<TrackWithStats>> =
        db.trackDao().observeAllWithStats().stateIn(viewModelScope, whileUsed, emptyList())

    val artists: StateFlow<List<String>> = combine(allTracks, _search) { tracks, q ->
        filterStrings(tracks.map(::artistOf).distinct().sorted(), q)
    }.stateIn(viewModelScope, whileUsed, emptyList())

    val albums: StateFlow<List<String>> = combine(allTracks, _search) { tracks, q ->
        filterStrings(tracks.map(::albumOf).distinct().sorted(), q)
    }.stateIn(viewModelScope, whileUsed, emptyList())

    // Ordered by playlist_tracks.position — see the comment on
    // PlaylistDao.observePlaylistTracks for why NATURAL_ORDER never applies here.
    private val playlistTracks: StateFlow<List<TrackWithStats>> = _currentPlaylistId
        .flatMapLatest { id -> id?.let { db.playlistDao().observePlaylistTracks(it) } ?: flowOf(emptyList()) }
        .stateIn(viewModelScope, whileUsed, emptyList())

    // The tracks for the current view, before the search filter — App.tsx's viewTracks.
    val viewTracks: StateFlow<List<TrackWithStats>> =
        combine(_viewMode, _viewFilter, allTracks, playlistTracks) { mode, filter, all, plTracks ->
            when (mode) {
                ViewMode.PLAYLIST -> plTracks
                ViewMode.ALL_SONGS -> sortNatural(all)
                ViewMode.ARTISTS -> if (filter != null) sortNatural(all.filter { artistOf(it) == filter }) else emptyList()
                ViewMode.ALBUMS -> if (filter != null) sortNatural(all.filter { albumOf(it) == filter }) else emptyList()
                ViewMode.FAVORITES -> sortNatural(all.filter { it.track.favorite })
                ViewMode.MOST_PLAYED -> mostPlayed(all)
                ViewMode.RECENTLY_ADDED -> recentlyAdded(all)
                ViewMode.RECENTLY_PLAYED -> recentlyPlayed(all)
            }
        }.stateIn(viewModelScope, whileUsed, emptyList())

    val displayTracks: StateFlow<List<TrackWithStats>> = combine(viewTracks, _search) { tracks, q ->
        filterTracks(tracks, q)
    }.stateIn(viewModelScope, whileUsed, emptyList())

    /** Switch to a top-level library section (App.tsx's handleLibraryClick). */
    fun selectLibrary(mode: ViewMode) {
        _viewMode.value = mode
        _viewFilter.value = null
        _currentPlaylistId.value = null
        _search.value = ""
    }

    /** Drill into one artist/album card (App.tsx's selectViewFilter). */
    fun selectFilter(value: String) {
        _viewFilter.value = value
        _search.value = ""
    }

    fun selectPlaylist(id: String) {
        _viewMode.value = ViewMode.PLAYLIST
        _currentPlaylistId.value = id
        _viewFilter.value = null
        _search.value = ""
    }

    /** Back out of an artist/album/playlist drill-down to its index. */
    fun clearDrilldown() {
        _viewFilter.value = null
        _currentPlaylistId.value = null
    }

    fun setSearch(query: String) {
        _search.value = query
    }

    fun toggleFavorite(track: TrackEntity) = viewModelScope.launch {
        db.trackDao().setFavorite(track.id, !track.favorite, System.currentTimeMillis())
    }

    /** Podcast read/unread toggle — mirrors setTrackPlayState's played <-> unplayed swing. */
    fun togglePlayed(track: TrackEntity) = viewModelScope.launch {
        val next = if (track.playState == "played") "unplayed" else "played"
        val resume = if (next == "unplayed") 0.0 else 0.0
        db.trackDao().setPlayState(track.id, next, resume, System.currentTimeMillis())
    }
}
