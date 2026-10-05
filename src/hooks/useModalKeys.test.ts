import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useModalKeys } from "./useModalKeys";

function fireKey(init: Partial<KeyboardEventInit> & { key: string }) {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("useModalKeys", () => {
    it("calls onEscape on Escape", () => {
        const onEscape = vi.fn();
        renderHook(() => useModalKeys({ onEscape, onSave: vi.fn(), canSave: false }));
        fireKey({ key: "Escape" });
        expect(onEscape).toHaveBeenCalledTimes(1);
    });

    it("calls onSave on Cmd/Ctrl+S only when canSave is true", () => {
        const onSave = vi.fn();
        const { rerender } = renderHook(
            ({ canSave }) => useModalKeys({ onEscape: vi.fn(), onSave, canSave }),
            { initialProps: { canSave: false } },
        );
        fireKey({ key: "s", metaKey: true });
        expect(onSave).not.toHaveBeenCalled();

        rerender({ canSave: true });
        fireKey({ key: "s", ctrlKey: true });
        expect(onSave).toHaveBeenCalledTimes(1);
    });

    it("attaches no listener at all when enabled is false", () => {
        const onEscape = vi.fn();
        renderHook(() => useModalKeys({ enabled: false, onEscape, onSave: vi.fn(), canSave: true }));
        fireKey({ key: "Escape" });
        expect(onEscape).not.toHaveBeenCalled();
    });

    it("detaches the listener on unmount", () => {
        const onEscape = vi.fn();
        const { unmount } = renderHook(() => useModalKeys({ onEscape, onSave: vi.fn(), canSave: false }));
        unmount();
        fireKey({ key: "Escape" });
        expect(onEscape).not.toHaveBeenCalled();
    });
});
