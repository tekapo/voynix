import { getDb } from "./core";
import { createPlaylistKeyResolver } from "./playlistKeys";

/** What the Rust Echo server (remote.rs) is handed: every playlist (smart ones
 *  already evaluated) and the files of the tracks they reference, snake_case
 *  like the sync snapshot. Echo plays whole playlists by name, so nothing else
 *  about a track is needed. */
export interface RemoteLibrary {
    playlists: { name: string; track_keys: string[] }[];
    tracks: { track_key: string; file_path: string }[];
}

export async function buildRemoteLibrary(): Promise<RemoteLibrary> {
    const db = await getDb();
    const resolver = createPlaylistKeyResolver();

    const playlistRows: any[] = await db.select(
        "SELECT id, name, type, kind, manual_order, rules FROM playlists ORDER BY name"
    );
    const playlists: RemoteLibrary["playlists"] = [];
    const wanted = new Set<string>();
    for (const pl of playlistRows) {
        const track_keys = await resolver.trackKeys(pl);
        track_keys.forEach(k => wanted.add(k));
        playlists.push({ name: pl.name, track_keys });
    }

    // Only tracks some playlist references, deduped by track_key (the same
    // recording can exist at two paths; the first one wins).
    const trackRows: any[] = await db.select(
        "SELECT track_key, file_path FROM tracks WHERE track_key IS NOT NULL"
    );
    const seen = new Set<string>();
    const tracks: RemoteLibrary["tracks"] = [];
    for (const t of trackRows) {
        if (!wanted.has(t.track_key) || seen.has(t.track_key)) continue;
        seen.add(t.track_key);
        tracks.push({ track_key: t.track_key, file_path: t.file_path });
    }
    return { playlists, tracks };
}
