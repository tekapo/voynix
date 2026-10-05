import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AlbumContextMenu } from "./AlbumContextMenu";
import { Track } from "../types";

const track: Track = {
    id: "t1",
    title: "A Song",
    artist: "Some Artist",
    album: "Some Album",
    file_path: "/music/a.mp3",
    file_name: "a.mp3",
};

const base = {
    visible: true,
    x: 0,
    y: 0,
    album: "Some Album",
    track,
    playlists: [],
    onPlay: () => {},
    onAddToPlaylist: () => {},
    onFindAlbumCover: () => {},
    onSetAlbumCover: () => {},
    onResetAlbumCover: () => {},
    onClose: () => {},
};

describe("AlbumContextMenu", () => {
    it("omits Get Info… when onGetInfo isn't passed", () => {
        render(<AlbumContextMenu {...base} />);
        expect(screen.queryByText("Get Info…")).not.toBeInTheDocument();
    });

    it("calls onGetInfo with the representative track and closes the menu", () => {
        const onGetInfo = vi.fn();
        const onClose = vi.fn();
        render(<AlbumContextMenu {...base} onGetInfo={onGetInfo} onClose={onClose} />);
        fireEvent.click(screen.getByText("Get Info…"));
        expect(onGetInfo).toHaveBeenCalledWith(track);
        expect(onClose).toHaveBeenCalled();
    });

    it("calls onFindAlbumCover with the representative track and closes the menu", () => {
        const onFindAlbumCover = vi.fn();
        const onClose = vi.fn();
        render(<AlbumContextMenu {...base} onFindAlbumCover={onFindAlbumCover} onClose={onClose} />);
        fireEvent.click(screen.getByText("Find Album Cover…"));
        expect(onFindAlbumCover).toHaveBeenCalledWith(track);
        expect(onClose).toHaveBeenCalled();
    });

    it("disables Get Info… while no representative track has resolved yet", () => {
        const onGetInfo = vi.fn();
        render(<AlbumContextMenu {...base} track={null} onGetInfo={onGetInfo} />);
        fireEvent.click(screen.getByText("Get Info…"));
        expect(onGetInfo).not.toHaveBeenCalled();
    });
});
