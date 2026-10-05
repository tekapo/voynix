import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { installFakeEngine } from "../test/fakeEngine";
import { useAudioPlayer } from "./useAudioPlayer";
import { Track } from "../types";

const podcastTrack = { id: "t1", kind: "podcast" } as Track;

describe("useAudioPlayer", () => {
    let engine: ReturnType<typeof installFakeEngine>;
    beforeEach(() => { engine = installFakeEngine(); });

    it("handleSeek writes to the engine and the clock", () => {
        const { result } = renderHook(() => useAudioPlayer({ currentTrack: podcastTrack }));

        act(() => { result.current.handleSeek(42); });

        expect(engine.currentTime).toBe(42);
        expect(result.current.clock.get()).toBe(42);
    });

    it("handleSkip clamps forward skips at the track's duration", () => {
        const { result } = renderHook(() => useAudioPlayer({ currentTrack: podcastTrack }));
        engine.currentTime = 95;
        engine.duration = 100;

        act(() => { result.current.handleSkip(10); });

        expect(engine.currentTime).toBe(100);
        expect(result.current.clock.get()).toBe(100);
    });

    it("handleSkip clamps backward skips at 0", () => {
        const { result } = renderHook(() => useAudioPlayer({ currentTrack: podcastTrack }));
        engine.currentTime = 5;
        engine.duration = 100;

        act(() => { result.current.handleSkip(-10); });

        expect(engine.currentTime).toBe(0);
    });

    it("handleSkip does nothing when there is no current track", () => {
        const { result } = renderHook(() => useAudioPlayer({ currentTrack: null }));
        engine.currentTime = 5;
        engine.duration = 100;

        act(() => { result.current.handleSkip(10); });

        expect(engine.currentTime).toBe(5);
        expect(result.current.clock.get()).toBe(0);
    });

    it("handleVolumeChange updates state and the engine", () => {
        const { result } = renderHook(() => useAudioPlayer({ currentTrack: podcastTrack }));

        act(() => { result.current.handleVolumeChange(0.4); });

        expect(result.current.volume).toBe(0.4);
        expect(engine.volume).toBe(0.4);
    });

    it("returns a stable clock instance across re-renders", () => {
        const { result, rerender } = renderHook(
            ({ track }) => useAudioPlayer({ currentTrack: track }),
            { initialProps: { track: podcastTrack as Track | null } },
        );
        const clock1 = result.current.clock;
        rerender({ track: null });
        expect(result.current.clock).toBe(clock1);
    });
});
