import { describe, expect, it } from "vitest";
import { compareNatural, nextSort, sortNatural, sortTracks, SortState } from "./trackSort";
import { Track } from "./types";
import naturalSortDivergence from "../docs/test-vectors/natural-sort-divergence.json";

const t = (over: Partial<Track>): Track => ({
    id: Math.random().toString(36).slice(2),
    title: "T",
    file_path: "/x.mp3",
    file_name: "x.mp3",
    ...over,
});

const titles = (ts: Track[]) => ts.map(x => x.title);

describe("nextSort", () => {
    it("starts a fresh column ascending", () => {
        expect(nextSort(null, "title")).toEqual({ key: "title", dir: "asc" });
        expect(nextSort({ key: "artist", dir: "desc" }, "title")).toEqual({ key: "title", dir: "asc" });
    });
    it("flips asc -> desc on the active column, then clears", () => {
        expect(nextSort({ key: "title", dir: "asc" }, "title")).toEqual({ key: "title", dir: "desc" });
        expect(nextSort({ key: "title", dir: "desc" }, "title")).toBeNull();
    });
});

describe("sortTracks", () => {
    it("returns the same reference when sort is null", () => {
        const list = [t({ title: "b" }), t({ title: "a" })];
        expect(sortTracks(list, null)).toBe(list);
    });

    it("sorts by title ascending and descending, case-insensitive with numeric awareness", () => {
        const list = [t({ title: "Track 10" }), t({ title: "track 2" }), t({ title: "Album" })];
        expect(titles(sortTracks(list, { key: "title", dir: "asc" }))).toEqual(["Album", "track 2", "Track 10"]);
        expect(titles(sortTracks(list, { key: "title", dir: "desc" }))).toEqual(["Track 10", "track 2", "Album"]);
    });

    it("orders Japanese titles", () => {
        const list = [t({ title: "さくら" }), t({ title: "あさ" }), t({ title: "かぜ" })];
        expect(titles(sortTracks(list, { key: "title", dir: "asc" }))).toEqual(["あさ", "かぜ", "さくら"]);
    });

    it("falls back to 'Unknown Artist' / 'Unknown Album' like the row does", () => {
        const list = [
            t({ title: "has-artist", artist: "ZZ Top" }),
            t({ title: "no-artist" }),
        ];
        // "Unknown Artist" < "ZZ Top"
        expect(titles(sortTracks(list, { key: "artist", dir: "asc" }))).toEqual(["no-artist", "has-artist"]);
    });

    it("treats missing plays / duration as 0", () => {
        const list = [
            t({ title: "c", play_count: 5 }),
            t({ title: "a" }),
            t({ title: "b", play_count: 2 }),
        ];
        expect(titles(sortTracks(list, { key: "plays", dir: "asc" }))).toEqual(["a", "b", "c"]);
        const byDur = [t({ title: "x", duration: 100 }), t({ title: "y" })];
        expect(titles(sortTracks(byDur, { key: "duration", dir: "asc" }))).toEqual(["y", "x"]);
    });

    it("is stable — equal keys keep their incoming order", () => {
        const list = [t({ title: "same", id: "1" }), t({ title: "same", id: "2" }), t({ title: "same", id: "3" })];
        const sorted = sortTracks(list, { key: "title", dir: "asc" } as SortState);
        expect(sorted.map(x => x.id)).toEqual(["1", "2", "3"]);
    });

    it("does not mutate the input array", () => {
        const list = [t({ title: "b" }), t({ title: "a" })];
        sortTracks(list, { key: "title", dir: "asc" });
        expect(titles(list)).toEqual(["b", "a"]);
    });
});

describe("sortNatural / compareNatural", () => {
    it("orders by artist -> album -> disc -> track -> title", () => {
        const list = [
            t({ title: "B-a1-d1-t2", artist: "B", album: "A", disc_no: 1, track_no: 2 }),
            t({ title: "A-a2-d1-t1", artist: "A", album: "Z", disc_no: 1, track_no: 1 }),
            t({ title: "A-a1-d2-t1", artist: "A", album: "A", disc_no: 2, track_no: 1 }),
            t({ title: "A-a1-d1-t1", artist: "A", album: "A", disc_no: 1, track_no: 1 }),
        ];
        expect(titles(sortNatural(list))).toEqual([
            "A-a1-d1-t1", "A-a1-d2-t1", "A-a2-d1-t1", "B-a1-d1-t2",
        ]);
    });

    it("keeps two artists' same-named albums apart", () => {
        const list = [
            t({ title: "beta", artist: "Beck", album: "Hits", track_no: 1 }),
            t({ title: "alpha", artist: "ABBA", album: "Hits", track_no: 1 }),
        ];
        expect(titles(sortNatural(list))).toEqual(["alpha", "beta"]);
    });

    it("puts un-numbered tracks at the end of their album, blank artist/album last", () => {
        const list = [
            t({ title: "no-num", artist: "A", album: "A" }),
            t({ title: "numbered", artist: "A", album: "A", track_no: 1 }),
            t({ title: "orphan" }),
        ];
        expect(titles(sortNatural(list))).toEqual(["numbered", "no-num", "orphan"]);
    });

    it("is a pure comparator and does not mutate its input", () => {
        const list = [t({ title: "b", artist: "B" }), t({ title: "a", artist: "A" })];
        expect(compareNatural(list[0], list[1])).toBeGreaterThan(0);
        sortNatural(list);
        expect(titles(list)).toEqual(["b", "a"]);
    });

    // Pinned to docs/test-vectors/natural-sort-divergence.json: JS's natural
    // order is numeric-aware, unlike the SQL and Kotlin "twins" of this same
    // function (see the vector file for the known, not-yet-fixed gap). This
    // test exists so a future change to compareNatural's numeric behavior is
    // a deliberate, visible decision — not a silent regression either way.
    it("orders same-album title tiebreaks numerically (documented divergence from SQL/Kotlin)", () => {
        const list = naturalSortDivergence.titles.map(title => t({ title, artist: "A", album: "A" }));
        expect(titles(sortNatural(list))).toEqual(naturalSortDivergence.numeric_aware_order);
    });
});
