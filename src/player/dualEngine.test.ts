import { describe, expect, it, vi } from "vitest";
import { DualEngine } from "./dualEngine";
import type { EngineTrack, PlayerEngine, PlayerEngineEvents } from "./engine";

function fakeEngine() {
  let listener: Partial<PlayerEngineEvents> = {};
  const engine = {
    load: vi.fn().mockResolvedValue(undefined),
    unload: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    seek: vi.fn(),
    setVolume: vi.fn(),
    setRate: vi.fn(),
    setNext: vi.fn(),
    getCurrentTime: vi.fn().mockReturnValue(0),
    getDuration: vi.fn().mockReturnValue(0),
    isPaused: vi.fn().mockReturnValue(true),
    isEnded: vi.fn().mockReturnValue(false),
    subscribe: vi.fn((l: Partial<PlayerEngineEvents>) => {
      listener = l;
      return () => {};
    }),
    dispose: vi.fn(),
  };
  return { engine: engine as unknown as PlayerEngine & typeof engine, emit: () => listener };
}

const music: EngineTrack = { id: "m1", filePath: "/m1.mp3", fileName: "m1.mp3", kind: "music" };
const music2: EngineTrack = { id: "m2", filePath: "/m2.mp3", fileName: "m2.mp3" };
const pod: EngineTrack = { id: "p1", filePath: "/p1.mp3", fileName: "p1.mp3", kind: "podcast" };

function setup() {
  const html = fakeEngine();
  const native = fakeEngine();
  const dual = new DualEngine(html.engine, native.engine);
  return { html, native, dual };
}

describe("DualEngine routing", () => {
  it("loads music on the native engine and podcasts on the html engine", async () => {
    const { html, native, dual } = setup();
    await dual.load(music, { autoplay: true });
    expect(native.engine.load).toHaveBeenCalledWith(music, { autoplay: true });
    expect(html.engine.load).not.toHaveBeenCalled();

    await dual.load(pod, { autoplay: true, rate: 1.5 });
    expect(html.engine.load).toHaveBeenCalledWith(pod, { autoplay: true, rate: 1.5 });
  });

  it("unloads the previous engine only when the kind changes", async () => {
    const { html, native, dual } = setup();
    await dual.load(music, { autoplay: true });
    await dual.load(music2, { autoplay: true });
    expect(native.engine.unload).not.toHaveBeenCalled();

    await dual.load(pod, { autoplay: true });
    expect(native.engine.unload).toHaveBeenCalledTimes(1);

    await dual.load(music, { autoplay: true });
    expect(html.engine.unload).toHaveBeenCalledTimes(1);
  });

  it("sends transport calls to whichever engine is active", async () => {
    const { html, native, dual } = setup();
    await dual.load(pod, { autoplay: false });
    dual.pause();
    dual.seek(12);
    dual.setRate(2);
    await dual.play();
    expect(html.engine.pause).toHaveBeenCalled();
    expect(html.engine.seek).toHaveBeenCalledWith(12);
    expect(html.engine.setRate).toHaveBeenCalledWith(2);
    expect(html.engine.play).toHaveBeenCalled();
    expect(native.engine.pause).not.toHaveBeenCalled();
  });

  it("applies volume to both engines", () => {
    const { html, native, dual } = setup();
    dual.setVolume(0.3);
    expect(html.engine.setVolume).toHaveBeenCalledWith(0.3);
    expect(native.engine.setVolume).toHaveBeenCalledWith(0.3);
  });

  it("queues the next track only when the same engine can play it", async () => {
    const { html, native, dual } = setup();
    await dual.load(music, { autoplay: true });
    dual.setNext(music2);
    expect(native.engine.setNext).toHaveBeenLastCalledWith(music2);

    dual.setNext(pod);
    expect(native.engine.setNext).toHaveBeenLastCalledWith(null);
    expect(html.engine.setNext).not.toHaveBeenCalled();

    dual.setNext(null);
    expect(native.engine.setNext).toHaveBeenLastCalledWith(null);
  });
});

describe("DualEngine events", () => {
  it("relays events from the active engine only", async () => {
    const { html, native, dual } = setup();
    const onPosition = vi.fn();
    const onEnded = vi.fn();
    dual.subscribe({ onPosition, onEnded });

    await dual.load(music, { autoplay: true });
    native.emit().onPosition?.(5);
    html.emit().onPosition?.(99);
    html.emit().onEnded?.();
    expect(onPosition).toHaveBeenCalledTimes(1);
    expect(onPosition).toHaveBeenCalledWith(5);
    expect(onEnded).not.toHaveBeenCalled();

    await dual.load(pod, { autoplay: true });
    native.emit().onEnded?.();
    expect(onEnded).not.toHaveBeenCalled();
    html.emit().onEnded?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("stops relaying after unsubscribe", async () => {
    const { native, dual } = setup();
    const onPlay = vi.fn();
    const off = dual.subscribe({ onPlay });
    native.emit().onPlay?.();
    off();
    native.emit().onPlay?.();
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
