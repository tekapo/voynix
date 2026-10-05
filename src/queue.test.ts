import { describe, expect, it } from "vitest";
import { buildOrder, cycleRepeat, effectiveShuffle, isPodcastQueue, peekNext, removeUpcoming, reorderUpcoming, stepOrder } from "./queue";

/** Deterministic LCG so a "shuffle" is reproducible in tests. */
const lcg = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
};

const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const isPermutationOf = (a: number[], n: number) =>
    a.length === n && new Set(a).size === n && sorted(a).every((v, i) => v === i);

describe("buildOrder", () => {
    it("returns identity in sequential mode and ignores first/avoidFirst", () => {
        expect(buildOrder(4, { shuffle: false })).toEqual([0, 1, 2, 3]);
        expect(buildOrder(4, { shuffle: false, first: 2, avoidFirst: 1 })).toEqual([0, 1, 2, 3]);
    });

    it("handles degenerate lengths", () => {
        expect(buildOrder(0, { shuffle: true })).toEqual([]);
        expect(buildOrder(-3, { shuffle: true })).toEqual([]);
        expect(buildOrder(1, { shuffle: true })).toEqual([0]);
    });

    it("always yields a complete permutation", () => {
        for (let s = 1; s <= 20; s++) {
            expect(isPermutationOf(buildOrder(10, { shuffle: true, rng: lcg(s) }), 10)).toBe(true);
        }
    });

    it("pins the exact Fisher–Yates result for a fixed rng", () => {
        // descending swap with j = 0 at every step
        expect(buildOrder(4, { shuffle: true, rng: () => 0 })).toEqual([1, 2, 3, 0]);
    });

    it("puts `first` at position 0 and keeps a full permutation", () => {
        for (let s = 1; s <= 10; s++) {
            const o = buildOrder(8, { shuffle: true, first: 5, rng: lcg(s) });
            expect(o[0]).toBe(5);
            expect(isPermutationOf(o, 8)).toBe(true);
        }
    });

    it("ignores an out-of-range `first`", () => {
        expect(isPermutationOf(buildOrder(6, { shuffle: true, first: -1, rng: lcg(2) }), 6)).toBe(true);
        expect(isPermutationOf(buildOrder(6, { shuffle: true, first: 99, rng: lcg(2) }), 6)).toBe(true);
    });

    it("keeps `avoidFirst` out of position 0 while staying a full permutation", () => {
        for (let s = 1; s <= 20; s++) {
            const o = buildOrder(5, { shuffle: true, avoidFirst: 3, rng: lcg(s) });
            expect(o[0]).not.toBe(3);
            expect(isPermutationOf(o, 5)).toBe(true);
        }
    });

    it("cannot honour avoidFirst on a single-track queue", () => {
        expect(buildOrder(1, { shuffle: true, avoidFirst: 0 })).toEqual([0]);
    });

    it("lets `first` win over `avoidFirst`", () => {
        const o = buildOrder(6, { shuffle: true, first: 2, avoidFirst: 2, rng: lcg(4) });
        expect(o[0]).toBe(2);
    });

    it("is deterministic for a given rng", () => {
        expect(buildOrder(12, { shuffle: true, rng: lcg(7) })).toEqual(
            buildOrder(12, { shuffle: true, rng: lcg(7) }),
        );
    });
});

