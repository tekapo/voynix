import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../types";
import { useMediaSession } from "./useMediaSession";

const t = vi.hoisted(() => ({
    invoke: vi.fn(async (_cmd: string, _args?: unknown) => null as unknown),
    listen: vi.fn(async (_event: string, _handler: (e: unknown) => void) => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => t.invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
    listen: (...a: [string, (e: unknown) => void]) => t.listen(...a),
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

const artworkCalls = () => t.invoke.mock.calls.filter((c) => c[0] === "set_now_playing_artwork").map((c) => (c[1] as any).dataUri);

const nowPlayingCalls = () => t.invoke.mock.calls.filter((c) => c[0] === "set_now_playing").map((c) => (c[1] as any).info);

beforeEach(() => {
    t.invoke.mockClear();
    t.listen.mockClear();
});

describe("useMediaSession", () => {
    it("publishes the track and playing state to the native Now Playing", () => {
        renderHook(() => useMediaSession(track, null, true, 1, makeActions()));
        expect(nowPlayingCalls()).toEqual([
            { title: "Song", artist: "Artist", album: "Album", duration: 200, position: 0, rate: 1, playing: true },
        ]);
    });

    it("clears Now Playing and its artwork when nothing is loaded", async () => {
        renderHook(() => useMediaSession(null, null, false, 1, makeActions()));
        await act(async () => {});
        expect(artworkCalls()).toEqual([null]);
        expect(nowPlayingCalls()).toEqual([null]);
    });

    it("sends the cover before publishing, and again only when it changes", async () => {
        const order: string[] = [];
        t.invoke.mockImplementation(async (cmd: string) => { order.push(cmd); return null; });
        const { rerender } = renderHook(({ art }) => useMediaSession(track, art, true, 1, makeActions()), {
            initialProps: { art: "data:image/jpeg;base64,AQID" as string | null },
        });
        await act(async () => {});
        expect(order).toEqual(["set_now_playing_artwork", "set_now_playing"]);

        // An unrelated republish (pause) must not resend the image.
        rerender({ art: "data:image/jpeg;base64,AQID" });
        expect(artworkCalls()).toHaveLength(1);

        rerender({ art: null });
        await act(async () => {});
        expect(artworkCalls()).toEqual(["data:image/jpeg;base64,AQID", null]);
        expect(nowPlayingCalls()).toHaveLength(2);
    });

    it("re-publishes on pause", () => {
        const { rerender } = renderHook(({ playing }) => useMediaSession(track, null, playing, 1, makeActions()), {
            initialProps: { playing: true },
        });
        rerender({ playing: false });
        expect(nowPlayingCalls().map((i) => i.playing)).toEqual([true, false]);
    });

    it("routes media keys to the latest actions", async () => {
        const actions = makeActions();
        renderHook(() => useMediaSession(track, null, true, 1, actions));
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
        const { rerender } = renderHook(({ playing }) => useMediaSession(track, null, playing, 1, actions), {
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
        const { result } = renderHook(() => useMediaSession(track, null, true, 1, makeActions()));
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
