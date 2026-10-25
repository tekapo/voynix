import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackList } from "./TrackList";
import { Track } from "../types";

const track: Track = {
    id: "t1",
    title: "Song One",
    artist: "Artist One",
    album: "Album One",
    file_path: "/Users/me/Music/song-one.flac",
    file_name: "song-one.flac",
};

const track2: Track = {
    id: "t2",
    title: "Song Two",
    artist: "Artist Two",
    file_path: "/Users/me/Music/song-two.mp3",
    file_name: "song-two.mp3",
};

const noop = () => {};
const base = {
    tracks: [track],
    currentTrack: null,
    onTrackClick: noop,
    onTrackActivate: noop,
    onContextMenu: noop,
    onToggleFavorite: noop,
};

describe("TrackList Path column", () => {
    it("hides the Path column by default", () => {
        render(<TrackList {...base} />);
        expect(screen.queryByText("Path")).not.toBeInTheDocument();
        expect(screen.queryByText(track.file_path)).not.toBeInTheDocument();
        // other columns still there
        expect(screen.getByText("Song One")).toBeInTheDocument();
    });

    it("shows the Path column and the file path when showPath is set", () => {
        render(<TrackList {...base} showPath />);
        expect(screen.getByText("Path")).toBeInTheDocument();
        expect(screen.getByText(track.file_path)).toBeInTheDocument();
    });

    it("renders the empty state for an empty list", () => {
        render(<TrackList {...base} tracks={[]} />);
        expect(screen.getByText("No tracks found.")).toBeInTheDocument();
    });
});

describe("TrackList podcast badge", () => {
    it("shows no badge for music tracks", () => {
        const { container } = render(<TrackList {...base} />);
        expect(container.querySelector(".podcast-badge")).toBeNull();
    });

    it("shows an unplayed badge for an unplayed podcast", () => {
        const pod: Track = { ...track, kind: "podcast", play_state: "unplayed" };
        const { container } = render(<TrackList {...base} tracks={[pod]} />);
        expect(container.querySelector(".podcast-badge--unplayed")).not.toBeNull();
    });

    it("shows an in-progress badge with percentage in the title", () => {
        const pod: Track = { ...track, kind: "podcast", play_state: "in_progress", duration: 100, resume_position: 40 };
        const { container } = render(<TrackList {...base} tracks={[pod]} />);
        const badge = container.querySelector(".podcast-badge--in_progress");
        expect(badge).not.toBeNull();
        expect(badge?.getAttribute("title")).toContain("40%");
    });

    it("dims a played podcast row and shows no badge", () => {
        const pod: Track = { ...track, kind: "podcast", play_state: "played" };
        const { container } = render(<TrackList {...base} tracks={[pod]} />);
        expect(container.querySelector(".podcast-badge")).toBeNull();
        expect(container.querySelector("li.track-item")?.className).toContain("is-played");
    });
});

