import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMenuPosition } from "./useMenuPosition";

function TestMenu({ x, y }: { x: number; y: number }) {
    const { ref, style } = useMenuPosition(true, x, y);
    return <div ref={ref} data-testid="menu" style={{ position: "fixed", top: style.top, left: style.left }} />;
}

// Renders the hook with a mocked element size (jsdom's real
// getBoundingClientRect is always 0×0) and returns the resulting inline style.
function measure(x: number, y: number, width: number, height: number) {
    const spy = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue({ width, height } as DOMRect);
    const { getByTestId } = render(<TestMenu x={x} y={y} />);
    const style = getByTestId("menu").style;
    spy.mockRestore();
    return { top: parseFloat(style.top), left: parseFloat(style.left) };
}

describe("useMenuPosition", () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;

    afterEach(() => {
        Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: originalInnerHeight, configurable: true });
    });

    it("keeps the cursor position when the menu fits on screen", () => {
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
        expect(measure(100, 100, 200, 150)).toEqual({ top: 100, left: 100 });
    });

    it("flips above the cursor when the menu would overflow the bottom", () => {
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
        // A short (3-item) menu opened near the bottom of a tall window —
        // this is the sidebar-playlist right-click bug.
        expect(measure(100, 780, 200, 120)).toEqual({ top: 660, left: 100 }); // 780 - 120
    });

    it("clamps to the top edge if flipping above the cursor still overflows", () => {
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });
        expect(measure(100, 280, 200, 500).top).toBe(8);
    });

    it("pulls left when the menu would overflow the right edge", () => {
        Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
        expect(measure(450, 100, 200, 150)).toEqual({ top: 100, left: 250 }); // 450 - 200
    });
});
