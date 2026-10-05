// e2e for the backup export/import surface (db/backup.ts) over two real
// SQLite databases (source install + target install) — not a fakeDb mock,
// since what matters here lives in real SQL: ON CONFLICT behavior, whether
// an existing track's metadata survives a merge untouched, and whether a
// re-import of the same backup is idempotent. backup.test.ts already pins
// parseBackup/remapSmartRules's pure logic without a DB; this file is scoped
// to buildBackup/importSettings/importPlaylists themselves, run the same way
// dbRoundTrip.test.ts drives buildSyncSnapshot/applySyncInbox: two Device
// instances sharing one Node process via db.ts's module-level singleton.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Device } from "./test/sqliteDevice";
import { createDevice, setActiveDevice } from "./test/sqliteDevice";

vi.mock("@tauri-apps/plugin-sql", () => ({
    default: { load: async () => (await import("./test/sqliteDevice")).activeAdapter() },
}));

const fsExists = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@tauri-apps/plugin-fs", () => ({
    BaseDirectory: { AppLocalData: 1 },
    exists: (...a: unknown[]) => fsExists(...a),
    readTextFile: async () => "[]",
    writeTextFile: async () => {},
}));

import {
    _resetInitForTests,
    buildBackup,
    buildCoverImages,
    getAllAlbumCovers,
    getAllArtistCovers,
    importCovers,
    setAlbumCover,
    setArtistCover,
    createPlaylist,
    createSmartPlaylist,
    getDb,
    getPlaylists,
    getSetting,
    importPlaylists,
    importSettings,
    initDb,
    linkTracksToPlaylist,
    setPlaylistKind,
    setPlaylistSyncToDevice,
    setPlaylistTrackOrder,
    setSetting,
} from "./db";
import { DEFAULT_SMART_RULES } from "./smartPlaylist";

async function withDevice<T>(d: Device, fn: () => Promise<T>): Promise<T> {
    setActiveDevice(d);
    _resetInitForTests();
    await initDb();
    return fn();
}

