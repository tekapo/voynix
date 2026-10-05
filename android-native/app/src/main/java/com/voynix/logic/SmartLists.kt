package com.voynix.logic

import com.voynix.data.db.TrackWithStats

// The "Most Played" / "Recently Added" / "Recently Played" auto playlists,
// mirroring src/smartLists.ts. Pure functions over TrackWithStats so both the
// phone UI (LibraryViewModel) and Android Auto (BrowseTree) can share one
// implementation instead of each inlining the filter/sort/cap.

private const val SMART_LIST_LIMIT = 100

/** Tracks with at least one play, most-played first, capped at 100. */
fun mostPlayed(tracks: List<TrackWithStats>): List<TrackWithStats> =
    tracks.filter { it.playCount > 0 }
        .sortedByDescending { it.playCount }
        .take(SMART_LIST_LIMIT)

/**
 * Tracks most-recently added first, capped at 100. Podcasts are excluded —
 * episodes arrive continuously and would otherwise crowd out music (they
 * already have their own playlist + unplayed/in-progress markers). Tracks
 * with no addedAt (not yet backfilled by a sync, see VoynixDatabase's
 * MIGRATION_3_4) are left out rather than sorted arbitrarily.
 */
fun recentlyAdded(tracks: List<TrackWithStats>): List<TrackWithStats> =
    tracks.filter { it.track.kind != "podcast" && it.track.addedAt != null }
        .sortedByDescending { it.track.addedAt }
        .take(SMART_LIST_LIMIT)

/**
 * Tracks most-recently played first, capped at 100. lastPlayed is derived
 * from play_events (MAX(played_at) per track_key), so this includes plays
 * synced in from a paired device.
 */
fun recentlyPlayed(tracks: List<TrackWithStats>): List<TrackWithStats> =
    tracks.filter { it.lastPlayed != null }
        .sortedByDescending { it.lastPlayed }
        .take(SMART_LIST_LIMIT)
