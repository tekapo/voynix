// e2e for db.ts's stats sync surface, over two real SQLite databases (Mac +
// phone) — not the fakeDb mock used elsewhere (db.test.ts, App.test.tsx), and
// not statsMerge.ts's DB-free reimplementation of the merge algebra (already
// pinned by 22 cases in statsMerge.test.ts). What only a real DB can catch —
// and what this file is for — is anything that lives in the SQL/schema
// itself: the play_events UNIQUE(device_id, played_at, track_key) dedup index
// backing `INSERT OR IGNORE`, and the LWW guards' `< v.columnN` comparisons
// (each referenced twice in one UPDATE ... FROM statement). See
// statsMerge.ts's header comment for the full mapping.
//
// This replaces the pre-Tauri-Mobile-removal statsRoundTrip.test.ts, which
// drove the same real-DB harness (test/sqliteDevice.ts) through
// syncEngine.ts's runSync() — a Tauri-Mobile-only client that no longer
// exists (the client role moved to android-native's SyncEngine.kt, tested in
// Kotlin by SyncApiTest.kt/SyncTest.kt). What's exercised here is only the
// Mac-side surface that's still TypeScript: buildSyncSnapshot (what a peer
// receives), applyManifestStats (what a peer applies from a fetched
// manifest — mirrors android's SyncEngine reconcile step), and
// applySyncInbox (what the Mac applies from a peer's push — mirrors
// App.tsx's 3s take_sync_inbox poll at App.tsx:1357-1379). The pre-existing
// reconcile/download machinery (diffTracks, file transfer) is Android's now
// and stays covered on that side — the TS diffTracks/diffPlaylists twins and the
// mirror writers in the old db/mirror.ts were deleted outright once nothing
// called them; this file is scoped to the stats layer
// db.ts still owns on both platforms conceptually.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Device } from "./test/sqliteDevice";
import { createDevice, setActiveDevice } from "./test/sqliteDevice";

vi.mock("@tauri-apps/plugin-sql", () => ({
    default: { load: async () => (await import("./test/sqliteDevice")).activeAdapter() },
}));

const fsExists = vi.fn(async (..._a: unknown[]) => false);
const fsReadTextFile = vi.fn(async (..._a: unknown[]) => "[]");
vi.mock("@tauri-apps/plugin-fs", () => ({
    BaseDirectory: { AppLocalData: 1 },
    exists: (...a: unknown[]) => fsExists(...a),
    readTextFile: (...a: unknown[]) => fsReadTextFile(...a),
}));

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => invoke(...a) }));

import {
    _resetInitForTests,
    applyManifestStats,
    applySyncInbox,
    buildSyncSnapshot,
    getAllTracks,
    getDb,
    getDeviceId,
    getLocalFavorites,
    getLocalPlayEvents,
    getLocalPlayStates,
    initDb,
    recordPlayEvent,
    setTrackFavorite,
    setTrackPlayState,
} from "./db";
import type { IncomingStats } from "./types";

/** Point db.ts's module-level singleton at `d` and let its migrations settle
 * (a no-op past the first call, guarded by PRAGMA user_version) before running
 * `fn` against it. This is how one Node process plays both "devices". */
async function withDevice<T>(d: Device, fn: () => Promise<T>): Promise<T> {
    setActiveDevice(d);
    _resetInitForTests();
    await initDb();
    return fn();
}

