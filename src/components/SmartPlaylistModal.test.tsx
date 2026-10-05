import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SmartPlaylistModal } from "./SmartPlaylistModal";
import { DEFAULT_SMART_RULES } from "../smartPlaylist";
import { SmartRules, Track } from "../types";

const makeTrack = (over: Partial<Track>): Track => ({
    id: over.id ?? "t1",
    title: "Song",
    file_path: "/music/song.mp3",
    file_name: "song.mp3",
    ...over,
});

const allTracks: Track[] = [
    makeTrack({ id: "t1", title: "Rock Song", genre: "Rock" }),
    makeTrack({ id: "t2", title: "Jazz Song", genre: "Jazz" }),
];

const emptyMembership = new Map<string, Set<string>>();

describe("SmartPlaylistModal", () => {
    it("renders nothing when editor is null", () => {
        const { container } = render(
            <SmartPlaylistModal
                editor={null}
                allTracks={allTracks}
                playlistOptions={[]}
                membership={emptyMembership}
                onClose={() => {}}
                onSave={async () => {}}
            />
        );
        expect(container.querySelector(".modal-overlay")).toBeNull();
    });

    it("shows a live match count that updates as rules change", async () => {
        render(
            <SmartPlaylistModal
                editor={{ name: "New Smart Playlist", rules: DEFAULT_SMART_RULES }}
                allTracks={allTracks}
                playlistOptions={[]}
                membership={emptyMembership}
                onClose={() => {}}
                onSave={async () => {}}
            />
        );
        // No conditions yet — every track matches.
        expect(await screen.findByText("2 songs match.")).toBeInTheDocument();

        fireEvent.click(screen.getByText("Add Rule"));
        // Default new rule is Title contains "" — still matches everything.
        expect(await screen.findByText("2 songs match.")).toBeInTheDocument();

        // Switch the field to Genre and type a value that only one track has.
        fireEvent.change(screen.getByDisplayValue("Title"), { target: { value: "genre" } });
        const valueInput = document.querySelector(".smart-rule-value") as HTMLInputElement;
        fireEvent.change(valueInput, { target: { value: "Rock" } });
        expect(await screen.findByText("1 song matches.")).toBeInTheDocument();
    });

    it("removes a rule with its × button", async () => {
        render(
            <SmartPlaylistModal
                editor={{ name: "Mix", rules: { ...DEFAULT_SMART_RULES, conditions: [{ field: "genre", op: "contains", value: "Rock" }] } }}
                allTracks={allTracks}
                playlistOptions={[]}
                membership={emptyMembership}
                onClose={() => {}}
                onSave={async () => {}}
            />
        );
        expect(await screen.findByText("1 song matches.")).toBeInTheDocument();
        fireEvent.click(screen.getByLabelText("Remove rule"));
        expect(await screen.findByText("No rules — every track matches.")).toBeInTheDocument();
        expect(await screen.findByText("2 songs match.")).toBeInTheDocument();
    });

    it("calls onSave with the trimmed name and current rules, then onClose", async () => {
        const onSave = vi.fn().mockResolvedValue(undefined);
        const onClose = vi.fn();
        render(
            <SmartPlaylistModal
                editor={{ name: "New Smart Playlist", rules: DEFAULT_SMART_RULES }}
                allTracks={allTracks}
                playlistOptions={[]}
                membership={emptyMembership}
                onClose={onClose}
                onSave={onSave}
            />
        );
        const nameInput = await screen.findByPlaceholderText("Smart Playlist Name");
        fireEvent.change(nameInput, { target: { value: "  My Mix  " } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(onSave).toHaveBeenCalledWith("My Mix", DEFAULT_SMART_RULES));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("asks to confirm discard when closing with unsaved changes", async () => {
        const onClose = vi.fn();
        render(
            <SmartPlaylistModal
                editor={{ name: "Mix", rules: DEFAULT_SMART_RULES }}
                allTracks={allTracks}
                playlistOptions={[]}
                membership={emptyMembership}
                onClose={onClose}
                onSave={async () => {}}
            />
        );
        const nameInput = await screen.findByDisplayValue("Mix");
        fireEvent.change(nameInput, { target: { value: "Mix 2" } });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        expect(onClose).toHaveBeenCalled();
    });

    it("lists non-smart playlists as options for the Playlist field", async () => {
        render(
            <SmartPlaylistModal
                editor={{
                    name: "Mix",
                    rules: { ...DEFAULT_SMART_RULES, conditions: [{ field: "playlist", op: "in", value: "p1" } as SmartRules["conditions"][number]] },
                }}
                allTracks={allTracks}
                playlistOptions={[{ id: "p1", name: "Rock Favorites" }]}
                membership={new Map([["p1", new Set(["t1"])]])}
                onClose={() => {}}
                onSave={async () => {}}
            />
        );
        expect(await screen.findByText("Rock Favorites")).toBeInTheDocument();
        expect(await screen.findByText("1 song matches.")).toBeInTheDocument();
    });
});
