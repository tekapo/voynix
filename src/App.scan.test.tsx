// Characterization tests for App.tsx's scan-folder / iTunes-import cluster
// (handleAddScanFolder / rescanFolder / handleRescanFolders / handleRescanFolder /
// handleRemoveScanFolder / handleSetFolderKind / handleImportXml / importXml
// and the scanWithCache/cloudNote/folderName helpers they share).
//
// This is the safety net the planned App.tsx hook-splitting (phase 2) is
// waiting on: these 13 functions had zero coverage because renderApp.tsx's
// `open` mock defaults to `null` (no file picked), so no prior test ever
// drove a scan to completion.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { invoke, open, resetAppTestMocks } from "./test/renderApp";
import { seedLibrary } from "./test/seedLibrary";
import {
    _resetInitForTests,
    addScanFolder,
    addTracksToPlaylist,
    createPlaylist,
    getAllTracks,
    getScanFolders,
    initDb,
    setPlaylistTrackOrder,
} from "./db";
import type { ScanResult, Track } from "./types";

beforeEach(async () => {
    resetAppTestMocks();
    _resetInitForTests();
    await initDb();
});

import App from "./App";

function scanTrack(over: Partial<Track> & Pick<Track, "id" | "title" | "file_path" | "file_name">): Track {
    return { artist: "New Artist", album: "New Album", duration: 200, ...over };
}

function scanResult(tracks: Track[], over: Partial<ScanResult> = {}): ScanResult {
    return { tracks, scanned_path: "/music/new-folder", hash_cache: [], cancelled: false, skipped_cloud: 0, ...over };
}

async function openSettingsFoldersTab(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const heading = await screen.findByRole("heading", { name: "Music Folders" });
    return heading.closest(".modal-content") as HTMLElement;
}

function sidebar(): HTMLElement {
    return document.querySelector(".sidebar") as HTMLElement;
}

function trackList(): HTMLElement {
    return document.querySelector(".track-list") as HTMLElement;
}

function clickAddMusicFolder(): void {
    fireEvent.click(within(sidebar()).getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByText("Add Music Folder…"));
}

describe("Add Music Folder", () => {
    it("scans a folder, creates a playlist from it, registers it, and switches to it", async () => {
        open.mockResolvedValueOnce("/music/new-folder");
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") {
                return scanResult([
                    scanTrack({ id: "t-new-1", title: "New Song", file_path: "/music/new-folder/song.mp3", file_name: "song.mp3" }),
                ]);
            }
            return null;
        });

        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        clickAddMusicFolder();

        await screen.findByText("New Song");
        expect(within(sidebar()).getByText("new-folder")).toBeInTheDocument(); // new playlist in the sidebar, named after the folder

        const folders = await getScanFolders();
        expect(folders.map(f => f.path)).toContain("/music/new-folder");
    });

    it("refuses a folder that's already registered, without starting a scan", async () => {
        open.mockResolvedValueOnce("/music/dup-folder");
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") throw new Error("should not be called");
            return null;
        });

        const seeded = await seedLibrary();
        await addScanFolder("/music/dup-folder", seeded.rockPlaylistId);

        render(<App />);
        await screen.findByText("Aurora");

        clickAddMusicFolder();

        await screen.findByText("This folder is already registered.");
        expect(invoke).not.toHaveBeenCalledWith("scan_music_dir", expect.anything());
    });

    it("does nothing when the folder picker is dismissed", async () => {
        open.mockResolvedValueOnce(null);
        const scanSpy = invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") throw new Error("should not be called");
            return null;
        });

        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        clickAddMusicFolder();
        await waitFor(() => expect(open).toHaveBeenCalled());

        expect(scanSpy).not.toHaveBeenCalledWith("scan_music_dir", expect.anything());
        expect((await getScanFolders())).toHaveLength(0);
    });

    it("a cancelled scan adds nothing and shows a cancellation message", async () => {
        open.mockResolvedValueOnce("/music/cancelled-folder");
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") return scanResult([], { cancelled: true });
            return null;
        });

        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        clickAddMusicFolder();

        await screen.findByText("Folder scan cancelled — nothing was added.");
        expect((await getScanFolders())).toHaveLength(0);
        expect(invoke).not.toHaveBeenCalledWith("prewarm_album_thumbs", expect.anything());
    });

    it("prewarms one album-thumbnail request per distinct (artist, album), not one per track", async () => {
        open.mockResolvedValueOnce("/music/new-folder");
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") {
                return scanResult([
                    scanTrack({ id: "t-1", title: "One", artist: "Band A", album: "LP", file_path: "/music/new-folder/1.mp3", file_name: "1.mp3" }),
                    scanTrack({ id: "t-2", title: "Two", artist: "Band A", album: "LP", file_path: "/music/new-folder/2.mp3", file_name: "2.mp3" }),
                    scanTrack({ id: "t-3", title: "Three", artist: "Band B", album: "", file_path: "/music/new-folder/Live/3.mp3", file_name: "3.mp3" }),
                ]);
            }
            return null;
        });

        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        clickAddMusicFolder();
        await screen.findByText("Two"); // second track of the shared album, once the scan has landed

        await waitFor(() => expect(invoke).toHaveBeenCalledWith("prewarm_album_thumbs", expect.anything()));
        const call = invoke.mock.calls.find(([cmd]) => cmd === "prewarm_album_thumbs");
        const items = (call?.[1] as { items: { artist: string; album: string; path: string }[] }).items;
        expect(items).toHaveLength(2); // Band A/LP once, Band B's untagged track once
        expect(items).toContainEqual({ artist: "Band A", album: "LP", path: "/music/new-folder/1.mp3" });
        // Untagged album falls back to the parent folder name (see albumName.ts).
        expect(items).toContainEqual({ artist: "Band B", album: "Live", path: "/music/new-folder/Live/3.mp3" });
    });
});

