// Characterization tests for App.tsx's play-stats and playback-cursor
// clusters (the `usePlayStats` / `usePlaybackCursor` boundary).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAppTestMocks } from "./test/renderApp";
import { seedLibrary } from "./test/seedLibrary";
import { _resetInitForTests, initDb, loadLastPlayback } from "./db";

import App from "./App";

beforeEach(async () => {
    resetAppTestMocks();
    _resetInitForTests();
    await initDb();
});

function trackList(): HTMLElement {
    return document.querySelector(".track-list") as HTMLElement;
}

function playPauseButton(): HTMLElement {
    return screen.getByRole("button", { name: /^(Play|Pause)$/ });
}

async function playRow(title: string) {
    const row = within(trackList()).getByText(title).closest("li") as HTMLElement;
    fireEvent.doubleClick(row);
    await waitFor(() => expect(playPauseButton()).toHaveAttribute("aria-label", "Pause"));
}

describe("favorite toggle", () => {
    it("PlayerBar's star reflects and toggles the playing track's favorite state", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora"); // Aurora is seeded as already-favorited

        const playerBar = document.querySelector(".player-bar") as HTMLElement;
        const star = within(playerBar).getByRole("button", { name: /Favorites/ });
        expect(star).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(star);
        await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "false"));

        fireEvent.click(star);
        await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    });

    it("a track without the favorite flag starts unpressed", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Borealis");

        const playerBar = document.querySelector(".player-bar") as HTMLElement;
        expect(within(playerBar).getByRole("button", { name: /Favorites/ })).toHaveAttribute("aria-pressed", "false");
    });
});

describe("playback cursor persistence", () => {
    it("flushes the playing track + position to the DB on pagehide", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Borealis");

        fireEvent(window, new Event("pagehide"));

        await waitFor(async () => {
            const saved = await loadLastPlayback();
            expect(saved).toMatchObject({ trackId: "t-a-2", viewMode: "playlist" }); // Borealis
        });
    });

    // Note: a fresh mount re-reading that cursor and re-arming the exact same
    // track (not just the view — App.test.tsx already covers view-mode
    // restore) is real App.tsx behavior (the effect at App.tsx:1605-1629), but
    // asserting it end-to-end here is racy: with every native call resolving
    // near-instantly (fakeDb/sqliteDevice vs. real Tauri IPC), the "arm first
    // track of this view" effect (App.tsx:1638) can re-fire after the restore
    // effect's one-shot guard is already spent, and win. Left uncovered here
    // rather than asserted flakily.
});
