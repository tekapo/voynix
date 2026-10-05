import { BatchOpts, getDb } from "./core";
import { chunk } from "../sync";
import { TRACK_COLUMNS_WITH_STATS } from "./tracks";
import { Playlist, SmartRules, Track, TrackKind } from "../types";
import { parseSmartRules, serializeSmartRules } from "../smartPlaylist";

// The view's "natural order": artist, then album, then disc/track order, with
// un-numbered tracks falling to the end of their album and blank artist/album
// falling to the end. Shared by the library view (getPlaylists) and the sync
// snapshot so a paired device mirrors the same order. `t` must be the alias for
// the `tracks` table in the query. Keep the key sequence in step with
// NATURAL_KEYS / compareNatural in trackSort.ts (the DB-free views use that).
const NATURAL_ORDER = `
  COALESCE(NULLIF(TRIM(t.artist), ''), '~~~') COLLATE NOCASE,
  COALESCE(NULLIF(TRIM(t.album), ''), '~~~') COLLATE NOCASE,
  COALESCE(t.disc_no, 1),
  COALESCE(t.track_no, 999999),
  t.title COLLATE NOCASE
`;

// Single source of truth for how a playlist's tracks are ordered, shared by
// getPlaylists (what the app shows) and buildSyncSnapshot (what a paired
// device receives as track_keys order) — they must never disagree, or Mac and
// Android show a playlist in different orders. A freshly-scanned folder
// playlist has no meaningful manual order, so it renders in NATURAL_ORDER
// (artist/album/disc/track) until the user drags it into a custom order
// (manual_order = 1, set by setPlaylistTrackOrder), at which point — like any
// non-folder playlist — it renders by the stored `position`.
export function playlistOrderBy(pl: { type: string; manual_order?: number }): string {
    return (pl.manual_order || pl.type !== 'folder')
        ? `pt.position ASC`
        : `${NATURAL_ORDER}, pt.position ASC`;
}

export async function getPlaylists(): Promise<Playlist[]> {
    const db = await getDb();
    const playlists: any[] = await db.select("SELECT * FROM playlists");
    if (playlists.length === 0) return [];

    // playlistOrderBy only ever returns one of two ORDER BY clauses (manual/
    // position vs. natural-order-then-position), so group playlists by that
    // clause and fetch each group's tracks in one query instead of one query
    // per playlist — avoids an N+1 IPC/SQLite round trip for N playlists.
    const groups = new Map<string, any[]>();
    for (const pl of playlists) {
        const orderBy = playlistOrderBy(pl);
        const group = groups.get(orderBy);
        if (group) group.push(pl);
        else groups.set(orderBy, [pl]);
    }

    const tracksByPlaylist = new Map<string, Track[]>();
    for (const [orderBy, group] of groups) {
        const placeholders = group.map((_, i) => `$${i + 1}`).join(", ");
        // XML imports keep the order the playlist file gave (iTunes ordering
        // is intentional); mirrors keep position too, since the Mac already
        // sorted them before sending. Folder scans default to natural album
        // order but fall back to position once the user drags them into a
        // manual order — see playlistOrderBy.
        const rows: any[] = await db.select(`
      SELECT ${TRACK_COLUMNS_WITH_STATS}, pt.playlist_id AS __playlist_id
      FROM tracks t
      JOIN playlist_tracks pt ON t.id = pt.track_id
      WHERE pt.playlist_id IN (${placeholders})
      ORDER BY pt.playlist_id, ${orderBy}
    `, group.map((pl) => pl.id));

        for (const { __playlist_id, ...track } of rows) {
            const arr = tracksByPlaylist.get(__playlist_id);
            if (arr) arr.push(track as Track);
            else tracksByPlaylist.set(__playlist_id, [track as Track]);
        }
    }

    return playlists.map((pl) => ({
        id: pl.id,
        name: pl.name,
        type: pl.type as any,
        sync_to_device: pl.sync_to_device ?? 0,
        kind: (pl.kind ?? 'music') as TrackKind,
        manual_order: pl.manual_order ?? 0,
        // Only meaningful for type === 'smart'; every other type's rules
        // column is NULL, and parseSmartRules(null) is harmless (the default
        // rule set is never read for a non-smart playlist).
        rules: pl.type === 'smart' ? parseSmartRules(pl.rules) : undefined,
        // A smart playlist has no playlist_tracks rows — its membership is
        // evaluated live from `rules` (see evaluateSmartPlaylist in App.tsx),
        // not stored here.
        tracks: tracksByPlaylist.get(pl.id) ?? [],
    }));
}

