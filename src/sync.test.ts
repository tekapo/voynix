import { describe, expect, it } from "vitest";
import { chunk, favoriteWins, playStateWins, pool } from "./sync";

describe("pool", () => {
    it("processes every item and never exceeds the concurrency limit", async () => {
        const items = Array.from({ length: 10 }, (_, i) => i);
        const seen: number[] = [];
        let inFlight = 0;
        let peak = 0;
        await pool(items, 3, async (n) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 1));
            seen.push(n);
            inFlight--;
        });
        expect(seen.sort((a, b) => a - b)).toEqual(items);
        expect(peak).toBeLessThanOrEqual(3);
    });

    it("handles an empty list", async () => {
        let called = false;
        await pool([], 3, async () => { called = true; });
        expect(called).toBe(false);
    });
});

describe("chunk", () => {
    it("splits into groups of at most the given size, last group smaller", () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it("returns an empty array for an empty input", () => {
        expect(chunk([], 2)).toEqual([]);
    });
});

describe("favoriteWins", () => {
    it("takes the side with the newer timestamp", () => {
        expect(favoriteWins(
            { favorite: 1, favorite_updated_at: 100 },
            { favorite: 0, favorite_updated_at: 200 }
        )).toEqual({ favorite: 0, favorite_updated_at: 200 });
    });

    it("keeps local when it is newer or remote is unset", () => {
        expect(favoriteWins(
            { favorite: 1, favorite_updated_at: 300 },
            { favorite: 0, favorite_updated_at: 200 }
        )).toEqual({ favorite: 1, favorite_updated_at: 300 });
        expect(favoriteWins(
            { favorite: 1, favorite_updated_at: 5 },
            { favorite: 0, favorite_updated_at: null }
        )).toEqual({ favorite: 1, favorite_updated_at: 5 });
    });
});

describe("playStateWins", () => {
    it("takes the side with the newer timestamp", () => {
        expect(playStateWins(
            { play_state: "in_progress", resume_position: 30, play_state_updated_at: 100 },
            { play_state: "played", resume_position: 0, play_state_updated_at: 200 }
        )).toEqual({ play_state: "played", resume_position: 0, play_state_updated_at: 200 });
    });

    it("keeps local when it is newer or remote is unset", () => {
        expect(playStateWins(
            { play_state: "played", resume_position: 0, play_state_updated_at: 300 },
            { play_state: "in_progress", resume_position: 30, play_state_updated_at: 200 }
        )).toEqual({ play_state: "played", resume_position: 0, play_state_updated_at: 300 });
        expect(playStateWins(
            { play_state: "in_progress", resume_position: 12, play_state_updated_at: 5 },
            { play_state: "unplayed", resume_position: 0, play_state_updated_at: null }
        )).toEqual({ play_state: "in_progress", resume_position: 12, play_state_updated_at: 5 });
    });

    it("replaces the whole pair atomically — never mixes state with a stale position", () => {
        const winner = playStateWins(
            { play_state: "in_progress", resume_position: 500, play_state_updated_at: 10 },
            { play_state: "played", resume_position: 0, play_state_updated_at: 20 }
        );
        expect(winner).toEqual({ play_state: "played", resume_position: 0, play_state_updated_at: 20 });
    });
});
