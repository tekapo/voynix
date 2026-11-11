// deleteOrphanedTracksUnder runs after every folder rescan and deletes `tracks`
// rows, so it's pinned against real SQLite: only unlinked tracks under the
// folder go, and the path prefix must not leak into sibling folders.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice, setActiveDevice } from "./test/sqliteDevice";

vi.mock("@tauri-apps/plugin-sql", () => ({
    default: { load: async () => (await import("./test/sqliteDevice")).activeAdapter() },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
    BaseDirectory: { AppLocalData: 1 },
    exists: async () => true,
    readTextFile: async () => "[]",
    writeTextFile: async () => {},
}));

import {
    _resetInitForTests,
    createPlaylist,
    deleteOrphanedTracksUnder,
    getAllTracks,
    getDb,
    initDb,
    linkTracksToPlaylist,
} from "./db";

async function insertTrack(id: string, file_path: string) {
    const db = await getDb();
    await db.execute(
        "INSERT INTO tracks (id, title, file_path, file_name) VALUES ($1, $2, $3, $4)",
        [id, id, file_path, file_path.split("/").pop()]
    );
}

async function remainingIds(): Promise<string[]> {
    return (await getAllTracks()).map(t => t.id).sort();
}

describe("deleteOrphanedTracksUnder", () => {
    beforeEach(async () => {
        setActiveDevice(createDevice("orphans"));
        _resetInitForTests();
        await initDb();
        await insertTrack("linked", "/Music/a.mp3");
        await insertTrack("orphan", "/Music/gone.mp3");
        await insertTrack("orphan-nested", "/Music/Sub/gone.mp3");
        await insertTrack("sibling", "/Music2/gone.mp3");
        await insertTrack("other-playlist", "/Music/kept-elsewhere.mp3");
        const pl = await createPlaylist("Folder", "folder");
        await linkTracksToPlaylist(pl.id, ["linked"]);
        const other = await createPlaylist("Mix", "custom");
        await linkTracksToPlaylist(other.id, ["other-playlist"]);
    });

    it("deletes only unlinked tracks under the folder", async () => {
        await deleteOrphanedTracksUnder("/Music");
        expect(await remainingIds()).toEqual(["linked", "other-playlist", "sibling"]);
    });

    it("treats a trailing slash the same and does not touch a sibling folder with the same prefix", async () => {
        await deleteOrphanedTracksUnder("/Music/");
        expect(await remainingIds()).toEqual(["linked", "other-playlist", "sibling"]);
    });
});
