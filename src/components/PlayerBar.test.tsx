import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPlaybackClock } from "../playbackClock";
import { PlayerBar } from "./PlayerBar";

// Shuffle / repeat are now SVG icons (which do honour CSS `color`), but the
// on/off state must still be exposed a way tests and screen readers can see —
// `aria-pressed`. These lock that in.

const base = {
    currentTrack: null,
    isPlaying: false,
    togglePlay: () => {},
    clock: createPlaybackClock(),
};

const music = { id: "t1", title: "T", file_path: "/a.mp3", file_name: "a.mp3" };
const podcast = { ...music, kind: "podcast" as const };

describe("PlayerBar transport toggles", () => {
    it("reflects the shuffle prop via aria-pressed", () => {
        const { rerender } = render(<PlayerBar {...base} shuffle={false} />);
        expect(screen.getByRole("button", { name: "Shuffle" })).toHaveAttribute("aria-pressed", "false");

        rerender(<PlayerBar {...base} shuffle={true} />);
        expect(screen.getByRole("button", { name: "Shuffle" })).toHaveAttribute("aria-pressed", "true");
    });

    it("fires onToggleShuffle on click", () => {
        const onToggleShuffle = vi.fn();
        render(<PlayerBar {...base} onToggleShuffle={onToggleShuffle} />);
        fireEvent.click(screen.getByRole("button", { name: "Shuffle" }));
        expect(onToggleShuffle).toHaveBeenCalledOnce();
    });

    it("reflects the lyrics-panel prop via aria-pressed and fires onLyricsClick", () => {
        const onLyricsClick = vi.fn();
        const track = { id: "t1", title: "T", file_path: "/a.mp3", file_name: "a.mp3" };
        const { rerender } = render(
            <PlayerBar {...base} currentTrack={track} onLyricsClick={onLyricsClick} isLyricsOpen={false} />
        );
        const btn = screen.getByRole("button", { name: "Lyrics" });
        expect(btn).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(btn);
        expect(onLyricsClick).toHaveBeenCalledOnce();

        rerender(<PlayerBar {...base} currentTrack={track} onLyricsClick={onLyricsClick} isLyricsOpen={true} />);
        expect(screen.getByRole("button", { name: "Lyrics" })).toHaveAttribute("aria-pressed", "true");
    });

    it("fires the ±10s skip handlers when a podcast is playing", () => {
        const onSkipBack = vi.fn();
        const onSkipForward = vi.fn();
        render(<PlayerBar {...base} currentTrack={podcast} onSkipBack={onSkipBack} onSkipForward={onSkipForward} />);
        fireEvent.click(screen.getByRole("button", { name: "Back 10 seconds" }));
        fireEvent.click(screen.getByRole("button", { name: "Forward 10 seconds" }));
        expect(onSkipBack).toHaveBeenCalledOnce();
        expect(onSkipForward).toHaveBeenCalledOnce();
    });

    it("shows ±10s only for podcasts, shuffle/repeat only otherwise", () => {
        const { rerender } = render(<PlayerBar {...base} currentTrack={podcast} />);
        expect(screen.queryByRole("button", { name: "Back 10 seconds" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Forward 10 seconds" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Shuffle" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Repeat" })).not.toBeInTheDocument();

        // Music track, and a track with no `kind` at all — both are "music".
        for (const t of [{ ...music, kind: "music" as const }, music]) {
            rerender(<PlayerBar {...base} currentTrack={t} />);
            expect(screen.queryByRole("button", { name: "Back 10 seconds" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Forward 10 seconds" })).not.toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Shuffle" })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Repeat" })).toBeInTheDocument();
        }
    });

    it("shows the podcast speed control only for podcasts, labelled with the current speed", () => {
        const { rerender } = render(<PlayerBar {...base} currentTrack={podcast} podcastSpeed={1.25} />);
        expect(screen.getByRole("button", { name: "Playback speed" })).toHaveTextContent("1.25x");

        rerender(<PlayerBar {...base} currentTrack={music} podcastSpeed={1.25} />);
        expect(screen.queryByRole("button", { name: "Playback speed" })).not.toBeInTheDocument();
    });

    it("fires onCyclePodcastSpeed on click", () => {
        const onCyclePodcastSpeed = vi.fn();
        render(<PlayerBar {...base} currentTrack={podcast} onCyclePodcastSpeed={onCyclePodcastSpeed} />);
        fireEvent.click(screen.getByRole("button", { name: "Playback speed" }));
        expect(onCyclePodcastSpeed).toHaveBeenCalledOnce();
    });

    it("marks repeat pressed for any mode other than off", () => {
        const { rerender } = render(<PlayerBar {...base} repeatMode="off" />);
        expect(screen.getByRole("button", { name: "Repeat" })).toHaveAttribute("aria-pressed", "false");

        rerender(<PlayerBar {...base} repeatMode="all" />);
        expect(screen.getByRole("button", { name: "Repeat" })).toHaveAttribute("aria-pressed", "true");

        expect(screen.queryByTestId("repeat-one-badge")).not.toBeInTheDocument();

        rerender(<PlayerBar {...base} repeatMode="one" />);
        expect(screen.getByRole("button", { name: "Repeat" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByTestId("repeat-one-badge")).toBeInTheDocument();
    });
});

describe("PlayerBar now-playing info", () => {
    const track = {
        id: "t1",
        title: "Song Title",
        artist: "Some Artist",
        album: "Some Album",
        file_path: "/music/song.mp3",
        file_name: "song.mp3",
    };

    it("shows the title and 'Artist — Album' on one line", () => {
        render(<PlayerBar {...base} currentTrack={track} />);
        expect(screen.getByText("Song Title")).toBeInTheDocument();
        expect(screen.getByText("Some Artist — Some Album")).toBeInTheDocument();
    });

    it("omits the dash when the track has no album", () => {
        render(<PlayerBar {...base} currentTrack={{ ...track, album: undefined }} />);
        expect(screen.getByText("Some Artist")).toBeInTheDocument();
        expect(screen.queryByText(/—/)).not.toBeInTheDocument();
    });

    it("enables the play button only when a track is loaded", () => {
        const { rerender } = render(<PlayerBar {...base} />);
        expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();

        rerender(<PlayerBar {...base} currentTrack={track} />);
        expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
    });

    it("shows elapsed / total time from the clock and duration", () => {
        const clock = createPlaybackClock(83);
        render(<PlayerBar {...base} clock={clock} currentTrack={track} duration={222} />);
        expect(screen.getByText("1:23")).toBeInTheDocument();
        expect(screen.getByText("3:42")).toBeInTheDocument();
    });

    it("re-renders the elapsed time when the clock ticks", () => {
        const clock = createPlaybackClock(0);
        render(<PlayerBar {...base} clock={clock} currentTrack={track} duration={222} />);
        expect(screen.getByText("0:00")).toBeInTheDocument();

        act(() => clock.set(5));
        expect(screen.getByText("0:05")).toBeInTheDocument();
    });

    it("disables the seek slider until a track is loaded", () => {
        const { rerender } = render(<PlayerBar {...base} />);
        expect(screen.getByRole("slider", { name: "Seek" })).toBeDisabled();

        rerender(<PlayerBar {...base} currentTrack={track} />);
        expect(screen.getByRole("slider", { name: "Seek" })).toBeEnabled();
    });
});
