import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrackContextMenu } from "./ContextMenu";
import { Track } from "../types";

const track: Track = {
    id: "t1",
    title: "A Song",
    file_path: "/music/a.mp3",
    file_name: "a.mp3",
};

const base = {
    visible: true,
    x: 0,
    y: 0,
    track,
    playlists: [],
    onAddToPlaylist: () => {},
    onShowInFinder: () => {},
    onSetArtwork: () => {},
    onToggleFavorite: () => {},
    onToggleDislike: () => {},
    onClose: () => {},
};

describe("TrackContextMenu", () => {
    it("omits Get Info… when onGetInfo isn't passed", () => {
        render(<TrackContextMenu {...base} />);
        expect(screen.queryByText("Get Info…")).not.toBeInTheDocument();
    });

    it("shows Remove from Playlist only when onRemoveFromPlaylist is passed", () => {
        const { rerender } = render(<TrackContextMenu {...base} />);
        expect(screen.queryByText("Remove from Playlist")).not.toBeInTheDocument();
        const onRemove = vi.fn();
        const onClose = vi.fn();
        rerender(<TrackContextMenu {...base} onRemoveFromPlaylist={onRemove} onClose={onClose} />);
        fireEvent.click(screen.getByText("Remove from Playlist"));
        expect(onRemove).toHaveBeenCalledWith(track);
        expect(onClose).toHaveBeenCalled();
    });

    it("calls onGetInfo with the track and closes the menu", () => {
        const onGetInfo = vi.fn();
        const onClose = vi.fn();
        render(<TrackContextMenu {...base} onGetInfo={onGetInfo} onClose={onClose} />);
        fireEvent.click(screen.getByText("Get Info…"));
        expect(onGetInfo).toHaveBeenCalledWith(track);
        expect(onClose).toHaveBeenCalled();
    });
});

describe("TrackContextMenu keyboard access", () => {
    const withInfo = (over = {}) => {
        const onGetInfo = vi.fn();
        const onAddToQueue = vi.fn();
        const onClose = vi.fn();
        render(<TrackContextMenu {...base} onGetInfo={onGetInfo} onAddToQueue={onAddToQueue} onClose={onClose} {...over} />);
        return { menu: screen.getByRole("menu"), onGetInfo, onAddToQueue, onClose };
    };

    it("is a menu of menuitems and focuses the first item on open", () => {
        withInfo();
        const items = screen.getAllByRole("menuitem");
        expect(items.length).toBeGreaterThan(2);
        expect(items[0]).toHaveFocus();
    });

    it("moves focus with the arrow keys, wrapping around", () => {
        const { menu } = withInfo();
        const items = screen.getAllByRole("menuitem").filter(el => !el.classList.contains("disabled"));
        fireEvent.keyDown(menu, { key: "ArrowDown" });
        expect(items[1]).toHaveFocus();
        fireEvent.keyDown(menu, { key: "ArrowUp" });
        fireEvent.keyDown(menu, { key: "ArrowUp" });
        expect(items[items.length - 1]).toHaveFocus();
        fireEvent.keyDown(menu, { key: "Home" });
        expect(items[0]).toHaveFocus();
        fireEvent.keyDown(menu, { key: "End" });
        expect(items[items.length - 1]).toHaveFocus();
    });

    it("runs the focused item on Enter and on Space", () => {
        const { menu, onGetInfo, onClose } = withInfo();
        fireEvent.keyDown(menu, { key: "Enter" });
        expect(onGetInfo).toHaveBeenCalledWith(track);
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.keyDown(menu, { key: " " });
        expect(onGetInfo).toHaveBeenCalledTimes(2);
    });

    it("closes on Escape and Tab", () => {
        const { menu, onClose } = withInfo();
        fireEvent.keyDown(menu, { key: "Escape" });
        fireEvent.keyDown(menu, { key: "Tab" });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("skips disabled items", () => {
        render(<TrackContextMenu {...base} />);
        const menu = screen.getByRole("menu");
        // "No custom playlists" is the disabled row: never reachable by arrows.
        fireEvent.keyDown(menu, { key: "End" });
        expect(document.activeElement).not.toHaveClass("disabled");
    });

    it("hands focus back to the opener when closed", () => {
        const opener = document.createElement("button");
        document.body.appendChild(opener);
        opener.focus();
        const { rerender } = render(<TrackContextMenu {...base} />);
        expect(screen.getAllByRole("menuitem")[0]).toHaveFocus();
        rerender(<TrackContextMenu {...base} visible={false} />);
        expect(opener).toHaveFocus();
        opener.remove();
    });
});
