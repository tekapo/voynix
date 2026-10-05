// artistArt.ts is the structural twin of albumArt.ts (in-memory cache +
// generation-bumped invalidate), minus the embedded/online fallback — a
// track has no "artist photo" of its own, only a user-set override. Modeled
// on albumArt.test.ts.
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getArtistCover = vi.fn(async (_artist: string) => null as string | null);
vi.mock("./db", () => ({ getArtistCover: (...a: [string]) => getArtistCover(...a) }));

import { invalidateArtistArt, useArtistThumb } from "./artistArt";

beforeEach(() => {
    getArtistCover.mockReset().mockResolvedValue(null);
    invalidateArtistArt();
});

describe("useArtistThumb", () => {
    it("returns null for no artist, without calling getArtistCover", () => {
        const { result } = renderHook(() => useArtistThumb(null));
        expect(result.current).toBeNull();
        expect(getArtistCover).not.toHaveBeenCalled();
    });

    it("resolves the override once it loads", async () => {
        getArtistCover.mockResolvedValue("data:image/jpeg;base64,PHOTO");
        const { result } = renderHook(() => useArtistThumb("The Beatles"));
        expect(result.current).toBeNull(); // not yet resolved
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,PHOTO"));
    });

    it("returns null (not loading forever) when there's no override", async () => {
        const { result } = renderHook(() => useArtistThumb("Unknown Artist"));
        await waitFor(() => expect(getArtistCover).toHaveBeenCalled());
        expect(result.current).toBeNull();
    });

    it("normalizes artist name (trim + lowercase) for the cache key: one fetch for two spellings", async () => {
        getArtistCover.mockResolvedValue("data:image/jpeg;base64,PHOTO");
        const first = renderHook(() => useArtistThumb("The Beatles"));
        await waitFor(() => expect(first.result.current).toBe("data:image/jpeg;base64,PHOTO"));

        const second = renderHook(() => useArtistThumb("  the beatles  "));
        // Cache hit — resolves without a second async round trip.
        expect(second.result.current).toBe("data:image/jpeg;base64,PHOTO");
        expect(getArtistCover).toHaveBeenCalledTimes(1);
    });

    it("re-resolves after invalidateArtistArt() (e.g. Set/Reset Artist Image)", async () => {
        getArtistCover.mockResolvedValue("data:image/jpeg;base64,OLD");
        const { result } = renderHook(() => useArtistThumb("The Beatles"));
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,OLD"));

        getArtistCover.mockResolvedValue("data:image/jpeg;base64,NEW");
        act(() => invalidateArtistArt());
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,NEW"));
    });

    it("switching to a different artist re-resolves for that name", async () => {
        getArtistCover.mockImplementation(async (artist: string) =>
            artist === "Artist A" ? "data:image/jpeg;base64,A" : "data:image/jpeg;base64,B",
        );
        const { result, rerender } = renderHook(({ a }) => useArtistThumb(a), {
            initialProps: { a: "Artist A" },
        });
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,A"));

        rerender({ a: "Artist B" });
        await waitFor(() => expect(result.current).toBe("data:image/jpeg;base64,B"));
    });

    // Note: the cache's MAX=300 LRU-ish eviction (artistArt.ts:11,22-27) is
    // deliberately left uncovered here — exercising it needs 300+ distinct
    // cache entries, which is slow (multiple seconds) for a property that
    // isn't on the surface of any of the planned refactors.
});
