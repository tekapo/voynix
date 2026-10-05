// Pure helpers the Mac still uses: chunk/pool for the batched SQL writers and
// the album-art fan-out, and the last-write-wins merge algebra that pairs with
// android-native's logic/StatsMerge.kt. No DB or network here so it can be
// unit-tested directly.
//
// The Android (client) side of sync — diffing, reconcile, peer self-healing —
// lives in android-native (logic/Sync.kt, sync/SyncEngine.kt).

import { lwwPick } from "./lib/lww";
import { PlayState, SyncSnapshot } from "./types";

export type ManifestTrack = SyncSnapshot["tracks"][number];

/** Run `worker` over `items` with at most `limit` promises in flight at once. */
export async function pool<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>
): Promise<void> {
    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) {
            const i = next++;
            await worker(items[i], i);
        }
    });
    await Promise.all(runners);
}

/** Split `items` into chunks of at most `size` (last chunk may be smaller). */
export function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

interface FavoriteState {
    favorite: number;
    favorite_updated_at: number | null;
}

/** Last-write-wins by timestamp; a null timestamp is treated as oldest. */
export function favoriteWins(local: FavoriteState, remote: FavoriteState): FavoriteState {
    return lwwPick(local, remote, (v) => v.favorite_updated_at);
}

/**
 * `play_state` + `resume_position` share one `play_state_updated_at` and are
 * merged as a single atomic unit — the two fields are mutually constraining
 * (`play_state === 'played'` implies `resume_position === 0`), so an
 * independent-timestamp merge could produce an incoherent pair.
 */
export interface PlayStateFields {
    play_state: PlayState;
    resume_position: number;
    play_state_updated_at: number | null;
}

/** Last-write-wins by timestamp; a null timestamp is treated as oldest. */
export function playStateWins(local: PlayStateFields, remote: PlayStateFields): PlayStateFields {
    return lwwPick(local, remote, (v) => v.play_state_updated_at);
}
