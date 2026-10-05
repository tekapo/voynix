// A `Map`-backed cache capped at `max` entries, evicting the oldest insertion
// once over the cap (not true LRU — a read doesn't refresh an entry's
// position), with in-flight promise de-duplication built in: concurrent
// callers for the same key that's still resolving get the same Promise
// instead of each starting their own request.
//
// Pulled out because albumArt.ts (twice — its thumbnail cache and its
// separate full-size cache) and artistArt.ts each hand-rolled their own near-
// identical copy of exactly this "get-or-resolve, remember, evict oldest"
// shape; only whether a `null` result gets cached at all varies per site
// (see `cacheNull` below).

export interface CappedCacheOptions {
    /** Evict the oldest entry once the cache holds more than this many. */
    max: number;
    /**
     * Whether a resolved `null` (e.g. "looked, found nothing") is cached at
     * all. Defaults to `true`. Pass `false` for a cache where a `null` should
     * be retried on the very next lookup instead of remembered — e.g.
     * albumArt.ts's full-size cache, where an armed-but-not-yet-loaded track
     * resolves without its online fallback, and caching that miss would
     * permanently block the fallback from ever running once the track loads.
     */
    cacheNull?: boolean;
}

export interface CappedCache<T> {
    /** The raw entry for `key`: `undefined` (never looked up), a resolved
     * value/`null`, or a `Promise` still in flight. */
    get(key: string): T | null | Promise<T | null> | undefined;
    /** Registers an in-flight (or already-resolved) entry ahead of `remember`
     * settling it — lets a second concurrent caller for the same key join the
     * same Promise instead of starting its own. */
    set(key: string, value: T | null | Promise<T | null>): void;
    /** Settles `key` to its resolved value, applying `cacheNull` and evicting
     * the oldest entry if now over `max`. */
    remember(key: string, value: T | null): void;
    clear(): void;
}

export function createCappedCache<T>(opts: CappedCacheOptions): CappedCache<T> {
    const cacheNull = opts.cacheNull ?? true;
    const cache = new Map<string, T | null | Promise<T | null>>();

    return {
        get(key) {
            return cache.get(key);
        },
        set(key, value) {
            cache.set(key, value);
        },
        remember(key, value) {
            if (value === null && !cacheNull) {
                cache.delete(key);
                return;
            }
            cache.set(key, value);
            // Map keeps insertion order; drop the oldest once over the cap.
            if (cache.size > opts.max) {
                const oldest = cache.keys().next().value as string | undefined;
                if (oldest !== undefined && oldest !== key) cache.delete(oldest);
            }
        },
        clear() {
            cache.clear();
        },
    };
}

/**
 * Wraps `resolveUncached` with `cache`'s get-or-resolve-once semantics: a hit
 * (settled or still in flight) is returned as-is; a miss resolves once, with
 * every caller in between sharing that same in-flight Promise.
 */
export function resolveCached<T>(
    cache: CappedCache<T>,
    key: string,
    resolveUncached: () => Promise<T | null>,
): Promise<T | null> {
    const hit = cache.get(key);
    if (hit !== undefined) return hit instanceof Promise ? hit : Promise.resolve(hit);

    const p = resolveUncached().then((value) => {
        cache.remember(key, value);
        return value;
    });
    cache.set(key, p);
    return p;
}
