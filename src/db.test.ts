import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HashCacheEntry } from "./types";

// In-memory stand-in for @tauri-apps/plugin-sql.
const fakeDb = {
    execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowsAffected: 0, lastInsertId: 0 })),
    select: vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]),
};
vi.mock("@tauri-apps/plugin-sql", () => ({
    default: { load: vi.fn(async () => fakeDb) },
}));

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => [] as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => invoke(...a) }));

const fsExists = vi.fn(async (..._a: unknown[]) => false);
const fsReadTextFile = vi.fn(async (..._a: unknown[]) => "[]");
vi.mock("@tauri-apps/plugin-fs", () => ({
    BaseDirectory: { AppLocalData: 1 },
    exists: (...a: unknown[]) => fsExists(...a),
    readTextFile: (...a: unknown[]) => fsReadTextFile(...a),
}));

import {
    _resetInitForTests,
    addScanFolder,
    addTracksToPlaylist,
    applyAlbumCovers,
    applyArtistCovers,
    applyFavoritesBatch,
    applyManifestStats,
    applyPlayStatesBatch,
    applySyncInbox,
    backfillExtraTags,
    backfillTrackIdentities,
    backfillTrackNumbers,
    buildSyncSnapshot,
    clearPlaylistTracks,
    createPlaylist,
    createSmartPlaylist,
    deletePlaylist,
    deletePlaylists,
    getAlbumCover,
    getAllAlbumCovers,
    getAllArtistCovers,
    getAllTracks,
    getArtistCover,
    getArtistCoverKeys,
    getDeviceId,
    getLocalPlayStates,
    getPlaylists,
    getPlaylistTrackPositions,
    getScanFolders,
    getSetting,
    getSyncServerPort,
    getSyncToken,
    getTrackPlayState,
    getTranscodeOptions,
    insertPlayEventsBatch,
    loadHashCache,
    loadLastPlayback,
    migrateFromJson,
    reapplyPlaylistKind,
    removeScanFolder,
    resetPlaylistManualOrder,
    saveHashCache,
    saveLastPlayback,
    setAlbumCover,
    setArtistCover,
    setFolderDefaultKind,
    setPlaylistKind,
    setPlaylistSyncToDevice,
    setPlaylistTrackOrder,
    setSetting,
    setSyncServerPort,
    setTrackIdentity,
    setTrackKind,
    setTrackPlayState,
    setTranscodeBitrate,
    setTranscodeFormat,
    updateLyrics,
    updateSmartPlaylist,
} from "./db";
import { DEFAULT_SMART_RULES } from "./smartPlaylist";
import type { ManifestTrack } from "./sync";
import type { IncomingStats, SyncSnapshot, Track } from "./types";

const manifestTrack = (over: Partial<ManifestTrack> = {}): ManifestTrack => ({
    track_key: "k1",
    title: "Ep 1",
    artist: null,
    album: null,
    duration: 100,
    file_name: "ep1.mp3",
    file_path: "/m/ep1.mp3",
    content_hash: "h1",
    size: 0,
    favorite: 0,
    favorite_updated_at: null,
    kind: "podcast",
    disc_no: null,
    track_no: null,
    play_state: "unplayed",
    resume_position: 0,
    play_state_updated_at: null,
    ...over,
});

const entry = (n: number): HashCacheEntry => ({
    file_path: `/music/${n}.mp3`,
    size: n * 10,
    mtime: n,
    content_hash: `h${n}`,
    track_key: `k${n}`,
});

beforeEach(() => {
    fakeDb.execute.mockReset();
    fakeDb.select.mockReset();
    fakeDb.execute.mockImplementation(async () => ({ rowsAffected: 0, lastInsertId: 0 }));
    fakeDb.select.mockImplementation(async () => [] as unknown[]);
    invoke.mockReset();
    invoke.mockImplementation(async () => [] as unknown);
    fsExists.mockReset();
    fsExists.mockImplementation(async () => false);
    fsReadTextFile.mockReset();
    fsReadTextFile.mockImplementation(async () => "[]");
    _resetInitForTests();
});

describe("saveHashCache", () => {
    it("is a no-op for an empty list", async () => {
        await saveHashCache([]);
        expect(fakeDb.execute).not.toHaveBeenCalled();
    });

    it("upserts a small batch in one statement with 5 params per row", async () => {
        await saveHashCache([entry(1), entry(2)]);
        expect(fakeDb.execute).toHaveBeenCalledTimes(1);
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("ON CONFLICT(file_path) DO UPDATE");
        expect(sql).toContain("($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)");
        expect(params).toEqual([
            "/music/1.mp3", 10, 1, "h1", "k1",
            "/music/2.mp3", 20, 2, "h2", "k2",
        ]);
    });

    it("splits large lists into chunks that stay under the SQLite param limit", async () => {
        await saveHashCache(Array.from({ length: 300 }, (_, i) => entry(i)));
        expect(fakeDb.execute).toHaveBeenCalledTimes(3); // 120 + 120 + 60
        for (const [, params] of fakeDb.execute.mock.calls) {
            expect((params as unknown[]).length).toBeLessThanOrEqual(999);
        }
        const total = fakeDb.execute.mock.calls.reduce((n, [, p]) => n + (p as unknown[]).length, 0);
        expect(total).toBe(300 * 5);
    });
});

// Batching the reconcile-phase DB round trips for large libraries.
// UPDATE ... FROM (not ON CONFLICT) is used here — track_key has no UNIQUE
// index, only file_path does.
describe("applyFavoritesBatch / applyPlayStatesBatch", () => {
    it("applyFavoritesBatch keeps the per-row LWW guard under the join", async () => {
        await applyFavoritesBatch([{ track_key: "k1", favorite: 1, favorite_updated_at: 500 }]);
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("FROM (VALUES");
        expect(sql).toContain("tracks.favorite_updated_at IS NULL OR tracks.favorite_updated_at < v.column3");
        expect(params).toEqual(["k1", 1, 500]);
    });

    it("applyPlayStatesBatch keeps the per-row LWW guard under the join", async () => {
        await applyPlayStatesBatch([{ track_key: "k1", play_state: "played", resume_position: 0, play_state_updated_at: 500 }]);
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("FROM (VALUES");
        expect(sql).toContain("tracks.play_state_updated_at IS NULL OR tracks.play_state_updated_at < v.column4");
        expect(params).toEqual(["k1", "played", 0, 500]);
    });

    it("keeps the max-timestamp row when a batch has a duplicate key (equivalent to any serial order)", async () => {
        await applyFavoritesBatch([
            { track_key: "k1", favorite: 0, favorite_updated_at: 100 },
            { track_key: "k1", favorite: 1, favorite_updated_at: 500 },
        ]);
        const [, params] = fakeDb.execute.mock.calls[0];
        expect(params).toEqual(["k1", 1, 500]);
    });
});

