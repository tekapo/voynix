import { invoke } from "@tauri-apps/api/core";
import { getDb } from "./core";
import { getDeviceId } from "./settings";
import { loadHashCache, saveHashCache } from "./hashCache";
import { chunk } from "../sync";
import { HashCacheEntry, PlayState, Track, TrackKind } from "../types";

// play_count / last_played are derived from the append-only play_events log,
// joined on track_key. idx_play_events_key covers both.
export const TRACK_COLUMNS_WITH_STATS = `
  t.*,
  (SELECT COUNT(*) FROM play_events pe WHERE pe.track_key = t.track_key) AS play_count,
  (SELECT MAX(played_at) FROM play_events pe WHERE pe.track_key = t.track_key) AS last_played
`;

export async function getAllTracks(): Promise<Track[]> {
    const db = await getDb();
    return await db.select(`SELECT ${TRACK_COLUMNS_WITH_STATS} FROM tracks t`);
}

/**
 * Fill in disc_no / track_no for tracks scanned before migration 5 added those
 * columns — without it NATURAL_ORDER can only fall back to title order within an
 * album. Reads the numbers straight from each file's tags (Rust), so it's a
 * one-time catch-up that needs no full rescan. Missing files and cloud
 * placeholders are left NULL and retried on the next launch.
 * Returns the number of rows updated.
 */
export async function backfillTrackNumbers(): Promise<number> {
    const db = await getDb();
    const rows: { id: string; file_path: string }[] = await db.select(
        "SELECT id, file_path FROM tracks WHERE disc_no IS NULL AND track_no IS NULL"
    );
    if (rows.length === 0) return 0;

    const found = await invoke<{ file_path: string; disc_no: number | null; track_no: number | null }[]>(
        "read_track_numbers",
        { paths: rows.map(r => r.file_path) }
    );
    const idByPath = new Map(rows.map(r => [r.file_path, r.id]));

    let updated = 0;
    for (const { file_path, disc_no, track_no } of found) {
        const id = idByPath.get(file_path);
        if (!id) continue;
        await db.execute("UPDATE tracks SET disc_no = $1, track_no = $2 WHERE id = $3", [
            disc_no ?? null,
            track_no ?? null,
            id,
        ]);
        updated += 1;
    }
    return updated;
}

/**
 * Fill in genre / year / album_artist / composer for tracks scanned before
 * migration 12 added those columns (or a cloud placeholder that wasn't
 * downloaded yet at scan time). `extra_tags_read` tells rows already covered
 * apart from ones still needing a read — without it a track with genuinely no
 * genre tag would be retried forever. Sent in chunks like
 * backfillTrackIdentities, since this is real file I/O across the library.
 * Missing files and cloud placeholders are left as-is and retried on the next
 * launch. Returns the number of rows updated.
 */
export async function backfillExtraTags(chunkSize = 200): Promise<number> {
    const db = await getDb();
    const rows: { id: string; file_path: string }[] = await db.select(
        "SELECT id, file_path FROM tracks WHERE extra_tags_read = 0"
    );
    if (rows.length === 0) return 0;
    const idByPath = new Map(rows.map(r => [r.file_path, r.id]));

    let updated = 0;
    for (const chunkRows of chunk(rows, chunkSize)) {
        const found = await invoke<{
            file_path: string;
            genre: string | null;
            year: number | null;
            album_artist: string | null;
            composer: string | null;
        }[]>("read_extra_tags", { paths: chunkRows.map(r => r.file_path) });

        for (const { file_path, genre, year, album_artist, composer } of found) {
            const id = idByPath.get(file_path);
            if (!id) continue;
            await db.execute(
                "UPDATE tracks SET genre = $1, year = $2, album_artist = $3, composer = $4, extra_tags_read = 1 WHERE id = $5",
                [genre ?? null, year ?? null, album_artist ?? null, composer ?? null, id]
            );
            updated += 1;
        }
    }
    return updated;
}

