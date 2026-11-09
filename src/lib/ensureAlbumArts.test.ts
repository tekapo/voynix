import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { buildAlbumReps, ensureAlbumArts } from "./ensureAlbumArts";

const describeTrack = (t: { artist: string; album: string; file_path: string }) => ({
    key: `${t.artist}|${t.album}`, artist: t.artist, album: t.album, lookupOnline: t.album !== "Folder",
});

describe("buildAlbumReps", () => {
    it("groups by key, keeps the first path and caps extras at 20", () => {
        const tracks = Array.from({ length: 25 }, (_, i) => ({ artist: "A", album: "X", file_path: `/m/${i}.mp3` }));
        tracks.push({ artist: "B", album: "Folder", file_path: "/f/1.mp3" });
        const reps = buildAlbumReps(tracks, describeTrack);
        expect(reps).toHaveLength(2);
        expect(reps[0].path).toBe("/m/0.mp3");
        expect(reps[0].extra).toHaveLength(20);
        expect(reps[1].lookupOnline).toBe(false);
    });
});

describe("ensureAlbumArts", () => {
    beforeEach(() => { invoke.mockReset(); });

    it("calls ensure_album_art per album and reports resolved ones", async () => {
        invoke.mockImplementation(async (_c: string, a: { album: string }) => a.album === "X");
        const reps = buildAlbumReps(
            [{ artist: "A", album: "X", file_path: "/1" }, { artist: "B", album: "Folder", file_path: "/2" }],
            describeTrack,
        );
        const onResolved = vi.fn();
        await ensureAlbumArts(reps, { concurrency: 2, onResolved });
        expect(invoke).toHaveBeenCalledWith("ensure_album_art", expect.objectContaining({ album: "Folder", lookupOnline: false }));
        expect(onResolved).toHaveBeenCalledTimes(1);
    });

    it("stops starting new albums once cancelled, and survives a failing call", async () => {
        invoke.mockRejectedValue(new Error("boom"));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const reps = buildAlbumReps(
            [1, 2, 3].map((i) => ({ artist: "A", album: `X${i}`, file_path: `/${i}` })), describeTrack);
        let cancelled = false;
        await ensureAlbumArts(reps, { concurrency: 1, isCancelled: () => cancelled });
        expect(invoke).toHaveBeenCalledTimes(3);
        invoke.mockClear();
        cancelled = true;
        await ensureAlbumArts(reps, { concurrency: 1, isCancelled: () => cancelled });
        expect(invoke).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
