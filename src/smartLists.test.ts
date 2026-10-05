import { describe, it, expect } from "vitest";
import { isLibrarySyncSource, libraryListTracks, mostPlayed, recentlyAdded, recentlyPlayed } from "./smartLists";
import { Track } from "./types";

function track(overrides: Partial<Track>): Track {
    return {
        id: overrides.id ?? "id",
        title: overrides.id ?? "title",
        file_path: `/x/${overrides.id}`,
        file_name: `${overrides.id}.mp3`,
        ...overrides,
    };
}

describe("mostPlayed", () => {
    it("excludes zero-play tracks and sorts descending", () => {
        const tracks = [
            track({ id: "a", play_count: 0 }),
            track({ id: "b", play_count: 5 }),
            track({ id: "c", play_count: 10 }),
        ];
        expect(mostPlayed(tracks).map(t => t.id)).toEqual(["c", "b"]);
    });

    it("caps at 100", () => {
        const tracks = Array.from({ length: 150 }, (_, i) => track({ id: `t${i}`, play_count: i + 1 }));
        expect(mostPlayed(tracks)).toHaveLength(100);
    });
});

describe("recentlyAdded", () => {
    it("excludes podcasts and tracks with no added_at, sorts newest first", () => {
        const tracks = [
            track({ id: "a", added_at: 100 }),
            track({ id: "b", added_at: 300 }),
            track({ id: "c", added_at: 200, kind: "podcast" }),
            track({ id: "d" }),
        ];
        expect(recentlyAdded(tracks).map(t => t.id)).toEqual(["b", "a"]);
    });
});

describe("recentlyPlayed", () => {
    it("excludes never-played tracks and sorts newest first", () => {
        const tracks = [
            track({ id: "a", last_played: 100 }),
            track({ id: "b", last_played: 300 }),
            track({ id: "c" }),
        ];
        expect(recentlyPlayed(tracks).map(t => t.id)).toEqual(["b", "a"]);
    });
});

describe("libraryListTracks", () => {
    const tracks = [
        track({ id: "a", favorite: 1, play_count: 3, added_at: 10, last_played: 5 }),
        track({ id: "b", favorite: 0, play_count: 0 }),
    ];

    it("returns each Library entry's tracks", () => {
        expect(libraryListTracks("all_songs", tracks).map(t => t.id)).toEqual(["a", "b"]);
        expect(libraryListTracks("favorites", tracks).map(t => t.id)).toEqual(["a"]);
        expect(libraryListTracks("most_played", tracks).map(t => t.id)).toEqual(["a"]);
        expect(libraryListTracks("recently_added", tracks).map(t => t.id)).toEqual(["a"]);
        expect(libraryListTracks("recently_played", tracks).map(t => t.id)).toEqual(["a"]);
    });

    it("validates source names", () => {
        expect(isLibrarySyncSource("favorites")).toBe(true);
        expect(isLibrarySyncSource("artists")).toBe(false);
    });
});
