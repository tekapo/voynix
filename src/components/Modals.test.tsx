import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./Modals";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));

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