describe("stepOrder", () => {
    it("moves forward inside bounds", () => {
        expect(stepOrder(0, 3, 1, { repeat: "off" })).toEqual({ pos: 1, reshuffle: false });
    });

    it("handles the forward end per repeat mode", () => {
        expect(stepOrder(2, 3, 1, { repeat: "off" })).toBeNull();
        expect(stepOrder(2, 3, 1, { repeat: "all" })).toEqual({ pos: 0, reshuffle: true });
        expect(stepOrder(2, 3, 1, { repeat: "one" })).toEqual({ pos: 0, reshuffle: true });
    });

    it("moves backward inside bounds", () => {
        expect(stepOrder(2, 3, -1, { repeat: "off" })).toEqual({ pos: 1, reshuffle: false });
    });

    it("clamps or wraps backward, never reshuffling", () => {
        expect(stepOrder(0, 3, -1, { repeat: "off" })).toEqual({ pos: 0, reshuffle: false });
        expect(stepOrder(0, 3, -1, { repeat: "all" })).toEqual({ pos: 2, reshuffle: false });
        expect(stepOrder(0, 3, -1, { repeat: "one" })).toEqual({ pos: 2, reshuffle: false });
    });

    it("handles a single-track order", () => {
        expect(stepOrder(0, 1, 1, { repeat: "off" })).toBeNull();
        expect(stepOrder(0, 1, 1, { repeat: "all" })).toEqual({ pos: 0, reshuffle: true });
        expect(stepOrder(0, 1, -1, { repeat: "off" })).toEqual({ pos: 0, reshuffle: false });
    });

    it("returns null for an empty order", () => {
        expect(stepOrder(0, 0, 1, { repeat: "all" })).toBeNull();
        expect(stepOrder(0, 0, -1, { repeat: "all" })).toBeNull();
    });

    it("handles pos -1 (nothing started yet)", () => {
        expect(stepOrder(-1, 4, 1, { repeat: "off" })).toEqual({ pos: 0, reshuffle: false });
        expect(stepOrder(-1, 4, -1, { repeat: "off" })).toEqual({ pos: 0, reshuffle: false });
        expect(stepOrder(-1, 4, -1, { repeat: "all" })).toEqual({ pos: 3, reshuffle: false });
    });
});

describe("shuffle pass (buildOrder + stepOrder together)", () => {
    it("plays every track once before repeating", () => {
        const order = buildOrder(10, { shuffle: true, rng: lcg(3) });
        const played = [order[0]];
        let pos = 0;
        for (let i = 0; i < 9; i++) {
            const step = stepOrder(pos, order.length, 1, { repeat: "off" })!;
            pos = step.pos;
            played.push(order[pos]);
        }
        expect(isPermutationOf(played, 10)).toBe(true);
    });

    it("retraces the exact played sequence backward with ⏮", () => {
        const order = buildOrder(10, { shuffle: true, rng: lcg(5) });
        const forward: number[] = [order[0]];
        let pos = 0;
        for (let i = 0; i < 9; i++) {
            pos = stepOrder(pos, order.length, 1, { repeat: "off" })!.pos;
            forward.push(order[pos]);
        }
        const backward: number[] = [order[pos]];
        for (let i = 0; i < 9; i++) {
            pos = stepOrder(pos, order.length, -1, { repeat: "off" })!.pos;
            backward.push(order[pos]);
        }
        expect(backward).toEqual([...forward].reverse());
    });

    it("reshuffles at the wrap without replaying the just-finished track", () => {
        for (let s = 1; s <= 8; s++) {
            const order = buildOrder(6, { shuffle: true, rng: lcg(s) });
            const last = order[order.length - 1];
            const step = stepOrder(order.length - 1, order.length, 1, { repeat: "all" })!;
            expect(step.reshuffle).toBe(true);
            const next = buildOrder(6, { shuffle: true, avoidFirst: last, rng: lcg(s + 100) });
            expect(next[0]).not.toBe(last);
            expect(isPermutationOf(next, 6)).toBe(true);
        }
    });

    it("visits both tracks of a 2-track queue exactly once and ⏮ returns to the first", () => {
        const order = buildOrder(2, { shuffle: true, first: 1, rng: lcg(9) });
        expect(order).toEqual([1, 0]);
        const fwd = stepOrder(0, 2, 1, { repeat: "off" })!;
        expect(order[fwd.pos]).toBe(0);
        const back = stepOrder(fwd.pos, 2, -1, { repeat: "off" })!;
        expect(order[back.pos]).toBe(1);
    });
});

describe("reorderUpcoming", () => {
    // order positions:    0  1  2* 3  4  5   (2 = current, orderPos = 2)
    const order = [10, 11, 12, 13, 14, 15];

    it("swaps an upcoming entry with its neighbour", () => {
        expect(reorderUpcoming(order, 2, 4, -1)).toEqual([10, 11, 12, 14, 13, 15]);
        expect(reorderUpcoming(order, 2, 3, 1)).toEqual([10, 11, 12, 14, 13, 15]);
    });

    it("won't move the current track or history, or across the cursor", () => {
        expect(reorderUpcoming(order, 2, 2, 1)).toBe(order); // current
        expect(reorderUpcoming(order, 2, 1, 1)).toBe(order); // history
        expect(reorderUpcoming(order, 2, 3, -1)).toBe(order); // first upcoming can't go up past current
    });

    it("won't move past the ends", () => {
        expect(reorderUpcoming(order, 2, 5, 1)).toBe(order);
        expect(reorderUpcoming(order, 2, 0, -1)).toBe(order);
    });

    it("leaves the cursor's track and history untouched", () => {
        const out = reorderUpcoming(order, 2, 3, 1);
        expect(out.slice(0, 3)).toEqual([10, 11, 12]);
    });
});