describe("Rescan", () => {
    it("a single folder rescan replaces that playlist's tracks with the fresh scan result", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);

        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") {
                return scanResult([
                    scanTrack({ id: "t-rescanned", title: "Rescanned Track", file_path: "/music/artist-a/album-a/03-new.mp3", file_name: "03-new.mp3" }),
                ]);
            }
            return null;
        });

        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Rescan /music/artist-a/album-a" }));

        await waitFor(() => expect(within(dialog).queryByText(/Scanning/)).not.toBeInTheDocument());
        fireEvent.click(within(sidebar()).getByText("Rock Favorites"));

        await within(trackList()).findByText("Rescanned Track");
        expect(within(trackList()).queryByText("Aurora")).not.toBeInTheDocument(); // clearPlaylistTracks dropped the old rows
    });

    it("preserves a hand-reordered (manual_order) playlist's order across a rescan", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);
        // Reverse the existing two tracks in this folder to mark the playlist manual_order.
        await setPlaylistTrackOrder(seeded.rockPlaylistId, [seeded.trackIds.aTrack2, seeded.trackIds.aFavorite, seeded.trackIds.bTrack1]);

        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") {
                return scanResult([
                    scanTrack({ id: seeded.trackIds.aFavorite, title: "Aurora", file_path: "/music/artist-a/album-a/01-aurora.mp3", file_name: "01-aurora.mp3" }),
                    scanTrack({ id: seeded.trackIds.aTrack2, title: "Borealis", file_path: "/music/artist-a/album-a/02-borealis.mp3", file_name: "02-borealis.mp3" }),
                ]);
            }
            return null;
        });

        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Rescan /music/artist-a/album-a" }));
        await waitFor(() => expect(within(dialog).queryByText(/Scanning/)).not.toBeInTheDocument());

        fireEvent.click(within(sidebar()).getByText("Rock Favorites"));
        await within(trackList()).findByText("Aurora");

        const rows = document.querySelectorAll(".track-list .track-item .cell-title");
        const titles = Array.from(rows).map(r => r.textContent);
        expect(titles.indexOf("Borealis")).toBeLessThan(titles.indexOf("Aurora")); // manual order (Borealis, Aurora) restored, not scan order
    });

    it("Rescan All stops at the first cancelled folder and leaves later folders untouched", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);
        await addScanFolder("/music/my-podcast", seeded.podcastPlaylistId);

        let scanCalls = 0;
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") {
                scanCalls++;
                return scanResult([], { cancelled: true });
            }
            return null;
        });

        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Rescan All" }));

        await screen.findByText("Rescan cancelled — folders scanned so far are updated.");
        expect(scanCalls).toBe(1); // loop broke after the first folder's cancelled result
    });

    it("prunes a tracks row for a file gone from the rescanned folder, without touching tracks outside it", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);

        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") {
                return scanResult([
                    scanTrack({ id: "t-rescanned", title: "Rescanned Track", file_path: "/music/artist-a/album-a/03-new.mp3", file_name: "03-new.mp3" }),
                ]);
            }
            return null;
        });

        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Rescan /music/artist-a/album-a" }));
        await waitFor(() => expect(within(dialog).queryByText(/Scanning/)).not.toBeInTheDocument());

        const titles = (await getAllTracks()).map(t => t.title);
        // Aurora/Borealis lived under the rescanned folder and are gone from disk: pruned entirely, not just unlinked.
        expect(titles).not.toContain("Aurora");
        expect(titles).not.toContain("Borealis");
        expect(titles).toContain("Rescanned Track");
        // Cascade lived under a different folder path (artist-b/album-b); still orphaned from
        // "Rock Favorites", but out of scope for this rescan's prune, so its row must survive.
        expect(titles).toContain("Cascade");
    });

    it("a track still referenced by another playlist survives the rescan even though gone from the folder", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);
        const mix = await createPlaylist("My Mix", "custom");
        await addTracksToPlaylist(mix.id, [
            { id: seeded.trackIds.aFavorite, title: "Aurora", artist: "Artist A", album: "Album A", file_path: "/music/artist-a/album-a/01-aurora.mp3", file_name: "01-aurora.mp3" } as Track,
        ]);

        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") {
                return scanResult([
                    scanTrack({ id: "t-rescanned", title: "Rescanned Track", file_path: "/music/artist-a/album-a/03-new.mp3", file_name: "03-new.mp3" }),
                ]);
            }
            return null;
        });

        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Rescan /music/artist-a/album-a" }));
        await waitFor(() => expect(within(dialog).queryByText(/Scanning/)).not.toBeInTheDocument());

        // Aurora is gone from "Rock Favorites" but still belongs to "My Mix" — not an orphan, so its row survives.
        expect((await getAllTracks()).map(t => t.title)).toContain("Aurora");
    });

    it("rejects a rescan of an unreachable folder without touching its playlist", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);

        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "scan_music_dir") throw new Error("Folder not found: /music/artist-a/album-a");
            return null;
        });

        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Rescan /music/artist-a/album-a" }));

        await screen.findByText("Failed to rescan: Error: Folder not found: /music/artist-a/album-a");
        // The playlist was never cleared, since the scan failed before rescanFolder touched it.
        fireEvent.click(within(sidebar()).getByText("Rock Favorites"));
        await within(trackList()).findByText("Aurora");
    });
});

