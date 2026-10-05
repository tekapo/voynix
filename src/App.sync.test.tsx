// Characterization tests for App.tsx's sync-server and settings/modal
// clusters (the `useSyncServer` / `useSettings` / `useModals`
// boundary).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { invoke, resetAppTestMocks } from "./test/renderApp";
import { seedLibrary } from "./test/seedLibrary";
import { _resetInitForTests, getSetting, initDb } from "./db";

import App from "./App";

const FAKE_STATUS = {
    running: true,
    ip: "192.168.1.5",
    port: 9999,
    url: "https://192.168.1.5:9999",
    token: "tok",
    fingerprint: "aabbccddeeff00112233445566778899",
    transcode_available: true,
};

beforeEach(async () => {
    resetAppTestMocks();
    _resetInitForTests();
    await initDb();
    // Autostart fires on every mount (App.tsx:364-368); give it a real-shaped
    // response so the sync modal reflects a running server without every test
    // having to click "Start Server" first.
    invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "start_sync_server") return FAKE_STATUS;
        if (cmd === "sync_server_status") return null; // forces the autostart branch, once
        return null;
    });
});

describe("sync server", () => {
    it("autostarts on mount and the Sync modal shows it running", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByRole("button", { name: "Sync" }));
        const modal = await screen.findByText("Wi-Fi Sync Server");
        const dialog = modal.closest(".modal-content") as HTMLElement;
        expect(within(dialog).getByText(FAKE_STATUS.url)).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "Stop Server" })).toBeInTheDocument();
    });

    it("Stop Server calls stop_sync_server and flips the modal to stopped", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_sync_server", expect.anything()));

        fireEvent.click(screen.getByRole("button", { name: "Sync" }));
        const dialog = (await screen.findByText("Wi-Fi Sync Server")).closest(".modal-content") as HTMLElement;
        fireEvent.click(within(dialog).getByRole("button", { name: "Stop Server" }));

        expect(await within(dialog).findByRole("button", { name: "Start Server" })).toBeInTheDocument();
        expect(invoke).toHaveBeenCalledWith("stop_sync_server");
    });
});

describe("settings", () => {
    async function openSettings() {
        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        const heading = await screen.findByRole("heading", { name: "Settings" });
        return heading.closest(".modal-content") as HTMLElement;
    }

    it("toggling 'Show file path column' persists the setting", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettings();
        fireEvent.click(within(dialog).getByRole("tab", { name: "Library" }));
        const checkbox = within(dialog).getByRole("checkbox", { name: /Show file path column/ });
        expect(checkbox).not.toBeChecked();

        fireEvent.click(checkbox);
        expect(checkbox).toBeChecked();
        await waitFor(async () => expect(await getSetting("show_path_column")).toBe("1"));
    });

    it("switching the transcode format persists it and updates the visible bitrate options", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettings();
        fireEvent.click(within(dialog).getByRole("tab", { name: "Sync" }));
        expect(within(dialog).getByText(/AAC bitrate/)).toBeInTheDocument();

        const formatSelect = within(dialog).getByLabelText(/Convert unsupported files/) ??
            within(dialog).getAllByRole("combobox")[0];
        fireEvent.change(formatSelect, { target: { value: "flac" } });

        await waitFor(async () => expect(await getSetting("transcode_format")).toBe("flac"));
        expect(within(dialog).queryByText(/AAC bitrate/)).not.toBeInTheDocument();
    });

    it("switching the transcode format rebuilds the pushed sync snapshot", async () => {
        // Unlike beforeEach's mock, keep reporting the server as running after the autostart —
        // the 3 s status poll would otherwise see it "gone" and the push effect stands down.
        let statusCalls = 0;
        invoke.mockImplementation(async (cmd: string) => {
            if (cmd === "start_sync_server") return FAKE_STATUS;
            if (cmd === "sync_server_status") return statusCalls++ === 0 ? null : FAKE_STATUS;
            if (cmd === "prepare_sync_media") return [];
            return null;
        });
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        const snapshotPushes = () => invoke.mock.calls.filter(c => c[0] === "set_sync_snapshot").length;
        // The initial push (debounced 1.5 s after the server is up).
        await waitFor(() => expect(snapshotPushes()).toBeGreaterThanOrEqual(1), { timeout: 5000 });
        const before = snapshotPushes();

        const dialog = await openSettings();
        fireEvent.click(within(dialog).getByRole("tab", { name: "Sync" }));
        const formatSelect = within(dialog).getByLabelText(/Convert unsupported files/);
        fireEvent.change(formatSelect, { target: { value: "flac" } });

        // Files already converted to the old format are stale; the manifest must be rebuilt.
        await waitFor(() => expect(snapshotPushes()).toBeGreaterThan(before), { timeout: 5000 });
    }, 15000);

    it("toggling sync-server autostart persists the setting", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        const dialog = await openSettings();
        fireEvent.click(within(dialog).getByRole("tab", { name: "Sync" }));
        const checkbox = within(dialog).getByRole("checkbox", { name: /Start sync server automatically/ });
        expect(checkbox).toBeChecked(); // default on

        fireEvent.click(checkbox);
        expect(checkbox).not.toBeChecked();
        await waitFor(async () => expect(await getSetting("sync_server_autostart")).toBe("0"));
    });
});

describe("context menus", () => {
    it("right-clicking a track row opens its context menu, and a window click closes it", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        const row = document.querySelector(".track-list li") as HTMLElement;
        fireEvent.contextMenu(row);

        expect(await screen.findByText("Show in Finder")).toBeInTheDocument();

        fireEvent.click(document.body);
        await waitFor(() => expect(screen.queryByText("Show in Finder")).not.toBeInTheDocument());
    });
});
