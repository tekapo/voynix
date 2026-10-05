// A version counter + listener set, shaped for `useSyncExternalStore`:
// `subscribe`/`getVersion` feed it directly, and `bump()` is what an
// invalidate-on-write call (setAlbumCover, setArtistCover, …) calls so every
// component already showing a (possibly now stale) value knows to re-resolve.
// Pulled out because albumArt.ts and artistArt.ts each hand-rolled their own
// identical copy of this.
export interface ChangeSignal {
    subscribe: (listener: () => void) => () => void;
    getVersion: () => number;
    bump: () => void;
}

export function createChangeSignal(): ChangeSignal {
    let version = 0;
    const listeners = new Set<() => void>();
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getVersion() {
            return version;
        },
        bump() {
            version++;
            for (const l of listeners) l();
        },
    };
}