describe("insertPlayEventsBatch", () => {
    it("is a no-op for an empty list", async () => {
        await insertPlayEventsBatch([]);
        expect(fakeDb.execute).not.toHaveBeenCalled();
    });

    it("batches multiple events into one INSERT OR IGNORE statement", async () => {
        await insertPlayEventsBatch([
            { track_key: "k1", played_at: 1, device_id: "d1" },
            { track_key: "k2", played_at: 2, device_id: "d1" },
        ]);
        expect(fakeDb.execute).toHaveBeenCalledTimes(1);
        const [sql] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("INSERT OR IGNORE INTO play_events");
    });
});

describe("deletePlaylists", () => {
    it("deletePlaylists chunks by id and sweeps orphaned playlist_tracks rows", async () => {
        const ids = Array.from({ length: 1200 }, (_, i) => `p${i}`);
        await deletePlaylists(ids);
        const playlistDeletes = fakeDb.execute.mock.calls.filter(c => String(c[0]).startsWith("DELETE FROM playlists"));
        const ptDeletes = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("DELETE FROM playlist_tracks WHERE playlist_id"));
        expect(playlistDeletes).toHaveLength(3);
        expect(ptDeletes).toHaveLength(3);
    });

    // Library-wide views (All Songs / Artists / Albums) now read `tracks`
    // directly instead of deriving from playlist_tracks membership, so a
    // deleted playlist must also sweep the tracks it orphaned — otherwise
    // those rows would linger forever and keep surfacing there.
    it("deletePlaylist and deletePlaylists both sweep tracks orphaned by the deletion", async () => {
        await deletePlaylist("p1");
        const single = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("DELETE FROM tracks WHERE id NOT IN"));
        expect(single).toHaveLength(1);

        fakeDb.execute.mockClear();
        await deletePlaylists(["p1", "p2"]);
        const batch = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("DELETE FROM tracks WHERE id NOT IN"));
        expect(batch).toHaveLength(1);
    });
});

describe("applyAlbumCovers chunking", () => {
    it("chunks 25 covers into 2 statements, keeping the LWW ON CONFLICT guard", async () => {
        const covers = Array.from({ length: 25 }, (_, i) => ({
            artist: `a${i}`, album: `b${i}`, image_data_uri: "data:image/jpeg;base64,x", updated_at: i,
        }));
        await applyAlbumCovers(covers);
        expect(fakeDb.execute).toHaveBeenCalledTimes(2); // 20 + 5
        for (const [sql] of fakeDb.execute.mock.calls) {
            expect(sql).toContain("WHERE excluded.updated_at > album_covers.updated_at");
        }
    });
});

describe("natural album order (disc / track numbers)", () => {
    const track = (over: Partial<Track> = {}): Track => ({
        id: "t1", title: "Song", file_path: "/m/1.mp3", file_name: "1.mp3",
        disc_no: 1, track_no: 3, ...over,
    });

    const stubMaxPos = () => fakeDb.select.mockImplementation(async (sql: string) =>
        sql.includes("MAX(position)") ? [{ max_pos: null }] : []);

    it("addTracksToPlaylist persists disc_no / track_no and re-applies them on conflict", async () => {
        stubMaxPos();
        await addTracksToPlaylist("pl", [track()]);
        const insert = fakeDb.execute.mock.calls.find(c => String(c[0]).includes("INSERT INTO tracks"))!;
        const [sql, params] = insert;
        expect(sql).toContain("disc_no, track_no");
        expect(sql).toContain("disc_no = excluded.disc_no");
        expect(sql).toContain("track_no = excluded.track_no");
        // slice(-8, -6): the 6 trailing params are added_at, genre, year,
        // album_artist, composer, extra_tags_read, tested separately.
        expect((params as unknown[]).slice(-8, -6)).toEqual([1, 3]);
    });

    it("addTracksToPlaylist sends null for an untagged track", async () => {
        stubMaxPos();
        await addTracksToPlaylist("pl", [track({ disc_no: undefined, track_no: undefined })]);
        const insert = fakeDb.execute.mock.calls.find(c => String(c[0]).includes("INSERT INTO tracks"))!;
        expect((insert[1] as unknown[]).slice(-8, -6)).toEqual([null, null]);
    });

    it("getPlaylists sorts folder playlists by album/disc/track, keeps position for others", async () => {
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("SELECT * FROM playlists")) {
                return [
                    { id: "f", name: "Folder", type: "folder" },
                    { id: "x", name: "XML", type: "xml" },
                ];
            }
            return [];
        });
        await getPlaylists();
        const trackQueries = fakeDb.select.mock.calls
            .map(c => String(c[0]))
            .filter(s => s.includes("JOIN playlist_tracks pt"));
        // Folder playlist: outer group-by-playlist first, then artist -> album
        // -> disc -> track -> title within it.
        const order = trackQueries[0].slice(trackQueries[0].indexOf("ORDER BY"));
        const keys = ["pt.playlist_id", "t.artist", "t.album", "t.disc_no", "t.track_no", "t.title"]
            .map(k => order.indexOf(k));
        expect(keys.every(i => i >= 0)).toBe(true);
        expect(keys).toEqual([...keys].sort((a, b) => a - b));
        // Other playlist types keep their saved position, grouped by playlist first.
        expect(trackQueries[1]).toMatch(/ORDER BY\s+pt\.playlist_id,\s*pt\.position ASC\s*$/);
    });

    it("getPlaylists uses saved position, not natural order, for a manually-reordered folder playlist", async () => {
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("SELECT * FROM playlists")) {
                return [{ id: "f", name: "Podcast", type: "folder", manual_order: 1 }];
            }
            return [];
        });
        await getPlaylists();
        const trackQuery = fakeDb.select.mock.calls
            .map(c => String(c[0]))
            .find(s => s.includes("JOIN playlist_tracks pt"))!;
        expect(trackQuery).toMatch(/ORDER BY\s+pt\.playlist_id,\s*pt\.position ASC\s*$/);
    });

    it("getPlaylists fetches all playlists' tracks in a bounded number of queries (no N+1) and keeps each playlist's own tracks", async () => {
        const playlists = [
            { id: "f1", name: "Folder 1", type: "folder" },
            { id: "x1", name: "XML 1", type: "xml" },
            { id: "f2", name: "Folder 2", type: "folder" },
            { id: "x2", name: "XML 2", type: "xml" },
        ];
        fakeDb.select.mockImplementation(async (sql: string, params?: unknown[]) => {
            if (sql.includes("SELECT * FROM playlists")) return playlists;
            if (sql.includes("JOIN playlist_tracks pt")) {
                // Return one row per requested playlist_id, tagged so we can
                // verify each ends up on the right Playlist below.
                return (params as string[]).map((id) => ({ id: `t-${id}`, __playlist_id: id }));
            }
            return [];
        });
        await getPlaylists();
        const trackQueries = fakeDb.select.mock.calls.filter(c => String(c[0]).includes("JOIN playlist_tracks pt"));
        // Two ORDER BY shapes across 4 playlists (folder vs. xml) -> 2 grouped
        // queries total, not 4 — this is the N+1 fix.
        expect(trackQueries.length).toBe(2);

        const result = await getPlaylists();
        expect(result.find(p => p.id === "f1")!.tracks.map(t => t.id)).toEqual(["t-f1"]);
        expect(result.find(p => p.id === "x1")!.tracks.map(t => t.id)).toEqual(["t-x1"]);
        expect(result.find(p => p.id === "f2")!.tracks.map(t => t.id)).toEqual(["t-f2"]);
        expect(result.find(p => p.id === "x2")!.tracks.map(t => t.id)).toEqual(["t-x2"]);
    });
});

