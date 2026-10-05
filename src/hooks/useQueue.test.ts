import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeEngine } from "../test/fakeEngine";
import { Track } from "../types";
import { useQueue } from "./useQueue";

const t = (id: string): Track => ({ id, title: id, file_path: `/${id}.mp3`, file_name: `${id}.mp3` });

function setup() {
    const engine = new FakeEngine();
    let currentTrack: Track | null = null;
    const setCurrentTrack = vi.fn((updater: any) => {
        currentTrack = typeof updater === "function" ? updater(currentTrack) : updater;
    });
    const hook = renderHook(() =>
        useQueue({
            engine,
            setCurrentTrack,
            setIsPlaying: vi.fn(),
            setLoadToken: vi.fn(),
            setError: vi.fn(),
            podcastNoShuffle: true,
            pendingPlayRef: { current: null },
            loadedTrackIdRef: { current: null },
            nativeAdvancedToIdRef: { current: null },
        })
    );
    return { hook, engine, setCurrentTrack };
}

describe("useQueue gapless hand-off to the same track", () => {
    it("re-queues the next copy after repeat-one hands off to the same track", async () => {
        const { hook, engine } = setup();
        // App.tsx wires the engine's onAdvanced event to the hook like this.
        engine.subscribe({ onAdvanced: id => act(() => hook.result.current.onEngineAdvanced(id)) });
        act(() => hook.result.current.playCollection([t("a")]));
        await engine.load({ id: "a", filePath: "/a.mp3", fileName: "a.mp3" }, { autoplay: true });
        act(() => hook.result.current.setRepeatMode("one"));
        expect(engine.next?.id).toBe("a");

        // The first copy ends; the engine rolls straight into the queued second copy.
        act(() => engine.fireAdvanced());
        expect(engine.next?.id).toBe("a"); // a third copy is queued — playback doesn't stop after two plays
        act(() => engine.fireAdvanced());
        expect(engine.next?.id).toBe("a");
    });

    it("does the same for repeat-all on a one-track queue", async () => {
        const { hook, engine } = setup();
        engine.subscribe({ onAdvanced: id => act(() => hook.result.current.onEngineAdvanced(id)) });
        act(() => hook.result.current.playCollection([t("a")]));
        await engine.load({ id: "a", filePath: "/a.mp3", fileName: "a.mp3" }, { autoplay: true });
        act(() => hook.result.current.setRepeatMode("all"));
        expect(engine.next?.id).toBe("a");
        act(() => engine.fireAdvanced());
        expect(engine.next?.id).toBe("a");
    });
});

describe("useQueue", () => {
    it("addToQueue appends the track at the end of both queue and order", () => {
        const { hook } = setup();
        act(() => hook.result.current.playCollection([t("a"), t("b")]));
        act(() => hook.result.current.addToQueue(t("c")));

        expect(hook.result.current.queue.map(x => x.id)).toEqual(["a", "b", "c"]);
        expect(hook.result.current.order).toEqual([0, 1, 2]);
    });

    // Regression test for the bug found while extracting this hook (see the
    // plan / CHANGELOG): removeFromQueue only shrinks `order`, not `queue`, so
    // a naive `order.length`-based append pointed at a leftover queue slot
    // instead of the track just added.
    it("addToQueue after a removal still points at the newly added track, not a leftover slot", () => {
        const { hook } = setup();
        act(() => hook.result.current.playCollection([t("a"), t("b"), t("c")]));
        // Remove "b" (order position 1) from the upcoming queue.
        act(() => hook.result.current.removeFromQueue(1));
        expect(hook.result.current.order).toEqual([0, 2]); // "a" (current), "c"

        act(() => hook.result.current.addToQueue(t("d")));

        // "d" must have landed in `queue` at index 3 (queue.length before the
        // append), and `order`'s new entry must point at that same index.
        expect(hook.result.current.queue.map(x => x.id)).toEqual(["a", "b", "c", "d"]);
        const newOrderEntry = hook.result.current.order[hook.result.current.order.length - 1];
        expect(hook.result.current.queue[newOrderEntry].id).toBe("d");
    });

    it("addCollectionToQueue after a removal still points at the newly added tracks", () => {
        const { hook } = setup();
        act(() => hook.result.current.playCollection([t("a"), t("b"), t("c")]));
        act(() => hook.result.current.removeFromQueue(1)); // drop "b"
        expect(hook.result.current.order).toEqual([0, 2]);

        act(() => hook.result.current.addCollectionToQueue([t("d"), t("e")]));

        expect(hook.result.current.queue.map(x => x.id)).toEqual(["a", "b", "c", "d", "e"]);
        const newEntries = hook.result.current.order.slice(-2);
        expect(newEntries.map(i => hook.result.current.queue[i].id)).toEqual(["d", "e"]);
    });
});
