// Thin factory so tests can substitute a FakeEngine (see
// src/test/fakeEngine.ts) without threading an engine prop through App.tsx.
// `createEngine()` is only ever called lazily, from inside useAudioPlayer's
// render-time `useRef` initializer — never at module-evaluation time — so a
// test can safely call `__setEngineFactoryForTests` right up until the
// `render(<App/>)` call and still have it take effect.

import { DualEngine } from "./dualEngine";
import { PlayerEngine } from "./engine";

let factoryOverride: (() => PlayerEngine) | null = null;

export function __setEngineFactoryForTests(factory: (() => PlayerEngine) | null): void {
  factoryOverride = factory;
}

export function createEngine(): PlayerEngine {
  return factoryOverride ? factoryOverride() : new DualEngine();
}