export async function createPlaylist(name: string, type: 'folder' | 'xml' | 'custom', id?: string): Promise<Playlist> {
    const db = await getDb();
    id ??= crypto.randomUUID();
    await db.execute("INSERT INTO playlists (id, name, type) VALUES ($1, $2, $3)", [id, name, type]);
    return { id, name, type, tracks: [] };
}

export async function createSmartPlaylist(name: string, rules: SmartRules, id?: string): Promise<Playlist> {
    const db = await getDb();
    id ??= crypto.randomUUID();
    await db.execute(
        "INSERT INTO playlists (id, name, type, rules) VALUES ($1, $2, 'smart', $3)",
        [id, name, serializeSmartRules(rules)]
    );
    return { id, name, type: 'smart', tracks: [], rules };
}

export async function updateSmartPlaylist(id: string, name: string, rules: SmartRules) {
    const db = await getDb();
    await db.execute(
        "UPDATE playlists SET name = $1, rules = $2 WHERE id = $3",
        [name, serializeSmartRules(rules), id]
    );
}

export async function deletePlaylist(id: string) {
    const db = await getDb();
    await db.execute("DELETE FROM playlists WHERE id = $1", [id]);
    // FK cascade on playlist_tracks isn't enabled (no PRAGMA foreign_keys).
    await db.execute("DELETE FROM playlist_tracks WHERE playlist_id = $1", [id]);
    await deleteOrphanedTracks(db);
}

/** Batched form of deletePlaylist. */
export async function deletePlaylists(ids: string[], opts?: BatchOpts<string>) {
    if (ids.length === 0) return;
    const db = await getDb();
    const PER_CHUNK = 500;
    let done = 0;
    for (const part of chunk(ids, PER_CHUNK)) {
        const placeholders = part.map((_, j) => `$${j + 1}`).join(", ");
        try {
            await db.execute(`DELETE FROM playlists WHERE id IN (${placeholders})`, part);
            await db.execute(`DELETE FROM playlist_tracks WHERE playlist_id IN (${placeholders})`, part);
        } catch (e) {
            if (opts?.onError) {
                await opts.onError(part, e);
            } else {
                throw e;
            }
        }
        done += part.length;
        opts?.onChunk?.(done, ids.length);
    }
    await deleteOrphanedTracks(db);
}

// A track shared by no playlist any more (its only playlist(s) were just
// deleted) is gone from the user's library, not merely "not in a playlist
// right now". Without this, deleting a playlist/folder left orphaned rows in
// `tracks` forever, invisible in the playlist UI but still surfacing in
// library-wide views (All Songs / Artists / Albums), which read `tracks`
// directly rather than deriving from playlist_tracks membership.
async function deleteOrphanedTracks(db: Awaited<ReturnType<typeof getDb>>) {
    await db.execute(
        "DELETE FROM tracks WHERE id NOT IN (SELECT DISTINCT track_id FROM playlist_tracks)"
    );
}

// Same orphan condition as deleteOrphanedTracks, but scoped to one rescanned
// folder: a rescan's clearPlaylistTracks-then-re-add drops a since-deleted
// file's playlist link but not its `tracks` row (so a scan_music_dir failure,
// e.g. an unmounted cloud volume, can't wipe the library — see
// missing_folder_error in lib.rs). Call this after a *successful* rescan to
// prune the rows for files genuinely gone from that folder, without touching
// orphans elsewhere (another folder, or a deleted playlist not yet swept).
// substr(...) = $1 (not LIKE) so `%`/`_` in a real path can't be misread as
// wildcards.
export async function deleteOrphanedTracksUnder(folderPath: string) {
    const db = await getDb();
    const prefix = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    await db.execute(
        `DELETE FROM tracks
         WHERE id NOT IN (SELECT DISTINCT track_id FROM playlist_tracks)
           AND substr(file_path, 1, length($1)) = $1`,
        [prefix]
    );
}