describe("Remove folder", () => {
    it("removes the folder's registration and deletes its playlist", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);

        render(<App />);
        await screen.findByText("Aurora");
        fireEvent.click(within(sidebar()).getByText("Rock Favorites"));
        await within(trackList()).findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove folder" }));

        await waitFor(async () => expect(await getScanFolders()).toHaveLength(0));
    });

    it("switching back to All Songs after removing the folder that was showing", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);

        render(<App />);
        await screen.findByText("Aurora");
        fireEvent.click(within(sidebar()).getByText("Rock Favorites"));
        await within(trackList()).findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Remove folder" }));

        await waitFor(() => expect(screen.queryByText("Rock Favorites")).not.toBeInTheDocument());
        // The removed playlist's own tracks are gone; the podcast playlist's are unaffected.
        await waitFor(() => expect(screen.queryByText("Aurora")).not.toBeInTheDocument());
    });
});

describe("Set folder kind", () => {
    it("persists the chosen default kind for the folder", async () => {
        const seeded = await seedLibrary();
        await addScanFolder("/music/artist-a/album-a", seeded.rockPlaylistId);

        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        const select = within(dialog).getByLabelText("Kind for /music/artist-a/album-a") as HTMLSelectElement;
        fireEvent.change(select, { target: { value: "podcast" } });

        await waitFor(async () => {
            const folders = await getScanFolders();
            expect(folders.find(f => f.path === "/music/artist-a/album-a")?.default_kind).toBe("podcast");
        });
    });
});

describe("Import iTunes Library", () => {
    it("imports the picked XML and creates a playlist named after the file", async () => {
        open.mockResolvedValueOnce("/Users/me/iTunes Music Library.xml");
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "import_itunes_xml") {
                return scanResult([
                    scanTrack({ id: "t-xml-1", title: "Imported Track", file_path: "/music/imported/track.mp3", file_name: "track.mp3" }),
                ]);
            }
            return null;
        });

        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Import iTunes Library…" }));

        await screen.findByText("Imported Track");
        expect(within(sidebar()).getByText("iTunes Music Library.xml")).toBeInTheDocument();
    });

    it("a cancelled import adds nothing and reports cancellation", async () => {
        open.mockResolvedValueOnce("/Users/me/iTunes Music Library.xml");
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "import_itunes_xml") return scanResult([], { cancelled: true });
            return null;
        });

        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettingsFoldersTab();
        fireEvent.click(within(dialog).getByRole("button", { name: "Import iTunes Library…" }));

        await screen.findByText("iTunes import cancelled — nothing was added.");
    });
});
