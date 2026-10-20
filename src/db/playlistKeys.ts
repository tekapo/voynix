import { getDb } from "./core";
import { playlistOrderBy } from "./playlists";
import { getAllTracks } from "./tracks";
import { evaluateSmartPlaylist, parseSmartRules } from "../smartPlaylist";

/** The `playlists` columns the resolver reads. */
export interface PlaylistKeyRow {
    id: string;
    type: string;
    manual_order?: number;
    rules?: string | null;
}

/**
 * Resolves a playlist row to its ordered `track_key`s — evaluating a smart
 * playlist's rules, or reading a regular one in the order the app itself shows
 * (playlistOrderBy). Shared by the Android sync snapshot and the remote API so
 * both mirror exactly what the Mac displays.
 *
 * The whole library and every playlist's membership are only needed when a
 * smart playlist (or a caller of `allTracks`) asks, so they load lazily, once.
 */
export function createPlaylistKeyResolver() {
    let allTracks: Awaited<ReturnType<typeof getAllTracks>> | null = null;
    let membership: Map<string, Set<string>> | null = null;

    async function context() {
        const db = await getDb();
        if (!allTracks) allTracks = await getAllTracks();
        if (!membership) {
            const rows: { playlist_id: string; track_id: string }[] = await db.select(
                "SELECT playlist_id, track_id FROM playlist_tracks"
            );
            membership = new Map();
            for (const { playlist_id, track_id } of rows) {
                const set = membership.get(playlist_id);
                if (set) set.add(track_id);
                else membership.set(playlist_id, new Set([track_id]));
            }
        }
        return { allTracks, membership };
    }

    return {
        /** The whole library (for library-source sync and rule evaluation). */
        allTracks: async () => (await context()).allTracks,
        trackKeys: async (pl: PlaylistKeyRow): Promise<string[]> => {
            if (pl.type === 'smart') {
                const { allTracks: tracks, membership: memb } = await context();
                return evaluateSmartPlaylist(parseSmartRules(pl.rules), tracks, memb, Date.now())
                    .map(t => t.track_key)
                    .filter((k): k is string => !!k);
            }
            const db = await getDb();
            const rows: any[] = await db.select(
                `SELECT t.track_key
                 FROM tracks t
                 JOIN playlist_tracks pt ON t.id = pt.track_id
                 WHERE pt.playlist_id = $1 AND t.track_key IS NOT NULL
                 ORDER BY ${playlistOrderBy({ type: pl.type, manual_order: pl.manual_order })}`,
                [pl.id]
            );
            return rows.map(r => r.track_key as string);
        },
    };
}
