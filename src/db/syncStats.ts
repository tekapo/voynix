import { getDb } from "./core";
import { batchExecute } from "./batch";
import { applyAlbumCovers, applyArtistCovers } from "./covers";
import { mergeLww } from "../lib/lww";
import { ManifestTrack } from "../sync";
import { IncomingStats, PlayState, SyncSnapshot } from "../types";

export async function getLocalPlayEvents(deviceId: string) {
    const db = await getDb();
    return db.select<{ track_key: string; played_at: number }[]>(
        "SELECT track_key, played_at FROM play_events WHERE device_id = $1",
        [deviceId]
    );
}

export async function getLocalFavorites() {
    const db = await getDb();
    return db.select<{ track_key: string; favorite: number; updated_at: number }[]>(
        "SELECT track_key, favorite, favorite_updated_at AS updated_at FROM tracks WHERE favorite_updated_at IS NOT NULL AND track_key IS NOT NULL"
    );
}

// Not filtered by kind='podcast': kind is itself an independently LWW-synced
// field, so the two devices can transiently disagree about it — a field's
// propagation must not depend on another LWW field's current value. In
// practice a stamp only ever appears on a podcast row (setTrackPlayState's
// callers all guard on kind), and a stale stamp on a reclassified row is inert
// since the UI only reads play_state under a podcast guard.
export async function getLocalPlayStates() {
    const db = await getDb();
    return db.select<{ track_key: string; play_state: PlayState; resume_position: number; updated_at: number }[]>(
        "SELECT track_key, play_state, resume_position, play_state_updated_at AS updated_at FROM tracks WHERE play_state_updated_at IS NOT NULL AND track_key IS NOT NULL"
    );
}

interface PlayEventRow { track_key: string; played_at: number; device_id: string }
interface FavoriteRow { track_key: string; favorite: number; favorite_updated_at: number }
interface PlayStateRow { track_key: string; play_state: PlayState; resume_position: number; play_state_updated_at: number }

/** Batched grow-only insert of play events (dedup is INSERT OR IGNORE against idx_play_events_dedup). */
export async function insertPlayEventsBatch(rows: PlayEventRow[], onChunk?: (done: number, total: number) => void) {
    const db = await getDb();
    await batchExecute(db, {
        rows,
        cols: 4,
        perChunk: 200, // 200 * 4 = 800 params
        toParams: e => [crypto.randomUUID(), e.track_key, e.played_at, e.device_id],
        sql: tuples => `INSERT OR IGNORE INTO play_events (id, track_key, played_at, device_id) VALUES ${tuples}`,
        onChunk,
    });
}

/**
 * Batched LWW favorite merge. `UPDATE ... FROM` is a join: the guard predicate
 * is evaluated per (target row, VALUES row) pair, so each target row is still
 * gated on its own `favorite_updated_at` exactly as the serial per-row
 * statement was — batching does not weaken the LWW guard.
 */
export async function applyFavoritesBatch(rows: FavoriteRow[], onChunk?: (done: number, total: number) => void) {
    const db = await getDb();
    // Dedup can shrink the row count (duplicate track_keys collapse to one) —
    // report progress against the caller's original total, not the deduped one.
    const deduped = dedupeByKeyKeepMax(rows, r => r.track_key, r => r.favorite_updated_at);
    await batchExecute(db, {
        rows: deduped,
        cols: 3,
        perChunk: 300, // 300 * 3 = 900 params
        toParams: r => [r.track_key, r.favorite, r.favorite_updated_at],
        sql: tuples => `
            UPDATE tracks SET favorite = v.column2, favorite_updated_at = v.column3
            FROM (VALUES ${tuples}) AS v
            WHERE tracks.track_key = v.column1
              AND (tracks.favorite_updated_at IS NULL OR tracks.favorite_updated_at < v.column3)`,
        onChunk: onChunk && ((done) => onChunk(done, rows.length)),
    });
}

/** Batched LWW play_state/resume_position merge — see applyFavoritesBatch for the guard-under-join argument. */
export async function applyPlayStatesBatch(rows: PlayStateRow[], onChunk?: (done: number, total: number) => void) {
    const db = await getDb();
    const deduped = dedupeByKeyKeepMax(rows, r => r.track_key, r => r.play_state_updated_at);
    return batchExecute(db, {
        rows: deduped,
        cols: 4,
        perChunk: 200, // 200 * 4 = 800 params
        toParams: r => [r.track_key, r.play_state, r.resume_position, r.play_state_updated_at],
        sql: tuples => `
            UPDATE tracks SET play_state = v.column2, resume_position = v.column3, play_state_updated_at = v.column4
            FROM (VALUES ${tuples}) AS v
            WHERE tracks.track_key = v.column1
              AND (tracks.play_state_updated_at IS NULL OR tracks.play_state_updated_at < v.column4)`,
        onChunk: onChunk && ((done) => onChunk(done, rows.length)),
    });
}