describe("playlist manual ordering", () => {
    it("setPlaylistTrackOrder rewrites position 0..n-1 in the given order and flips manual_order on", async () => {
        await setPlaylistTrackOrder("pl1", ["t3", "t1", "t2"]);
        const updates = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("SET position"));
        expect(updates).toEqual([
            ["UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND track_id = $3", [0, "pl1", "t3"]],
            ["UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND track_id = $3", [1, "pl1", "t1"]],
            ["UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND track_id = $3", [2, "pl1", "t2"]],
        ]);
        const flag = fakeDb.execute.mock.calls.find(c => String(c[0]).includes("SET manual_order = 1"));
        expect(flag).toEqual(["UPDATE playlists SET manual_order = 1 WHERE id = $1", ["pl1"]]);
    });

    it("resetPlaylistManualOrder only clears the flag, leaving position rows untouched", async () => {
        await resetPlaylistManualOrder("pl1");
        expect(fakeDb.execute).toHaveBeenCalledWith(
            "UPDATE playlists SET manual_order = 0 WHERE id = $1", ["pl1"]
        );
        expect(fakeDb.execute.mock.calls.some(c => String(c[0]).includes("playlist_tracks"))).toBe(false);
    });

    it("getPlaylistTrackPositions returns a file_path -> position map", async () => {
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("FROM playlist_tracks pt")) {
                return [
                    { file_path: "/a.mp3", position: 0 },
                    { file_path: "/b.mp3", position: 1 },
                ];
            }
            return [];
        });
        const positions = await getPlaylistTrackPositions("pl1");
        expect(positions.get("/a.mp3")).toBe(0);
        expect(positions.get("/b.mp3")).toBe(1);
    });
});

describe("backfillTrackNumbers", () => {
    it("no-ops when every row already has numbers", async () => {
        fakeDb.select.mockImplementation(async () => []);
        expect(await backfillTrackNumbers()).toBe(0);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("reads tags for NULL rows and writes disc_no / track_no back by file_path", async () => {
        fakeDb.select.mockImplementation(async (sql: string) =>
            sql.includes("disc_no IS NULL")
                ? [
                    { id: "t1", file_path: "/m/a.mp3" },
                    { id: "t2", file_path: "/m/b.mp3" },
                    { id: "t3", file_path: "/m/gone.mp3" },
                ]
                : []);
        invoke.mockImplementation(async () => [
            { file_path: "/m/a.mp3", disc_no: 1, track_no: 4 },
            { file_path: "/m/b.mp3", disc_no: null, track_no: 2 },
        ]);

        expect(await backfillTrackNumbers()).toBe(2);
        expect(invoke).toHaveBeenCalledWith("read_track_numbers", {
            paths: ["/m/a.mp3", "/m/b.mp3", "/m/gone.mp3"],
        });
        const updates = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("SET disc_no"));
        expect(updates.map(c => c[1])).toEqual([
            [1, 4, "t1"],
            [null, 2, "t2"],
        ]);
    });
});

describe("backfillExtraTags", () => {
    it("no-ops when every row is already marked read", async () => {
        fakeDb.select.mockImplementation(async () => []);
        expect(await backfillExtraTags()).toBe(0);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("reads tags for unread rows and writes genre/year/album_artist/composer back, marking them read", async () => {
        fakeDb.select.mockImplementation(async (sql: string) =>
            sql.includes("extra_tags_read = 0")
                ? [
                    { id: "t1", file_path: "/m/a.mp3" },
                    { id: "t2", file_path: "/m/gone.mp3" },
                ]
                : []);
        invoke.mockImplementation(async () => [
            { file_path: "/m/a.mp3", genre: "Rock", year: 1999, album_artist: "The Band", composer: null },
        ]);

        expect(await backfillExtraTags()).toBe(1);
        expect(invoke).toHaveBeenCalledWith("read_extra_tags", { paths: ["/m/a.mp3", "/m/gone.mp3"] });
        const updates = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("extra_tags_read = 1"));
        expect(updates.map(c => c[1])).toEqual([["Rock", 1999, "The Band", null, "t1"]]);
    });
});

describe("backfillTrackIdentities", () => {
    it("no-ops when every row already has an identity", async () => {
        fakeDb.select.mockImplementation(async () => []);
        expect(await backfillTrackIdentities()).toBe(0);
        expect(invoke).not.toHaveBeenCalled();
    });

    it("chunks candidate paths and writes track_key / content_hash back by file_path", async () => {
        const rows = Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, file_path: `/m/${i}.mp3` }));
        fakeDb.select.mockImplementation(async (sql: string) =>
            sql.includes("track_key IS NULL") ? rows : []);
        invoke.mockImplementation(async (_cmd: string, args?: unknown) => ({
            rows: (args as { paths: string[] }).paths
                .filter(p => p !== "/m/1.mp3") // pretend this one went missing mid-flight
                .map(p => ({ file_path: p, track_key: `k-${p}`, content_hash: `h-${p}` })),
            hash_cache: [],
        }));

        expect(await backfillTrackIdentities(2)).toBe(2);
        // 3 rows at chunk size 2 => two invoke calls: [0,1] then [2].
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(invoke).toHaveBeenNthCalledWith(1, "compute_track_identities", expect.objectContaining({
            paths: ["/m/0.mp3", "/m/1.mp3"],
        }));
        expect(invoke).toHaveBeenNthCalledWith(2, "compute_track_identities", expect.objectContaining({
            paths: ["/m/2.mp3"],
        }));

        const updates = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("SET track_key"));
        expect(updates.map(c => c[1])).toEqual([
            ["k-/m/0.mp3", "h-/m/0.mp3", "t0"],
            ["k-/m/2.mp3", "h-/m/2.mp3", "t2"],
        ]);
        // The missing file never got an UPDATE — it's left for the next launch.
        expect(updates.some(c => (c[1] as unknown[])[2] === "t1")).toBe(false);
    });

    it("persists the refreshed hash cache rows returned by the batch", async () => {
        fakeDb.select.mockImplementation(async (sql: string) =>
            sql.includes("track_key IS NULL") ? [{ id: "t1", file_path: "/m/a.mp3" }] : []);
        invoke.mockImplementation(async () => ({
            rows: [{ file_path: "/m/a.mp3", track_key: "k1", content_hash: "h1" }],
            hash_cache: [{ file_path: "/m/a.mp3", size: 10, mtime: 1, content_hash: "h1", track_key: "k1" }],
        }));

        await backfillTrackIdentities();
        const upsert = fakeDb.execute.mock.calls.find(c => String(c[0]).includes("INTO content_hash_cache"));
        expect(upsert?.[1]).toEqual(["/m/a.mp3", 10, 1, "h1", "k1"]);
    });
});

