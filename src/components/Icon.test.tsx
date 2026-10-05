import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, IconName } from "./Icon";

const NAMES: IconName[] = [
    'music', 'star', 'star-filled', 'flame', 'mic', 'disc', 'folder', 'file-text',
    'smartphone', 'list-music', 'broadcast', 'settings', 'plus', 'menu', 'queue',
    'search', 'shuffle', 'repeat', 'repeat-one', 'skip-back', 'skip-forward',
    'skip-back-10', 'skip-forward-10',
    'rewind', 'fast-forward', 'play', 'pause', 'volume', 'lyrics',
    'chevron-up', 'chevron-down', 'x', 'check', 'wand',
];

describe("Icon", () => {
    it("renders an aria-hidden svg for every name", () => {
        for (const name of NAMES) {
            const { container, unmount } = render(<Icon name={name} />);
            const svg = container.querySelector("svg");
            expect(svg, name).not.toBeNull();
            expect(svg!.getAttribute("aria-hidden")).toBe("true");
            expect(svg!.classList.contains("icon")).toBe(true);
            unmount();
        }
    });

    it("honours the size prop and merges className", () => {
        const { container } = render(<Icon name="play" size={30} className="foo" />);
        const svg = container.querySelector("svg")!;
        expect(svg.getAttribute("width")).toBe("30");
        expect(svg.classList.contains("foo")).toBe(true);
    });

    it("draws the settings gear with equal x/y extents (not 縦長)", () => {
        const { container } = render(<Icon name="settings" />);
        const path = container.querySelector("path")!;
        const coords = [...path.getAttribute("d")!.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)]
            .map(m => [Number(m[1]), Number(m[2])] as const);
        const xs = coords.map(([x]) => x);
        const ys = coords.map(([, y]) => y);
        const width = Math.max(...xs) - Math.min(...xs);
        const height = Math.max(...ys) - Math.min(...ys);
        expect(Math.abs(width - height)).toBeLessThan(0.5);
        expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(12, 0);
        expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(12, 0);
    });
});
