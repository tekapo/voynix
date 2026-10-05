// Characterization tests for App.tsx's playback-transport and queue clusters
// (the `useAudioPlayer` / `usePlaybackQueue` boundary).
// DOM-only: what a user can click and what PlayerBar/QueuePanel then show.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppTestMocks } from "./test/renderApp";
import { seedLibrary } from "./test/seedLibrary";
import { FakeEngine, installFakeEngine } from "./test/fakeEngine";
import { _resetInitForTests, getTrackPlayState, initDb } from "./db";

import App from "./App";

// The engine App.tsx drives playback through (see src/player/engine.ts) — a
// FakeEngine stands in for both the <audio>-backed podcast engine and the
// native gapless one, since none of these tests care which is "really"
// active, only how App reacts to the events an engine reports.
let engine: FakeEngine;

// The useAudioPlayer extraction: `currentTime` used to be React
// state on App itself, so every ~250ms `timeupdate` tick re-rendered the whole
// tree. It now lives in an external `playbackClock` that only PlayerBar
// subscribes to. Wrap Sidebar (deliberately not memoised — see its render-count
// comment) to prove a tick no longer reaches it.
const sidebarRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/Sidebar", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./components/Sidebar")>();
    return {
        ...actual,
        Sidebar: (props: Parameters<typeof actual.Sidebar>[0]) => {
            sidebarRenders.count++;
            return actual.Sidebar(props);
        },
    };
});

beforeEach(async () => {
    resetAppTestMocks();
    _resetInitForTests();
    await initDb();
    sidebarRenders.count = 0;
    engine = installFakeEngine();
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

describe("playback transport", () => {
    it("double-clicking a row starts playback: Pause button + active row", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        await playRow("Aurora");
        const row = within(trackList()).getByText("Aurora").closest("li") as HTMLElement;
        expect(row).toHaveClass("active");
    });

    it("the play/pause button toggles isPlaying", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        fireEvent.click(playPauseButton());
        await waitFor(() => expect(playPauseButton()).toHaveAttribute("aria-label", "Play"));

        fireEvent.click(playPauseButton());
        await waitFor(() => expect(playPauseButton()).toHaveAttribute("aria-label", "Pause"));
    });

    it("Next advances to the next track in the queue", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        await waitFor(() => {
            const row = within(trackList()).getByText("Borealis").closest("li") as HTMLElement;
            expect(row).toHaveClass("active");
        });
    });

    it("Previous goes back to the track that was just playing", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => {
            expect(within(trackList()).getByText("Borealis").closest("li")).toHaveClass("active");
        });

        fireEvent.click(screen.getByRole("button", { name: "Previous" }));

        await waitFor(() => {
            expect(within(trackList()).getByText("Aurora").closest("li")).toHaveClass("active");
        });
    });

    it("shuffle toggles without interrupting the currently playing track", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        const shuffleBtn = screen.getByRole("button", { name: "Shuffle" });
        expect(shuffleBtn).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(shuffleBtn);
        expect(shuffleBtn).toHaveAttribute("aria-pressed", "true");

        // Still the same track playing — shuffle only affects future order.
        expect(within(trackList()).getByText("Aurora").closest("li")).toHaveClass("active");
    });

    it("±10s skip buttons only appear for a podcast track", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        expect(screen.queryByRole("button", { name: "Back 10 seconds" })).not.toBeInTheDocument();

        fireEvent.click(screen.getByText("All Songs"));
        await within(trackList()).findByText("Episode 1");
        await playRow("Episode 1");

        expect(screen.getByRole("button", { name: "Back 10 seconds" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Forward 10 seconds" })).toBeInTheDocument();
        // Music transport controls are hidden while a podcast plays.
        expect(screen.queryByRole("button", { name: "Shuffle" })).not.toBeInTheDocument();
    });
});

describe("podcast pause settle point", () => {
    it("pausing a podcast saves the exact position (not the 5s-throttled one)", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        fireEvent.click(screen.getByText("All Songs"));
        await within(trackList()).findByText("Episode 1");
        await playRow("Episode 1");

        engine.currentTime = 93;
        engine.duration = 1800;
        engine.pause();

        await waitFor(async () => {
            const ps = await getTrackPlayState("t-pod-1");
            expect(ps?.play_state).toBe("in_progress");
            expect(ps?.resume_position).toBe(93);
        });
    });

    it("pausing a music track does not write a podcast play state", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");
        engine.currentTime = 50;
        engine.duration = 200;

        engine.pause();
        await new Promise(r => setTimeout(r, 50));

        const ps = await getTrackPlayState("t-a-fav");
        expect(ps?.play_state).toBe("unplayed");
        expect(ps?.resume_position).toBe(0);
    });
});

