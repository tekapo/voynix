// Characterization tests for App.tsx's view-switching / search / sort
// cluster (the `useView` boundary). Written against DOM
// output and db.ts calls only — never App's internal state shape — so they
// keep passing across the planned useView/useLibrary hook split.
//
// QueuePanel and LibraryView stay mounted (CSS-toggled) even when not the
// active view, and can repeat a track/artist name the track list also shows
// (e.g. the cold-start queue). Track-row assertions are scoped to
// `.track-list`, grid assertions to `.library-list-container`, to avoid
// matching the wrong panel.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAppTestMocks } from "./test/renderApp";
import { seedLibrary } from "./test/seedLibrary";
import { _resetInitForTests, createSmartPlaylist, initDb } from "./db";
import { DEFAULT_SMART_RULES } from "./smartPlaylist";

import App from "./App";

beforeEach(async () => {
    resetAppTestMocks();
    _resetInitForTests();
    await initDb();
});

function trackList(): HTMLElement {
    const el = document.querySelector(".track-list");
    if (!el) throw new Error(".track-list not found — is a track view rendered?");
    return el as HTMLElement;
}

function libraryGrid(): HTMLElement {
    const el = document.querySelector(".library-list-container");
    if (!el) throw new Error(".library-list-container not found — is a grid view rendered?");
    return el as HTMLElement;
}

describe("view switching", () => {
    it("shows a seeded playlist's tracks when its sidebar entry is clicked", async () => {
        await seedLibrary();
        render(<App />);

        // Boots into the first playlist (App.tsx's cold-start default).
        await screen.findByText("Aurora");
        const list = trackList();
        expect(within(list).getByText("Borealis")).toBeInTheDocument();
        expect(within(list).getByText("Cascade")).toBeInTheDocument();
    });

    it("All Songs shows tracks from every playlist, deduped", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("All Songs"));
        await within(trackList()).findByText("Episode 1");

        const list = trackList();
        expect(within(list).getByText("Aurora")).toBeInTheDocument();
        expect(within(list).getByText("Cascade")).toBeInTheDocument();
        expect(within(list).getByText("Episode 2")).toBeInTheDocument();
    });

    it("Favorites shows only the favorited track", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("Favorites"));
        await within(trackList()).findByText("Aurora");

        const list = trackList();
        expect(within(list).queryByText("Borealis")).not.toBeInTheDocument();
        expect(within(list).queryByText("Cascade")).not.toBeInTheDocument();
    });

    it("Artists drills down into an artist's tracks", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("Artists"));
        const artistBCard = await within(libraryGrid()).findByText("Artist B");
        fireEvent.click(artistBCard);

        await waitFor(() => expect(trackList()).toBeTruthy());
        const list = trackList();
        expect(within(list).getByText("Cascade")).toBeInTheDocument();
        expect(within(list).queryByText("Aurora")).not.toBeInTheDocument();
    });

    it("header title reflects the current view", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("Most Played"));
        const header = document.querySelector("header.header") as HTMLElement;
        expect(within(header).getByText("Most Played")).toBeInTheDocument();
    });

    it("a smart playlist shows its evaluated rule results, not stored membership", async () => {
        await seedLibrary();
        await createSmartPlaylist("Favorites Mix", {
            ...DEFAULT_SMART_RULES,
            conditions: [{ field: "favorite", op: "is_true" }],
        });
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("Favorites Mix"));
        await within(trackList()).findByText("Aurora");

        const list = trackList();
        // Only "Aurora" is favorited in the seed fixture — everything else,
        // including tracks from other playlists, must be excluded.
        expect(within(list).queryByText("Borealis")).not.toBeInTheDocument();
        expect(within(list).queryByText("Cascade")).not.toBeInTheDocument();
        expect(within(list).queryByText("Episode 1")).not.toBeInTheDocument();
    });
});

