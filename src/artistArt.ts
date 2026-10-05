// Artist images for the Artists grid: a user-set override (db.ts's
// artist_covers table) only — unlike albumArt.ts there's no embedded-tag or
// online fallback, since a track has no "artist photo" of its own. Cached in
// memory for the session, same invalidate-on-change convention as albumArt.ts.

import { useEffect, useState, useSyncExternalStore } from "react";
import { getArtistCover } from "./db";
import { createCappedCache, resolveCached } from "./lib/cappedCache";
import { createChangeSignal } from "./lib/changeSignal";

const cache = createCappedCache<string>({ max: 300 });
const changeSignal = createChangeSignal();

// Bumped whenever an artist image override changes (Set/Reset Artist Image),
// so components already showing a (possibly now stale) image re-resolve.

function cacheKey(artist: string): string {
    return artist.trim().toLowerCase();
}

async function resolveUncached(artist: string): Promise<string | null> {
    try {
        return await getArtistCover(artist);
    } catch {
        return null;
    }
}

function resolve(artist: string): Promise<string | null> {
    return resolveCached(cache, cacheKey(artist), () => resolveUncached(artist));
}

/** The image override data URI for an artist, or null while loading / absent. */
export function useArtistThumb(artist: string | null): string | null {
    const name = artist ?? "";
    const gen = useSyncExternalStore(changeSignal.subscribe, changeSignal.getVersion, changeSignal.getVersion);
    const [uri, setUri] = useState<string | null>(() => {
        if (!artist) return null;
        const hit = cache.get(cacheKey(name));
        return typeof hit === "string" ? hit : null;
    });

    useEffect(() => {
        if (!artist) { setUri(null); return; }
        const hit = cache.get(cacheKey(name));
        if (typeof hit === "string" || hit === null) { setUri(hit); return; }
        let alive = true;
        resolve(name).then((v) => { if (alive) setUri(v); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [artist, name, gen]);

    return uri;
}

/** Drop the cache and tell every subscribed component to re-resolve — call
 *  after setArtistCover()/clearing an override. */
export function invalidateArtistArt() {
    cache.clear();
    changeSignal.bump();
}