export async function addTracksToPlaylist(playlistId: string, tracks: Track[], defaultKind: TrackKind = 'music') {
    const db = await getDb();

    for (const track of tracks) {
        // Ensure track exists in DB. favorite / lyrics / kind / play_state are
        // deliberately NOT in the DO UPDATE set — a rescan must not clobber what
        // the user set by hand. added_at is only set on INSERT (not in the DO
        // UPDATE SET) so a rescan of an already-known file keeps its original
        // "Recently Added" date instead of jumping to the top on every rescan.
        // genre/year/album_artist/composer and extra_tags_read DO update on a
        // rescan (unlike the user-editable fields above) — they're read fresh
        // from the file's tags every time, same as title/artist/album.
        await db.execute(`
          INSERT INTO tracks (id, title, artist, album, file_path, file_name, duration, lyrics, track_key, content_hash, kind, disc_no, track_no, added_at, genre, year, album_artist, composer, extra_tags_read)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          ON CONFLICT(file_path) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            album = excluded.album,
            duration = excluded.duration,
            track_key = excluded.track_key,
            content_hash = excluded.content_hash,
            disc_no = excluded.disc_no,
            track_no = excluded.track_no,
            genre = excluded.genre,
            year = excluded.year,
            album_artist = excluded.album_artist,
            composer = excluded.composer,
            extra_tags_read = excluded.extra_tags_read
        `, [
            track.id,
            track.title,
            track.artist || null,
            track.album || null,
            track.file_path,
            track.file_name,
            track.duration || null,
            track.lyrics || null,
            track.track_key || null,
            track.content_hash || null,
            track.kind || defaultKind,
            track.disc_no ?? null,
            track.track_no ?? null,
            Date.now(),
            track.genre || null,
            track.year ?? null,
            track.album_artist || null,
            track.composer || null,
            track.extra_tags_read ?? 0,
        ]);
    }

    await linkTracksToPlaylist(playlistId, tracks.map(t => t.id));
}

/**
 * Just the playlist_tracks half of addTracksToPlaylist, for a caller that
 * already has (or has separately resolved) existing `tracks` rows and only
 * needs to add membership — e.g. importPlaylists in db/backup.ts, which must
 * not touch an existing track's metadata. Appends after the playlist's
 * current max position; a trackId already linked is left alone (no-op via
 * INSERT OR IGNORE, since (playlist_id, track_id) is the primary key).
 */
export async function linkTracksToPlaylist(playlistId: string, trackIds: string[]) {
    if (trackIds.length === 0) return;
    const db = await getDb();
    const result: any[] = await db.select("SELECT MAX(position) as max_pos FROM playlist_tracks WHERE playlist_id = $1", [playlistId]);
    let currentPos = (result[0].max_pos ?? -1) + 1;
    for (const trackId of trackIds) {
        await db.execute(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES ($1, $2, $3)",
            [playlistId, trackId, currentPos++]
        );
    }
}

export async function clearPlaylistTracks(playlistId: string) {
    const db = await getDb();
    await db.execute("DELETE FROM playlist_tracks WHERE playlist_id = $1", [playlistId]);
}

// Drag & drop reorder: rewrite `position` to match trackIds' order (0..n-1)
// and flip the playlist into manual_order mode, so getPlaylists/buildSyncSnapshot
// (via playlistOrderBy) stop overriding it with the natural album order.
export async function setPlaylistTrackOrder(playlistId: string, trackIds: string[]) {
    const db = await getDb();
    for (let i = 0; i < trackIds.length; i++) {
        await db.execute(
            "UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND track_id = $3",
            [i, playlistId, trackIds[i]]
        );
    }
    await db.execute("UPDATE playlists SET manual_order = 1 WHERE id = $1", [playlistId]);
}

// Drops back to the playlist's default order (natural album order for a
// folder playlist, otherwise still `position`). Leaves `position` values as
// they are — only the flag that makes playlistOrderBy ignore them changes.
export async function resetPlaylistManualOrder(playlistId: string) {
    const db = await getDb();
    await db.execute("UPDATE playlists SET manual_order = 0 WHERE id = $1", [playlistId]);
}

// file_path -> position snapshot, taken right before a rescan clears and
// re-inserts a folder playlist's rows, so a manually-ordered playlist can be
// restored afterwards (see rescanFolder in App.tsx).
export async function getPlaylistTrackPositions(playlistId: string): Promise<Map<string, number>> {
    const db = await getDb();
    const rows: any[] = await db.select(
        `SELECT t.file_path AS file_path, pt.position AS position
         FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = $1`,
        [playlistId]
    );
    return new Map(rows.map(r => [r.file_path as string, r.position as number]));
}

// file_path -> track id, for a caller (backup import — see db/backup.ts /
// useBackup.ts) that has a desired file_path order to restore but only
// discovers track ids once the folder has actually been scanned.
export async function getPlaylistTrackIdsByPath(playlistId: string): Promise<Map<string, string>> {
    const db = await getDb();
    const rows: any[] = await db.select(
        `SELECT t.file_path AS file_path, t.id AS id
         FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = $1`,
        [playlistId]
    );
    return new Map(rows.map(r => [r.file_path as string, r.id as string]));
}
