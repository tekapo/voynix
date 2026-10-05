import { describe, expect, it } from "vitest";
import {
    accumulateListened,
    effectiveSpeed,
    emptyListenProgress,
    formatSpeed,
    isNearEnd,
    nextPlayState,
    nextSpeed,
    parseSpeed,
    shouldCountPlay,
    skipTarget,
    SPEED_PRESETS,
} from "./playback";

describe("skipTarget", () => {
    it("adds the delta within the track", () => {
        expect(skipTarget(30, 10, 200)).toBe(40);
        expect(skipTarget(30, -10, 200)).toBe(20);
    });
    it("clamps to 0 and to the duration", () => {
        expect(skipTarget(5, -10, 200)).toBe(0);
        expect(skipTarget(195, 10, 200)).toBe(200);
    });
    it("only clamps the lower bound when duration is unknown", () => {
        expect(skipTarget(100, 10, 0)).toBe(110);
        expect(skipTarget(3, -10, 0)).toBe(0);
    });
});

describe("accumulateListened", () => {
    it("sums normal forward playback ticks", () => {
        let p = emptyListenProgress();
        for (const t of [0.25, 0.5, 0.75, 1.0]) p = accumulateListened(p, t);
        expect(p.secs).toBeCloseTo(1.0);
        expect(p.last).toBe(1.0);
    });

    it("ignores a forward seek", () => {
        let p = emptyListenProgress();
        p = accumulateListened(p, 0.5); // heard 0.5s
        p = accumulateListened(p, 120); // scrubbed to 2:00 — not listening
        expect(p.secs).toBeCloseTo(0.5);
        expect(p.last).toBe(120); // baseline still moves so the next tick measures from here
    });

    it("ignores a rewind", () => {
        let p = emptyListenProgress();
        p = accumulateListened(p, 40);
        p = accumulateListened(p, 5);
        expect(p.secs).toBe(0);
    });
});

describe("shouldCountPlay", () => {
    it("counts after 30 seconds heard", () => {
        expect(shouldCountPlay(30, 240)).toBe(true);
        expect(shouldCountPlay(29.9, 240)).toBe(false);
    });

    it("counts a short track at 50% heard", () => {
        expect(shouldCountPlay(10, 20)).toBe(true);
        expect(shouldCountPlay(9, 20)).toBe(false);
    });

    it("does not count when only a seek jumped the position", () => {
        // 0.5s actually heard on a 5-minute track after scrubbing to the end
        expect(shouldCountPlay(0.5, 300)).toBe(false);
    });

    it("handles unknown duration", () => {
        expect(shouldCountPlay(31, 0)).toBe(true);
        expect(shouldCountPlay(5, 0)).toBe(false);
    });
});

describe("isNearEnd", () => {
    it("is true within the last 30s", () => {
        expect(isNearEnd(3600 - 20, 3600)).toBe(true);
        expect(isNearEnd(3400, 3600)).toBe(false); // 200s left and under 95%
    });
    it("is true past 95% even when >30s from the end", () => {
        expect(isNearEnd(950, 1000)).toBe(true);  // 95%, but 50s left
        expect(isNearEnd(900, 1000)).toBe(false); // 90%, 100s left
    });
    it("is false with no duration", () => {
        expect(isNearEnd(10, 0)).toBe(false);
    });
});

describe("nextPlayState", () => {
    it("moves unplayed -> in_progress as playback advances", () => {
        expect(nextPlayState("unplayed", 300, 3600)).toEqual({ state: "in_progress", resume: 300 });
    });
    it("reaches played at the end and rewinds resume to 0", () => {
        expect(nextPlayState("in_progress", 3595, 3600)).toEqual({ state: "played", resume: 0 });
    });
    it("keeps played sticky while still at the end", () => {
        expect(nextPlayState("played", 3595, 3600)).toEqual({ state: "played", resume: 0 });
    });
    it("scrubbing a played episode back to the start reopens it as unplayed", () => {
        expect(nextPlayState("played", 0.5, 3600)).toEqual({ state: "unplayed", resume: 0 });
    });
    it("scrubbing an in_progress episode back to the start stays in_progress-ish (prev)", () => {
        expect(nextPlayState("in_progress", 0.5, 3600)).toEqual({ state: "in_progress", resume: 0 });
    });
});

describe("parseSpeed", () => {
    it("parses a valid preset", () => {
        expect(parseSpeed("1.5")).toBe(1.5);
        expect(parseSpeed("0.8")).toBe(0.8);
    });
    it("falls back to 1.0 for garbage, missing, or out-of-range values", () => {
        expect(parseSpeed(null)).toBe(1.0);
        expect(parseSpeed(undefined)).toBe(1.0);
        expect(parseSpeed("")).toBe(1.0);
        expect(parseSpeed("not a number")).toBe(1.0);
        expect(parseSpeed("3.0")).toBe(1.0);
        expect(parseSpeed("-1")).toBe(1.0);
    });
});

describe("nextSpeed", () => {
    it("cycles through the presets in order", () => {
        expect(nextSpeed(0.8)).toBe(1.0);
        expect(nextSpeed(1.0)).toBe(1.25);
        expect(nextSpeed(1.75)).toBe(2.0);
    });
    it("wraps from the last preset back to the first", () => {
        expect(nextSpeed(2.0)).toBe(0.8);
    });
    it("wraps an unknown value back to the first preset", () => {
        expect(nextSpeed(3.0)).toBe(0.8);
    });
});

describe("formatSpeed", () => {
    it("labels the speed with a trailing x", () => {
        expect(formatSpeed(1)).toBe("1x");
        expect(formatSpeed(1.25)).toBe("1.25x");
    });
});

describe("effectiveSpeed", () => {
    it("uses the stored speed for a podcast", () => {
        expect(effectiveSpeed("podcast", 1.5)).toBe(1.5);
    });
    it("is always 1.0 for music, regardless of the stored speed", () => {
        expect(effectiveSpeed("music", 1.5)).toBe(1.0);
        expect(effectiveSpeed(undefined, 1.5)).toBe(1.0);
    });
});

describe("SPEED_PRESETS", () => {
    it("includes the documented range", () => {
        expect(SPEED_PRESETS).toEqual([0.8, 1.0, 1.25, 1.5, 1.75, 2.0]);
    });
});