describe("TrackList column sort", () => {
    it("renders sortable headers as buttons, but not # or the star", () => {
        const onSort = vi.fn();
        render(<TrackList {...base} onSort={onSort} />);
        expect(screen.getByRole("button", { name: /Sort by/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Title" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "#" })).toBeNull();
    });

    it("fires onSort with the column key on header click", () => {
        const onSort = vi.fn();
        render(<TrackList {...base} onSort={onSort} />);
        fireEvent.click(screen.getByRole("button", { name: "Artist" }));
        expect(onSort).toHaveBeenCalledWith("artist");
    });

    it("marks the active column via aria-sort and shows a caret", () => {
        const { container } = render(
            <TrackList {...base} onSort={vi.fn()} sortState={{ key: "title", dir: "asc" }} />,
        );
        expect(container.querySelector(".th-title")?.getAttribute("aria-sort")).toBe("ascending");
        expect(container.querySelector(".th-artist")?.getAttribute("aria-sort")).toBe("none");
        expect(container.querySelector(".th-title .th-sort-caret")).not.toBeNull();
    });

    it("renders plain headers when no onSort is passed", () => {
        render(<TrackList {...base} />);
        expect(screen.queryByRole("button", { name: "Title" })).toBeNull();
        expect(screen.getByText("Title")).toBeInTheDocument();
    });
});

describe("TrackList click behaviour", () => {
    it("single click cues (onTrackClick), it does not play", () => {
        const onTrackClick = vi.fn();
        const onTrackActivate = vi.fn();
        render(<TrackList {...base} onTrackClick={onTrackClick} onTrackActivate={onTrackActivate} />);
        fireEvent.click(screen.getByText("Song One"));
        expect(onTrackClick).toHaveBeenCalledTimes(1);
        expect(onTrackActivate).not.toHaveBeenCalled();
    });

    it("double click activates (onTrackActivate)", () => {
        const onTrackActivate = vi.fn();
        render(<TrackList {...base} onTrackActivate={onTrackActivate} />);
        fireEvent.doubleClick(screen.getByText("Song One"));
        expect(onTrackActivate).toHaveBeenCalledTimes(1);
    });

    it("marks the loaded track now-playing and a different cued track selected", () => {
        const { container } = render(
            <TrackList {...base} tracks={[track, track2]} currentTrack={track2} loadedTrackId={track.id} />,
        );
        const rows = container.querySelectorAll("li.track-item");
        expect(rows[0].className).toContain("active");
        expect(rows[0].className).not.toContain("selected");
        expect(rows[1].className).toContain("selected");
        expect(rows[1].className).not.toContain("active");
    });
});

// jsdom has no DataTransfer constructor, so drag events need a stand-in
// object passed through fireEvent's event-init — TrackList only ever reads
// effectAllowed/dropEffect off it, never calls setData/getData.
function fakeDataTransfer() {
    return { effectAllowed: "", dropEffect: "" } as unknown as DataTransfer;
}

// Safety net for the planned DOM-virtualization refactor:
// pins that a drag from row `from`
// dropped on row `to` calls onReorder(from, to) — using the *rendered* row
// index into `tracks`, which the caller (App.tsx) trusts to match the
// playlist's DB position (see TrackList.tsx's `reorderable` doc comment).
// Any virtualization that windows the rendered rows must keep this contract.
describe("TrackList drag-and-drop reorder", () => {
    const track3: Track = {
        id: "t3", title: "Song Three", artist: "Artist One",
        file_path: "/Users/me/Music/song-three.mp3", file_name: "song-three.mp3",
    };
    const reorderBase = { ...base, tracks: [track, track2, track3], reorderable: true };

    it("is not draggable when reorderable is false (the default)", () => {
        render(<TrackList {...base} />);
        const row = screen.getByText("Song One").closest("li") as HTMLElement;
        expect(row).toHaveAttribute("draggable", "false");
    });

    it("dragging row 0 onto row 2 calls onReorder(0, 2) with the rendered indices", () => {
        const onReorder = vi.fn();
        render(<TrackList {...reorderBase} onReorder={onReorder} />);
        const rows = () => screen.getAllByRole("listitem");

        const dt = fakeDataTransfer();
        fireEvent.dragStart(rows()[0], { dataTransfer: dt });
        fireEvent.dragOver(rows()[2], { dataTransfer: dt });
        fireEvent.drop(rows()[2], { dataTransfer: dt });

        expect(onReorder).toHaveBeenCalledTimes(1);
        expect(onReorder).toHaveBeenCalledWith(0, 2);
    });

    it("dragging a row onto itself does not call onReorder", () => {
        const onReorder = vi.fn();
        render(<TrackList {...reorderBase} onReorder={onReorder} />);
        const rows = () => screen.getAllByRole("listitem");

        const dt = fakeDataTransfer();
        fireEvent.dragStart(rows()[1], { dataTransfer: dt });
        fireEvent.dragOver(rows()[1], { dataTransfer: dt });
        fireEvent.drop(rows()[1], { dataTransfer: dt });

        expect(onReorder).not.toHaveBeenCalled();
    });

    it("marks the dragged row is-dragging and the hovered row drop-target", () => {
        render(<TrackList {...reorderBase} />);
        const rows = () => screen.getAllByRole("listitem");

        fireEvent.dragStart(rows()[0], { dataTransfer: fakeDataTransfer() });
        expect(rows()[0]).toHaveClass("is-dragging");

        fireEvent.dragOver(rows()[2], { dataTransfer: fakeDataTransfer() });
        expect(rows()[2]).toHaveClass("drop-target");
        expect(rows()[0]).not.toHaveClass("drop-target"); // the source row isn't its own target

        fireEvent.dragEnd(rows()[0]);
        expect(rows()[0]).not.toHaveClass("is-dragging");
        expect(rows()[2]).not.toHaveClass("drop-target");
    });
});

// Safety net for the large-library performance fix: above VIRTUALIZE_THRESHOLD (300, TrackList.tsx),
// only the visible + overscan rows are mounted via @tanstack/react-virtual.
//
// @tanstack/virtual-core sizes both the scroll viewport and each row off
// `offsetHeight` (see getRect()/measureElement() in its source) — real jsdom
// elements report 0 there, so this block stubs it per-element: a plausible
// row height for `.track-item`, a bounded viewport for everything else
// (standing in for App.tsx's `.track-list-container`, which in this
// standalone render is just testing-library's anonymous container div).
// Scoped to this describe block only — not global setup.ts — so it can't
// affect the other 330+ tests in the suite.
describe("TrackList virtualized rendering (tracks.length > VIRTUALIZE_THRESHOLD)", () => {
    const ROW_HEIGHT = 40;
    const VIEWPORT_HEIGHT = 600;
    let restoreOffsetHeight: () => void;

    beforeEach(() => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
            configurable: true,
            get(this: HTMLElement) {
                return this.classList.contains("track-item") ? ROW_HEIGHT : VIEWPORT_HEIGHT;
            },
        });
        restoreOffsetHeight = () => {
            if (descriptor) Object.defineProperty(HTMLElement.prototype, "offsetHeight", descriptor);
        };
    });
    afterEach(() => restoreOffsetHeight());

    function manyTracks(n: number): Track[] {
        return Array.from({ length: n }, (_, i) => ({
            id: `v${i}`,
            title: `Track ${i}`,
            artist: `Artist ${i % 20}`,
            file_path: `/m/v${i}.mp3`,
            file_name: `v${i}.mp3`,
        }));
    }

    it("at exactly the threshold (300), still renders every row (the plain path)", () => {
        const tracks = manyTracks(300);
        const { container } = render(<TrackList {...base} tracks={tracks} />);
        expect(container.querySelectorAll("li.track-item")).toHaveLength(300);
        expect(container.querySelector(".track-list.is-virtualized")).toBeNull();
    });

    it("above the threshold (500), does not mount every row", () => {
        const tracks = manyTracks(500);
        const { container } = render(<TrackList {...base} tracks={tracks} />);
        const rendered = container.querySelectorAll("li.track-item").length;
        expect(container.querySelector(".track-list.is-virtualized")).not.toBeNull();
        expect(rendered).toBeGreaterThan(0);
        expect(rendered).toBeLessThan(500);
    });

    it("renders the first tracks' text (top of the window is visible on mount)", () => {
        const tracks = manyTracks(500);
        render(<TrackList {...base} tracks={tracks} />);
        expect(screen.getByText("Track 0")).toBeInTheDocument();
    });

    it("scrolling the container changes which tracks are rendered", () => {
        const tracks = manyTracks(500);
        const { container } = render(<TrackList {...base} tracks={tracks} />);
        expect(screen.queryByText("Track 499")).not.toBeInTheDocument();

        const scrollEl = container.querySelector(".track-list-wrapper")!.parentElement!;
        Object.defineProperty(scrollEl, "scrollTop", { configurable: true, writable: true, value: 500 * ROW_HEIGHT });
        fireEvent.scroll(scrollEl);

        expect(screen.getByText("Track 499")).toBeInTheDocument();
        expect(screen.queryByText("Track 0")).not.toBeInTheDocument();
    });

    it("drag-and-drop still resolves absolute indices (onReorder(from, to)) within the rendered window", () => {
        const tracks = manyTracks(500);
        const onReorder = vi.fn();
        const { container } = render(
            <TrackList {...base} tracks={tracks} reorderable onReorder={onReorder} />,
        );
        const rows = () => Array.from(container.querySelectorAll<HTMLElement>("li.track-item"));
        const [first, , third] = rows(); // both within the initial visible window

        const dt = { effectAllowed: "", dropEffect: "" } as unknown as DataTransfer;
        fireEvent.dragStart(first, { dataTransfer: dt });
        fireEvent.dragOver(third, { dataTransfer: dt });
        fireEvent.drop(third, { dataTransfer: dt });

        // The rendered rows' true indices (not their position within the
        // windowed DOM) — index 0 dragged onto index 2, same as the
        // unvirtualized D&D test above.
        expect(onReorder).toHaveBeenCalledWith(0, 2);
    });

    it("shows the now-playing jump button and rail marker once the current track scrolls out of the virtualized window", () => {
        const tracks = manyTracks(500);
        const { container } = render(<TrackList {...base} tracks={tracks} loadedTrackId="v400" />);

        // v400 isn't in the initial (top-of-list) window.
        expect(container.querySelector(".now-playing-jump")).not.toBeNull();
        expect(container.querySelector(".now-playing-marker")).not.toBeNull();
    });

    it("hides the jump button once scrolling brings the current track into the virtualized window", () => {
        const tracks = manyTracks(500);
        const { container } = render(<TrackList {...base} tracks={tracks} loadedTrackId="v400" />);

        const scrollEl = container.querySelector(".track-list-wrapper")!.parentElement!;
        Object.defineProperty(scrollEl, "scrollTop", { configurable: true, writable: true, value: 400 * ROW_HEIGHT });
        fireEvent.scroll(scrollEl);

        expect(container.querySelector(".now-playing-jump")).toBeNull();
    });

    it("shows nothing when loadedTrackId isn't in the current (e.g. filtered) list", () => {
        const tracks = manyTracks(500);
        const { container } = render(<TrackList {...base} tracks={tracks} loadedTrackId="not-in-list" />);
        expect(container.querySelector(".now-playing-jump")).toBeNull();
        expect(container.querySelector(".now-playing-marker")).toBeNull();
    });
});

