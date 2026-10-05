// A "each listener is a whole object of named handlers" pub/sub. This is the
// shape `PlayerEngine.subscribe(events: Partial<PlayerEngineEvents>)` needs —
// HtmlAudioEngine, NativeEngine and DualEngine each hand-rolled an identical
// `listeners: Set<Partial<Events>>` + `emit()` + `subscribe()` before this was
// pulled out. Not a general emitter library (mitt/nanoevents register one
// handler per event name on possibly many listeners) — this app's convention
// is a single object bundling every handler one caller cares about.
// `Events` isn't constrained to `Record<string, Function>` — a plain object
// interface like `PlayerEngineEvents` (no index signature) doesn't satisfy
// that constraint in TS even though every property IS a function, so
// constraining it would force every caller to add a pointless index
// signature to its own event interface.
export interface EventBus<Events> {
    /** Registers `listener` for whichever events it defines handlers for.
     *  Returns an unsubscribe function. */
    subscribe(listener: Partial<Events>): () => void;
    /** Calls every subscribed listener's handler for `event`, if it has one. */
    emit<K extends keyof Events>(event: K, ...args: Events[K] extends (...a: infer A) => void ? A : never): void;
    /** Drops every subscriber — call from `dispose()`. */
    clear(): void;
}

export function createEventBus<Events>(): EventBus<Events> {
    const listeners = new Set<Partial<Events>>();
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        emit(event, ...args) {
            for (const l of listeners) {
                const handler = l[event] as ((...a: typeof args) => void) | undefined;
                handler?.(...args);
            }
        },
        clear() {
            listeners.clear();
        },
    };
}
