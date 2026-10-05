import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { NativeEngine } from "./nativeEngine";

const track = { id: "t1", filePath: "/m/a.mp3", fileName: "a.mp3" };

describe("NativeEngine play/pause state", () => {
    beforeEach(() => invoke.mockClear());

    it("pause() makes isPaused() true and emits onPause — the Rust side never emits player-pause", async () => {
        const engine = new NativeEngine();
        const onPause = vi.fn();
        engine.subscribe({ onPause });
        await engine.load(track, { autoplay: true });
        expect(engine.isPaused()).toBe(false);

        engine.pause();

        expect(engine.isPaused()).toBe(true);
        expect(onPause).toHaveBeenCalledTimes(1);
        expect(invoke).toHaveBeenCalledWith("player_pause");
    });

    it("play() after a pause makes isPaused() false again and emits onPlay", async () => {
        const engine = new NativeEngine();
        const onPlay = vi.fn();
        await engine.load(track, { autoplay: false });
        expect(engine.isPaused()).toBe(true);
        engine.subscribe({ onPlay });

        await engine.play();

        expect(engine.isPaused()).toBe(false);
        expect(engine.isEnded()).toBe(false);
        expect(onPlay).toHaveBeenCalledTimes(1);
    });
});