describe("TrackList now-playing indicator (unvirtualized)", () => {
    function mockRect(el: Element, rect: Partial<DOMRect>) {
        Object.defineProperty(el, "getBoundingClientRect", {
            configurable: true,
            value: () => ({
                top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
                toJSON() { return {}; },
                ...rect,
            }),
        });
    }

    function manySmallTracks(n: number): Track[] {
        return Array.from({ length: n }, (_, i) => ({
            id: `s${i}`,
            title: `Song ${i}`,
            artist: `Artist ${i}`,
            file_path: `/m/s${i}.mp3`,
            file_name: `s${i}.mp3`,
        }));
    }

    // A short (unvirtualized) list only has something to jump to once it's
    // actually scrollable, so every test here sets up a "tall content, short
    // viewport" scroll container before asserting on the indicator.
    function makeScrollable(container: HTMLElement) {
        const wrapper = container.querySelector(".track-list-wrapper")! as HTMLElement;
        const scrollEl = wrapper.parentElement!;
        Object.defineProperty(wrapper, "offsetHeight", { configurable: true, value: 1000 });
        Object.defineProperty(scrollEl, "offsetHeight", { configurable: true, value: 400 });
        mockRect(scrollEl, { top: 0, bottom: 400, height: 400 });
        mockRect(container.querySelector(".track-list-header")!, { height: 40 });
        return scrollEl;
    }

    it("shows a jump button when the playing row is below the visible window, hides it once brought into view", () => {
        const tracks = manySmallTracks(10);
        const { container } = render(<TrackList {...base} tracks={tracks} loadedTrackId={tracks[8].id} />);
        const scrollEl = makeScrollable(container);
        const row = container.querySelector('li.track-item[data-index="8"]')!;
        mockRect(row, { top: 500, bottom: 540 });
        fireEvent.scroll(scrollEl);

        const jumpButton = container.querySelector(".now-playing-jump");
        expect(jumpButton).not.toBeNull();
        expect(container.querySelector(".now-playing-marker")).not.toBeNull();

        mockRect(row, { top: 100, bottom: 140 });
        fireEvent.scroll(scrollEl);
        expect(container.querySelector(".now-playing-jump")).toBeNull();
    });

    it("renders the 'above' jump button right after the header so sticky top can pin it", () => {
        const tracks = manySmallTracks(10);
        const { container } = render(<TrackList {...base} tracks={tracks} loadedTrackId={tracks[1].id} />);
        const scrollEl = makeScrollable(container);
        const row = container.querySelector('li.track-item[data-index="1"]')!;
        mockRect(row, { top: -100, bottom: -60 });
        fireEvent.scroll(scrollEl);

        const slot = container.querySelector(".now-playing-jump-slot.is-above");
        expect(slot).not.toBeNull();
        expect(slot!.previousElementSibling).toBe(container.querySelector(".track-list-header"));
    });

    it("scrolls the playing row into view when the jump button is clicked", () => {
        const tracks = manySmallTracks(10);
        const { container } = render(<TrackList {...base} tracks={tracks} loadedTrackId={tracks[8].id} />);
        const scrollEl = makeScrollable(container);
        const row = container.querySelector('li.track-item[data-index="8"]')!;
        mockRect(row, { top: 500, bottom: 540 });
        fireEvent.scroll(scrollEl);

        const scrollIntoView = vi.fn();
        row.scrollIntoView = scrollIntoView;
        fireEvent.click(container.querySelector(".now-playing-jump")!);
        expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "center" }));
    });

    it("shows nothing when loadedTrackId isn't in the current list", () => {
        const tracks = manySmallTracks(10);
        const { container } = render(<TrackList {...base} tracks={tracks} loadedTrackId="missing" />);
        makeScrollable(container);
        expect(container.querySelector(".now-playing-jump")).toBeNull();
        expect(container.querySelector(".now-playing-rail")).toBeNull();
    });

    it("shows nothing when the list fits without scrolling", () => {
        const tracks = manySmallTracks(10);
        const { container } = render(<TrackList {...base} tracks={tracks} loadedTrackId={tracks[8].id} />);
        // No scrollable-container mocking here — jsdom's default scrollHeight
        // === clientHeight (both 0), so the list "fits" and nothing shows.
        expect(container.querySelector(".now-playing-jump")).toBeNull();
        expect(container.querySelector(".now-playing-rail")).toBeNull();
    });
});