/**
 * Fill in track_key / content_hash for tracks scanned before those
 * columns existed (and for rows a rescan hasn't revisited since) — without a
 * key a track is invisible to sync (buildSyncSnapshot filters
 * `WHERE track_key IS NOT NULL`) and its play events / favorites can't
 * round-trip to a paired device. Reads identity straight from each file's
 * tags + bytes (Rust), so it's a catch-up that needs no full rescan. Sent in
 * chunks so one IPC call doesn't have to do hundreds of MB of file I/O at
 * once. Missing files and cloud placeholders are left as-is and retried on
 * the next launch; `ensureTrackKey()` in App.tsx covers them lazily on play
 * in the meantime. Returns the number of rows updated.
 */
export async function backfillTrackIdentities(chunkSize = 200): Promise<number> {
    const db = await getDb();
    const rows: { id: string; file_path: string }[] = await db.select(
        "SELECT id, file_path FROM tracks WHERE track_key IS NULL OR track_key = '' OR content_hash IS NULL OR content_hash = ''"
    );
    if (rows.length === 0) return 0;

    const idByPath = new Map(rows.map(r => [r.file_path, r.id]));
    const hashCache = await loadHashCache();
    let updated = 0;
    const freshCache: HashCacheEntry[] = [];

    for (const rowChunk of chunk(rows, chunkSize)) {
        const batch = await invoke<{
            rows: { file_path: string; track_key: string; content_hash: string }[];
            hash_cache: HashCacheEntry[];
        }>("compute_track_identities", { paths: rowChunk.map(r => r.file_path), hashCache });

        for (const { file_path, track_key, content_hash } of batch.rows) {
            const id = idByPath.get(file_path);
            if (!id) continue;
            await setTrackIdentity(id, track_key, content_hash);
            updated += 1;
        }
        freshCache.push(...batch.hash_cache);
    }

    await saveHashCache(freshCache);
    return updated;
}

/** Record a play. Counts once the listener passed the 30s / 50% threshold (caller decides). */
export async function recordPlayEvent(trackKey: string) {
    const db = await getDb();
    await db.execute(
        "INSERT INTO play_events (id, track_key, played_at, device_id) VALUES ($1, $2, $3, $4)",
        [crypto.randomUUID(), trackKey, Date.now(), await getDeviceId()]
    );
}

export async function setTrackFavorite(trackId: string, favorite: boolean) {
    const db = await getDb();
    await db.execute(
        "UPDATE tracks SET favorite = $1, favorite_updated_at = $2 WHERE id = $3",
        [favorite ? 1 : 0, Date.now(), trackId]
    );
}

/** Set a track's kind ('music' | 'podcast' | 'other'). LWW-stamped for sync. */
export async function setTrackKind(trackId: string, kind: TrackKind) {
    const db = await getDb();
    await db.execute(
        "UPDATE tracks SET kind = $1, kind_updated_at = $2 WHERE id = $3",
        [kind, Date.now(), trackId]
    );
}

/** Podcast playback status + resume position. LWW-stamped for sync (see getLocalPlayStates / applyManifestStats). */
export async function setTrackPlayState(trackId: string, state: PlayState, resume: number) {
    const db = await getDb();
    await db.execute(
        "UPDATE tracks SET play_state = $1, resume_position = $2, play_state_updated_at = $3 WHERE id = $4",
        [state, resume, Date.now(), trackId]
    );
}

/**
 * The DB's own view of a track's podcast status, read right before playback
 * starts. The `playlists` state (and any `Track` derived from it) can be stale:
 * the 5s-throttled resume-position writes in App.tsx update the DB and the
 * playing track's local state only, deliberately skipping a full library
 * refresh — so a list row's `resume_position` may lag behind what's actually
 * saved. Returns null if the track no longer exists.
 */