describe("migrateFromJson", () => {
    it("is a no-op when playlists.json doesn't exist", async () => {
        fsExists.mockResolvedValue(false);
        await migrateFromJson();
        expect(fsReadTextFile).not.toHaveBeenCalled();
        expect(fakeDb.execute).not.toHaveBeenCalled();
    });

    it("skips when the DB already has playlists, and still marks migrated", async () => {
        fsExists.mockResolvedValue(true);
        fsReadTextFile.mockResolvedValue(JSON.stringify([{ id: "p1", name: "P", type: "folder", tracks: [] }]));
        fakeDb.select.mockImplementation(async (sql: string) =>
            sql.includes("count(*)") ? [{ count: 1 }] : []);

        await migrateFromJson();
        const insertedPlaylist = fakeDb.execute.mock.calls.some(c => String(c[0]).includes("INSERT INTO playlists"));
        expect(insertedPlaylist).toBe(false);
        const markedMigrated = fakeDb.execute.mock.calls.some(
            c => String(c[0]).includes("INSERT INTO settings") && (c[1] as unknown[]).includes("json_migrated"));
        expect(markedMigrated).toBe(true);
    });

    it("two concurrent calls only migrate once (StrictMode double-invoke)", async () => {
        fsExists.mockResolvedValue(true);
        fsReadTextFile.mockResolvedValue(JSON.stringify([{ id: "p1", name: "P", type: "folder", tracks: [] }]));
        fakeDb.select.mockImplementation(async (sql: string) =>
            sql.includes("count(*)") ? [{ count: 0 }] : []);

        await Promise.all([migrateFromJson(), migrateFromJson()]);

        const insertedPlaylists = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("INSERT INTO playlists"));
        expect(insertedPlaylists.length).toBe(1);
    });

    it("a later call short-circuits once json_migrated is set", async () => {
        fsExists.mockResolvedValue(true);
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("SELECT value FROM settings")) return [{ value: "1" }];
            return [];
        });

        await migrateFromJson();
        expect(fsReadTextFile).not.toHaveBeenCalled();
    });
});

describe("track kind / play state writers", () => {
    it("setTrackKind stamps kind + kind_updated_at", async () => {
        await setTrackKind("t1", "podcast");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("SET kind = $1, kind_updated_at = $2");
        expect(params?.[0]).toBe("podcast");
        expect(params?.[2]).toBe("t1");
    });

    it("setTrackPlayState writes state, resume position and timestamp", async () => {
        await setTrackPlayState("t2", "in_progress", 42.5);
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("SET play_state = $1, resume_position = $2, play_state_updated_at = $3");
        expect(params?.slice(0, 2)).toEqual(["in_progress", 42.5]);
        expect(params?.[3]).toBe("t2");
    });

    it("getTrackPlayState reads back what setTrackPlayState writes", async () => {
        fakeDb.select.mockImplementation(async () => [
            { play_state: "in_progress", resume_position: 42.5, play_state_updated_at: 12345 },
        ]);
        const result = await getTrackPlayState("t2");
        const [sql, params] = fakeDb.select.mock.calls[0];
        expect(sql).toContain("SELECT play_state, resume_position, play_state_updated_at FROM tracks WHERE id = $1");
        expect(params).toEqual(["t2"]);
        expect(result).toEqual({ play_state: "in_progress", resume_position: 42.5, play_state_updated_at: 12345 });
    });

    it("getTrackPlayState returns null for an unknown track", async () => {
        fakeDb.select.mockImplementation(async () => []);
        expect(await getTrackPlayState("missing")).toBeNull();
    });

    it("setFolderDefaultKind updates the folder then reclassifies its tracks", async () => {
        await setFolderDefaultKind("/pods", "podcast");
        expect(fakeDb.execute).toHaveBeenCalledTimes(2);
        expect(String(fakeDb.execute.mock.calls[0][0])).toContain("UPDATE scan_folders SET default_kind");
        const [sql, params] = fakeDb.execute.mock.calls[1];
        expect(sql).toContain("file_path LIKE $4 ESCAPE");
        expect(params?.[3]).toBe("/pods/%");
    });

    it("setPlaylistKind updates the playlist then bulk-reclassifies its tracks", async () => {
        await setPlaylistKind("pl1", "podcast");
        expect(fakeDb.execute).toHaveBeenCalledTimes(2);
        const [sql0, params0] = fakeDb.execute.mock.calls[0];
        expect(String(sql0)).toContain("UPDATE playlists SET kind = $1 WHERE id = $2");
        expect(params0).toEqual(["podcast", "pl1"]);
        const [sql1, params1] = fakeDb.execute.mock.calls[1];
        expect(String(sql1)).toContain("UPDATE tracks SET kind = $1, kind_updated_at = $2");
        expect(String(sql1)).toContain("SELECT track_id FROM playlist_tracks WHERE playlist_id = $3");
        expect(params1?.[0]).toBe("podcast");
        expect(params1?.[2]).toBe("pl1");
    });

    it("reapplyPlaylistKind is a no-op for a music playlist", async () => {
        fakeDb.select.mockImplementation(async () => [{ kind: "music" }]);
        await reapplyPlaylistKind("pl1");
        expect(fakeDb.execute).not.toHaveBeenCalled();
    });

    it("reapplyPlaylistKind re-runs setPlaylistKind for a podcast playlist", async () => {
        fakeDb.select.mockImplementation(async () => [{ kind: "podcast" }]);
        await reapplyPlaylistKind("pl1");
        expect(fakeDb.execute).toHaveBeenCalledTimes(2);
        expect(String(fakeDb.execute.mock.calls[0][0])).toContain("UPDATE playlists SET kind");
    });
});

