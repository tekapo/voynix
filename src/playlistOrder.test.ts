import { describe, expect, it } from "vitest";
import { moveItem, restoreManualOrder } from "./playlistOrder";

describe("moveItem", () => {
    it("moves an item later in the list", () => {
        expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    });

    it("moves an item earlier in the list", () => {
        expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    });

    it("moves the first item to the front — no-op but a valid drop", () => {
        expect(moveItem(["a", "b", "c"], 0, 0)).toEqual(["a", "b", "c"]);
    });

    it("moves an item to the very end", () => {
        expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    });

    it("moves an item to the very start", () => {
        expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    });

    it("returns the same array reference when from === to", () => {
        const list = ["a", "b", "c"];
        expect(moveItem(list, 1, 1)).toBe(list);
    });

    it("returns the same array reference for an out-of-range index", () => {
        const list = ["a", "b", "c"];
        expect(moveItem(list, -1, 1)).toBe(list);
        expect(moveItem(list, 1, 3)).toBe(list);
        expect(moveItem(list, 5, 0)).toBe(list);
    });

    it("does not mutate the input array", () => {
        const list = ["a", "b", "c"];
        moveItem(list, 0, 2);
        expect(list).toEqual(["a", "b", "c"]);
    });
});

describe("restoreManualOrder", () => {
    const byPath = (p: string) => p;

    it("keeps the old relative order for tracks still present", () => {
        const scanned = ["/c.mp3", "/a.mp3", "/b.mp3"]; // scan (filesystem) order
        const oldPositions = new Map([["/a.mp3", 0], ["/b.mp3", 1], ["/c.mp3", 2]]);
        expect(restoreManualOrder(scanned, oldPositions, byPath)).toEqual(["/a.mp3", "/b.mp3", "/c.mp3"]);
    });

    it("appends never-seen-before files at the end, in scan order", () => {
        const scanned = ["/new2.mp3", "/b.mp3", "/new1.mp3", "/a.mp3"];
        const oldPositions = new Map([["/a.mp3", 0], ["/b.mp3", 1]]);
        expect(restoreManualOrder(scanned, oldPositions, byPath))
            .toEqual(["/a.mp3", "/b.mp3", "/new2.mp3", "/new1.mp3"]);
    });

    it("drops files that disappeared without leaving a gap", () => {
        const scanned = ["/a.mp3", "/c.mp3"]; // /b.mp3 was deleted
        const oldPositions = new Map([["/a.mp3", 0], ["/b.mp3", 1], ["/c.mp3", 2]]);
        expect(restoreManualOrder(scanned, oldPositions, byPath)).toEqual(["/a.mp3", "/c.mp3"]);
    });

    it("falls back to scan order entirely when nothing was previously known", () => {
        const scanned = ["/b.mp3", "/a.mp3"];
        expect(restoreManualOrder(scanned, new Map(), byPath)).toEqual(["/b.mp3", "/a.mp3"]);
    });
});
