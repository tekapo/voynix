import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => null as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => invoke(...a) }));

const getAlbumCover = vi.fn(async (_artist: string, _album: string) => null as string | null);
vi.mock("./db", () => ({ getAlbumCover: (...a: [string, string]) => getAlbumCover(...a) }));

import { invalidateAlbumArt, useAlbumThumb, useNowPlayingArtwork } from "./albumArt";
import { Track } from "./types";

const track = (over: Partial<Track> = {}): Track => ({
    id: "t1",
    title: "Song",
    artist: "Artist A",
    album: "Album A",
    file_path: "/m/a.mp3",
    file_name: "a.mp3",
    duration: 100,
    ...over,
});

beforeEach(() => {
    invoke.mockReset().mockResolvedValue(null);
    getAlbumCover.mockReset().mockResolvedValue(null);
    invalidateAlbumArt();
});

describe("useNowPlayingArtwork", () => {
    it("prefers a user-set album cover override over anything else", async () => {
        getAlbumCover.mockResolvedValue("data:image/jpeg;base64,OVERRIDE");
        invoke.mockResolvedValue("data:image/jpeg;base64,EMBEDDED");
        const { result } = renderHook(() => useNowPlayingArtwork(track(), true));
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,OVERRIDE"));
        expect(invoke).not.toHaveBeenCalledWith("get_track_artwork", expect.anything());
    });

    it("falls back to the embedded cover when there's no override", async () => {
        invoke.mockImplementation(async (cmd: string) =>
            cmd === "get_track_artwork" ? "data:image/jpeg;base64,EMBEDDED" : null,
        );
        const { result } = renderHook(() => useNowPlayingArtwork(track(), true));
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,EMBEDDED"));
    });

    it("does not hit the online fallback while the track is merely armed (online=false)", async () => {
        const { result } = renderHook(() => useNowPlayingArtwork(track(), false));
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_track_artwork", { path: "/m/a.mp3" }));
        expect(result.current).toBeNull();
        expect(invoke).not.toHaveBeenCalledWith("fetch_album_art", expect.anything());
    });

    it("falls back to the online lookup once the track is actually loaded (online=true)", async () => {
        invoke.mockImplementation(async (cmd: string) =>
            cmd === "fetch_album_art" ? "data:image/jpeg;base64,ITUNES" : null,
        );
        const { result } = renderHook(() => useNowPlayingArtwork(track(), true));
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,ITUNES"));
        expect(invoke).toHaveBeenCalledWith("fetch_album_art", { artist: "Artist A", album: "Album A" });
    });

    it("clears the previous track's cover immediately when the track changes", async () => {
        invoke.mockResolvedValue("data:image/jpeg;base64,FIRST");
        const { result, rerender } = renderHook(({ t }) => useNowPlayingArtwork(t, true), {
            initialProps: { t: track({ id: "t1" }) },
        });
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,FIRST"));

        invoke.mockResolvedValue("data:image/jpeg;base64,SECOND");
        rerender({ t: track({ id: "t2", album: "Album B" }) });
        // Synchronously cleared, before the new track's async resolution lands.
        expect(result.current).toBeNull();
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,SECOND"));
    });

    it("re-resolves after invalidateAlbumArt() (e.g. Set/Reset Album Cover)", async () => {
        invoke.mockResolvedValue("data:image/jpeg;base64,OLD");
        const { result } = renderHook(() => useNowPlayingArtwork(track(), true));
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,OLD"));

        getAlbumCover.mockResolvedValue("data:image/jpeg;base64,NEW_OVERRIDE");
        act(() => invalidateAlbumArt());
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,NEW_OVERRIDE"));
    });

    it("returns null for no track", () => {
        const { result } = renderHook(() => useNowPlayingArtwork(null, true));
        expect(result.current).toBeNull();
    });
});

describe("useAlbumThumb", () => {
    it("returns null for no track, without calling get_album_thumb", () => {
        const { result } = renderHook(() => useAlbumThumb(null));
        expect(result.current).toBeNull();
        expect(invoke).not.toHaveBeenCalled();
    });

    it("prefers a user-set album cover override over the thumbnail lookup", async () => {
        getAlbumCover.mockResolvedValue("data:image/jpeg;base64,OVERRIDE");
        invoke.mockResolvedValue("data:image/jpeg;base64,THUMB");
        const { result } = renderHook(() => useAlbumThumb(track()));
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,OVERRIDE"));
        expect(invoke).not.toHaveBeenCalledWith("get_album_thumb", expect.anything());
    });

    it("falls back to get_album_thumb when there's no override", async () => {
        invoke.mockResolvedValue("data:image/jpeg;base64,THUMB");
        const { result } = renderHook(() => useAlbumThumb(track(), 256));
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,THUMB"));
        expect(invoke).toHaveBeenCalledWith("get_album_thumb", {
            artist: "Artist A", album: "Album A", path: "/m/a.mp3", size: 256,
        });
    });

    it("caches by (artist, album, size): a second mount with the same key doesn't re-invoke", async () => {
        invoke.mockResolvedValue("data:image/jpeg;base64,THUMB");
        const first = renderHook(() => useAlbumThumb(track()));
        await waitFor(() => expect(first.result.current).toBe("data:image/jpeg;base64,THUMB"));

        const second = renderHook(() => useAlbumThumb(track()));
        expect(second.result.current).toBe("data:image/jpeg;base64,THUMB");
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it("re-resolves after invalidateAlbumArt()", async () => {
        invoke.mockResolvedValue("data:image/jpeg;base64,OLD");
        const { result } = renderHook(() => useAlbumThumb(track()));
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,OLD"));

        invoke.mockResolvedValue("data:image/jpeg;base64,NEW");
        act(() => invalidateAlbumArt());
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,NEW"));
    });
});