async function seedTrack(
    dev: Device,
    opts: { trackKey: string; contentHash?: string; origin?: "local" | "mirror" }
): Promise<string> {
    return withDevice(dev, async () => {
        const db = await getDb();
        const id = `t-${opts.trackKey}-${dev.name}`;
        await db.execute(
            `INSERT INTO tracks (id, title, file_path, file_name, track_key, content_hash, origin)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, "Song", `/music/${dev.name}/${opts.trackKey}.mp3`, `${opts.trackKey}.mp3`,
                opts.trackKey, opts.contentHash ?? "same-bytes", opts.origin ?? "local"]
        );
        return id;
    });
}

/** Mac-only: put a track into a `sync_to_device` playlist — buildSyncSnapshot
 * only puts tracks in the manifest if they're reachable from such a playlist. */
async function seedMacPlaylist(mac: Device, trackIds: string[]) {
    return withDevice(mac, async () => {
        const db = await getDb();
        await db.execute(
            "INSERT INTO playlists (id, name, type, sync_to_device) VALUES ($1, $2, 'folder', 1)",
            ["pl-1", "Synced"]
        );
        let pos = 0;
        for (const id of trackIds) {
            await db.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ($1, $2, $3)",
                ["pl-1", id, pos++]
            );
        }
    });
}

describe("stats round-trip over real SQLite (両端末同時再生の収束)", () => {
    let mac: Device;
    let phone: Device;
    let phoneDeviceId: string;

    beforeEach(async () => {
        mac = createDevice("mac");
        phone = createDevice("phone");
        fsExists.mockReset();
        fsExists.mockImplementation(async () => false);
        fsReadTextFile.mockReset();
        fsReadTextFile.mockImplementation(async () => "[]");
        invoke.mockReset();
        // buildSyncSnapshot() (db.ts) asks Rust to prepare a playable path per
        // track (transcode/passthrough) and to ensure album art — best-effort
        // in both cases, but stub them so the console isn't full of the
        // caught-and-logged failures from the default `undefined` return.
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "prepare_sync_media") return [];
            if (cmd === "ensure_album_art") return null;
            return undefined;
        });

        // Same track_key + content_hash on both sides — this suite is about
        // the stats merge, not the file-download/reconcile path (covered by
        // android-native's SyncApiTest.kt / SyncTest.kt and the Rust server.rs
        // tests).
        const macTrackId = await seedTrack(mac, { trackKey: "k1" });
        await seedTrack(phone, { trackKey: "k1", origin: "mirror" });
        await seedMacPlaylist(mac, [macTrackId]);
        phoneDeviceId = await withDevice(phone, () => getDeviceId());
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** One sync round, replaying the two real hops that carry stats between
     * Mac and a peer:
     *  1. Mac -> peer: the peer fetches Mac's manifest and applies it
     *     (mirrors a client's reconcile step; on Android, SyncEngine.kt).
     *  2. Peer -> Mac: the peer pushes its own local stats, which the Mac
     *     applies from its inbox (mirrors App.tsx's take_sync_inbox poll,
     *     App.tsx:1357-1379).
     */
    async function syncRound() {
        const manifest = await withDevice(mac, () => buildSyncSnapshot());
        await withDevice(phone, () => applyManifestStats(manifest, phoneDeviceId));

        const payload: IncomingStats = await withDevice(phone, async () => ({
            device_id: phoneDeviceId,
            events: await getLocalPlayEvents(phoneDeviceId),
            favorites: await getLocalFavorites(),
            play_states: await getLocalPlayStates(),
        }));
        await withDevice(mac, () => applySyncInbox([payload]));
    }

    it("converges play counts when both devices play the same track before syncing", async () => {
        await withDevice(mac, () => recordPlayEvent("k1"));
        await withDevice(phone, () => recordPlayEvent("k1"));

        await syncRound();

        const macTracks = await withDevice(mac, () => getAllTracks());
        const phoneTracks = await withDevice(phone, () => getAllTracks());
        expect(macTracks.find(t => t.track_key === "k1")?.play_count).toBe(2);
        expect(phoneTracks.find(t => t.track_key === "k1")?.play_count).toBe(2);
    });

    it("dedups a resynced event against the play_events UNIQUE index, not just by row id", async () => {
        // This is exactly the case a fakeDb mock cannot exercise: two rows with
        // different `id`s (crypto.randomUUID()) but the same
        // (device_id, played_at, track_key) must collapse to one via `INSERT OR
        // IGNORE` hitting migration 3's idx_play_events_dedup.
        await withDevice(phone, () => recordPlayEvent("k1"));
        await syncRound();
        await syncRound(); // resend the same local event a second time

        const macTracks = await withDevice(mac, () => getAllTracks());
        const phoneTracks = await withDevice(phone, () => getAllTracks());
        expect(macTracks.find(t => t.track_key === "k1")?.play_count).toBe(1);
        expect(phoneTracks.find(t => t.track_key === "k1")?.play_count).toBe(1);
    });

    it("resolves a favorite conflict to the later write (phone wins)", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        await withDevice(mac, () => setTrackFavorite("t-k1-mac", true));
        vi.setSystemTime(2000);
        await withDevice(phone, () => setTrackFavorite("t-k1-phone", false));
        vi.useRealTimers();

        await syncRound();

        const macFav = (await withDevice(mac, () => getLocalFavorites())).find(f => f.track_key === "k1");
        const phoneFav = (await withDevice(phone, () => getLocalFavorites())).find(f => f.track_key === "k1");
        expect(macFav?.favorite).toBe(0);
        expect(phoneFav?.favorite).toBe(0);
    });

    it("resolves a favorite conflict to the later write (Mac wins)", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        await withDevice(phone, () => setTrackFavorite("t-k1-phone", false));
        vi.setSystemTime(2000);
        await withDevice(mac, () => setTrackFavorite("t-k1-mac", true));
        vi.useRealTimers();

        await syncRound();

        const macFav = (await withDevice(mac, () => getLocalFavorites())).find(f => f.track_key === "k1");
        const phoneFav = (await withDevice(phone, () => getLocalFavorites())).find(f => f.track_key === "k1");
        expect(macFav?.favorite).toBe(1);
        expect(phoneFav?.favorite).toBe(1);
    });

    it("resolves a play_state/resume_position conflict atomically to the later write", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        await withDevice(mac, () => setTrackPlayState("t-k1-mac", "in_progress", 30));
        vi.setSystemTime(2000);
        await withDevice(phone, () => setTrackPlayState("t-k1-phone", "played", 300));
        vi.useRealTimers();

        await syncRound();

        for (const dev of [mac, phone]) {
            const rows = await withDevice(dev, () => getLocalPlayStates());
            const row = rows.find(r => r.track_key === "k1");
            // state and position must move together — never an old position with
            // the new state or vice versa.
            expect(row?.play_state).toBe("played");
            expect(row?.resume_position).toBe(300);
        }
    });

    it("is idempotent: a second round with no new activity changes nothing", async () => {
        await withDevice(mac, () => recordPlayEvent("k1"));
        await withDevice(phone, () => recordPlayEvent("k1"));
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        await withDevice(phone, () => setTrackFavorite("t-k1-phone", true));
        vi.useRealTimers();
        await syncRound();

        const before = {
            mac: await withDevice(mac, () => getAllTracks()),
            phone: await withDevice(phone, () => getAllTracks()),
        };

        await syncRound(); // nothing new happened in between

        const after = {
            mac: await withDevice(mac, () => getAllTracks()),
            phone: await withDevice(phone, () => getAllTracks()),
        };
        expect(after.mac.find(t => t.track_key === "k1")?.play_count)
            .toBe(before.mac.find(t => t.track_key === "k1")?.play_count);
        expect(after.phone.find(t => t.track_key === "k1")?.play_count)
            .toBe(before.phone.find(t => t.track_key === "k1")?.play_count);
        expect(after.mac.find(t => t.track_key === "k1")?.favorite).toBe(1);
        expect(after.phone.find(t => t.track_key === "k1")?.favorite).toBe(1);
    });

    it("does not let the phone echo a third device's event back to the Mac", async () => {
        // Seed an event from device_c directly on the Mac (as if it arrived from
        // a third paired device), then have the phone sync. getLocalPlayEvents()
        // is filtered to the caller's own device_id (db.ts), so the phone's push
        // payload must not carry it — real-SQL counterpart of
        // statsMerge.test.ts's "does not echo a third device's events".
        await withDevice(mac, async () => {
            const db = await getDb();
            await db.execute(
                "INSERT INTO play_events (id, track_key, played_at, device_id) VALUES ($1, $2, $3, $4)",
                ["evt-c", "k1", 500, "device_c"]
            );
        });

        await syncRound();

        const macTracks = await withDevice(mac, () => getAllTracks());
        const phoneTracks = await withDevice(phone, () => getAllTracks());
        // The Mac's own copy is untouched (1 pre-existing event); the phone
        // picked it up via the manifest (applyManifestStats skips only its own
        // device_id), so both read 1 — but the phone's *push* must not have
        // reintroduced it (asserted structurally: another round changes nothing).
        expect(macTracks.find(t => t.track_key === "k1")?.play_count).toBe(1);
        expect(phoneTracks.find(t => t.track_key === "k1")?.play_count).toBe(1);
        await syncRound();
        expect((await withDevice(mac, () => getAllTracks())).find(t => t.track_key === "k1")?.play_count).toBe(1);
    });

    it("silently drops a favorite update for a track the receiving side hasn't seen (documented behaviour, not a bug)", async () => {
        // UPDATE ... WHERE track_key = ? is a no-op when the row doesn't exist —
        // there's no retry or watermark, so a favorite for a track the peer
        // doesn't have yet is simply lost. This locks in that this is the
        // current, deliberate behaviour (the sync_peers watermark columns are
        // unused) rather than silently regressing it further.
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        await withDevice(mac, async () => {
            const db = await getDb();
            await db.execute(
                "INSERT INTO tracks (id, title, file_path, file_name, track_key, content_hash, origin, favorite, favorite_updated_at) " +
                "VALUES ($1,$2,$3,$4,$5,$6,'local',1,$7)",
                ["t-unknown-mac", "Unknown", "/music/mac/unknown.mp3", "unknown.mp3", "unknown-key", "h", 1000]
            );
        });
        vi.useRealTimers();
        // "unknown-key" is not in any sync_to_device playlist, so it never
        // reaches the manifest, and the phone never gets a row for it.

        await syncRound();

        const phoneRow = (await withDevice(phone, () => getLocalFavorites())).find(f => f.track_key === "unknown-key");
        expect(phoneRow).toBeUndefined();
    });

    // Batching the reconcile-phase DB round trips for large
    // libraries. These exercise the batched SQL (UPDATE ... FROM, chunked
    // multi-row INSERT) against real SQLite, on top of the 8 tests above
    // that already pin the LWW-guard/dedup semantics this file exists for.
    describe("batched stats at scale", () => {
        const N = 300;

        /** Adds N more tracks (all routed through applyManifestStats/favorites),
         *  on top of the outer beforeEach's k1 track. */
        async function seedManyTracks(): Promise<string[]> {
            const keys = Array.from({ length: N }, (_, i) => `s${i}`);
            await Promise.all(keys.map(k => seedTrack(mac, { trackKey: k })));
            await Promise.all(keys.map(k => seedTrack(phone, { trackKey: k, origin: "mirror" })));
            const macIds = keys.map(k => `t-${k}-mac`);
            await withDevice(mac, async () => {
                const db = await getDb();
                let pos = 1; // after k1, already at position 0
                for (const id of macIds) {
                    await db.execute(
                        "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ($1, $2, $3)",
                        ["pl-1", id, pos++]
                    );
                }
            });
            return keys;
        }

        it("converges a 300-track library's favorites in one round and stays converged on a second (idempotence)", async () => {
            const keys = await seedManyTracks();
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            await withDevice(mac, async () => {
                for (const k of keys) await setTrackFavorite(`t-${k}-mac`, true);
            });
            vi.useRealTimers();

            await syncRound();
            const afterFirst = await withDevice(phone, () => getAllTracks());
            for (const k of keys) {
                expect(afterFirst.find(t => t.track_key === k)?.favorite).toBe(1);
            }

            const before = await withDevice(phone, () => getAllTracks());
            await syncRound(); // nothing new — must not change anything
            const after = await withDevice(phone, () => getAllTracks());
            expect(after).toEqual(before);
        });

        it("pins the statement-count reduction: a 300-track favorites batch stays well under a per-row count", async () => {
            const keys = await seedManyTracks();
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            await withDevice(mac, async () => {
                for (const k of keys) await setTrackFavorite(`t-${k}-mac`, true);
            });
            vi.useRealTimers();

            phone.resetStats();
            const manifest = await withDevice(mac, () => buildSyncSnapshot());
            phone.resetStats();
            await withDevice(phone, () => applyManifestStats(manifest, phoneDeviceId));

            // Per-row this would be ~300 UPDATE statements (one per favorite);
            // batching (applyFavoritesBatch, PER_CHUNK=300) does it in ~1.
            // Loose bound — the point is order-of-magnitude, not an exact count.
            expect(phone.stats.executes).toBeLessThan(10);
        });
    });
});

