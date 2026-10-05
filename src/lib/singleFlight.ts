/**
 * Guards a "run once for the app's lifetime" async job (e.g. DB migrations)
 * against React StrictMode's double-invoked mount effects: concurrent callers
 * share the same in-flight promise instead of both racing the same side
 * effect. On success the promise is cached forever (the job never re-runs);
 * on failure it's cleared so a later call can retry.
 */
export function createRunOnce<T>(start: () => Promise<T>) {
    let inFlight: Promise<T> | null = null;
    return {
        run(): Promise<T> {
            if (!inFlight) {
                inFlight = start().catch((e) => {
                    inFlight = null; // let a later call retry
                    throw e;
                });
            }
            return inFlight;
        },
        /** Test-only: drop the cached promise so the job runs again. */
        reset() {
            inFlight = null;
        },
    };
}

/**
 * Dedupes concurrent async calls that share a key: the first caller for a key
 * starts `start()`, later callers before it settles get the same promise back.
 * Unlike `createRunOnce`, a key's slot always clears once its job settles
 * (success or failure) — the job is expected to be callable again later, just
 * not run twice at once for the same key.
 */
export function createKeyedSingleFlight<K, T>() {
    const inFlight = new Map<K, Promise<T>>();
    return function run(key: K, start: () => Promise<T>): Promise<T> {
        const pending = inFlight.get(key);
        if (pending) return pending;
        const job = start().finally(() => inFlight.delete(key));
        inFlight.set(key, job);
        return job;
    };
}
