import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LibraryColumns } from "./LibraryColumns";
import { Track } from "../types";

function track(over: Partial<Track> & Pick<Track, "id" | "title">): Track {
    return {
        artist: "Artist A",
        album: "Album A",
        file_path: `/music/${over.id}.mp3`,
        file_name: `${over.id}.mp3`,
        duration: 180,
        disc_no: 1,
        track_no: 1,
        ...over,
    };
}

const baseProps = {
    onSelect: () => {},
    onItemContextMenu: () => {},
    artFor: () => null,
    currentTrack: null,
    loadedTrackId: null,
    onTrackClick: () => {},
    onTrackActivate: () => {},
    onTrackContextMenu: () => {},
    onToggleFavorite: () => {},
    onPlay: () => {},
    onShuffle: () => {},
    onArtistMore: () => {},
    onAlbumMore: () => {},
    onBack: () => {},
};

describe("LibraryColumns", () => {
    it("shows a placeholder in the right pane when nothing is selected", () => {
        render(
            <LibraryColumns
                {...baseProps}
                viewMode="artists"
                items={["Artist A", "Artist B"]}
                selected={null}
                tracks={[]}
            />
        );
        expect(screen.getByText("Select an artist.")).toBeInTheDocument();
        expect(screen.getByText("Artist A")).toBeInTheDocument();
        expect(screen.getByText("Artist B")).toBeInTheDocument();
    });

    it("groups an artist's tracks into per-album sections with a song count and total time", () => {
        const tracks = [
            track({ id: "t1", title: "Song 1", album: "Album A", duration: 180, track_no: 1 }),
            track({ id: "t2", title: "Song 2", album: "Album A", duration: 210, track_no: 2 }),
            track({ id: "t3", title: "Song 3", album: "Album B", duration: 200, track_no: 1 }),
        ];
        render(
            <LibraryColumns
                {...baseProps}
                viewMode="artists"
                items={["Artist A"]}
                selected="Artist A"
                tracks={tracks}
            />
        );
        expect(screen.getByRole("heading", { name: "Artist A" })).toBeInTheDocument();
        // 2 albums, 3 songs total.
        expect(screen.getByText(/2 albums, 3 songs/)).toBeInTheDocument();

        expect(screen.getByText("Album A")).toBeInTheDocument();
        // Album A: 180 + 210 = 390s = 6.5min, rounds to 7 min.
        expect(screen.getByText("2 songs · 7 min")).toBeInTheDocument();
        expect(screen.getByText("Album B")).toBeInTheDocument();
        expect(screen.getByText("1 song · 3 min")).toBeInTheDocument();

        expect(screen.getByText("Song 1")).toBeInTheDocument();
        expect(screen.getByText("Song 3")).toBeInTheDocument();
    });

    it("shows the artist name on each section when browsing Albums (not Artists)", () => {
        const tracks = [track({ id: "t1", title: "Song 1", artist: "Artist A", album: "Album A" })];
        render(
            <LibraryColumns
                {...baseProps}
                viewMode="albums"
                items={["Album A"]}
                selected="Album A"
                tracks={tracks}
            />
        );
        // No top header for the Albums view — the album section itself carries the artist.
        expect(screen.queryByRole("heading", { name: "Album A" })).not.toBeInTheDocument();
        const rightPane = document.querySelector(".library-columns-right") as HTMLElement;
        expect(within(rightPane).getByText("Album A")).toBeInTheDocument();
        expect(within(rightPane).getByText("Artist A")).toBeInTheDocument();
    });

    it("fires onSelect when a left-pane row is clicked", () => {
        const onSelect = vi.fn();
        render(
            <LibraryColumns
                {...baseProps}
                viewMode="artists"
                items={["Artist A", "Artist B"]}
                selected={null}
                tracks={[]}
                onSelect={onSelect}
            />
        );
        fireEvent.click(screen.getByText("Artist B"));
        expect(onSelect).toHaveBeenCalledWith("Artist B");
    });

    it("clicking a track row cues it and double-click activates it", () => {
        const onTrackClick = vi.fn();
        const onTrackActivate = vi.fn();
        const tracks = [track({ id: "t1", title: "Song 1" })];
        render(
            <LibraryColumns
                {...baseProps}
                viewMode="artists"
                items={["Artist A"]}
                selected="Artist A"
                tracks={tracks}
                onTrackClick={onTrackClick}
                onTrackActivate={onTrackActivate}
            />
        );
        const row = screen.getByText("Song 1").closest("li") as HTMLElement;
        fireEvent.click(row);
        expect(onTrackClick).toHaveBeenCalledWith(tracks[0]);
        fireEvent.doubleClick(row);
        expect(onTrackActivate).toHaveBeenCalledWith(tracks[0]);
    });

    it("play/shuffle buttons pass the artist's full track list", () => {
        const onPlay = vi.fn();
        const onShuffle = vi.fn();
        const tracks = [track({ id: "t1", title: "Song 1" }), track({ id: "t2", title: "Song 2" })];
        render(
            <LibraryColumns
                {...baseProps}
                viewMode="artists"
                items={["Artist A"]}
                selected="Artist A"
                tracks={tracks}
                onPlay={onPlay}
                onShuffle={onShuffle}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: "Play" }));
        expect(onPlay).toHaveBeenCalledWith(tracks);
        fireEvent.click(screen.getByRole("button", { name: "Shuffle" }));
        expect(onShuffle).toHaveBeenCalledWith(tracks);
    });

    it("the back button calls onBack", () => {
        const onBack = vi.fn();
        render(
            <LibraryColumns
                {...baseProps}
                viewMode="artists"
                items={["Artist A"]}
                selected="Artist A"
                tracks={[track({ id: "t1", title: "Song 1" })]}
                onBack={onBack}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: /Back/ }));
        expect(onBack).toHaveBeenCalled();
    });
});
