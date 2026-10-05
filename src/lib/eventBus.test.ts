import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "./eventBus";

interface TestEvents {
    onFoo: (n: number) => void;
    onBar: () => void;
}

describe("createEventBus", () => {
    it("calls a listener's matching handler with the emitted args", () => {
        const bus = createEventBus<TestEvents>();
        const onFoo = vi.fn();
        bus.subscribe({ onFoo });
        bus.emit("onFoo", 42);
        expect(onFoo).toHaveBeenCalledWith(42);
    });

    it("skips a listener that didn't register a handler for this event", () => {
        const bus = createEventBus<TestEvents>();
        const onFoo = vi.fn();
        bus.subscribe({ onBar: vi.fn() }); // no onFoo — must not throw
        bus.subscribe({ onFoo });
        expect(() => bus.emit("onFoo", 1)).not.toThrow();
        expect(onFoo).toHaveBeenCalledWith(1);
    });

    it("notifies every subscribed listener", () => {
        const bus = createEventBus<TestEvents>();
        const a = vi.fn();
        const b = vi.fn();
        bus.subscribe({ onBar: a });
        bus.subscribe({ onBar: b });
        bus.emit("onBar");
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe stops further calls to that listener", () => {
        const bus = createEventBus<TestEvents>();
        const onFoo = vi.fn();
        const unsubscribe = bus.subscribe({ onFoo });
        unsubscribe();
        bus.emit("onFoo", 1);
        expect(onFoo).not.toHaveBeenCalled();
    });

    it("clear() drops every subscriber", () => {
        const bus = createEventBus<TestEvents>();
        const onFoo = vi.fn();
        bus.subscribe({ onFoo });
        bus.clear();
        bus.emit("onFoo", 1);
        expect(onFoo).not.toHaveBeenCalled();
    });
});
