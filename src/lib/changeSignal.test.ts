import { describe, expect, it, vi } from "vitest";
import { createChangeSignal } from "./changeSignal";

describe("createChangeSignal", () => {
    it("starts at version 0", () => {
        expect(createChangeSignal().getVersion()).toBe(0);
    });

    it("bump() increments the version", () => {
        const s = createChangeSignal();
        s.bump();
        expect(s.getVersion()).toBe(1);
        s.bump();
        expect(s.getVersion()).toBe(2);
    });

    it("bump() notifies every subscribed listener", () => {
        const s = createChangeSignal();
        const a = vi.fn();
        const b = vi.fn();
        s.subscribe(a);
        s.subscribe(b);
        s.bump();
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it("unsubscribing stops further notifications", () => {
        const s = createChangeSignal();
        const listener = vi.fn();
        const unsubscribe = s.subscribe(listener);
        unsubscribe();
        s.bump();
        expect(listener).not.toHaveBeenCalled();
    });
});