describe("podcast playback speed", () => {
    it("applies the saved podcast speed only while a podcast is loaded", async () => {
        await seedLibrary();
        const { setSetting } = await import("./db");
        await setSetting("podcast_speed", "1.5");
        render(<App />);
        await screen.findByText("Aurora");

        // Music track: always 1.0x regardless of the saved podcast speed.
        await playRow("Aurora");
        expect(engine.rate).toBe(1);

        // Podcast: the saved speed is applied on load.
        fireEvent.click(screen.getByText("All Songs"));
        await within(trackList()).findByText("Episode 1");
        await playRow("Episode 1");
        expect(engine.rate).toBe(1.5);
    });

    it("cycling the speed control updates the engine immediately", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        fireEvent.click(screen.getByText("All Songs"));
        await within(trackList()).findByText("Episode 1");
        await playRow("Episode 1");
        expect(engine.rate).toBe(1);

        fireEvent.click(screen.getByRole("button", { name: "Playback speed" }));
        expect(engine.rate).toBe(1.25);
        expect(screen.getByRole("button", { name: "Playback speed" })).toHaveTextContent("1.25x");
    });
});

describe("play queue", () => {
    async function openQueue() {
        fireEvent.click(screen.getByRole("button", { name: "Play queue" }));
        return await screen.findByRole("complementary", { name: "Play queue" });
    }

    it("shows the cued playlist's tracks in queue order", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        const panel = await openQueue();
        const rows = within(panel).getAllByRole("listitem");
        expect(rows.map(r => r.textContent)).toEqual(
            expect.arrayContaining([expect.stringContaining("Aurora"), expect.stringContaining("Borealis"), expect.stringContaining("Cascade")])
        );
    });

    it("jumping to an upcoming row starts playing that track", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        const panel = await openQueue();
        fireEvent.click(within(panel).getByText("Cascade"));

        await waitFor(() => {
            expect(within(trackList()).getByText("Cascade").closest("li")).toHaveClass("active");
        });
    });

    it("removing an upcoming row drops it from the queue", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        const panel = await openQueue();
        expect(within(panel).getByText("Cascade")).toBeInTheDocument();

        const cascadeRow = within(panel).getByText("Cascade").closest("li") as HTMLElement;
        fireEvent.click(within(cascadeRow).getByRole("button", { name: "Remove from queue" }));

        expect(within(panel).queryByText("Cascade")).not.toBeInTheDocument();
    });
});

describe("natural end of track", () => {
    it("advances to the next track when the loaded one ends with no gapless hand-off queued", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        // Simulate the engine having nothing queued via setNext (e.g. it
        // hasn't caught up yet) — onEnded must still be able to advance.
        engine.next = null;
        engine.fireEnded();

        await waitFor(() => {
            expect(within(trackList()).getByText("Borealis").closest("li")).toHaveClass("active");
        });
    });

    it("stops at the end of the queue with repeat off", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => expect(within(trackList()).getByText("Borealis").closest("li")).toHaveClass("active"));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => expect(within(trackList()).getByText("Cascade").closest("li")).toHaveClass("active"));

        engine.next = null;
        engine.fireEnded();

        await waitFor(() => expect(playPauseButton()).toHaveAttribute("aria-label", "Play"));
        // Still parked on the last track, not wrapped back to the first.
        expect(within(trackList()).getByText("Cascade").closest("li")).toHaveClass("active");
    });

    // Pinning test written before extracting the queue state into useQueue
    // (see the plan): protects stepOrder's repeat-"all" wrap as integrated
    // into playAdjacent, which the extraction moves verbatim.
    it("repeat-all wraps back to the first track at the end of the queue", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");
        fireEvent.click(screen.getByRole("button", { name: "Repeat" })); // off -> all
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => expect(within(trackList()).getByText("Borealis").closest("li")).toHaveClass("active"));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => expect(within(trackList()).getByText("Cascade").closest("li")).toHaveClass("active"));

        engine.next = null;
        engine.fireEnded();

        await waitFor(() => {
            expect(within(trackList()).getByText("Aurora").closest("li")).toHaveClass("active");
        });
        expect(playPauseButton()).toHaveAttribute("aria-label", "Pause");
    });

    it("repeat-one replays the same track instead of advancing", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");
        const repeatBtn = screen.getByRole("button", { name: "Repeat" });
        fireEvent.click(repeatBtn); // off -> all
        fireEvent.click(repeatBtn); // all -> one

        engine.fireEnded();

        // Never left Aurora, and the seek landed back at 0.
        await waitFor(() => expect(engine.currentTime).toBe(0));
        expect(within(trackList()).getByText("Aurora").closest("li")).toHaveClass("active");
    });

    it("a podcast reaching the end is marked played", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        fireEvent.click(screen.getByText("All Songs"));
        await within(trackList()).findByText("Episode 1");
        await playRow("Episode 1");

        engine.next = null;
        engine.fireEnded();

        await waitFor(async () => {
            const ps = await getTrackPlayState("t-pod-1");
            expect(ps?.play_state).toBe("played");
            expect(ps?.resume_position).toBe(0);
        });
    });
});