describe("last-playback cursor", () => {
    it("saveLastPlayback writes the five settings keys, flooring the position", async () => {
        await saveLastPlayback({
            trackId: "t9", position: 42.7, viewMode: "playlist",
            playlistId: "p3", viewFilter: null,
        });
        const writes = Object.fromEntries(
            fakeDb.execute.mock.calls.map(c => [(c[1] as unknown[])[0], (c[1] as unknown[])[1]]),
        );
        expect(writes).toMatchObject({
            last_track_id: "t9",
            last_position: "42",
            last_view_mode: "playlist",
            last_playlist_id: "p3",
            last_view_filter: "",
        });
    });

    it("loadLastPlayback returns null when no track was stored", async () => {
        fakeDb.select.mockImplementation(async () => []);
        expect(await loadLastPlayback()).toBeNull();
    });

    it("loadLastPlayback reads back the cursor", async () => {
        const store: Record<string, string> = {
            last_track_id: "t9", last_position: "42", last_view_mode: "all_songs",
            last_playlist_id: "", last_view_filter: "",
        };
        fakeDb.select.mockImplementation(async (_sql: string, params?: unknown[]) => {
            const key = (params?.[0] as string) ?? "";
            return key in store ? [{ value: store[key] }] : [];
        });
        expect(await loadLastPlayback()).toEqual({
            trackId: "t9", position: 42, viewMode: "all_songs",
            playlistId: null, viewFilter: null,
        });
    });
});

describe("sync stats SQL", () => {
    it("buildSyncSnapshot selects and carries the podcast play-state columns", async () => {
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("FROM playlists WHERE sync_to_device")) {
                return [{ id: "p1", name: "Pod", type: "folder", kind: "podcast" }];
            }
            if (sql.includes("JOIN playlist_tracks pt")) {
                return [{ track_key: "k1" }];
            }
            if (sql.includes("FROM tracks WHERE track_key IS NOT NULL")) {
                return [{
                    track_key: "k1", title: "Ep 1", artist: null, album: null, duration: 100,
                    file_name: "ep1.mp3", file_path: "/m/ep1.mp3", content_hash: "h1",
                    favorite: 0, favorite_updated_at: null, kind: "podcast",
                    disc_no: null, track_no: null,
                    play_state: "in_progress", resume_position: 42.5, play_state_updated_at: 12345,
                }];
            }
            return [];
        });

        const snapshot = await buildSyncSnapshot();
        const trackQuery = fakeDb.select.mock.calls.map(c => String(c[0]))
            .find(sql => sql.includes("FROM tracks WHERE track_key IS NOT NULL"))!;
        expect(trackQuery).toContain("play_state_updated_at");
        expect(snapshot.tracks[0]).toMatchObject({
            play_state: "in_progress",
            resume_position: 42.5,
            play_state_updated_at: 12345,
        });
    });

    it("buildSyncSnapshot orders a manually-reordered folder playlist by position, matching getPlaylists", async () => {
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("FROM playlists WHERE sync_to_device")) {
                return [{ id: "p1", name: "Pod", type: "folder", kind: "podcast", manual_order: 1 }];
            }
            if (sql.includes("JOIN playlist_tracks pt")) {
                return [{ track_key: "k1" }];
            }
            return [];
        });
        await buildSyncSnapshot();
        const trackKeyQuery = fakeDb.select.mock.calls.map(c => String(c[0]))
            .find(sql => sql.includes("JOIN playlist_tracks pt"))!;
        expect(trackKeyQuery).toMatch(/ORDER BY\s+pt\.position ASC\s*$/);
    });

    it("getLocalPlayStates selects only stamped rows, aliasing the timestamp", async () => {
        await getLocalPlayStates();
        const [sql] = fakeDb.select.mock.calls[0];
        expect(sql).toContain("play_state_updated_at IS NOT NULL");
        expect(sql).toContain("play_state_updated_at AS updated_at");
    });

    it("applyManifestStats batches the LWW guard, applying it only to stamped play-state tracks", async () => {
        const manifest: SyncSnapshot = {
            device_id: "mac-1",
            generated_at: 1,
            playlists: [],
            play_events: [],
            tracks: [
                manifestTrack({ track_key: "k1", play_state: "played", resume_position: 0, play_state_updated_at: 500 }),
                manifestTrack({ track_key: "k2", play_state_updated_at: null }),
            ],
        };
        await applyManifestStats(manifest, "phone-1");
        const updates = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("SET play_state ="));
        // Exactly one batched statement, not one per track.
        expect(updates).toHaveLength(1);
        const [sql, params] = updates[0];
        expect(sql).toContain("FROM (VALUES");
        expect(sql).toContain("play_state_updated_at IS NULL OR tracks.play_state_updated_at < v.column4");
        // Only k1 (stamped) is present — k2 was filtered out in JS, not by SQL.
        expect(params).toEqual(["k1", "played", 0, 500]);
    });

    it("applySyncInbox applies play_states and no-ops when the key is absent", async () => {
        const items: IncomingStats[] = [
            { device_id: "phone-1", play_states: [{ track_key: "k1", play_state: "played", resume_position: 0, updated_at: 99 }] },
            { device_id: "phone-2" },
        ];
        await applySyncInbox(items);
        const updates = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("SET play_state ="));
        expect(updates).toHaveLength(1);
        const [sql, params] = updates[0];
        expect(sql).toContain("tracks.play_state_updated_at IS NULL OR tracks.play_state_updated_at < v.column4");
        expect(params).toEqual(["k1", "played", 0, 99]);
    });

    it("applySyncInbox batches events and favorites per item with the item's device_id", async () => {
        await applySyncInbox([{
            device_id: "phone-1",
            events: [{ track_key: "k1", played_at: 10 }, { track_key: "k2", played_at: 20 }],
            favorites: [{ track_key: "k1", favorite: 1, updated_at: 30 }],
        }]);
        const calls = fakeDb.execute.mock.calls.map(c => [String(c[0]), c[1] as unknown[]] as const);
        const ins = calls.filter(([sql]) => sql.includes("INSERT OR IGNORE INTO play_events"));
        expect(ins).toHaveLength(1);
        expect(ins[0][1]).toEqual([expect.any(String), "k1", 10, "phone-1", expect.any(String), "k2", 20, "phone-1"]);
        const fav = calls.filter(([sql]) => sql.includes("SET favorite ="));
        expect(fav).toHaveLength(1);
        expect(fav[0][1]).toEqual(["k1", 1, 30]);
    });

    it("applySyncInbox counts applied rows from rowsAffected and reports none failed", async () => {
        fakeDb.execute.mockImplementation(async (sql: string) => ({
            rowsAffected: String(sql).includes("SET play_state =") ? 1 : 0, lastInsertId: 0,
        }));
        const res = await applySyncInbox([
            { device_id: "p", play_states: [{ track_key: "k1", play_state: "in_progress", resume_position: 42, updated_at: 5 }] },
        ]);
        expect(res).toEqual({ play_states_received: 1, play_states_applied: 1, failed: [] });
    });

    it("applySyncInbox reports received>0 / applied=0 when no track_key matches", async () => {
        const res = await applySyncInbox([
            { device_id: "p", play_states: [{ track_key: "nope", play_state: "played", resume_position: 0, updated_at: 5 }] },
        ]);
        expect(res.play_states_received).toBe(1);
        expect(res.play_states_applied).toBe(0);
    });

    it("applySyncInbox keeps applying after one item throws and returns the failed item", async () => {
        const bad: IncomingStats = { device_id: "bad", play_states: [{ track_key: "boom", play_state: "played", resume_position: 0, updated_at: 1 }] };
        const good: IncomingStats = { device_id: "good", play_states: [{ track_key: "k2", play_state: "played", resume_position: 0, updated_at: 2 }] };
        fakeDb.execute.mockImplementation(async (_sql: string, params?: unknown[]) => {
            if (params?.includes("boom")) throw new Error("db locked");
            return { rowsAffected: 1, lastInsertId: 0 };
        });
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const res = await applySyncInbox([bad, good]);
        errSpy.mockRestore();
        expect(res.failed).toEqual([bad]);
        expect(res.play_states_applied).toBe(1);
    });

});

