import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Subscribes to a Tauri event for the component's lifetime, unlistening on
 * unmount. Replaces the `useEffect(() => { const un = listen(...); return
 * () => un.then(f => f()); }, [])` boilerplate written out separately in
 * App.tsx, useScanFolders.ts and useSyncServer.ts.
 *
 * `handler` is read fresh on every call but deliberately isn't in the effect
 * dependency array — the listener itself (and its one-time `listen()` call)
 * must stay stable for the life of the mount, same as before this was
 * extracted. A handler that needs the latest state/props without
 * resubscribing should close over a ref that's updated every render (see
 * App.tsx's `dockActionsRef` for the existing pattern this doesn't change).
 */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void): void {
    useEffect(() => {
        const un = listen<T>(event, (e) => handler(e.payload));
        return () => { un.then((f) => f()); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [event]);
}