/**
 * Dedupes `rows` by key, keeping the row with the max timestamp — provably
 * equivalent to serial application in any order, since the LWW guards are a
 * strict `<`. Guards against `UPDATE ... FROM` matching an arbitrary VALUES
 * row when a chunk has a duplicate join key (chunking itself is now
 * `batchExecute`'s job — see applyFavoritesBatch/applyPlayStatesBatch).
 */
function dedupeByKeyKeepMax<T>(rows: T[], key: (r: T) => string, ts: (r: T) => number): T[] {
    return mergeLww([], rows, key, ts);
}

/**
 * Apply the peer's play events, favorite states and podcast progress carried
 * in its manifest. The merge semantics (grow-only events, LWW favorites/play
 * state) and their convergence properties are spec'd and tested DB-free in
 * statsMerge.ts.
 */
export async function applyManifestStats(
    manifest: SyncSnapshot,
    myDeviceId: string,
    onChunk?: (done: number, total: number) => void
) {
    const events = manifest.play_events.filter(e => e.device_id !== myDeviceId);
    const favorites = manifest.tracks
        .filter((t): t is ManifestTrack & { favorite_updated_at: number } => t.favorite_updated_at != null)
        .map(t => ({ track_key: t.track_key, favorite: t.favorite, favorite_updated_at: t.favorite_updated_at }));
    const playStates = manifest.tracks
        .filter((t): t is ManifestTrack & { play_state_updated_at: number } => t.play_state_updated_at != null)
        .map(t => ({
            track_key: t.track_key, play_state: t.play_state,
            resume_position: t.resume_position, play_state_updated_at: t.play_state_updated_at,
        }));
    const covers = manifest.album_covers ?? [];
    const artistCovers = manifest.artist_covers ?? [];
    const total = events.length + favorites.length + playStates.length + covers.length + artistCovers.length;
    let base = 0;

    await insertPlayEventsBatch(events, subDone => onChunk?.(base + subDone, total));
    base += events.length;
    await applyFavoritesBatch(favorites, subDone => onChunk?.(base + subDone, total));
    base += favorites.length;
    await applyPlayStatesBatch(playStates, subDone => onChunk?.(base + subDone, total));
    base += playStates.length;
    if (covers.length) await applyAlbumCovers(covers, subDone => onChunk?.(base + subDone, total));
    base += covers.length;
    if (artistCovers.length) await applyArtistCovers(artistCovers, subDone => onChunk?.(base + subDone, total));
}

export interface InboxApplyResult {
    /** play_states rows received / rows whose UPDATE matched a Mac track (received > 0 && applied === 0 means no track_key matched). */
    play_states_received: number;
    play_states_applied: number;
    /** Items that threw part-way; every write is idempotent (OR IGNORE / LWW-guarded), so re-applying one whole is safe. */
    failed: IncomingStats[];
}

/**
 * Merge play/favorite/podcast-progress updates received from a paired device.
 * A failure in one item doesn't stop the rest; failed items are returned so the
 * caller can requeue them rather than losing the push.
 */
export async function applySyncInbox(items: IncomingStats[]): Promise<InboxApplyResult> {
    const result: InboxApplyResult = { play_states_received: 0, play_states_applied: 0, failed: [] };
    for (const item of items) {
        try {
            // Per-item batches: one item's failure is still isolated and requeued whole.
            await insertPlayEventsBatch((item.events ?? []).map(ev => ({ ...ev, device_id: item.device_id })));
            await applyFavoritesBatch(
                (item.favorites ?? []).map(f => ({
                    track_key: f.track_key, favorite: f.favorite, favorite_updated_at: f.updated_at,
                }))
            );
            const playStates = item.play_states ?? [];
            result.play_states_received += playStates.length;
            result.play_states_applied += await applyPlayStatesBatch(
                playStates.map(ps => ({
                    track_key: ps.track_key, play_state: ps.play_state,
                    resume_position: ps.resume_position, play_state_updated_at: ps.updated_at,
                }))
            );
        } catch (e) {
            console.error("applySyncInbox: item failed, will retry:", e);
            result.failed.push(item);
        }
    }
    return result;
}
