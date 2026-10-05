import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AlbumCoverPicker } from "./AlbumCoverPicker";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const candidate = {
    id: "itunes-1",
    title: "Abbey Road",
    artist: "The Beatles",
    image_url: "https://x.mzstatic.com/1000x1000bb.jpg",
    thumb_url: "https://x.mzstatic.com/300x300bb.jpg",
    source: "itunes",
};

describe("AlbumCoverPicker", () => {
    beforeEach(() => {
        vi.mocked(invoke).mockReset().mockResolvedValue([candidate]);
    });

    it("searches with the initial query and selects a candidate", async () => {
        const onSelect = vi.fn().mockResolvedValue(undefined);
        const onClose = vi.fn();
        render(<AlbumCoverPicker isOpen query="The Beatles Abbey Road" onClose={onClose} onSelect={onSelect} />);
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith("search_album_covers", { query: "The Beatles Abbey Road" }));
        fireEvent.click(await screen.findByAltText("Abbey Road"));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(candidate.image_url));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
});
