import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsModal } from "../Modals";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

type Props = React.ComponentProps<typeof SettingsModal>;

function makeProps(over: Partial<Props> = {}): Props {
    return {
        isOpen: true,
        onClose: () => {},
        folders: [],
        isScanning: false,
        onAddFolder: () => {},
        onRemoveFolder: () => {},
        onRescan: () => {},
        onRescanFolder: () => {},
        onImportXml: () => {},
        onSetFolderKind: () => {},
        showPathColumn: false,
        onTogglePathColumn: () => {},
        podcastNoShuffle: false,
        onTogglePodcastNoShuffle: () => {},
        serverAutostart: false,
        bluetoothSync: false,
        onToggleBluetoothSync: () => {},
        onToggleServerAutostart: () => {},
        transcodeFormat: "aac",
        onChangeTranscodeFormat: () => {},
        transcodeBitrate: 256000,
        onChangeTranscodeBitrate: () => {},
        onFetchMissingArtistImages: () => {},
        onCancelFetchMissingArtistImages: () => {},
        language: "system",
        onChangeLanguage: () => {},
        theme: "system",
        onChangeTheme: () => {},
        autoUpdateCheck: false,
        onToggleAutoUpdateCheck: () => {},
        updater: {
            status: { kind: "idle" },
            dialogOpen: false,
            checkNow: () => {},
            install: () => {},
            dismiss: () => {},
        },
        onExportBackup: () => {},
        onImportBackup: () => {},
        ...over,
    } as Props;
}

const folder = (path: string, kind = "music") => ({ path, default_kind: kind }) as never;
const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("tab strip", () => {
    it("lists General, Music Folders, Library, Sync and About, and hides Remote without remote access", () => {
        render(<SettingsModal {...makeProps()} />);
        expect(screen.getAllByRole("tab").map(t => t.textContent)).toEqual([
            "General", "Music Folders", "Library", "Sync", "About",
        ]);
    });

    it("opens on General and marks exactly one tab selected", () => {
        render(<SettingsModal {...makeProps()} />);
        const selected = screen.getAllByRole("tab").filter(t => t.getAttribute("aria-selected") === "true");
        expect(selected.map(t => t.textContent)).toEqual(["General"]);
    });

    it("moves between tabs with the arrow keys, wrapping at both ends", () => {
        render(<SettingsModal {...makeProps()} />);
        const strip = screen.getByRole("tablist");
        fireEvent.keyDown(strip, { key: "ArrowUp" });
        expect(screen.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true");
        fireEvent.keyDown(strip, { key: "ArrowDown" });
        expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
        fireEvent.keyDown(strip, { key: "ArrowDown" });
        expect(screen.getByRole("tab", { name: "Music Folders" })).toHaveAttribute("aria-selected", "true");
    });

    it("renders nothing when closed", () => {
        const { container } = render(<SettingsModal {...makeProps({ isOpen: false })} />);
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});

describe("General tab", () => {
    it("changes language", () => {
        const onChangeLanguage = vi.fn();
        render(<SettingsModal {...makeProps({ onChangeLanguage })} />);
        fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "ja" } });
        expect(onChangeLanguage).toHaveBeenCalledWith("ja");
    });

    it("toggles the launch-time update check and runs a manual check", () => {
        const onToggleAutoUpdateCheck = vi.fn();
        const checkNow = vi.fn();
        const updater = { status: { kind: "idle" }, dialogOpen: false, checkNow, install: vi.fn(), dismiss: vi.fn() };
        render(<SettingsModal {...makeProps({ onToggleAutoUpdateCheck, updater: updater as never })} />);
        fireEvent.click(screen.getByRole("checkbox"));
        expect(onToggleAutoUpdateCheck).toHaveBeenCalledWith(true);
        fireEvent.click(screen.getByRole("button", { name: "Check for Updates" }));
        expect(checkNow).toHaveBeenCalledTimes(1);
    });

    it("disables the manual check while one is running", () => {
        const updater = { status: { kind: "checking" }, dialogOpen: false, checkNow: vi.fn(), install: vi.fn(), dismiss: vi.fn() };
        render(<SettingsModal {...makeProps({ updater: updater as never })} />);
        expect(screen.getByRole("button", { name: "Check for Updates" })).toBeDisabled();
    });
});

