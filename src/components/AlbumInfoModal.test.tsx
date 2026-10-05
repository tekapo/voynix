import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AlbumInfoModal } from "./AlbumInfoModal";
import { Track } from "../types";

const makeTrack = (over: Partial<Track>): Track => ({
    id: over.id ?? "t1",
    title: "Song",
    artist: "The Artist",
    album: "The Album",
    file_path: "/music/song.mp3",
    file_name: "song.mp3",
    duration: 180,
    track_no: 1,
    play_count: 0,
    ...over,
});

const tracks: Track[] = [
    makeTrack({ id: "t1", title: "Track One", track_no: 1, duration: 180, play_count: 3, favorite: 1, added_at: 2000 }),
    makeTrack({ id: "t2", title: "Track Two", track_no: 2, duration: 220, play_count: 1, added_at: 1000 }),
];

describe("AlbumInfoModal", () => {
    it("renders nothing when tracks is empty", () => {
        const { container } = render(
            <AlbumInfoModal tracks={[]} onClose={() => {}} onSave={async () => {}} />
        );
        expect(container.querySelector(".modal-overlay")).toBeNull();
    });

    it("shows aggregated stats on the Details tab and disables Save until edited", async () => {
        render(<AlbumInfoModal tracks={tracks} onClose={() => {}} onSave={async () => {}} />);
        expect(await screen.findByDisplayValue("The Artist")).toBeInTheDocument();
        expect(screen.getByDisplayValue("The Album")).toBeInTheDocument();
        expect(screen.getByText("2 tracks")).toBeInTheDocument();
        expect(screen.getByText("1 favorite")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    it("lists every track on the Tracks tab", async () => {
        render(<AlbumInfoModal tracks={tracks} onClose={() => {}} onSave={async () => {}} />);
        await screen.findByDisplayValue("The Artist");
        fireEvent.click(screen.getByRole("tab", { name: "Tracks" }));
        expect(screen.getByText("Track One")).toBeInTheDocument();
        expect(screen.getByText("Track Two")).toBeInTheDocument();
    });

    it("enables Save after editing Artist/Album and calls onSave with every track", async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        const onClose = vi.fn();
        render(<AlbumInfoModal tracks={tracks} onClose={onClose} onSave={onSave} />);
        const albumInput = await screen.findByDisplayValue("The Album");
        fireEvent.change(albumInput, { target: { value: "New Album" } });

        const saveBtn = screen.getByRole("button", { name: "Save" });
        expect(saveBtn).not.toBeDisabled();
        fireEvent.click(saveBtn);

        await waitFor(() => expect(onSave).toHaveBeenCalledWith(
            tracks,
            { artist: "The Artist", album: "New Album" },
            expect.any(Function)
        ));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("shows save progress via the onProgress callback", async () => {
        let progressCb: ((done: number, total: number) => void) | undefined;
        const onSave = vi.fn((_tracks, _fields, onProgress) => {
            progressCb = onProgress;
            return new Promise<void>((resolve) => {
                onProgress(1, 2);
                setTimeout(resolve, 0);
            });
        });
        render(<AlbumInfoModal tracks={tracks} onClose={() => {}} onSave={onSave} />);
        const albumInput = await screen.findByDisplayValue("The Album");
        fireEvent.change(albumInput, { target: { value: "New Album" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(screen.getByRole("button", { name: /Saving… 1\/2/ })).toBeInTheDocument());
        expect(progressCb).toBeDefined();
    });

    it("surfaces a partial-failure error and keeps the modal open", async () => {
        const onSave = vi.fn().mockRejectedValue(new Error("1/2 files failed: track-two.mp3"));
        const onClose = vi.fn();
        render(<AlbumInfoModal tracks={tracks} onClose={onClose} onSave={onSave} />);
        const albumInput = await screen.findByDisplayValue("The Album");
        fireEvent.change(albumInput, { target: { value: "New Album" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await screen.findByText(/1\/2 files failed/);
        expect(onClose).not.toHaveBeenCalled();
    });

    it("asks to discard unsaved changes on Escape", async () => {
        const onClose = vi.fn();
        render(<AlbumInfoModal tracks={tracks} onClose={onClose} onSave={async () => {}} />);
        const albumInput = await screen.findByDisplayValue("The Album");
        fireEvent.change(albumInput, { target: { value: "New Album" } });

        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        expect(onClose).toHaveBeenCalled();
    });

    it("closes immediately on Escape when nothing changed", async () => {
        const onClose = vi.fn();
        render(<AlbumInfoModal tracks={tracks} onClose={onClose} onSave={async () => {}} />);
        await screen.findByDisplayValue("The Artist");
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalled();
    });
});
