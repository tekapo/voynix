import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getArtistCover = vi.fn(async (_artist: string) => null as string | null);
vi.mock("../db", () => ({ getArtistCover: (...a: [string]) => getArtistCover(...a) }));

import { invalidateArtistArt } from "../artistArt";
import { CollectionHero } from "./CollectionHero";
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

const albums = (n: number): Track[] =>
    Array.from({ length: n }, (_, i) => track({ id: `t${i}`, title: `Song ${i}`, album: `Album ${i}`, file_path: `/music/a${i}/t.mp3` }));

const baseProps = { title: "Road Trip", onPlay: () => {}, onShuffle: () => {} };

beforeEach(() => {
    getArtistCover.mockReset().mockResolvedValue(null);
    invalidateArtistArt();
});

describe("CollectionHero", () => {
    it("shows the kind label, the title as a level-2 heading, and the song count and minutes", () => {
        render(<CollectionHero {...baseProps} kind="playlist" tracks={albums(3)} />);
        expect(screen.getByText("Playlist")).toBeInTheDocument();
        expect(screen.getByRole("heading", { level: 2, name: "Road Trip" })).toBeInTheDocument();
        expect(screen.getByText("3 songs · 9 min")).toBeInTheDocument();
    });

    it("calls onPlay and onShuffle from the two buttons", () => {
        const onPlay = vi.fn();
        const onShuffle = vi.fn();
        render(<CollectionHero {...baseProps} kind="playlist" tracks={albums(2)} onPlay={onPlay} onShuffle={onShuffle} />);
        fireEvent.click(screen.getByRole("button", { name: "Play Road Trip" }));
        fireEvent.click(screen.getByRole("button", { name: "Shuffle Road Trip" }));
        expect(onPlay).toHaveBeenCalledTimes(1);
        expect(onShuffle).toHaveBeenCalledTimes(1);
    });

    it("keeps the visible button text short while the accessible name says what is played", () => {
        render(<CollectionHero {...baseProps} kind="playlist" tracks={albums(2)} />);
        expect(screen.getByRole("button", { name: "Play Road Trip" })).toHaveTextContent("Play");
        // The player bar's own Play button must stay the only one named exactly "Play".
        expect(screen.queryByRole("button", { name: "Play" })).not.toBeInTheDocument();
    });

    it("omits the shuffle button when showShuffle is false", () => {
        render(<CollectionHero {...baseProps} kind="playlist" tracks={albums(2)} showShuffle={false} />);
        expect(screen.getByRole("button", { name: "Play Road Trip" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /^Shuffle/ })).not.toBeInTheDocument();
    });

    it("disables both buttons when there are no tracks", () => {
        render(<CollectionHero {...baseProps} kind="playlist" tracks={[]} />);
        expect(screen.getByRole("button", { name: "Play Road Trip" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Shuffle Road Trip" })).toBeDisabled();
        expect(screen.getByText("0 songs · 0 min")).toBeInTheDocument();
    });

    it.each([
        [5, 4],
        [4, 4],
        [3, 3],
        [2, 2],
        [1, 1],
    ])("builds the playlist cover from %i distinct albums as %i tiles", (albumCount, tiles) => {
        const { container } = render(<CollectionHero {...baseProps} kind="playlist" tracks={albums(albumCount)} />);
        const cover = container.querySelector(".collection-hero-cover") as HTMLElement;
        expect(cover).toHaveAttribute("data-count", String(tiles));
        expect(cover.querySelectorAll(".collection-hero-tile")).toHaveLength(tiles);
    });

    it("counts tracks of the same artist and album once when picking cover tiles", () => {
        const same = [track({ id: "a", title: "A" }), track({ id: "b", title: "B" }), track({ id: "c", title: "C" })];
        const { container } = render(<CollectionHero {...baseProps} kind="playlist" tracks={same} />);
        expect(container.querySelector(".collection-hero-cover")).toHaveAttribute("data-count", "1");
    });

    it("shows a single cover for an album, with the artist ahead of the count", () => {
        const { container } = render(
            <CollectionHero {...baseProps} kind="album" title="Album A" tracks={[track({ id: "a", title: "A" }), track({ id: "b", title: "B" })]} />,
        );
        expect(screen.getByText("Album")).toBeInTheDocument();
        expect(screen.getByText("Artist A · 2 songs · 6 min")).toBeInTheDocument();
        expect(container.querySelector(".collection-hero-cover")).toHaveAttribute("data-count", "1");
    });

    it("shows a round artist image and the album count for an artist", () => {
        const tracks = [
            track({ id: "a", title: "A", album: "One" }),
            track({ id: "b", title: "B", album: "Two" }),
            track({ id: "c", title: "C", album: "Two" }),
        ];
        const { container } = render(<CollectionHero {...baseProps} kind="artist" title="Artist A" tracks={tracks} />);
        expect(screen.getByText("Artist", { selector: ".collection-hero-kind" })).toBeInTheDocument();
        expect(screen.getByText("2 albums · 3 songs · 9 min")).toBeInTheDocument();
        expect(container.querySelector(".collection-hero-art-round")).toBeInTheDocument();
        expect(container.querySelector(".collection-hero-cover")).not.toBeInTheDocument();
    });
});