describe("Music Folders tab", () => {
    it("shows the empty state and disables Rescan All with no folders", () => {
        render(<SettingsModal {...makeProps()} />);
        openTab("Music Folders");
        expect(screen.getByText("No folders added yet.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Rescan All" })).toBeDisabled();
    });

    it("wires Add, Rescan All and iTunes import", () => {
        const onAddFolder = vi.fn();
        const onRescan = vi.fn();
        const onImportXml = vi.fn();
        render(<SettingsModal {...makeProps({ folders: [folder("/m")], onAddFolder, onRescan, onImportXml })} />);
        openTab("Music Folders");
        fireEvent.click(screen.getByRole("button", { name: "+ Add Folder" }));
        fireEvent.click(screen.getByRole("button", { name: "Rescan All" }));
        fireEvent.click(screen.getByRole("button", { name: "Import iTunes Library…" }));
        expect(onAddFolder).toHaveBeenCalledTimes(1);
        expect(onRescan).toHaveBeenCalledTimes(1);
        expect(onImportXml).toHaveBeenCalledTimes(1);
    });

    it("acts on the right folder: rescan, remove and change kind", () => {
        const a = folder("/music/a");
        const b = folder("/music/b");
        const onRescanFolder = vi.fn();
        const onRemoveFolder = vi.fn();
        const onSetFolderKind = vi.fn();
        render(<SettingsModal {...makeProps({ folders: [a, b], onRescanFolder, onRemoveFolder, onSetFolderKind })} />);
        openTab("Music Folders");

        fireEvent.click(screen.getByRole("button", { name: "Rescan /music/b" }));
        expect(onRescanFolder).toHaveBeenCalledWith(b);

        fireEvent.click(screen.getAllByRole("button", { name: "Remove folder" })[0]);
        expect(onRemoveFolder).toHaveBeenCalledWith(a);

        fireEvent.change(screen.getByRole("combobox", { name: "Kind for /music/a" }), { target: { value: "podcast" } });
        expect(onSetFolderKind).toHaveBeenCalledWith(a, "podcast");
    });

    it("shows scan progress with a cancel button, and locks the folder actions while scanning", () => {
        const onCancelScan = vi.fn();
        render(<SettingsModal {...makeProps({
            folders: [folder("/m")], isScanning: true, scanProgress: { done: 3, total: 10 }, onCancelScan,
        })} />);
        openTab("Music Folders");
        expect(screen.getByText("Scanning… 3/10")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Cancel scan" }));
        expect(onCancelScan).toHaveBeenCalledTimes(1);
        for (const name of ["+ Add Folder", "Rescan All", "Import iTunes Library…", "Remove folder", "Rescan /m"]) {
            expect(screen.getByRole("button", { name })).toBeDisabled();
        }
    });
});

