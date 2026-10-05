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
    onClose: () => {},
};

describe("TrackContextMenu", () => {
    it("omits Get Info… when onGetInfo isn't passed", () => {
        render(<TrackContextMenu {...base} />);
        expect(screen.queryByText("Get Info…")).not.toBeInTheDocument();
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