// Non-destructive per-album cover overrides — keyed by (artist, album), not
// album alone, so two artists' self-titled (or both-untagged) albums don't
// collide onto one cover (see db.ts's migration 7 / albumCoverKey). LWW-merged
// the same way as favorites/play_state.
describe("album cover overrides", () => {
    it("setAlbumCover upserts by (artist, album), normalized, with a fresh timestamp", async () => {
        await setAlbumCover(" The Beatles ", " Abbey Road ", "data:image/jpeg;base64,AAA");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("INSERT INTO album_covers");
        expect(params).toEqual(["the beatles", "abbey road", "data:image/jpeg;base64,AAA", params![3]]);
        expect(typeof params![3]).toBe("number");
    });

    it("getAlbumCover normalizes and falls back blank album to 'unknown album'", async () => {
        await getAlbumCover("The Beatles", "");
        const [sql, params] = fakeDb.select.mock.calls[0];
        expect(sql).toContain("WHERE artist = $1 AND album = $2");
        expect(params).toEqual(["the beatles", "unknown album"]);
    });

    it("getAlbumCover returns null when there's no override", async () => {
        fakeDb.select.mockResolvedValueOnce([]);
        expect(await getAlbumCover("Anyone", "Nope")).toBeNull();
    });

    it("two different artists' same-named album don't collide", async () => {
        await setAlbumCover("Artist A", "Greatest Hits", "data:a");
        await setAlbumCover("Artist B", "Greatest Hits", "data:b");
        expect(fakeDb.execute.mock.calls[0][1]?.slice(0, 2)).toEqual(["artist a", "greatest hits"]);
        expect(fakeDb.execute.mock.calls[1][1]?.slice(0, 2)).toEqual(["artist b", "greatest hits"]);
    });

    it("applyAlbumCovers guards the upsert on the incoming update being newer", async () => {
        await applyAlbumCovers([{ artist: "the beatles", album: "abbey road", image_data_uri: "data:x", updated_at: 500 }]);
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("WHERE excluded.updated_at > album_covers.updated_at");
        expect(params).toEqual(["the beatles", "abbey road", "data:x", 500]);
    });

    it("buildSyncSnapshot carries album cover overrides", async () => {
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("FROM album_covers")) {
                return [{ artist: "the beatles", album: "abbey road", image_data_uri: "data:x", updated_at: 999 }];
            }
            return [];
        });
        const snapshot = await buildSyncSnapshot();
        expect(snapshot.album_covers).toEqual([
            { artist: "the beatles", album: "abbey road", image_data_uri: "data:x", updated_at: 999 },
        ]);
    });

    it("applyManifestStats merges album_covers from the peer's manifest", async () => {
        const manifest: SyncSnapshot = {
            device_id: "mac-1",
            generated_at: 1,
            playlists: [],
            tracks: [],
            play_events: [],
            album_covers: [{ artist: "the beatles", album: "abbey road", image_data_uri: "data:x", updated_at: 42 }],
        };
        await applyManifestStats(manifest, "phone-1");
        const updates = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("album_covers"));
        expect(updates).toHaveLength(1);
        expect(updates[0][1]).toEqual(["the beatles", "abbey road", "data:x", 42]);
    });
});

