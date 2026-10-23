import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTauriTestMocks } from "../test/tauriMocks";
import type { Track } from "../types";
import { useMediaSession } from "./useMediaSession";

const t = createTauriTestMocks();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => t.invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
    listen: (...a: [string, (e: unknown) => void]) => t.listen(...a),
    emit: (...a: [string, unknown?]) => t.emit(...a),
}));

const track = { id: "a", title: "Song", artist: "Artist", album: "Album", duration: 200, kind: "music" } as unknown as Track;

const makeActions = () => ({
    togglePlay: vi.fn(), handleSeek: vi.fn(), handleSkip: vi.fn(), playAdjacent: vi.fn(), skipSeconds: 10,
});

/** The handler useMediaSession registered for `media-action`. */
const mediaActionHandler = () => {
    const call = t.listen.mock.calls.find((c) => c[0] === "media-action");
    return (payload: unknown) => (call![1] as (e: unknown) => void)({ payload });
};

const nowPlayingCalls = () => t.invoke.mock.calls.filter((c) => c[0] === "set_now_playing").map((c) => (c[1] as any).info);

beforeEach(() => t.reset());

describe("useMediaSession", () => {
    it("publishes the track and playing state to the native Now Playing", () => {
        renderHook(() => useMediaSession(track, true, 1, makeActions()));
        expect(nowPlayingCalls()).toEqual([
            { title: "Song", artist: "Artist", album: "Album", duration: 200, position: 0, rate: 1, playing: true },
        ]);
    });

    it("clears Now Playing when nothing is loaded", () => {
        renderHook(() => useMediaSession(null, false, 1, makeActions()));
        expect(nowPlayingCalls()).toEqual([null]);
    });

    it("re-publishes on pause", () => {
        const { rerender } = renderHook(({ playing }) => useMediaSession(track, playing, 1, makeActions()), {
            initialProps: { playing: true },
        });
        rerender({ playing: false });
        expect(nowPlayingCalls().map((i) => i.playing)).toEqual([true, false]);
    });

    it("routes media keys to the latest actions", async () => {
        const actions = makeActions();
        renderHook(() => useMediaSession(track, true, 1, actions));
        await act(async () => {});
        const send = mediaActionHandler();
        send("toggle");
        send("next");
        send("previous");
        send({ seek: 42 });
        expect(actions.togglePlay).toHaveBeenCalledTimes(1);
        expect(actions.playAdjacent.mock.calls).toEqual([[1], [-1]]);
        expect(actions.handleSeek).toHaveBeenCalledWith(42);
    });

    it("treats play while playing and pause while paused as no-ops", async () => {
        const actions = makeActions();
        const { rerender } = renderHook(({ playing }) => useMediaSession(track, playing, 1, actions), {
            initialProps: { playing: true },
        });
        await act(async () => {});
        const send = mediaActionHandler();
        send("play");
        expect(actions.togglePlay).not.toHaveBeenCalled();
        send("pause");
        expect(actions.togglePlay).toHaveBeenCalledTimes(1);
        rerender({ playing: false });
        send("pause");
        expect(actions.togglePlay).toHaveBeenCalledTimes(1);
        send("play");
        expect(actions.togglePlay).toHaveBeenCalledTimes(2);
    });

    it("re-publishes the position only after a seek, not on ordinary ticks", () => {
        vi.spyOn(performance, "now").mockReturnValue(0);
        const { result } = renderHook(() => useMediaSession(track, true, 1, makeActions()));
        expect(nowPlayingCalls()).toHaveLength(1);

        vi.spyOn(performance, "now").mockReturnValue(1000);
        result.current(1); // on schedule: 1s after a start at 0
        expect(nowPlayingCalls()).toHaveLength(1);

        vi.spyOn(performance, "now").mockReturnValue(2000);
        result.current(120); // seek
        const calls = nowPlayingCalls();
        expect(calls).toHaveLength(2);
        expect(calls[1].position).toBe(120);
        vi.restoreAllMocks();
    });
});