describe("smart playlist sync over real SQLite", () => {
    let mac: Device;

    beforeEach(async () => {
        mac = createDevice("mac");
        fsExists.mockReset();
        fsExists.mockImplementation(async () => false);
        fsReadTextFile.mockReset();
        fsReadTextFile.mockImplementation(async () => "[]");
        invoke.mockReset();
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "prepare_sync_media") return [];
            if (cmd === "ensure_album_art") return null;
            return undefined;
        });
    });

    it("buildSyncSnapshot evaluates a synced smart playlist's rules and includes its matching tracks", async () => {
        // Two tracks: one Rock (should match), one Jazz (should not).
        const rockId = await seedTrack(mac, { trackKey: "rock-1" });
        const jazzId = await seedTrack(mac, { trackKey: "jazz-1" });
        await withDevice(mac, async () => {
            const db = await getDb();
            await db.execute("UPDATE tracks SET genre = 'Rock' WHERE id = $1", [rockId]);
            await db.execute("UPDATE tracks SET genre = 'Jazz' WHERE id = $1", [jazzId]);

            const rules = { v: 1, match: 'all', conditions: [{ field: 'genre', op: 'contains', value: 'rock' }], sortBy: 'natural', sortDesc: false, limit: null };
            await db.execute(
                "INSERT INTO playlists (id, name, type, sync_to_device, rules) VALUES ($1, $2, 'smart', 1, $3)",
                ["smart-1", "Rock Mix", JSON.stringify(rules)]
            );
        });

        const manifest = await withDevice(mac, () => buildSyncSnapshot());
        const smartPlaylist = manifest.playlists.find(p => p.id === "smart-1");
        expect(smartPlaylist).toBeDefined();
        expect(smartPlaylist!.track_keys).toEqual(["rock-1"]);
        expect(manifest.tracks.some(t => t.track_key === "rock-1")).toBe(true);
        expect(manifest.tracks.some(t => t.track_key === "jazz-1")).toBe(false);
    });
});
