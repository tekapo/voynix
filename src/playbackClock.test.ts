import { describe, expect, it, vi } from "vitest";
import { createPlaybackClock } from "./playbackClock";

describe("playbackClock", () => {
    it("starts at 0 by default and returns the given initial value", () => {
        expect(createPlaybackClock().get()).toBe(0);
        expect(createPlaybackClock(42).get()).toBe(42);
    });

    it("set updates the value returned by get", () => {
        const clock = createPlaybackClock();
        clock.set(12.5);
        expect(clock.get()).toBe(12.5);
    });

    it("notifies subscribers when the value changes", () => {
        const clock = createPlaybackClock();
        const listener = vi.fn();
        clock.subscribe(listener);
        clock.set(1);
        expect(listener).toHaveBeenCalledTimes(1);
        clock.set(2);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("does not notify when set to the same value", () => {
        const clock = createPlaybackClock(5);
        const listener = vi.fn();
        clock.subscribe(listener);
        clock.set(5);
        expect(listener).not.toHaveBeenCalled();
    });

    it("unsubscribe stops further notifications", () => {
        const clock = createPlaybackClock();
        const listener = vi.fn();
        const unsubscribe = clock.subscribe(listener);
        clock.set(1);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        clock.set(2);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("supports multiple independent subscribers", () => {
        const clock = createPlaybackClock();
        const a = vi.fn();
        const b = vi.fn();
        clock.subscribe(a);
        const unsubB = clock.subscribe(b);
        clock.set(1);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        unsubB();
        clock.set(2);
        expect(a).toHaveBeenCalledTimes(2);
        expect(b).toHaveBeenCalledTimes(1);
    });
});
