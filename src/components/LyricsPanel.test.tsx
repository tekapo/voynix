import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => null as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => invoke(...a) }));

const updateLyrics = vi.fn(async (_id: string, _text: string) => {});
vi.mock("../db", () => ({ updateLyrics: (id: string, text: string) => updateLyrics(id, text) }));

import { LyricsPanel } from "./LyricsPanel";

const track = {
    id: "t1",
    title: "Song Title",
    artist: "Some Artist",
    album: "Some Album",
    file_path: "/music/song.mp3",
    file_name: "song.mp3",
};

beforeEach(() => {
    invoke.mockClear();
    invoke.mockResolvedValue(null);
    updateLyrics.mockClear();
});

describe("LyricsPanel", () => {
    it("renders nothing when closed", () => {
        const { container } = render(<LyricsPanel isOpen={false} onClose={() => {}} track={track} />);
        expect(container).toBeEmptyDOMElement();
    });

    it("shows embedded lyrics without hitting the network", () => {
        render(
            <LyricsPanel isOpen onClose={() => {}} track={{ ...track, lyrics: "line one\nline two" }} />
        );
        expect(screen.getByText("line one")).toBeInTheDocument();
        expect(screen.getByText("line two")).toBeInTheDocument();
        expect(invoke).not.toHaveBeenCalled();
    });

    it("fetches lyrics via fetch_lyrics when the track has none embedded", async () => {
        invoke.mockResolvedValueOnce("fetched line");
        render(<LyricsPanel isOpen onClose={() => {}} track={track} />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("fetch_lyrics", expect.objectContaining({ title: "Song Title" })));
        expect(await screen.findByText("fetched line")).toBeInTheDocument();
    });

    it("saves edited lyrics through updateLyrics", async () => {
        render(<LyricsPanel isOpen onClose={() => {}} track={{ ...track, lyrics: "old" }} />);
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "new words" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(updateLyrics).toHaveBeenCalledWith("t1", "new words"));
    });

    it("prompts when no track is playing", () => {
        render(<LyricsPanel isOpen onClose={() => {}} track={null} />);
        expect(screen.getByText("No track playing.")).toBeInTheDocument();
    });
});
