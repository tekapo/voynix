// Executable spec for the bidirectional stats merge (play counts + favorites +
// podcast play state).
//
// The shipping implementation is SQL in db.ts — `buildSyncSnapshot`,
// `applyManifestStats`, `applySyncInbox`, `getLocalPlayEvents`,
// `getLocalFavorites`, `getLocalPlayStates` — plus the server inbox in
// server.rs. The functions here mirror that SQL exactly but without a DB, so
// the convergence properties the design relies on can be unit-tested:
//
//   - play events are a grow-only set (a CRDT): the union of two logs, deduped
//     on (device_id, played_at, track_key) — the UNIQUE index migration 3 adds.
//   - favorites are last-write-wins by `favorite_updated_at` (strict `>`; a tie
//     keeps the incumbent, matching `WHERE favorite_updated_at < $2`).
//   - podcast play_state + resume_position are last-write-wins by
//     `play_state_updated_at`, merged as one atomic unit (same tie rule).
//
// Topology assumption: the Mac is the hub. Every phone syncs only with the Mac,
// so the Mac holds the union and a phone never needs to forward a third device's
// events. Peer-to-peer phone sync is out of scope.
//
// This models the SQL; it doesn't run it — anything that only lives in the
// SQL/schema itself (the UNIQUE-index dedup, the `< $2` LWW guards) isn't
// covered here.

import { mergeLww } from "./lib/lww";
import { favoriteWins, playStateWins } from "./sync";

export interface PlayEvent {
    track_key: string;
    played_at: number;
    device_id: string;
}

export interface FavoriteRow {
    track_key: string;
    favorite: number; // 0 | 1
    favorite_updated_at: number | null;
}

export interface PlayStateRow {
    track_key: string;
    play_state: "unplayed" | "in_progress" | "played";
    resume_position: number;
    play_state_updated_at: number | null;
}

export interface DeviceStats {
    id: string;
    /** Every play event this device knows about: its own plus merged peers'. */
    events: PlayEvent[];
    favorites: FavoriteRow[];
    play_states: PlayStateRow[];
}

const US = "␟"; // unit separator, same delimiter the track_key hash uses
const eventKey = (e: PlayEvent) => `${e.device_id}${US}${e.played_at}${US}${e.track_key}`;

/**
 * Union of two play-event logs, deduped on (device_id, played_at, track_key).
 * Mirrors the `INSERT OR IGNORE INTO play_events` loop against migration 3's
 * UNIQUE index. Grow-only and commutative: order of merges doesn't matter.
 */
export function mergeEvents(into: PlayEvent[], incoming: PlayEvent[]): PlayEvent[] {
    const seen = new Set(into.map(eventKey));
    const out = into.slice();
    for (const e of incoming) {
        const k = eventKey(e);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
    }
    return out;
}

/**
 * Play count for one track = number of distinct events for its key, matching
 * `SELECT COUNT(*) FROM play_events pe WHERE pe.track_key = t.track_key`.
 */
export function playCount(events: PlayEvent[], trackKey: string): number {
    return events.reduce((n, e) => (e.track_key === trackKey ? n + 1 : n), 0);
}

/**
 * Last-write-wins merge of favorite rows by track_key, matching
 * `UPDATE tracks SET favorite = $1, favorite_updated_at = $2
 *  WHERE track_key = $3 AND (favorite_updated_at IS NULL OR favorite_updated_at < $2)`.
 * Incoming rows with a null timestamp are ignored — `getLocalFavorites` and
 * `applyManifestStats` both skip those, so they never travel.
 */
export function mergeFavorites(into: FavoriteRow[], incoming: FavoriteRow[]): FavoriteRow[] {
    return mergeLww(into, incoming, r => r.track_key, r => r.favorite_updated_at, (cur, r) => {
        const win = favoriteWins(cur, r);
        return { track_key: r.track_key, favorite: win.favorite, favorite_updated_at: win.favorite_updated_at };
    });
}

/**
 * Last-write-wins merge of podcast play-state rows by track_key, matching
 * `UPDATE tracks SET play_state = $1, resume_position = $2, play_state_updated_at = $3
 *  WHERE track_key = $4 AND (play_state_updated_at IS NULL OR play_state_updated_at < $3)`.
 * state + resume_position are replaced together as one atomic unit — mirrors
 * mergeFavorites exactly, just with a two-field payload.
 */
export function mergePlayStates(into: PlayStateRow[], incoming: PlayStateRow[]): PlayStateRow[] {
    return mergeLww(into, incoming, r => r.track_key, r => r.play_state_updated_at, (cur, r) => {
        const win = playStateWins(cur, r);
        return {
            track_key: r.track_key,
            play_state: win.play_state as PlayStateRow["play_state"],
            resume_position: win.resume_position,
            play_state_updated_at: win.play_state_updated_at,
        };
    });
}

/**
 * One phone→Mac sync round trip:
 *
 *   1. phone fetches the Mac's manifest (all events the Mac knows + its favorites)
 *   2. phone pushes its *own* events and its favorites (taken before step 3)
 *   3. phone applies the manifest: peer events + LWW favorites
 *   4. the Mac later drains the push: union events + LWW favorites
 *
 * Pure — neither input is mutated; the updated pair is returned.
 */
export function syncRoundTrip(
    mac: DeviceStats,
    phone: DeviceStats
): { mac: DeviceStats; phone: DeviceStats } {
    // Step 2: what the phone sends, captured before it applies the manifest.
    const pushEvents = phone.events.filter(e => e.device_id === phone.id);
    const pushFavorites = phone.favorites;
    const pushPlayStates = phone.play_states;

    // Step 3: the phone reconciles against the manifest.
    const phoneNext: DeviceStats = {
        id: phone.id,
        events: mergeEvents(
            phone.events,
            mac.events.filter(e => e.device_id !== phone.id)
        ),
        favorites: mergeFavorites(phone.favorites, mac.favorites),
        play_states: mergePlayStates(phone.play_states, mac.play_states),
    };

    // Step 4: the Mac merges the phone's push.
    const macNext: DeviceStats = {
        id: mac.id,
        events: mergeEvents(mac.events, pushEvents),
        favorites: mergeFavorites(mac.favorites, pushFavorites),
        play_states: mergePlayStates(mac.play_states, pushPlayStates),
    };

    return { mac: macNext, phone: phoneNext };
}

/** Compare two devices' stats regardless of row/event order. */
export function sameStats(a: DeviceStats, b: DeviceStats): boolean {
    const evs = (d: DeviceStats) => d.events.map(eventKey).sort().join("|");
    const favs = (d: DeviceStats) =>
        d.favorites
            .filter(f => f.favorite_updated_at != null)
            .map(f => `${f.track_key}${US}${f.favorite}${US}${f.favorite_updated_at}`)
            .sort()
            .join("|");
    const plays = (d: DeviceStats) =>
        d.play_states
            .filter(p => p.play_state_updated_at != null)
            .map(p => `${p.track_key}${US}${p.play_state}${US}${p.resume_position}${US}${p.play_state_updated_at}`)
            .sort()
            .join("|");
    return evs(a) === evs(b) && favs(a) === favs(b) && plays(a) === plays(b);
}
