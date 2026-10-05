import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Track } from "../types";
import { QueuePanel } from "./QueuePanel";

const track = (id: string, title: string): Track =>
    ({ id, title, artist: "A", file_path: `/${id}`, file_name: `${id}.mp3` } as Track);

// queue index i holds track "t{i}"; order below plays them 0,1,2,3,4 with the
// cursor on position 2 (track t2).
const queue = [0, 1, 2, 3, 4].map(i => track(`t${i}`, `Track ${i}`));
const base = {
    open: true,
    onClose: () => {},
    queue,
    order: [0, 1, 2, 3, 4],
    orderPos: 2,
    onJump: () => {},
    onMove: () => {},
    onRemove: () => {},
};

const rows = () => screen.getAllByRole("listitem");

describe("QueuePanel", () => {
    it("shows the empty state when there is no order", () => {
        render(<QueuePanel {...base} order={[]} orderPos={-1} />);
        expect(screen.getByText("The queue is empty.")).toBeInTheDocument();
    });

    it("marks played / current / upcoming rows", () => {
        render(<QueuePanel {...base} />);
        const r = rows();
        expect(r[1].className).toContain("is-played");
        expect(r[2].className).toContain("is-current");
        expect(r[3].className).toContain("is-upcoming");
    });

    it("only upcoming rows carry reorder controls, and the current row isn't jumpable", () => {
        render(<QueuePanel {...base} />);
        const r = rows();
        expect(within(r[2]).queryByLabelText("Remove from queue")).toBeNull();
        expect(within(r[2]).getByRole("button")).toBeDisabled();
        expect(within(r[3]).getByLabelText("Remove from queue")).toBeInTheDocument();
    });

    it("disables ▲ on the first upcoming row and ▼ on the last", () => {
        render(<QueuePanel {...base} />);
        const r = rows();
        expect(within(r[3]).getByLabelText("Move up")).toBeDisabled();
        expect(within(r[4]).getByLabelText("Move up")).toBeEnabled();
        expect(within(r[4]).getByLabelText("Move down")).toBeDisabled();
    });

    it("wires jump / move / remove to the right positions", () => {
        const onJump = vi.fn();
        const onMove = vi.fn();
        const onRemove = vi.fn();
        render(<QueuePanel {...base} onJump={onJump} onMove={onMove} onRemove={onRemove} />);
        const r = rows();
        fireEvent.click(within(r[1]).getByRole("button")); // jump to a played row
        expect(onJump).toHaveBeenCalledWith(1);
        fireEvent.click(within(r[4]).getByLabelText("Move up"));
        expect(onMove).toHaveBeenCalledWith(4, -1);
        fireEvent.click(within(r[3]).getByLabelText("Remove from queue"));
        expect(onRemove).toHaveBeenCalledWith(3);
    });
});
