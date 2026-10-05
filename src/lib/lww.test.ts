import { describe, expect, it } from "vitest";
import { lwwPick, mergeLww } from "./lww";

interface Row { key: string; value: string; ts: number | null }

describe("lwwPick", () => {
    it("picks b when b is strictly newer", () => {
        expect(lwwPick({ ts: 1 }, { ts: 2 }, v => v.ts)).toEqual({ ts: 2 });
    });

    it("keeps a on a tie", () => {
        expect(lwwPick({ ts: 5 }, { ts: 5 }, v => v.ts)).toEqual({ ts: 5 });
    });

    it("treats a null timestamp as oldest", () => {
        expect(lwwPick({ ts: null }, { ts: 0 }, v => v.ts)).toEqual({ ts: 0 });
        expect(lwwPick({ ts: 0 }, { ts: null }, v => v.ts)).toEqual({ ts: 0 });
    });
});

describe("mergeLww", () => {
    const r = (key: string, value: string, ts: number | null): Row => ({ key, value, ts });

    it("adds an incoming key not already present", () => {
        const result = mergeLww<Row>([], [r("a", "v1", 1)], x => x.key, x => x.ts);
        expect(result).toEqual([r("a", "v1", 1)]);
    });

    it("keeps the newer row for a key present in both", () => {
        const into = [r("a", "old", 1)];
        const incoming = [r("a", "new", 2)];
        expect(mergeLww(into, incoming, x => x.key, x => x.ts)).toEqual([r("a", "new", 2)]);
    });

    it("ignores an incoming row with a null timestamp", () => {
        const into = [r("a", "keep", 1)];
        const incoming = [r("a", "should-be-ignored", null)];
        expect(mergeLww(into, incoming, x => x.key, x => x.ts)).toEqual([r("a", "keep", 1)]);
    });

    it("dedupes a single list to one row per key, keeping the max timestamp", () => {
        const rows = [r("a", "v1", 1), r("a", "v2", 3), r("a", "v3", 2)];
        expect(mergeLww([], rows, x => x.key, x => x.ts)).toEqual([r("a", "v2", 3)]);
    });

    it("supports a custom pick function", () => {
        const into = [r("a", "old", 1)];
        const incoming = [r("a", "new", 2)];
        const result = mergeLww(into, incoming, x => x.key, x => x.ts, (cur, inc) => r(cur.key, `${cur.value}+${inc.value}`, inc.ts));
        expect(result).toEqual([r("a", "old+new", 2)]);
    });
});