// Non-destructive per-artist image overrides — keyed by artist name alone
// (see db.ts's migration 10 / artistCoverKey). Synced to Android read-only,
// same LWW convention as album covers.
describe("artist cover overrides", () => {
    it("setArtistCover upserts by artist, normalized, with a fresh timestamp", async () => {
        await setArtistCover(" The Beatles ", "data:image/jpeg;base64,AAA");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("INSERT INTO artist_covers");
        expect(params).toEqual(["the beatles", "data:image/jpeg;base64,AAA", params![2]]);
        expect(typeof params![2]).toBe("number");
    });

    it("getArtistCover normalizes and falls back blank artist to 'unknown artist'", async () => {
        await getArtistCover("");
        const [sql, params] = fakeDb.select.mock.calls[0];
        expect(sql).toContain("WHERE artist = $1");
        expect(params).toEqual(["unknown artist"]);
    });

    it("getArtistCover returns null when there's no override", async () => {
        fakeDb.select.mockResolvedValueOnce([]);
        expect(await getArtistCover("Anyone")).toBeNull();
    });

    it("setArtistCover with null clears the override", async () => {
        await setArtistCover("The Beatles", null);
        const [, params] = fakeDb.execute.mock.calls[0];
        expect(params).toEqual(["the beatles", null, params![2]]);
    });

    it("getArtistCoverKeys returns the set of normalized artist keys already set", async () => {
        fakeDb.select.mockResolvedValueOnce([{ artist: "the beatles" }, { artist: "queen" }]);
        const keys = await getArtistCoverKeys();
        expect(keys).toEqual(new Set(["the beatles", "queen"]));
    });

    it("applyArtistCovers chunks and guards the upsert on the incoming update being newer", async () => {
        await applyArtistCovers([{ artist: "the beatles", image_data_uri: "data:x", updated_at: 500 }]);
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("INSERT INTO artist_covers");
        expect(sql).toContain("WHERE excluded.updated_at > artist_covers.updated_at");
        expect(params).toEqual(["the beatles", "data:x", 500]);
    });

    it("buildSyncSnapshot carries artist image overrides", async () => {
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("FROM artist_covers")) {
                return [{ artist: "the beatles", image_data_uri: "data:x", updated_at: 999 }];
            }
            return [];
        });
        const snapshot = await buildSyncSnapshot();
        expect(snapshot.artist_covers).toEqual([
            { artist: "the beatles", image_data_uri: "data:x", updated_at: 999 },
        ]);
    });

    it("applyManifestStats merges artist_covers from the peer's manifest", async () => {
        const manifest: SyncSnapshot = {
            device_id: "mac-1",
            generated_at: 1,
            playlists: [],
            tracks: [],
            play_events: [],
            artist_covers: [{ artist: "the beatles", image_data_uri: "data:x", updated_at: 42 }],
        };
        await applyManifestStats(manifest, "phone-1");
        const updates = fakeDb.execute.mock.calls.filter(c => String(c[0]).includes("artist_covers"));
        expect(updates).toHaveLength(1);
        expect(updates[0][1]).toEqual(["the beatles", "data:x", 42]);
    });
});

// ---- Settings / identity / transcode: previously untested getter/setter
// pairs. dbRoundTrip.test.ts covers the same table (`settings`) end-to-end
// via getDeviceId; these pin the exact SQL shape so a refactor that
// accidentally changes a column/key name fails fast here instead of only
// showing up as a silently-reset preference at runtime.
describe("settings getters/setters", () => {
    it("getSetting reads by key, returning null when absent", async () => {
        expect(await getSetting("show_path_column")).toBeNull();
        const [sql, params] = fakeDb.select.mock.calls[0];
        expect(sql).toContain("SELECT value FROM settings WHERE key");
        expect(params).toEqual(["show_path_column"]);
    });

    it("getSetting returns the stored value", async () => {
        fakeDb.select.mockResolvedValueOnce([{ value: "1" }]);
        expect(await getSetting("show_path_column")).toBe("1");
    });

    it("setSetting upserts key/value", async () => {
        await setSetting("show_path_column", "1");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("INSERT INTO settings");
        expect(sql).toContain("ON CONFLICT(key) DO UPDATE");
        expect(params).toEqual(["show_path_column", "1"]);
    });

    it("getDeviceId generates and persists a uuid on first call, reuses it after", async () => {
        const id = await getDeviceId();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        const writeCall = fakeDb.execute.mock.calls.find(c => String(c[0]).includes("INSERT INTO settings"));
        expect(writeCall?.[1]).toEqual(["device_id", id]);

        fakeDb.select.mockResolvedValueOnce([{ value: id }]);
        expect(await getDeviceId()).toBe(id);
    });

    it("getSyncToken generates a hyphen-free token and persists it", async () => {
        const token = await getSyncToken();
        expect(token).not.toContain("-");
        expect(token).toHaveLength(32);
    });

    it("getSyncServerPort returns null for anything not a positive integer", async () => {
        for (const stored of [null, "0", "-1", "abc", ""]) {
            fakeDb.select.mockReset().mockResolvedValueOnce(stored == null ? [] : [{ value: stored }]);
            expect(await getSyncServerPort()).toBeNull();
        }
        fakeDb.select.mockReset().mockResolvedValueOnce([{ value: "9999" }]);
        expect(await getSyncServerPort()).toBe(9999);
    });

    it("setSyncServerPort writes the port as a setting", async () => {
        await setSyncServerPort(9999);
        const [, params] = fakeDb.execute.mock.calls[0];
        expect(params).toEqual(["sync_server_port", "9999"]);
    });

    it("getTranscodeOptions defaults to aac/256000 when unset", async () => {
        expect(await getTranscodeOptions()).toEqual({ format: "aac", bitrate: 256000 });
    });

    it("getTranscodeOptions reads back a stored flac/bitrate pair", async () => {
        fakeDb.select.mockImplementation(async (_sql: string, params?: unknown[]) => {
            const key = params?.[0] as string;
            if (key === "transcode_format") return [{ value: "flac" }];
            if (key === "transcode_bitrate") return [{ value: "192000" }];
            return [];
        });
        expect(await getTranscodeOptions()).toEqual({ format: "flac", bitrate: 192000 });
    });

    it("setTranscodeFormat / setTranscodeBitrate write through setSetting", async () => {
        await setTranscodeFormat("flac");
        await setTranscodeBitrate(128000);
        const calls = fakeDb.execute.mock.calls.map(c => c[1]);
        expect(calls).toContainEqual(["transcode_format", "flac"]);
        expect(calls).toContainEqual(["transcode_bitrate", "128000"]);
    });
});

