import { describe, it, expect } from "vitest";
import { evaluateSmartPlaylist, parseSmartRules, sanitizeSmartRules, DEFAULT_SMART_RULES, serializeSmartRules } from "./smartPlaylist";
import { SmartRules, Track } from "./types";

function track(overrides: Partial<Track>): Track {
    return {
        id: overrides.id ?? "id",
        title: overrides.id ?? "title",
        file_path: `/x/${overrides.id}`,
        file_name: `${overrides.id}.mp3`,
        ...overrides,
    };
}

function rules(overrides: Partial<SmartRules>): SmartRules {
    return { ...DEFAULT_SMART_RULES, ...overrides };
}

const NO_MEMBERSHIP = new Map<string, Set<string>>();
const NOW = 1_700_000_000_000; // fixed instant so "in_last" tests are deterministic

describe("parseSmartRules", () => {
    it("returns the default for null/undefined", () => {
        expect(parseSmartRules(null)).toEqual(DEFAULT_SMART_RULES);
        expect(parseSmartRules(undefined)).toEqual(DEFAULT_SMART_RULES);
    });

    it("returns the default for corrupt JSON", () => {
        expect(parseSmartRules("{not json")).toEqual(DEFAULT_SMART_RULES);
    });

    it("returns the default when conditions isn't an array", () => {
        expect(parseSmartRules(JSON.stringify({ match: "all" }))).toEqual(DEFAULT_SMART_RULES);
    });

    it("round-trips through serializeSmartRules", () => {
        const r = rules({ match: "any", conditions: [{ field: "genre", op: "contains", value: "Rock" }], limit: 25 });
        expect(parseSmartRules(serializeSmartRules(r))).toEqual(r);
    });

    it("clamps a non-positive limit to null", () => {
        expect(parseSmartRules(JSON.stringify({ conditions: [], limit: 0 })).limit).toBeNull();
        expect(parseSmartRules(JSON.stringify({ conditions: [], limit: -5 })).limit).toBeNull();
    });
});

describe("sanitizeSmartRules", () => {
    it("returns null when there is no conditions array", () => {
        expect(sanitizeSmartRules(null)).toBeNull();
        expect(sanitizeSmartRules({ match: "any" })).toBeNull();
    });

    it("accepts every well-formed condition shape", () => {
        const conditions = [
            { field: "title", op: "starts_with", value: "A" },
            { field: "year", op: "gt", value: 1990 },
            { field: "duration", op: "between", value: 60, value2: 300 },
            { field: "added_at", op: "in_last", value: 2, unit: "weeks" },
            { field: "kind", op: "is", value: "podcast" },
            { field: "favorite", op: "is_true" },
            { field: "play_state", op: "is_not", value: "played" },
            { field: "playlist", op: "in", value: "pl-1" },
        ];
        expect(sanitizeSmartRules({ conditions })?.conditions).toEqual(conditions);
    });

    it("drops conditions whose value would break evaluation (undefined text, NaN, unknown enum)", () => {
        const out = sanitizeSmartRules({
            conditions: [
                { field: "artist", op: "is" },
                { field: "year", op: "eq", value: NaN },
                { field: "kind", op: "is", value: "video" },
                { field: "play_state", op: "is", value: "half" },
                { field: "favorite", op: "maybe" },
            ],
        });
        expect(out?.conditions).toEqual([]);
    });
});