describe("library list layout", () => {
    function libraryColumns(): HTMLElement {
        const el = document.querySelector(".library-columns");
        if (!el) throw new Error(".library-columns not found — is list layout active?");
        return el as HTMLElement;
    }

    it("switches Artists to the two-pane list and shows an artist's albums on selection", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("Artists"));
        await within(libraryGrid()).findByText("Artist B");

        fireEvent.click(screen.getByRole("button", { name: "List view" }));
        const columns = await waitFor(() => libraryColumns());
        expect(within(columns).getByText("Artist A")).toBeInTheDocument();
        expect(within(columns).getByText("Artist B")).toBeInTheDocument();
        // Nothing selected yet — no track rows.
        expect(within(columns).queryByText("Aurora")).not.toBeInTheDocument();

        fireEvent.click(within(columns).getByText("Artist B"));
        await within(columns).findByText("Cascade");
        expect(within(columns).queryByText("Aurora")).not.toBeInTheDocument();
        expect(within(columns).getByText("Album B")).toBeInTheDocument();
    });

    it("switches Albums to the two-pane list and shows an album's tracks on selection", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("Albums"));
        await within(libraryGrid()).findByText("Album A");

        fireEvent.click(screen.getByRole("button", { name: "List view" }));
        const columns = await waitFor(() => libraryColumns());
        fireEvent.click(within(columns).getByText("Album A"));

        await within(columns).findByText("Aurora");
        expect(within(columns).getByText("Borealis")).toBeInTheDocument();
        expect(within(columns).queryByText("Cascade")).not.toBeInTheDocument();
    });

    it("keeps list layout on grid button and reverts to the card grid", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("Artists"));
        await within(libraryGrid()).findByText("Artist B");
        fireEvent.click(screen.getByRole("button", { name: "List view" }));
        await waitFor(() => libraryColumns());

        fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
        await within(libraryGrid()).findByText("Artist B");
        expect(document.querySelector(".library-columns")).not.toBeInTheDocument();
    });

    it("typing in search still narrows the left-pane names list", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.click(screen.getByText("Artists"));
        await within(libraryGrid()).findByText("Artist B");
        fireEvent.click(screen.getByRole("button", { name: "List view" }));
        const columns = await waitFor(() => libraryColumns());
        fireEvent.click(within(columns).getByText("Artist A"));
        await within(columns).findByText("Aurora");

        fireEvent.click(screen.getByRole("button", { name: "Search" }));
        const input = screen.getByPlaceholderText("Search title, artist, album");
        fireEvent.change(input, { target: { value: "Artist B" } });

        const leftPane = () => columns.querySelector(".library-col-list") as HTMLElement;
        await waitFor(() => {
            expect(within(leftPane()).queryByText("Artist A")).not.toBeInTheDocument();
            expect(within(leftPane()).getByText("Artist B")).toBeInTheDocument();
        });
        // Selection (and its track list) isn't cleared by the search text.
        expect(within(columns).getByText("Aurora")).toBeInTheDocument();
    });
});

describe("search and sort", () => {
    it("header search narrows the visible rows", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        fireEvent.click(screen.getByText("All Songs"));
        await within(trackList()).findByText("Aurora");

        const toggle = screen.getByRole("button", { name: "Search" });
        fireEvent.click(toggle);
        const input = screen.getByPlaceholderText("Search title, artist, album");
        fireEvent.change(input, { target: { value: "casc" } });

        const list = trackList();
        expect(await within(list).findByText("Cascade")).toBeInTheDocument();
        expect(within(list).queryByText("Aurora")).not.toBeInTheDocument();
        expect(within(list).queryByText("Episode 1")).not.toBeInTheDocument();
    });

    it("clicking a column header sorts and marks aria-sort", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        // Re-query after the click: TrackList defines its sortable header cell
        // as a component created fresh every render (SortHeader), so a click
        // that changes sortState remounts the header cells — any DOM reference
        // captured before the click goes stale.
        const findTitleButton = () => {
            const header = trackList().parentElement as HTMLElement;
            return within(header).getByText("Title").closest("button") as HTMLElement;
        };
        const findTitleCell = () => findTitleButton().closest("[aria-sort]") as HTMLElement;

        expect(findTitleCell()).toHaveAttribute("aria-sort", "none");

        fireEvent.click(findTitleButton());
        expect(findTitleCell()).toHaveAttribute("aria-sort", expect.stringMatching(/ascending|descending/));
    });

    it("switching views resets any active sort", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        const findTitleCell = () => {
            const header = trackList().parentElement as HTMLElement;
            return within(header).getByText("Title").closest("[aria-sort]") as HTMLElement;
        };
        const findTitleButton = () => {
            const header = trackList().parentElement as HTMLElement;
            return within(header).getByText("Title").closest("button") as HTMLElement;
        };

        fireEvent.click(findTitleButton());
        expect(findTitleCell()).toHaveAttribute("aria-sort", expect.stringMatching(/ascending|descending/));

        fireEvent.click(screen.getByText("All Songs"));
        await within(trackList()).findByText("Episode 1");
        expect(findTitleCell()).toHaveAttribute("aria-sort", "none");
    });
});