describe("playlist CRUD", () => {
    it("createPlaylist inserts a row and returns an empty Playlist", async () => {
        const pl = await createPlaylist("My Mix", "custom");
        expect(pl).toEqual({ id: pl.id, name: "My Mix", type: "custom", tracks: [] });
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("INSERT INTO playlists");
        expect(params).toEqual([pl.id, "My Mix", "custom"]);
    });

    it("deletePlaylist removes the playlist and sweeps its playlist_tracks rows", async () => {
        await deletePlaylist("pl-1");
        const sqls = fakeDb.execute.mock.calls.map(c => String(c[0]));
        expect(sqls.some(s => s.includes("DELETE FROM playlists WHERE id"))).toBe(true);
        expect(sqls.some(s => s.includes("DELETE FROM playlist_tracks WHERE playlist_id"))).toBe(true);
    });

    it("clearPlaylistTracks deletes only that playlist's rows", async () => {
        await clearPlaylistTracks("pl-1");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toBe("DELETE FROM playlist_tracks WHERE playlist_id = $1");
        expect(params).toEqual(["pl-1"]);
    });

    it("updateLyrics writes lyrics by track id", async () => {
        await updateLyrics("t-1", "la la la");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toBe("UPDATE tracks SET lyrics = $1 WHERE id = $2");
        expect(params).toEqual(["la la la", "t-1"]);
    });

    it("setPlaylistSyncToDevice flips the flag as 0/1", async () => {
        await setPlaylistSyncToDevice("pl-1", true);
        expect(fakeDb.execute.mock.calls[0][1]).toEqual([1, "pl-1"]);
        fakeDb.execute.mockClear();
        await setPlaylistSyncToDevice("pl-1", false);
        expect(fakeDb.execute.mock.calls[0][1]).toEqual([0, "pl-1"]);
    });

    it("createSmartPlaylist inserts a row with type='smart' and serialized rules", async () => {
        const rules = { ...DEFAULT_SMART_RULES, conditions: [{ field: "genre" as const, op: "contains" as const, value: "Rock" }] };
        const pl = await createSmartPlaylist("Rock Mix", rules);
        expect(pl).toEqual({ id: pl.id, name: "Rock Mix", type: "smart", tracks: [], rules });
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("INSERT INTO playlists");
        expect(sql).toContain("'smart'");
        expect(params).toEqual([pl.id, "Rock Mix", JSON.stringify(rules)]);
    });

    it("updateSmartPlaylist writes name and serialized rules by id", async () => {
        const rules = { ...DEFAULT_SMART_RULES, limit: 10 };
        await updateSmartPlaylist("pl-1", "Renamed", rules);
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("UPDATE playlists SET name");
        expect(params).toEqual(["Renamed", JSON.stringify(rules), "pl-1"]);
    });

    it("getPlaylists parses rules only for type='smart', leaves it undefined otherwise", async () => {
        fakeDb.select.mockImplementation(async (sql: string) => {
            if (sql.includes("SELECT * FROM playlists")) {
                return [
                    { id: "s1", name: "Smart", type: "smart", rules: JSON.stringify({ ...DEFAULT_SMART_RULES, limit: 5 }) },
                    { id: "c1", name: "Custom", type: "custom", rules: null },
                ];
            }
            return [];
        });
        const [smart, custom] = await getPlaylists();
        expect(smart.rules).toEqual({ ...DEFAULT_SMART_RULES, limit: 5 });
        expect(custom.rules).toBeUndefined();
    });
});

describe("scan folders CRUD", () => {
    it("getScanFolders maps rows and defaults default_kind to 'music'", async () => {
        fakeDb.select.mockResolvedValueOnce([
            { path: "/music", playlist_id: "pl-1", default_kind: null },
        ]);
        expect(await getScanFolders()).toEqual([
            { path: "/music", playlist_id: "pl-1", default_kind: "music" },
        ]);
    });

    it("addScanFolder upserts by path, updating playlist_id on conflict", async () => {
        await addScanFolder("/music", "pl-1");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toContain("INSERT INTO scan_folders");
        expect(sql).toContain("ON CONFLICT(path) DO UPDATE SET playlist_id");
        expect(params?.[0]).toBe("/music");
        expect(params?.[1]).toBe("pl-1");
    });

    it("removeScanFolder deletes by path", async () => {
        await removeScanFolder("/music");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toBe("DELETE FROM scan_folders WHERE path = $1");
        expect(params).toEqual(["/music"]);
    });
});

describe("single-row mirror writers", () => {
    it("setTrackIdentity writes track_key + content_hash by id", async () => {
        await setTrackIdentity("t-1", "k1", "h1");
        const [sql, params] = fakeDb.execute.mock.calls[0];
        expect(sql).toBe("UPDATE tracks SET track_key = $1, content_hash = $2 WHERE id = $3");
        expect(params).toEqual(["k1", "h1", "t-1"]);
    });

});

describe("read-only getters", () => {
    it("getAllTracks selects every track with stats columns", async () => {
        await getAllTracks();
        expect(String(fakeDb.select.mock.calls[0][0])).toContain("FROM tracks t");
    });

    it("getAllAlbumCovers selects every override row", async () => {
        await getAllAlbumCovers();
        expect(String(fakeDb.select.mock.calls[0][0])).toContain("FROM album_covers");
    });

    it("getAllArtistCovers selects every override row", async () => {
        await getAllArtistCovers();
        expect(String(fakeDb.select.mock.calls[0][0])).toContain("FROM artist_covers");
    });

    it("loadHashCache selects every cached (path, size, mtime, hash, key) row", async () => {
        fakeDb.select.mockResolvedValueOnce([
            { file_path: "/m/a.mp3", size: 10, mtime: 1, content_hash: "h1", track_key: "k1" },
        ]);
        expect(await loadHashCache()).toEqual([
            { file_path: "/m/a.mp3", size: 10, mtime: 1, content_hash: "h1", track_key: "k1" },
        ]);
        expect(String(fakeDb.select.mock.calls[0][0])).toContain("FROM content_hash_cache");
    });
});