describe("Library tab", () => {
    it("toggles the path column and podcast shuffle with their current values", () => {
        const onTogglePathColumn = vi.fn();
        const onTogglePodcastNoShuffle = vi.fn();
        render(<SettingsModal {...makeProps({ onTogglePathColumn, onTogglePodcastNoShuffle })} />);
        openTab("Library");
        fireEvent.click(screen.getByRole("checkbox", { name: "Show file path column" }));
        expect(onTogglePathColumn).toHaveBeenCalledWith(true);
        fireEvent.click(screen.getByRole("checkbox", { name: "Don't shuffle Podcast playlists" }));
        expect(onTogglePodcastNoShuffle).toHaveBeenCalledWith(true);
    });

    it("starts the bulk artist-image fetch", () => {
        const onFetchMissingArtistImages = vi.fn();
        render(<SettingsModal {...makeProps({ onFetchMissingArtistImages })} />);
        openTab("Library");
        fireEvent.click(screen.getByRole("button", { name: "Fetch Missing Artist Images" }));
        expect(onFetchMissingArtistImages).toHaveBeenCalledTimes(1);
    });

    it("swaps the fetch button for a progress bar and Cancel while it runs", () => {
        const onCancelFetchMissingArtistImages = vi.fn();
        render(<SettingsModal {...makeProps({
            artistImageFetchProgress: { done: 2, total: 8, found: 1 }, onCancelFetchMissingArtistImages,
        })} />);
        openTab("Library");
        expect(screen.queryByRole("button", { name: "Fetch Missing Artist Images" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onCancelFetchMissingArtistImages).toHaveBeenCalledTimes(1);
    });
});

describe("Sync tab", () => {
    it("toggles the autostart option", () => {
        const onToggleServerAutostart = vi.fn();
        render(<SettingsModal {...makeProps({ onToggleServerAutostart })} />);
        openTab("Sync");
        fireEvent.click(screen.getByRole("checkbox", { name: "Start sync server automatically" }));
        expect(onToggleServerAutostart).toHaveBeenCalledWith(true);
    });

    it("changes the transcode format and (for AAC) the bitrate as a number", () => {
        const onChangeTranscodeFormat = vi.fn();
        const onChangeTranscodeBitrate = vi.fn();
        render(<SettingsModal {...makeProps({ onChangeTranscodeFormat, onChangeTranscodeBitrate })} />);
        openTab("Sync");
        const [format, bitrate] = screen.getAllByRole("combobox");
        fireEvent.change(format, { target: { value: "flac" } });
        expect(onChangeTranscodeFormat).toHaveBeenCalledWith("flac");
        fireEvent.change(bitrate, { target: { value: "320000" } });
        expect(onChangeTranscodeBitrate).toHaveBeenCalledWith(320000);
    });

    it("hides the bitrate choice for FLAC", () => {
        render(<SettingsModal {...makeProps({ transcodeFormat: "flac" })} />);
        openTab("Sync");
        expect(screen.getAllByRole("combobox")).toHaveLength(1);
    });
});

describe("About tab", () => {
    it("shows the app version once it has loaded", async () => {
        render(<SettingsModal {...makeProps({ initialTab: "about" })} />);
        expect(await screen.findByText(/0\.0\.0-test/)).toBeInTheDocument();
    });

    it("closes Settings, then opens the welcome guide", () => {
        const calls: string[] = [];
        render(<SettingsModal {...makeProps({
            initialTab: "about", onClose: () => calls.push("close"), onShowWelcome: () => calls.push("welcome"),
        })} />);
        fireEvent.click(screen.getByRole("button", { name: /welcome guide/i }));
        expect(calls).toEqual(["close", "welcome"]);
    });

    it("keeps the loaded licenses text when you switch tabs and come back", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "LICENSE TEXT" })));
        render(<SettingsModal {...makeProps({ initialTab: "about" })} />);
        fireEvent.click(screen.getByRole("button", { name: "Open source licenses" }));
        expect(await screen.findByText("LICENSE TEXT")).toBeInTheDocument();

        openTab("General");
        expect(screen.queryByText("LICENSE TEXT")).toBeNull();
        openTab("About");
        expect(screen.getByText("LICENSE TEXT")).toBeInTheDocument();
        vi.unstubAllGlobals();
    });

    it("hides the licenses again on a second click", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "LICENSE TEXT" })));
        render(<SettingsModal {...makeProps({ initialTab: "about" })} />);
        const btn = screen.getByRole("button", { name: "Open source licenses" });
        fireEvent.click(btn);
        await screen.findByText("LICENSE TEXT");
        fireEvent.click(btn);
        expect(screen.queryByText("LICENSE TEXT")).toBeNull();
        vi.unstubAllGlobals();
    });
});