describe("evaluateSmartPlaylist", () => {
    it("matches everything when there are no conditions", () => {
        const tracks = [track({ id: "a" }), track({ id: "b" })];
        expect(evaluateSmartPlaylist(rules({}), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a", "b"]);
    });

    describe("text conditions", () => {
        it("contains / not_contains ignore case and width", () => {
            const tracks = [track({ id: "a", genre: "Ｊ-POP" }), track({ id: "b", genre: "Rock" })];
            const r = rules({ conditions: [{ field: "genre", op: "contains", value: "j-pop" }] });
            expect(evaluateSmartPlaylist(r, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);

            const rNot = rules({ conditions: [{ field: "genre", op: "not_contains", value: "j-pop" }] });
            expect(evaluateSmartPlaylist(rNot, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["b"]);
        });

        it("is / is_not require an exact match", () => {
            const tracks = [track({ id: "a", artist: "AKB48" }), track({ id: "b", artist: "AKB" })];
            const r = rules({ conditions: [{ field: "artist", op: "is", value: "akb48" }] });
            expect(evaluateSmartPlaylist(r, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
        });

        it("starts_with / ends_with", () => {
            const tracks = [track({ id: "a", title: "Intro" }), track({ id: "b", title: "Outro" })];
            const starts = rules({ conditions: [{ field: "title", op: "starts_with", value: "In" }] });
            expect(evaluateSmartPlaylist(starts, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
            const ends = rules({ conditions: [{ field: "title", op: "ends_with", value: "tro" }] });
            expect(evaluateSmartPlaylist(ends, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a", "b"]);
        });

        it("treats a missing tag as empty string", () => {
            const tracks = [track({ id: "a" /* no genre */ })];
            const r = rules({ conditions: [{ field: "genre", op: "not_contains", value: "rock" }] });
            expect(evaluateSmartPlaylist(r, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
            const rIsNot = rules({ conditions: [{ field: "genre", op: "is_not", value: "rock" }] });
            expect(evaluateSmartPlaylist(rIsNot, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
        });
    });

    describe("number conditions", () => {
        it("gt / lt / eq / between", () => {
            const tracks = [track({ id: "a", play_count: 1 }), track({ id: "b", play_count: 5 }), track({ id: "c", play_count: 10 })];
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "play_count", op: "gt", value: 3 }] }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["b", "c"]);
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "play_count", op: "lt", value: 5 }] }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "play_count", op: "between", value: 2, value2: 8 }] }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["b"]);
        });

        it("treats a missing play_count as 0", () => {
            const tracks = [track({ id: "a" })];
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "play_count", op: "eq", value: 0 }] }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
        });

        it("a missing tag-derived number matches only ne", () => {
            const tracks = [track({ id: "a" /* no year */ })];
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "year", op: "gt", value: 2000 }] }), tracks, NO_MEMBERSHIP, NOW)).toEqual([]);
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "year", op: "ne", value: 2000 }] }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
        });
    });

    describe("date conditions", () => {
        it("in_last / not_in_last", () => {
            const oneDay = 24 * 60 * 60 * 1000;
            const tracks = [
                track({ id: "recent", last_played: NOW - oneDay }),
                track({ id: "old", last_played: NOW - 30 * oneDay }),
                track({ id: "never" }),
            ];
            const r = rules({ conditions: [{ field: "last_played", op: "in_last", value: 7, unit: "days" }] });
            expect(evaluateSmartPlaylist(r, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["recent"]);
            const rNot = rules({ conditions: [{ field: "last_played", op: "not_in_last", value: 7, unit: "days" }] });
            expect(evaluateSmartPlaylist(rNot, tracks, NO_MEMBERSHIP, NOW).map(t => t.id).sort()).toEqual(["never", "old"]);
        });
    });

    describe("kind / favorite / play_state", () => {
        it("kind is / is_not", () => {
            const tracks = [track({ id: "a", kind: "music" }), track({ id: "b", kind: "podcast" })];
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "kind", op: "is", value: "podcast" }] }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["b"]);
        });

        it("favorite is_true / is_false", () => {
            const tracks = [track({ id: "a", favorite: 1 }), track({ id: "b", favorite: 0 })];
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "favorite", op: "is_true" }] }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
        });

        it("play_state is / is_not", () => {
            const tracks = [track({ id: "a", play_state: "played" }), track({ id: "b", play_state: "unplayed" })];
            expect(evaluateSmartPlaylist(rules({ conditions: [{ field: "play_state", op: "is_not", value: "played" }] }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["b"]);
        });
    });

    describe("playlist condition", () => {
        it("in / not_in reference an existing (non-smart) playlist's membership", () => {
            const tracks = [track({ id: "a" }), track({ id: "b" })];
            const membership = new Map([["favorites-mix", new Set(["a"])]]);
            const r = rules({ conditions: [{ field: "playlist", op: "in", value: "favorites-mix" }] });
            expect(evaluateSmartPlaylist(r, tracks, membership, NOW).map(t => t.id)).toEqual(["a"]);
        });

        it("treats a deleted/unknown playlist id as matching nothing", () => {
            const tracks = [track({ id: "a" })];
            const r = rules({ conditions: [{ field: "playlist", op: "in", value: "gone" }] });
            expect(evaluateSmartPlaylist(r, tracks, NO_MEMBERSHIP, NOW)).toEqual([]);
            const rNot = rules({ conditions: [{ field: "playlist", op: "not_in", value: "gone" }] });
            expect(evaluateSmartPlaylist(rNot, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
        });
    });

    describe("match all vs any", () => {
        it("all requires every condition; any requires one", () => {
            const tracks = [
                track({ id: "a", genre: "Rock", play_count: 10 }),
                track({ id: "b", genre: "Rock", play_count: 0 }),
                track({ id: "c", genre: "Jazz", play_count: 10 }),
            ];
            const conditions = [
                { field: "genre" as const, op: "is" as const, value: "Rock" },
                { field: "play_count" as const, op: "gt" as const, value: 5 },
            ];
            expect(evaluateSmartPlaylist(rules({ match: "all", conditions }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a"]);
            expect(evaluateSmartPlaylist(rules({ match: "any", conditions }), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a", "b", "c"]);
        });
    });

    describe("sort and limit", () => {
        it("sorts by the given key/direction", () => {
            const tracks = [track({ id: "a", play_count: 1 }), track({ id: "b", play_count: 3 }), track({ id: "c", play_count: 2 })];
            const r = rules({ sortBy: "play_count", sortDesc: true });
            expect(evaluateSmartPlaylist(r, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["b", "c", "a"]);
        });

        it("falls back to natural order (artist/album/disc/track/title)", () => {
            const tracks = [
                track({ id: "b", artist: "Z", title: "one" }),
                track({ id: "a", artist: "A", title: "one" }),
            ];
            expect(evaluateSmartPlaylist(rules({}), tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["a", "b"]);
        });

        it("applies the limit after sorting", () => {
            const tracks = Array.from({ length: 10 }, (_, i) => track({ id: `t${i}`, play_count: i }));
            const r = rules({ sortBy: "play_count", sortDesc: true, limit: 3 });
            expect(evaluateSmartPlaylist(r, tracks, NO_MEMBERSHIP, NOW).map(t => t.id)).toEqual(["t9", "t8", "t7"]);
        });
    });
});
