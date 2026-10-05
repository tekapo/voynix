// A small, deterministic fixture library for App.tsx characterization tests.
// Built by calling db.ts's own write functions (createPlaylist,
// addTracksToPlaylist, setTrackFavorite, setTrackKind, setTrackPlayState)
// against a real in-memory SQLite device (test/sqliteDevice.ts) — not by
// hand-crafting fakeDb SQL-string matches. This means App renders against
// the exact same SQL getPlaylists()/buildSyncSnapshot() run in production,
// so a refactor that changes db.ts's query shape is caught the same way a
// real regression would be.
import {
    addTracksToPlaylist,
    createPlaylist,
    setTrackFavorite,
    setTrackKind,
    setTrackPlayState,
} from "../db";
import type { Track } from "../types";

export interface SeededLibrary {
    /** "Rock Favorites" — a folder playlist of music tracks, two artists/albums. */
    rockPlaylistId: string;
    /** "My Podcast" — a folder playlist of podcast episodes with play_state. */
    podcastPlaylistId: string;
    trackIds: {
        aFavorite: string; // Artist A / Album A / track 1, favorited
        aTrack2: string;   // Artist A / Album A / track 2
        bTrack1: string;   // Artist B / Album B / track 1
        podcastUnplayed: string;
        podcastInProgress: string;
    };
}

function track(over: Partial<Track> & Pick<Track, "id" | "title" | "file_path" | "file_name">): Track {
    return {
        artist: "Artist A",
        album: "Album A",
        duration: 180,
        disc_no: 1,
        track_no: 1,
        track_key: over.id, // stable + non-null so backfills short-circuit in tests
        content_hash: `hash-${over.id}`,
        kind: "music",
        extra_tags_read: 1, // so backfillExtraTags short-circuits in tests, same reasoning as track_key above
        ...over,
    };
}

/** Seeds a fixture library into whatever SQLite device db.ts's singleton
 * currently points at (see test/sqliteDevice.ts's setActiveDevice). Call
 * after initDb()/migrateFromJson() have settled. */
export async function seedLibrary(): Promise<SeededLibrary> {
    const rockPlaylist = await createPlaylist("Rock Favorites", "folder");
    const podcastPlaylist = await createPlaylist("My Podcast", "folder");

    const aFavorite = track({
        id: "t-a-fav", title: "Aurora", artist: "Artist A", album: "Album A",
        file_path: "/music/artist-a/album-a/01-aurora.mp3", file_name: "01-aurora.mp3", track_no: 1,
    });
    const aTrack2 = track({
        id: "t-a-2", title: "Borealis", artist: "Artist A", album: "Album A",
        file_path: "/music/artist-a/album-a/02-borealis.mp3", file_name: "02-borealis.mp3", track_no: 2,
    });
    const bTrack1 = track({
        id: "t-b-1", title: "Cascade", artist: "Artist B", album: "Album B",
        file_path: "/music/artist-b/album-b/01-cascade.mp3", file_name: "01-cascade.mp3", track_no: 1,
    });
    await addTracksToPlaylist(rockPlaylist.id, [aFavorite, aTrack2, bTrack1]);
    await setTrackFavorite(aFavorite.id, true);

    const podcastUnplayed = track({
        id: "t-pod-1", title: "Episode 1", artist: "Cast Host", album: "My Podcast",
        file_path: "/podcasts/my-podcast/ep1.mp3", file_name: "ep1.mp3", kind: "podcast", duration: 1800,
    });
    const podcastInProgress = track({
        id: "t-pod-2", title: "Episode 2", artist: "Cast Host", album: "My Podcast",
        file_path: "/podcasts/my-podcast/ep2.mp3", file_name: "ep2.mp3", kind: "podcast", duration: 1800,
    });
    await addTracksToPlaylist(podcastPlaylist.id, [podcastUnplayed, podcastInProgress], "podcast");
    await setTrackKind(podcastUnplayed.id, "podcast");
    await setTrackKind(podcastInProgress.id, "podcast");
    await setTrackPlayState(podcastInProgress.id, "in_progress", 42);

    return {
        rockPlaylistId: rockPlaylist.id,
        podcastPlaylistId: podcastPlaylist.id,
        trackIds: {
            aFavorite: aFavorite.id,
            aTrack2: aTrack2.id,
            bTrack1: bTrack1.id,
            podcastUnplayed: podcastUnplayed.id,
            podcastInProgress: podcastInProgress.id,
        },
    };
}