describe("gapless hand-off (setNext / onAdvanced)", () => {
    it("queues the following queue track via setNext once one is loaded", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        await waitFor(() => expect(engine.next?.id).toBe("t-a-2")); // Borealis
    });

    // Regression test: engine.setNext()'s call has no leading await, but
    // engine.load()'s does (FakeEngine models this the same way
    // NativeEngine.load's `await this.ready` does) — so the reactive
    // queue/order/orderPos effect and the load effect firing in the same
    // render used to race, with setNext's IPC call landing before load's and
    // getting silently dropped (see FakeEngine.setNext's "not loaded yet"
    // guard, mirroring the real Rust-side one). Without App.tsx's explicit
    // updateEngineNext() call *after* `await engine.load()` resolves, this
    // would leave engine.next permanently null for that track — silently
    // falling back to a non-gapless reload at every boundary.
    it("still queues the next track even though setNext races load()'s own await", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");
        await waitFor(() => expect(engine.next?.id).toBe("t-a-2"));

        // A manual jump (not just the very first play) exercises the same
        // race: the load effect and the reactive setNext effect both fire in
        // this same render.
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => {
            expect(within(trackList()).getByText("Borealis").closest("li")).toHaveClass("active");
        });

        await waitFor(() => expect(engine.next?.id).toBe("t-b-1")); // Cascade
    });

    it("an engine-driven advance moves the UI cursor without reloading the track", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");
        await waitFor(() => expect(engine.next?.id).toBe("t-a-2"));
        const loadsBefore = engine.loadCalls.length;

        engine.fireAdvanced();

        await waitFor(() => {
            expect(within(trackList()).getByText("Borealis").closest("li")).toHaveClass("active");
        });
        expect(playPauseButton()).toHaveAttribute("aria-label", "Pause");
        // No new load() — the engine already transitioned to it on its own.
        expect(engine.loadCalls.length).toBe(loadsBefore);
        // The next-next track is now queued.
        await waitFor(() => expect(engine.next?.id).toBe("t-b-1")); // Cascade
    });
});

describe("keyboard shortcuts", () => {
    it("Space toggles play/pause", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        fireEvent.keyDown(window, { key: " " });
        await waitFor(() => expect(playPauseButton()).toHaveAttribute("aria-label", "Play"));

        fireEvent.keyDown(window, { key: " " });
        await waitFor(() => expect(playPauseButton()).toHaveAttribute("aria-label", "Pause"));
    });

    it("Space is ignored while typing in the search box", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        const search = document.getElementById("global-search-input") as HTMLInputElement;
        search.focus();
        fireEvent.keyDown(search, { key: " " });

        // Still playing — the shortcut handler let the keystroke through as text input.
        expect(playPauseButton()).toHaveAttribute("aria-label", "Pause");
    });

    it("ArrowRight/ArrowLeft advance and go back to the previous track", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        fireEvent.keyDown(window, { key: "ArrowRight" });
        await waitFor(() => {
            expect(within(trackList()).getByText("Borealis").closest("li")).toHaveClass("active");
        });

        fireEvent.keyDown(window, { key: "ArrowLeft" });
        await waitFor(() => {
            expect(within(trackList()).getByText("Aurora").closest("li")).toHaveClass("active");
        });
    });

    it("⌘F focuses the search field", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");

        fireEvent.keyDown(window, { key: "f", metaKey: true });

        expect(document.getElementById("global-search-input")).toHaveFocus();
    });
});

describe("playback clock render isolation", () => {
    it("a position tick updates PlayerBar but does not re-render Sidebar", async () => {
        await seedLibrary();
        render(<App />);
        await screen.findByText("Aurora");
        await playRow("Aurora");

        // Settle the renders triggered by mount/seeding/playback-start before
        // measuring — only ticks after this point are under test.
        sidebarRenders.count = 0;

        // Only the *first* fireTick in real usage carries a duration report
        // (an engine's loadedmetadata/durationchange, which fires once per
        // load, not once per position tick) — `setDuration` is regular React
        // state, so a duration report on every tick would (correctly) also
        // re-render Sidebar and defeat what's under test here.
        engine.fireTick(7, 200);

        await waitFor(() => expect(screen.getByText("0:07")).toBeInTheDocument());
        sidebarRenders.count = 0;

        engine.fireTick(8);

        await waitFor(() => expect(screen.getByText("0:08")).toBeInTheDocument());
        expect(sidebarRenders.count).toBe(0);
    });
});