describe("TrackList column resizing", () => {
    // jsdom has no PointerEvent, and testing-library's fallback Event drops
    // clientX/button — a MouseEvent subclass keeps them.
    const OriginalPointerEvent = globalThis.PointerEvent;
    beforeEach(() => {
        class FakePointerEvent extends MouseEvent {}
        globalThis.PointerEvent = FakePointerEvent as unknown as typeof PointerEvent;
    });
    afterEach(() => {
        globalThis.PointerEvent = OriginalPointerEvent;
    });

    const widthOf = (el: Element, w: number) => {
        el.getBoundingClientRect = () => ({ width: w, height: 20, top: 0, left: 0, right: w, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
    };
    const drag = (handle: Element, from: number, to: number) => {
        fireEvent.pointerDown(handle, { clientX: from, button: 0 });
        fireEvent.pointerMove(window, { clientX: to });
        fireEvent.pointerUp(window);
    };

    it("shows no handles unless onColumnWidthsChange is given", () => {
        const { container } = render(<TrackList {...base} />);
        expect(container.querySelector(".col-resizer")).toBeNull();
    });

    it("has handles on title and artist, and on album only when Path is shown", () => {
        const { container, rerender } = render(<TrackList {...base} onColumnWidthsChange={noop} />);
        expect(container.querySelectorAll(".col-resizer")).toHaveLength(3);
        rerender(<TrackList {...base} showPath onColumnWidthsChange={noop} />);
        expect(container.querySelectorAll(".col-resizer")).toHaveLength(4);
    });

    it("widens the Time column when its left-edge handle is dragged left", () => {
        const onChange = vi.fn();
        const { container } = render(<TrackList {...base} onColumnWidthsChange={onChange} />);
        widthOf(container.querySelector(".th-time")!, 70);
        widthOf(container.querySelector(".th-flex")!, 200);
        drag(container.querySelector(".th-time .col-resizer")!, 500, 470);
        expect(onChange).toHaveBeenLastCalledWith({ time: 100 });
        // The header cells remount on each render, so re-mock.
        widthOf(container.querySelector(".th-time")!, 70);
        widthOf(container.querySelector(".th-flex")!, 200);
        drag(container.querySelector(".th-time .col-resizer")!, 500, 5000);
        expect(onChange).toHaveBeenLastCalledWith({ time: 40 });
        widthOf(container.querySelector(".th-time")!, 70);
        widthOf(container.querySelector(".th-flex")!, 200);
        drag(container.querySelector(".th-time .col-resizer")!, 500, -5000);
        expect(onChange).toHaveBeenLastCalledWith({ time: 210 });
    });

    it("applies a saved Time width and resets it on double-click", () => {
        const onChange = vi.fn();
        const { container } = render(<TrackList {...base} columnWidths={{ time: 90, artist: 120 }} onColumnWidthsChange={onChange} />);
        expect((container.firstChild as HTMLElement).style.getPropertyValue("--col-time")).toBe("90px");
        // A fixed-width Time column doesn't turn the flex column into minmax().
        expect((container.firstChild as HTMLElement).style.getPropertyValue("--col-album")).toBe("minmax(60px, 1fr)");
        fireEvent.doubleClick(container.querySelector(".th-time .col-resizer")!);
        expect(onChange).toHaveBeenCalledWith({ artist: 120 });
    });

    it("commits the dragged width once on release and shows it live", () => {
        const onChange = vi.fn();
        const { container } = render(<TrackList {...base} onColumnWidthsChange={onChange} />);
        widthOf(container.querySelector(".th-title")!, 300);
        widthOf(container.querySelector(".th-flex")!, 200);
        const handle = container.querySelector(".th-title .col-resizer")!;
        fireEvent.pointerDown(handle, { clientX: 100, button: 0 });
        fireEvent.pointerMove(window, { clientX: 150 });
        expect((container.firstChild as HTMLElement).style.getPropertyValue("--col-title")).toBe("350px");
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.pointerUp(window);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith({ title: 350 });
    });

    it("clamps to the minimum and to what leaves the flex column its minimum", () => {
        const onChange = vi.fn();
        const { container } = render(<TrackList {...base} onColumnWidthsChange={onChange} />);
        widthOf(container.querySelector(".th-title")!, 300);
        widthOf(container.querySelector(".th-flex")!, 200);
        const handle = container.querySelector(".th-title .col-resizer")!;
        drag(handle, 100, -1000);
        expect(onChange).toHaveBeenLastCalledWith({ title: 60 });
        // The header cells remount on each render (SortHeader is re-created), so re-mock.
        widthOf(container.querySelector(".th-title")!, 300);
        widthOf(container.querySelector(".th-flex")!, 200);
        drag(container.querySelector(".th-title .col-resizer")!, 100, 5000);
        expect(onChange).toHaveBeenLastCalledWith({ title: 440 });
    });

    it("does not commit a plain click", () => {
        const onChange = vi.fn();
        const { container } = render(<TrackList {...base} onColumnWidthsChange={onChange} />);
        const handle = container.querySelector(".th-title .col-resizer")!;
        fireEvent.pointerDown(handle, { clientX: 10, button: 0 });
        fireEvent.pointerUp(window);
        expect(onChange).not.toHaveBeenCalled();
    });

    it("resets a column on double-click without triggering sort", () => {
        const onChange = vi.fn();
        const onSort = vi.fn();
        const { container } = render(<TrackList {...base} columnWidths={{ title: 300, artist: 120 }} onSort={onSort} onColumnWidthsChange={onChange} />);
        const handle = container.querySelector(".th-title .col-resizer")!;
        fireEvent.click(handle);
        fireEvent.doubleClick(handle);
        expect(onSort).not.toHaveBeenCalled();
        expect(onChange).toHaveBeenCalledWith({ artist: 120 });
    });

    it("applies saved widths as CSS variables, with the flex column as minmax", () => {
        const { container } = render(<TrackList {...base} columnWidths={{ title: 300, album: 999 }} onColumnWidthsChange={noop} />);
        const style = (container.firstChild as HTMLElement).style;
        expect(style.getPropertyValue("--col-title")).toBe("300px");
        expect(style.getPropertyValue("--col-album")).toBe("minmax(60px, 1fr)");
    });

    it("leaves the default proportions alone when nothing is customised", () => {
        const { container } = render(<TrackList {...base} columnWidths={{}} onColumnWidthsChange={noop} />);
        expect((container.firstChild as HTMLElement).getAttribute("style")).toBeNull();
    });
});
