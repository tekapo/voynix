import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TrackInfoModal } from "./TrackInfoModal";
import { Track } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (_cmd: string, _args?: unknown) => null as unknown),
}));

const track: Track = {
    id: "t1",
    title: "Old Title",
    artist: "Old Artist",
    album: "Old Album",
    file_path: "/music/old.mp3",
    file_name: "old.mp3",
    disc_no: 1,
    track_no: 3,
};

const fileInfo = {
    title: "Old Title",
    artist: "Old Artist",
    album: "Old Album",
    genre: "Rock",
    year: 2001,
    disc_no: 1,
    track_no: 3,
    duration_ms: 210000,
    format: "Mpeg",
    audio_bitrate_kbps: 320,
    sample_rate_hz: 44100,
    bit_depth: null,
    channels: 2,
    size_bytes: 5_000_000,
    modified_at: 1700000000000,
    cloud_only: false,
};

describe("TrackInfoModal", () => {
    beforeEach(() => {
        (invoke as unknown as ReturnType<typeof vi.fn>).mockReset().mockImplementation(async (cmd: string) => {
            if (cmd === "get_track_file_info") return fileInfo;
            if (cmd === "write_track_tags") return { track_key: "new-key", content_hash: "new-hash" };
            return null;
        });
    });

    it("renders nothing when no track is selected", () => {
        const { container } = render(
            <TrackInfoModal track={null} onClose={() => {}} onSave={async () => {}} onShowInFinder={() => {}} />
        );
        expect(container.querySelector(".modal-overlay")).toBeNull();
    });

    it("loads file info into the Details tab and disables Save until a field changes", async () => {
        render(
            <TrackInfoModal track={track} onClose={() => {}} onSave={async () => {}} onShowInFinder={() => {}} />
        );
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_track_file_info", { path: "/music/old.mp3" }));
        await screen.findByDisplayValue("Old Title");
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    it("shows technical info on the File tab", async () => {
        render(
            <TrackInfoModal track={track} onClose={() => {}} onSave={async () => {}} onShowInFinder={() => {}} />
        );
        await screen.findByDisplayValue("Old Title");
        fireEvent.click(screen.getByRole("tab", { name: "File" }));
        expect(screen.getByText("320 kbps")).toBeInTheDocument();
        expect(screen.getByText("44.1 kHz")).toBeInTheDocument();
        expect(screen.getByText("Stereo")).toBeInTheDocument();
    });

    it("enables Save after an edit and calls onSave with the new fields", async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        const onClose = vi.fn();
        render(
            <TrackInfoModal track={track} onClose={onClose} onSave={onSave} onShowInFinder={() => {}} />
        );
        const titleInput = await screen.findByDisplayValue("Old Title");
        fireEvent.change(titleInput, { target: { value: "New Title" } });

        const saveBtn = screen.getByRole("button", { name: "Save" });
        expect(saveBtn).not.toBeDisabled();
        fireEvent.click(saveBtn);

        await waitFor(() => expect(onSave).toHaveBeenCalledWith(track, {
            title: "New Title",
            artist: "Old Artist",
            album: "Old Album",
            disc_no: 1,
            track_no: 3,
        }));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("submits on Enter in a text field", async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
            <TrackInfoModal track={track} onClose={() => {}} onSave={onSave} onShowInFinder={() => {}} />
        );
        const titleInput = await screen.findByDisplayValue("Old Title");
        fireEvent.change(titleInput, { target: { value: "New Title" } });
        fireEvent.submit(titleInput.closest("form")!);

        await waitFor(() => expect(onSave).toHaveBeenCalledWith(track, expect.objectContaining({ title: "New Title" })));
    });

    it("saves on Cmd+S / Ctrl+S", async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(
            <TrackInfoModal track={track} onClose={() => {}} onSave={onSave} onShowInFinder={() => {}} />
        );
        const titleInput = await screen.findByDisplayValue("Old Title");
        fireEvent.change(titleInput, { target: { value: "New Title" } });
        fireEvent.keyDown(window, { key: "s", metaKey: true });

        await waitFor(() => expect(onSave).toHaveBeenCalledWith(track, expect.objectContaining({ title: "New Title" })));
    });

    it("closes immediately on Escape when nothing changed", async () => {
        const onClose = vi.fn();
        render(
            <TrackInfoModal track={track} onClose={onClose} onSave={async () => {}} onShowInFinder={() => {}} />
        );
        await screen.findByDisplayValue("Old Title");
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalled();
    });

    it("asks to discard unsaved changes on Escape, and closes only after confirming", async () => {
        const onClose = vi.fn();
        render(
            <TrackInfoModal track={track} onClose={onClose} onSave={async () => {}} onShowInFinder={() => {}} />
        );
        const titleInput = await screen.findByDisplayValue("Old Title");
        fireEvent.change(titleInput, { target: { value: "New Title" } });

        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        expect(onClose).toHaveBeenCalled();
    });

    it("copies the file path from the File tab", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        render(
            <TrackInfoModal track={track} onClose={() => {}} onSave={async () => {}} onShowInFinder={() => {}} />
        );
        await screen.findByDisplayValue("Old Title");
        fireEvent.click(screen.getByRole("tab", { name: "File" }));
        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
        expect(writeText).toHaveBeenCalledWith("/music/old.mp3");
    });

    it("disables editing for a cloud-only placeholder", async () => {
        (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
            if (cmd === "get_track_file_info") return { ...fileInfo, cloud_only: true, title: null, artist: null, album: null };
            return null;
        });
        render(
            <TrackInfoModal track={track} onClose={() => {}} onSave={async () => {}} onShowInFinder={() => {}} />
        );
        await screen.findByText(/hasn't downloaded from iCloud yet/);
        expect(screen.getByDisplayValue("Old Title")).toBeDisabled();
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
});
