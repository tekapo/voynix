import { getDb } from "./core";
import { createPlaylistKeyResolver } from "./playlistKeys";

/** What the Rust Echo server (remote.rs) is handed: every playlist (smart ones
 *  already evaluated) and the files of the tracks they reference, snake_case
 *  like the sync snapshot. Echo plays whole playlists by name, so nothing else
 *  about a track is needed. A track key can have several files (the same
 *  recording at two paths, one maybe on an unmounted drive), so every path is
 *  sent and the server serves the first that exists. */
export interface RemoteLibrary {
    playlists: { name: string; track_keys: string[] }[];
    tracks: { track_key: string; file_paths: string[] }[];
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

    // Only tracks some playlist references, every file of each.
    const trackRows: any[] = await db.select(
        "SELECT track_key, file_path FROM tracks WHERE track_key IS NOT NULL ORDER BY id"
    );
    const paths = new Map<string, string[]>();
    for (const t of trackRows) {
        if (!wanted.has(t.track_key)) continue;
        const list = paths.get(t.track_key);
        if (list) list.push(t.file_path);
        else paths.set(t.track_key, [t.file_path]);
    }
    const tracks: RemoteLibrary["tracks"] = [...paths].map(([track_key, file_paths]) => ({ track_key, file_paths }));
    return { playlists, tracks };
}