async function insertTrack(opts: { id: string; file_path: string; title: string; track_key?: string }) {
    const db = await getDb();
    await db.execute(
        `INSERT INTO tracks (id, title, file_path, file_name, track_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [opts.id, opts.title, opts.file_path, opts.file_path.split("/").pop(), opts.track_key ?? null]
    );
}

describe("backup export/import round-trip over real SQLite", () => {
    let source: Device;
    let target: Device;

    beforeEach(() => {
        source = createDevice("source");
        target = createDevice("target");
        fsExists.mockReset();
        fsExists.mockImplementation(async () => true);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("carries settings, a custom playlist's tracks, and a folder playlist's manual order", async () => {
        await withDevice(source, async () => {
            await setSetting("ui_language", "ja");
            await setSetting("show_path_column", "1");
            // Not in BACKUP_SETTING_KEYS — must never travel.
            await setSetting("device_id", "source-device-id");

            await insertTrack({ id: "t-a", file_path: "/Music/a.mp3", title: "Song A" });
            await insertTrack({ id: "t-b", file_path: "/Music/b.mp3", title: "Song B" });
            const custom = await createPlaylist("My Mix", "custom");
            await linkTracksToPlaylist(custom.id, ["t-a", "t-b"]);
            await setPlaylistKind(custom.id, "music");
            await setPlaylistSyncToDevice(custom.id, true);

            // A folder playlist the user has drag-reordered (manual_order=1).
            const db = await getDb();
            await insertTrack({ id: "t-c", file_path: "/Music/Rock/c.mp3", title: "Song C" });
            await insertTrack({ id: "t-d", file_path: "/Music/Rock/d.mp3", title: "Song D" });
            const folderPl = await createPlaylist("Rock", "folder");
            await linkTracksToPlaylist(folderPl.id, ["t-c", "t-d"]);
            await setPlaylistTrackOrder(folderPl.id, ["t-d", "t-c"]); // reversed from insert order
            await db.execute(
                "INSERT INTO scan_folders (path, playlist_id, added_at) VALUES ($1, $2, $3)",
                ["/Music/Rock", folderPl.id, Date.now()]
            );
        });

        const backup = await withDevice(source, () => buildBackup("0.15.0"));

        expect(backup.settings).toEqual({ ui_language: "ja", show_path_column: "1" });
        expect(backup.playlists).toHaveLength(1);
        expect(backup.playlists[0]).toMatchObject({ name: "My Mix", type: "custom", sync_to_device: 1 });
        if (backup.playlists[0].type !== "custom" && backup.playlists[0].type !== "xml") throw new Error("unexpected type");
        expect(backup.playlists[0].tracks.map(t => t.file_path)).toEqual(["/Music/a.mp3", "/Music/b.mp3"]);

        expect(backup.folders).toHaveLength(1);
        expect(backup.folders[0]).toMatchObject({ path: "/Music/Rock", default_kind: "music" });
        // manual_order=1 -> track_paths reflects the drag-reordered position, not insert order.
        expect(backup.folders[0].playlist?.manual_order).toBe(1);
        expect(backup.folders[0].playlist?.track_paths).toEqual(["/Music/Rock/d.mp3", "/Music/Rock/c.mp3"]);

        await withDevice(target, async () => {
            await importSettings(backup.settings);
            expect(await getSetting("ui_language")).toBe("ja");
            expect(await getSetting("show_path_column")).toBe("1");
            // device_id was never in the backup, so importing it can't have set one.
            expect(await getSetting("device_id")).toBeNull();

            const idMap = new Map<string, string>();
            const { added, skipped, missingTracks } = await importPlaylists(backup.playlists, idMap);
            expect(added).toBe(1);
            expect(skipped).toBe(0);
            expect(missingTracks).toBe(0);

            const playlists = await getPlaylists();
            const imported = playlists.find(p => p.name === "My Mix");
            expect(imported).toBeTruthy();
            expect(imported!.sync_to_device).toBe(1);
            expect(imported!.tracks.map(t => t.file_path).sort()).toEqual(["/Music/a.mp3", "/Music/b.mp3"]);
            // exists() was stubbed true, so missing tracks were created fresh
            // from the backup's own metadata.
            expect(imported!.tracks.find(t => t.file_path === "/Music/a.mp3")?.title).toBe("Song A");
        });
    });

    it("importing a music-kind playlist leaves the kind of tracks it contains alone", async () => {
        await withDevice(target, async () => {
            // A podcast episode (classified by its folder), already in the library.
            await insertTrack({ id: "t-pod", file_path: "/Pod/ep1.mp3", title: "Episode 1" });
            const db = await getDb();
            await db.execute("UPDATE tracks SET kind = 'podcast', kind_updated_at = 1234 WHERE id = 't-pod'");

            await importPlaylists([{
                id: "pl-commute", name: "Commute", type: "custom", kind: "music", sync_to_device: 0,
                tracks: [{
                    file_path: "/Pod/ep1.mp3", file_name: "ep1.mp3", title: "Episode 1",
                    artist: null, album: null, duration: null, track_key: null, content_hash: null,
                    disc_no: null, track_no: null, genre: null, year: null, album_artist: null, composer: null,
                }],
            }], new Map());

            const rows: { kind: string; kind_updated_at: number }[] = await db.select(
                "SELECT kind, kind_updated_at FROM tracks WHERE id = 't-pod'"
            );
            expect(rows[0]).toEqual({ kind: "podcast", kind_updated_at: 1234 });
        });
    });

    it("remaps a smart playlist's playlist-id condition onto the newly-created local playlist", async () => {
        await withDevice(source, async () => {
            const custom = await createPlaylist("Favorites Base", "custom");
            const rules = {
                ...DEFAULT_SMART_RULES,
                conditions: [{ field: "playlist" as const, op: "in" as const, value: custom.id }],
            };
            await createSmartPlaylist("Derived Smart", rules);
        });

        const backup = await withDevice(source, () => buildBackup("0.15.0"));
        expect(backup.playlists).toHaveLength(2);
        const backedUpCustomId = backup.playlists.find(p => p.name === "Favorites Base")!.id;

        await withDevice(target, async () => {
            // Target already has a like-named custom playlist under a *different*
            // id (e.g. created locally before the backup ever existed) — so
            // importPlaylists must skip re-creating it and remap the smart
            // playlist's condition onto this existing id, not the backed-up one.
            const preExisting = await createPlaylist("Favorites Base", "custom");
            expect(preExisting.id).not.toBe(backedUpCustomId);

            const idMap = new Map<string, string>();
            const result = await importPlaylists(backup.playlists, idMap);
            expect(result).toMatchObject({ added: 1, skipped: 1 });

            const playlists = await getPlaylists();
            const newSmart = playlists.find(p => p.name === "Derived Smart")!;
            expect(newSmart.rules?.conditions[0]).toEqual({ field: "playlist", op: "in", value: preExisting.id });
        });
    });

    it("is idempotent: importing the same backup twice does not duplicate playlists or tracks", async () => {
        await withDevice(source, async () => {
            await insertTrack({ id: "t-a", file_path: "/Music/a.mp3", title: "Song A" });
            const custom = await createPlaylist("My Mix", "custom");
            await linkTracksToPlaylist(custom.id, ["t-a"]);
        });
        const backup = await withDevice(source, () => buildBackup("0.15.0"));

        await withDevice(target, async () => {
            const first = await importPlaylists(backup.playlists, new Map());
            expect(first).toMatchObject({ added: 1, skipped: 0 });

            const second = await importPlaylists(backup.playlists, new Map());
            expect(second).toMatchObject({ added: 0, skipped: 1 });

            const playlists = await getPlaylists();
            expect(playlists.filter(p => p.name === "My Mix")).toHaveLength(1);
            expect(playlists.find(p => p.name === "My Mix")!.tracks).toHaveLength(1);
        });
    });

    it("never overwrites an existing track's metadata, and counts a genuinely missing file", async () => {
        await withDevice(source, async () => {
            await insertTrack({ id: "t-a", file_path: "/Music/a.mp3", title: "Backup Title", track_key: "key-a" });
            await insertTrack({ id: "t-gone", file_path: "/Music/gone.mp3", title: "Gone" });
            const custom = await createPlaylist("My Mix", "custom");
            await linkTracksToPlaylist(custom.id, ["t-a", "t-gone"]);
        });
        const backup = await withDevice(source, () => buildBackup("0.15.0"));

        await withDevice(target, async () => {
            // Target already has this file under a different track id/title —
            // e.g. it was scanned locally with different tags before the import.
            await insertTrack({ id: "local-t-a", file_path: "/Music/a.mp3", title: "Local Title", track_key: "key-a" });

            fsExists.mockImplementation(async (path: unknown) => path !== "/Music/gone.mp3");

            const result = await importPlaylists(backup.playlists, new Map());
            expect(result.missingTracks).toBe(1);

            const playlists = await getPlaylists();
            const imported = playlists.find(p => p.name === "My Mix")!;
            expect(imported.tracks).toHaveLength(1);
            // Linked to the existing local row, and its title was NOT clobbered
            // with the backup's "Backup Title".
            expect(imported.tracks[0].id).toBe("local-t-a");
            expect(imported.tracks[0].title).toBe("Local Title");
        });
    });

    it("round-trips artist/album images as files, local wins, and is idempotent", async () => {
        const uri = (b: number) => `data:image/jpeg;base64,${btoa(String.fromCharCode(b, b + 1, b + 2))}`;
        const { backup, images } = await withDevice(source, async () => {
            await setArtistCover("Artist A", uri(1));
            await setArtistCover("Artist B", uri(10));
            await setArtistCover("Artist Cleared", null);
            await setAlbumCover("Artist A", "Album X", uri(20));
            const covers = await buildCoverImages();
            const b = await buildBackup("0.15.0");
            b.artist_covers = covers.artist_covers;
            b.album_covers = covers.album_covers;
            return { backup: b, images: covers.images };
        });

        expect(backup.artist_covers).toHaveLength(2); // the cleared (null) one is skipped
        expect(backup.album_covers).toHaveLength(1);
        expect([...images.keys()].every(k => k.startsWith("images/"))).toBe(true);

        await withDevice(target, async () => {
            // Local already has Artist B (different image) -> must not be overwritten.
            await setArtistCover("Artist B", uri(99));
            const first = await importCovers(backup, images);
            expect(first).toEqual({ artistImagesAdded: 1, albumCoversAdded: 1 });

            const artists = new Map((await getAllArtistCovers()).map(c => [c.artist, c.image_data_uri]));
            expect(artists.get("artist a")).toBe(uri(1));
            expect(artists.get("artist b")).toBe(uri(99));
            const albums = await getAllAlbumCovers();
            expect(albums[0]).toMatchObject({ artist: "artist a", album: "album x", image_data_uri: uri(20) });

            const again = await importCovers(backup, images);
            expect(again).toEqual({ artistImagesAdded: 0, albumCoversAdded: 0 });
        });
    });
});
