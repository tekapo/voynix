// A tiny external store for the playback position (seconds), read via
// useSyncExternalStore. `handleTimeUpdate` ticks this ~4x/s off the <audio>
// element's `timeupdate` event; routing it through React state instead (as
// `currentTime`) re-rendered the whole App component tree on every tick.
// Only PlayerBar subscribes, so it's the only thing that re-renders.
export interface PlaybackClock {
  get(): number;
  set(time: number): void;
  subscribe(listener: () => void): () => void;
}

export function createPlaybackClock(initial = 0): PlaybackClock {
  let time = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => time,
    set: (t: number) => {
      if (t === time) return;
      time = t;
      for (const l of listeners) l();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
