import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const base = {
    isOpen: true,
    onClose: () => {},
    viewMode: "all_songs" as const,
    onLibraryClick: () => {},
    playlists: [],
    currentPlaylistId: null,
    onPlaylistClick: () => {},
    onPlaylistContextMenu: () => {},
    onCreatePlaylist: () => {},
    onCreateSmartPlaylist: () => {},
    onAddFolder: () => {},
    onSync: () => {},
    onSettings: () => {},
};

function openNewMenu() {
    fireEvent.click(screen.getByRole("button", { name: "New" }));
}

describe("Sidebar scan controls", () => {
    it("shows scan progress and a Cancel button while scanning", () => {
        const onCancelScan = vi.fn();
        render(
            <Sidebar
                {...base}
                isScanning
                scanProgress={{ done: 12, total: 40 }}
                onCancelScan={onCancelScan}
            />,
        );
        expect(screen.getByText("Scanning… 12/40")).toBeInTheDocument();
        fireEvent.click(screen.getByLabelText("Cancel scan"));
        expect(onCancelScan).toHaveBeenCalledOnce();
    });

    it("has no Cancel button when not scanning", () => {
        render(<Sidebar {...base} />);
        expect(screen.queryByLabelText("Cancel scan")).not.toBeInTheDocument();
        openNewMenu();
        expect(screen.getByText("Add Music Folder…")).toBeInTheDocument();
    });

    it("disables Add Music Folder… in the New menu while scanning", () => {
        render(<Sidebar {...base} isScanning scanProgress={{ done: 1, total: 2 }} />);
        openNewMenu();
        expect(screen.getByText("Add Music Folder…").closest(".context-menu-item")).toHaveClass("disabled");
    });
});

describe("Sidebar artwork prewarm status", () => {
    it("shows artwork progress and a Cancel button once scanning has finished", () => {
        const onCancelThumbPrewarm = vi.fn();
        render(
            <Sidebar
                {...base}
                artworkProgress={{ done: 120, total: 450 }}
                onCancelThumbPrewarm={onCancelThumbPrewarm}
            />,
        );
        expect(screen.getByText("Loading artwork… 120/450")).toBeInTheDocument();
        fireEvent.click(screen.getByLabelText("Cancel loading artwork"));
        expect(onCancelThumbPrewarm).toHaveBeenCalledOnce();
    });

    it("is hidden while a scan is still in progress, even if artworkProgress is set", () => {
        render(
            <Sidebar
                {...base}
                isScanning
                scanProgress={{ done: 1, total: 2 }}
                artworkProgress={{ done: 1, total: 10 }}
            />,
        );
        expect(screen.queryByText(/Loading artwork/)).not.toBeInTheDocument();
    });

    it("is absent with no artworkProgress and not scanning", () => {
        render(<Sidebar {...base} />);
        expect(screen.queryByText(/Loading artwork/)).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Cancel loading artwork")).not.toBeInTheDocument();
    });
});

describe("Sidebar New menu", () => {
    it("closes after choosing an item", () => {
        const onCreatePlaylist = vi.fn();
        render(<Sidebar {...base} onCreatePlaylist={onCreatePlaylist} />);
        openNewMenu();
        fireEvent.click(screen.getByText("New Playlist"));
        expect(onCreatePlaylist).toHaveBeenCalledOnce();
        expect(screen.queryByText("New Smart Playlist")).not.toBeInTheDocument();
    });
});

describe("Sidebar playlist kind badge", () => {
    it("shows a Podcast badge only on podcast playlists", () => {
        render(
            <Sidebar
                {...base}
                playlists={[
                    { id: "p1", name: "My Podcast", tracks: [], type: "custom", kind: "podcast" },
                    { id: "p2", name: "My Music", tracks: [], type: "custom", kind: "music" },
                ]}
            />,
        );
        expect(screen.getByLabelText("Podcast")).toBeInTheDocument();
        expect(screen.getAllByLabelText("Podcast")).toHaveLength(1);
    });
});

describe("Sidebar smart playlists", () => {
    it("has a New Smart Playlist button that calls onCreateSmartPlaylist", () => {
        const onCreateSmartPlaylist = vi.fn();
        render(<Sidebar {...base} onCreateSmartPlaylist={onCreateSmartPlaylist} />);
        openNewMenu();
        fireEvent.click(screen.getByText("New Smart Playlist"));
        expect(onCreateSmartPlaylist).toHaveBeenCalledOnce();
    });

    it("renders a smart playlist with the wand icon", () => {
        const { container } = render(
            <Sidebar
                {...base}
                playlists={[{ id: "p1", name: "Recently Loved", tracks: [], type: "smart" }]}
            />,
        );
        expect(screen.getByText("Recently Loved")).toBeInTheDocument();
        // No accessible name is set on the icon itself, so just confirm one
        // svg renders per playlist row (a smoke check the icon lookup didn't
        // throw / fall back silently) — scoped to the Playlists list, since
        // the Library section above also uses .playlist-item/.playlist-icon.
        expect(container.querySelectorAll(".playlist-list .playlist-item .playlist-icon svg")).toHaveLength(1);
    });
});

describe("Sidebar keyboard access", () => {
    it("exposes library entries as buttons and marks the current view", () => {
        render(<Sidebar {...base} viewMode="favorites" />);
        expect(screen.getByRole("button", { name: "Favorites" })).toHaveAttribute("aria-current", "page");
        expect(screen.getByRole("button", { name: "All Songs" })).not.toHaveAttribute("aria-current");
    });

    it("opens a library entry with Enter and Space", () => {
        const onLibraryClick = vi.fn();
        render(<Sidebar {...base} onLibraryClick={onLibraryClick} />);
        const entry = screen.getByRole("button", { name: "Favorites" });
        fireEvent.keyDown(entry, { key: "Enter" });
        fireEvent.keyDown(entry, { key: " " });
        expect(onLibraryClick).toHaveBeenCalledTimes(2);
        expect(onLibraryClick).toHaveBeenCalledWith("favorites");
    });

    it("opens a playlist with the keyboard", () => {
        const onPlaylistClick = vi.fn();
        const pl = { id: "p1", name: "Road Trip", type: "custom" } as never;
        render(<Sidebar {...base} playlists={[pl]} onPlaylistClick={onPlaylistClick} />);
        fireEvent.keyDown(screen.getByRole("button", { name: /Road Trip/ }), { key: "Enter" });
        expect(onPlaylistClick).toHaveBeenCalledWith("p1");
    });
});