export async function getTrackPlayState(
    trackId: string,
): Promise<{ play_state: PlayState; resume_position: number; play_state_updated_at: number } | null> {
    const db = await getDb();
    const rows: any[] = await db.select(
        "SELECT play_state, resume_position, play_state_updated_at FROM tracks WHERE id = $1",
        [trackId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
        play_state: (row.play_state ?? 'unplayed') as PlayState,
        resume_position: row.resume_position ?? 0,
        play_state_updated_at: row.play_state_updated_at ?? 0,
    };
}

/** Set a playlist's kind and reclassify every track currently in it. */
export async function setPlaylistKind(playlistId: string, kind: TrackKind) {
    const db = await getDb();
    await db.execute(
        "UPDATE playlists SET kind = $1 WHERE id = $2",
        [kind, playlistId]
    );
    await db.execute(
        `UPDATE tracks SET kind = $1, kind_updated_at = $2
         WHERE id IN (SELECT track_id FROM playlist_tracks WHERE playlist_id = $3)`,
        [kind, Date.now(), playlistId]
    );
}

/** Re-apply a non-default playlist kind to its tracks (e.g. after a rescan added new ones). */
export async function reapplyPlaylistKind(playlistId: string) {
    const db = await getDb();
    const rows: any[] = await db.select("SELECT kind FROM playlists WHERE id = $1", [playlistId]);
    const kind = (rows[0]?.kind ?? 'music') as TrackKind;
    if (kind === 'music') return;
    await setPlaylistKind(playlistId, kind);
}

/** Change a scan folder's default kind and reclassify the tracks already under it. */
export async function setFolderDefaultKind(path: string, kind: TrackKind) {
    const db = await getDb();
    await db.execute(
        "UPDATE scan_folders SET default_kind = $1 WHERE path = $2",
        [kind, path]
    );
    await db.execute(
        "UPDATE tracks SET kind = $1, kind_updated_at = $2 WHERE file_path = $3 OR file_path LIKE $4 ESCAPE '\\'",
        [kind, Date.now(), path, path.replace(/[%_\\]/g, "\\$&") + "/%"]
    );
}

/** Backfill identity for tracks scanned before identity columns existed (track_key still NULL). */
export async function setTrackIdentity(trackId: string, trackKey: string, contentHash: string) {
    const db = await getDb();
    await db.execute(
        "UPDATE tracks SET track_key = $1, content_hash = $2 WHERE id = $3",
        [trackKey, contentHash, trackId]
    );
}

export async function updateLyrics(trackId: string, lyrics: string) {
    const db = await getDb();
    await db.execute("UPDATE tracks SET lyrics = $1 WHERE id = $2", [lyrics, trackId]);
}

/** Fields the "Get Info…" dialog can edit; mirrors Rust's `TagEdit`. */
export interface TrackTagEdit {
    title: string;
    artist: string;
    album: string;
    disc_no: number | null;
    track_no: number | null;
}

/**
 * Apply an edited title/artist/album/disc/track back onto the DB row after
 * `write_track_tags` has already rewritten the file. `track_key` is derived
 * from those tags, so it changes too — carry `play_events` over to the new
 * key so play count / last played survive the edit, unless another track row
 * still shares the old key (a duplicate file), in which case that row still
 * needs the history and moving it would steal it.
 */
export async function updateTrackTags(
    trackId: string,
    oldTrackKey: string | null | undefined,
    edit: TrackTagEdit,
    newTrackKey: string,
    newContentHash: string
) {
    const db = await getDb();
    await db.execute(
        "UPDATE tracks SET title = $1, artist = $2, album = $3, disc_no = $4, track_no = $5, track_key = $6, content_hash = $7 WHERE id = $8",
        [
            edit.title,
            edit.artist || null,
            edit.album || null,
            edit.disc_no,
            edit.track_no,
            newTrackKey,
            newContentHash,
            trackId,
        ]
    );

    if (oldTrackKey && oldTrackKey !== newTrackKey) {
        const dupes: { n: number }[] = await db.select(
            "SELECT COUNT(*) AS n FROM tracks WHERE track_key = $1 AND id <> $2",
            [oldTrackKey, trackId]
        );
        if ((dupes[0]?.n ?? 0) === 0) {
            await db.execute(
                "UPDATE play_events SET track_key = $1 WHERE track_key = $2",
                [newTrackKey, oldTrackKey]
            );
        }
    }
}
