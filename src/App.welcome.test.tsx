// First-launch welcome guide: shown once on an empty install, never for an
// existing library, and reopenable from Settings → About.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { invoke, resetAppTestMocks } from "./test/renderApp";
import { seedLibrary } from "./test/seedLibrary";
import { _resetInitForTests, getSetting, initDb, setSetting } from "./db";

import App from "./App";

beforeEach(async () => {
    resetAppTestMocks();
    _resetInitForTests();
    await initDb();
    invoke.mockImplementation(async () => null);
});

describe("welcome guide", () => {
    it("opens on an empty install and is marked seen immediately", async () => {
        render(<App />);
        expect(await screen.findByRole("dialog", { name: "Welcome to Voynix" })).toBeInTheDocument();
        await waitFor(async () => expect(await getSetting("welcome_seen")).toBe("1"));
    });

    it("does not open once seen", async () => {
        await setSetting("welcome_seen", "1");
        render(<App />);
        await screen.findByRole("button", { name: "Sync" });
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Welcome to Voynix" })).toBeNull());
    });

    it("does not open for an existing library", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        expect(screen.queryByRole("dialog", { name: "Welcome to Voynix" })).toBeNull();
        expect(await getSetting("welcome_seen")).toBeNull();
    });

    it("can be reopened from Settings → About", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        fireEvent.click(await screen.findByRole("tab", { name: "About" }));
        fireEvent.click(screen.getByRole("button", { name: "Show welcome guide" }));

        expect(await screen.findByRole("dialog", { name: "Welcome to Voynix" })).toBeInTheDocument();
    });
});
