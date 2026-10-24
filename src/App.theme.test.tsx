// Theme preference: applied to <html data-theme> (App.css keys its light
// variable set off it) and persisted from Settings → Library.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { invoke, resetAppTestMocks } from "./test/renderApp";
import { _resetInitForTests, getSetting, initDb, setSetting } from "./db";

import App from "./App";

beforeEach(async () => {
    resetAppTestMocks();
    _resetInitForTests();
    await initDb();
    invoke.mockImplementation(async () => null);
    await setSetting("welcome_seen", "1");
    delete document.documentElement.dataset.theme;
});

describe("theme", () => {
    it("applies a stored light preference to <html>", async () => {
        await setSetting("ui_theme", "light");
        render(<App />);
        await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    });

    it("persists a theme picked in Settings and applies it", async () => {
        render(<App />);
        fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
        fireEvent.click(await screen.findByRole("tab", { name: "General" }));
        fireEvent.change(screen.getByRole("combobox", { name: "Theme" }), { target: { value: "light" } });

        await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
        await waitFor(async () => expect(await getSetting("ui_theme")).toBe("light"));
    });
});