describe("removeUpcoming", () => {
    const order = [10, 11, 12, 13, 14, 15]; // orderPos = 2

    it("drops an upcoming entry", () => {
        expect(removeUpcoming(order, 2, 4)).toEqual([10, 11, 12, 13, 15]);
    });

    it("keeps history and the current track", () => {
        expect(removeUpcoming(order, 2, 2)).toBe(order);
        expect(removeUpcoming(order, 2, 0)).toBe(order);
    });

    it("ignores an out-of-range position", () => {
        expect(removeUpcoming(order, 2, 6)).toBe(order);
        expect(removeUpcoming(order, 2, -1)).toBe(order);
    });
});

describe("cycleRepeat", () => {
    it("goes off → all → one → off", () => {
        expect(cycleRepeat("off")).toBe("all");
        expect(cycleRepeat("all")).toBe("one");
        expect(cycleRepeat("one")).toBe("off");
    });
});

describe("effectiveShuffle", () => {
    const music = [{ kind: "music" }, { kind: undefined }];
    const podcast = [{ kind: "podcast" }, { kind: "podcast" }];
    const mixed = [{ kind: "music" }, { kind: "podcast" }];

    it("isPodcastQueue is true only for a non-empty all-podcast queue", () => {
        expect(isPodcastQueue(podcast)).toBe(true);
        expect(isPodcastQueue(mixed)).toBe(false);
        expect(isPodcastQueue(music)).toBe(false);
        expect(isPodcastQueue([])).toBe(false);
    });

    it("turns shuffle off for a Podcast queue when the setting is on", () => {
        expect(effectiveShuffle(true, true, podcast)).toBe(false);
    });

    it("keeps shuffle for music and mixed queues", () => {
        expect(effectiveShuffle(true, true, music)).toBe(true);
        expect(effectiveShuffle(true, true, mixed)).toBe(true);
    });

    it("keeps shuffle for a Podcast queue when the setting is off", () => {
        expect(effectiveShuffle(true, false, podcast)).toBe(true);
    });

    it("never turns shuffle on", () => {
        expect(effectiveShuffle(false, false, music)).toBe(false);
        expect(effectiveShuffle(false, true, podcast)).toBe(false);
    });
});

describe("peekNext", () => {
    it("returns the following queue index inside bounds", () => {
        expect(peekNext(0, [3, 1, 2], { repeat: "off", shuffled: false })).toBe(1);
    });

    it("returns null on an empty order", () => {
        expect(peekNext(0, [], { repeat: "off", shuffled: false })).toBeNull();
    });

    it("returns null past the end with repeat off", () => {
        expect(peekNext(2, [3, 1, 2], { repeat: "off", shuffled: false })).toBeNull();
        expect(peekNext(2, [3, 1, 2], { repeat: "off", shuffled: true })).toBeNull();
    });

    it("wraps to the start past the end with repeat all, unshuffled", () => {
        expect(peekNext(2, [3, 1, 2], { repeat: "all", shuffled: false })).toBe(3);
    });

    it("can't predict a shuffled repeat-all wrap (a fresh deal happens at the boundary)", () => {
        expect(peekNext(2, [3, 1, 2], { repeat: "all", shuffled: true })).toBeNull();
    });

    it("repeat one always points at the current track, mid-queue or at the end", () => {
        expect(peekNext(1, [3, 1, 2], { repeat: "one", shuffled: false })).toBe(1);
        expect(peekNext(2, [3, 1, 2], { repeat: "one", shuffled: true })).toBe(2);
    });

    it("repeat one on an empty order is still null", () => {
        expect(peekNext(0, [], { repeat: "one", shuffled: false })).toBeNull();
    });
});
