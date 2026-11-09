import { invoke } from "@tauri-apps/api/core";
import { pool } from "../sync";

/** One album to resolve a cover for: a representative track's path plus up to
 *  20 sibling paths (any of them may be the one with an embedded cover). */
export interface AlbumRep {
    artist: string;
    album: string;
    path: string;
    extra: string[];
    /** False for a folder-derived album name — searching iTunes for it would
     *  likely match an unrelated release rather than leave the cover blank. */
    lookupOnline: boolean;
}

const MAX_EXTRA_PATHS = 20;

/** Group tracks into one `AlbumRep` per distinct key (first track is the
 *  representative; later ones fill `extra`). */
export function buildAlbumReps<T extends { file_path: string }>(
    tracks: T[],
    describe: (t: T) => { key: string; artist: string; album: string; lookupOnline: boolean },
): AlbumRep[] {
    const reps = new Map<string, AlbumRep>();
    for (const t of tracks) {
        const { key, artist, album, lookupOnline } = describe(t);
        const rep = reps.get(key);
        if (!rep) {
            reps.set(key, { artist, album, path: t.file_path, extra: [], lookupOnline });
        } else if (rep.extra.length < MAX_EXTRA_PATHS) {
            rep.extra.push(t.file_path);
        }
    }
    return [...reps.values()];
}

/** Make sure each album's cover is in the Rust `artwork/` cache (embedded tag,
 *  else iTunes). `ensure_album_art` returns early for a cached cover or a
 *  fresh `.miss`, so re-running over a known library makes no requests.
 *  `onResolved` fires after each album that ended up with a cover. */
export async function ensureAlbumArts(
    reps: AlbumRep[],
    opts: { concurrency: number; isCancelled?: () => boolean; onResolved?: () => void },
): Promise<void> {
    await pool(reps, opts.concurrency, async (rep) => {
        if (opts.isCancelled?.()) return;
        try {
            const found = await invoke<boolean>("ensure_album_art", {
                artist: rep.artist, album: rep.album, path: rep.path, extraPaths: rep.extra,
                lookupOnline: rep.lookupOnline,
            });
            if (found) opts.onResolved?.();
        } catch (e) {
            console.warn(`ensure_album_art failed for ${rep.artist} / ${rep.album}:`, e);
        }
    });
}
