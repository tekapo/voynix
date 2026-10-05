// Real-SQLite coverage for updateTrackTags' play_events re-keying (see
// dbRoundTrip.test.ts's header for why this needs a real DB rather than the
// fakeDb mock in db.test.ts: the row-count guard that decides whether to move
// history is a live SELECT against the schema).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice, setActiveDevice, type Device } from "./test/sqliteDevice";

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

import { _resetInitForTests, getDb, initDb, recordPlayEvent, updateTrackTags } from "./db";

describe("updateTrackTags (play_events re-keying)", () => {
    let device: Device;

    beforeEach(async () => {
        device = createDevice("mac");
        setActiveDevice(device);
        _resetInitForTests();
        await initDb();
    });

    async function seedTrack(id: string, trackKey: string) {
        const db = await getDb();
        await db.execute(
            `INSERT INTO tracks (id, title, file_path, file_name, track_key, content_hash)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id, "Old Title", `/music/${id}.mp3`, `${id}.mp3`, trackKey, "hash-1"]
        );
    }

    it("moves play_events to the new track_key when it's the sole owner of the old key", async () => {
        await seedTrack("t1", "old-key");
        // Two distinct play_events for the same track_key — insert directly so
        // they don't collide on the (device_id, played_at, track_key) unique
        // index the way two recordPlayEvent() calls in the same millisecond would.
        const db = await getDb();
        await db.execute(
            "INSERT INTO play_events (id, track_key, played_at, device_id) VALUES ($1, $2, $3, $4)",
            ["e1", "old-key", 1000, "dev-a"]
        );
        await db.execute(
            "INSERT INTO play_events (id, track_key, played_at, device_id) VALUES ($1, $2, $3, $4)",
            ["e2", "old-key", 2000, "dev-a"]
        );

        await updateTrackTags(
            "t1",
            "old-key",
            { title: "New Title", artist: "New Artist", album: "New Album", disc_no: 1, track_no: 2 },
            "new-key",
            "hash-2"
        );

        const [track]: any[] = await db.select("SELECT title, artist, album, disc_no, track_no, track_key, content_hash FROM tracks WHERE id = $1", ["t1"]);
        expect(track).toMatchObject({
            title: "New Title",
            artist: "New Artist",
            album: "New Album",
            disc_no: 1,
            track_no: 2,
            track_key: "new-key",
            content_hash: "hash-2",
        });

        const oldEvents: any[] = await db.select("SELECT * FROM play_events WHERE track_key = $1", ["old-key"]);
        const newEvents: any[] = await db.select("SELECT * FROM play_events WHERE track_key = $1", ["new-key"]);
        expect(oldEvents).toHaveLength(0);
        expect(newEvents).toHaveLength(2);
    });

    it("leaves play_events on the old key when another track row still shares it (duplicate file)", async () => {
        await seedTrack("t1", "shared-key");
        await seedTrack("t2", "shared-key");
        await recordPlayEvent("shared-key");

        await updateTrackTags(
            "t1",
            "shared-key",
            { title: "New Title", artist: "", album: "", disc_no: null, track_no: null },
            "new-key",
            "hash-2"
        );

        const db = await getDb();
        const oldEvents: any[] = await db.select("SELECT * FROM play_events WHERE track_key = $1", ["shared-key"]);
        const newEvents: any[] = await db.select("SELECT * FROM play_events WHERE track_key = $1", ["new-key"]);
        expect(oldEvents).toHaveLength(1);
        expect(newEvents).toHaveLength(0);
    });

    it("doesn't touch play_events when the track_key is unchanged", async () => {
        await seedTrack("t1", "same-key");
        await recordPlayEvent("same-key");

        await updateTrackTags(
            "t1",
            "same-key",
            { title: "New Title", artist: "", album: "", disc_no: null, track_no: null },
            "same-key",
            "hash-2"
        );

        const db = await getDb();
        const events: any[] = await db.select("SELECT * FROM play_events WHERE track_key = $1", ["same-key"]);
        expect(events).toHaveLength(1);
    });
});
