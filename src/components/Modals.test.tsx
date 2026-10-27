import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./Modals";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

function makeProps(over: Partial<React.ComponentProps<typeof SettingsModal>> = {}) {
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
        podcastNoShuffle: true,
        onTogglePodcastNoShuffle: () => {},
        serverAutostart: true,
        onToggleServerAutostart: () => {},
        transcodeFormat: "aac" as const,
        onChangeTranscodeFormat: () => {},
        transcodeBitrate: 256000,
        onChangeTranscodeBitrate: () => {},
        onFetchMissingArtistImages: () => {},
        onCancelFetchMissingArtistImages: () => {},
        language: "system" as const,
        onChangeLanguage: () => {},
        theme: "system" as const,
        onChangeTheme: () => {},
        autoUpdateCheck: true,
        onToggleAutoUpdateCheck: () => {},
        updater: {
            status: { kind: "idle" } as const,
            dialogOpen: false,
            checkNow: () => {},
            install: () => {},
            dismiss: () => {},
        },
        onExportBackup: () => {},
        onImportBackup: () => {},
        ...over,
    };
}

describe("SettingsModal backup section", () => {
    it("shows Export/Import Backup buttons on the Library tab and calls the right handler", () => {
        const onExportBackup = vi.fn();
        const onImportBackup = vi.fn();
        render(<SettingsModal {...makeProps({ onExportBackup, onImportBackup })} />);

        fireEvent.click(screen.getByRole("tab", { name: "Library" }));

        fireEvent.click(screen.getByRole("button", { name: "Export Backup…" }));
        expect(onExportBackup).toHaveBeenCalledTimes(1);
        expect(onImportBackup).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Import Backup…" }));
        expect(onImportBackup).toHaveBeenCalledTimes(1);
    });

    it("disables the backup buttons while a scan/import is in progress", () => {
        render(<SettingsModal {...makeProps({ isScanning: true })} />);
        fireEvent.click(screen.getByRole("tab", { name: "Library" }));

        expect(screen.getByRole("button", { name: "Export Backup…" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Import Backup…" })).toBeDisabled();
    });
});

describe("SettingsModal theme setting", () => {
    it("lets the user pick a theme on the Library tab", () => {
        const onChangeTheme = vi.fn();
        render(<SettingsModal {...makeProps({ onChangeTheme })} />);
        fireEvent.click(screen.getByRole("tab", { name: "General" }));

        fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), { target: { value: "light" } });
        expect(onChangeTheme).toHaveBeenCalledWith("light");
    });
});

describe("SettingsModal about tab", () => {
    it("opens the Ko-fi page from the support button", () => {
        render(<SettingsModal {...makeProps()} />);
        fireEvent.click(screen.getByRole("tab", { name: "About" }));

        fireEvent.click(screen.getByRole("button", { name: "Support on Ko-fi" }));
        expect(openUrl).toHaveBeenCalledWith("https://ko-fi.com/tekapo");
    });
});

describe("SettingsModal self-update", () => {
    it("toggles the launch-time check", () => {
        const onToggleAutoUpdateCheck = vi.fn();
        render(<SettingsModal {...makeProps({ onToggleAutoUpdateCheck })} />);
        fireEvent.click(screen.getByLabelText("Check for updates at launch"));
        expect(onToggleAutoUpdateCheck).toHaveBeenCalledWith(false);
    });

    it("runs a manual check from About and shows the result", () => {
        const checkNow = vi.fn();
        const updater = { status: { kind: "upToDate" } as const, dialogOpen: false, checkNow, install: () => {}, dismiss: () => {} };
        render(<SettingsModal {...makeProps({ updater })} />);
        fireEvent.click(screen.getByRole("tab", { name: "About" }));
        fireEvent.click(screen.getByText("Check for Updates"));
        expect(checkNow).toHaveBeenCalled();
        expect(screen.getByText("You're up to date.")).toBeTruthy();
    });
});
