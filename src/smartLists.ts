import { Track } from "./types";

const SMART_LIST_LIMIT = 100;

/**
 * Tracks with at least one play, most-played first, capped at 100 —
 * App.tsx's inline logic for viewMode === 'most_played', extracted so the
 * same rule is unit-testable without a DB (mirrors Android's
 * logic/SmartLists.kt, which is the source of truth for the sibling client).
 */
export function mostPlayed(tracks: Track[]): Track[] {
    return tracks
        .filter(t => (t.play_count || 0) > 0)
        .sort((a, b) => (b.play_count || 0) - (a.play_count || 0))
        .slice(0, SMART_LIST_LIMIT);
}

/**
 * Tracks most-recently added first, capped at 100. Podcasts are excluded —
 * episodes arrive continuously and would otherwise crowd out music (they
 * already have their own playlist + unplayed/in-progress markers). Tracks
 * with no added_at (pre-migration rows that had no content_hash_cache entry
 * to backfill from) are left out rather than sorted arbitrarily.
 */
export function recentlyAdded(tracks: Track[]): Track[] {
    return tracks
        .filter(t => t.kind !== 'podcast' && !!t.added_at)
        .sort((a, b) => (b.added_at || 0) - (a.added_at || 0))
        .slice(0, SMART_LIST_LIMIT);
}

/**
 * Tracks most-recently played first, capped at 100. last_played is derived
 * from play_events (MAX(played_at) per track_key), so this includes plays
 * synced in from a paired device.
 */
export function recentlyPlayed(tracks: Track[]): Track[] {
    return tracks
        .filter(t => !!t.last_played)
        .sort((a, b) => (b.last_played || 0) - (a.last_played || 0))
        .slice(0, SMART_LIST_LIMIT);
}

/** Sidebar Library entries that can be flagged "Sync to Device". */
export const LIBRARY_SYNC_SOURCES = [
    "all_songs", "favorites", "most_played", "recently_added", "recently_played",
] as const;
export type LibrarySyncSource = typeof LIBRARY_SYNC_SOURCES[number];

export function isLibrarySyncSource(v: unknown): v is LibrarySyncSource {
    return (LIBRARY_SYNC_SOURCES as readonly unknown[]).includes(v);
}

/** The tracks a Library entry shows — same rules as App.tsx's view filters. */
export function libraryListTracks(source: LibrarySyncSource, tracks: Track[]): Track[] {
    switch (source) {
        case "all_songs": return tracks;
        case "favorites": return tracks.filter(t => t.favorite);
        case "most_played": return mostPlayed(tracks);
        case "recently_added": return recentlyAdded(tracks);
        case "recently_played": return recentlyPlayed(tracks);
    }
}
