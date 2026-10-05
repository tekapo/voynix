// Album art. Two flavors share the same resolution order and the same
// invalidation signal:
//   - useAlbumThumb: small, disk-cached-only thumbnails for the album/artist
//     grid (see `get_album_thumb`, never hits the network).
//   - useNowPlayingArtwork: the full-size cover for the player bar / now
//     playing screen, which additionally falls back to an online lookup
//     (`fetch_album_art`) once a track is actually loaded.
//
// Both prefer a user-set album cover override (db.ts's album_covers table)
// over the file's own embedded art. Cached in memory for the session, deduped
// so many rows/cards of one album make one call, and capped so a huge library
// can't pin every cover.

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { effectiveAlbum, isFolderAlbum } from "./albumName";
import { getAlbumCover } from "./db";
import { createCappedCache, resolveCached } from "./lib/cappedCache";
import { createChangeSignal } from "./lib/changeSignal";
import { Track } from "./types";

const SEP = "␟";
const DEFAULT_SIZE = 96;

// `get_album_thumb` decodes/resizes on the Rust side; even off the main
// thread there, firing one invoke per visible row/card at once (a library
// grid can have thousands) floods the IPC channel and the disk. Cap how many
// are in flight at a time, queuing the rest — same idea as sync.ts's `pool`,
// but for calls that arrive one at a time from many independent components
// rather than a known-upfront batch.
const MAX_CONCURRENT_THUMBS = 4;
let activeThumbCalls = 0;
const thumbQueue: (() => void)[] = [];

function drainThumbQueue() {
    if (activeThumbCalls >= MAX_CONCURRENT_THUMBS) return;
    const next = thumbQueue.shift();
    if (next) next();
}

function runThumbCall<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const run = () => {
            activeThumbCalls++;
            task().then(
                (v) => { activeThumbCalls--; drainThumbQueue(); resolve(v); },
                (e) => { activeThumbCalls--; drainThumbQueue(); reject(e); },
            );
        };
        if (activeThumbCalls < MAX_CONCURRENT_THUMBS) run();
        else thumbQueue.push(run);
    });
}

/** Cache key: by (artist, album, size), or by (file path, size) when both tags
 *  are blank (so untagged files don't all collapse onto one entry). */
function cacheKey(artist: string, album: string, path: string, size: number): string {
    const a = artist.trim().toLowerCase();
    const b = album.trim().toLowerCase();
    return a || b ? `${a}${SEP}${b}${SEP}${size}` : `path${SEP}${path}${SEP}${size}`;
}

const cache = createCappedCache<string>({ max: 600 });

// Bumped whenever an album cover override changes (Set/Reset Album Cover, or
// the destructive Set Artwork), so components already showing a (possibly now
// stale) cover know to re-resolve rather than just serving whatever they
// resolved once on mount. Shared with the full-size cache below — one
// invalidate() covers both.
const changeSignal = createChangeSignal();

async function resolveUncached(artist: string, album: string, path: string, size: number): Promise<string | null> {
    // A user-set album cover (see setAlbumCover / the "Set Album Cover" context
    // menu item) always wins — it's a deliberate per-album override, not a
    // fallback like the embedded tag or the iTunes lookup below it.
    try {
        const override = await getAlbumCover(artist, album);
        if (override) return override;
    } catch {
        /* fall through to the default resolution */
    }
    try {
        return (await runThumbCall(() =>
            invoke<string | null>("get_album_thumb", { artist, album, path, size }),
        )) ?? null;
    } catch {
        return null;
    }
}

function resolve(artist: string, album: string, path: string, size: number): Promise<string | null> {
    const key = cacheKey(artist, album, path, size);
    return resolveCached(cache, key, () => resolveUncached(artist, album, path, size));
}

/** The album thumbnail data URI for a track, or null while loading / absent.
 *  `size` defaults to 96px; pass a larger value for bigger renders like the
 *  desktop album grid. */
export function useAlbumThumb(track: Track | null, size: number = DEFAULT_SIZE): string | null {
    const artist = track?.artist ?? "";
    const album = (track && effectiveAlbum(track)) ?? "";
    const path = track?.file_path ?? "";
    const gen = useSyncExternalStore(changeSignal.subscribe, changeSignal.getVersion, changeSignal.getVersion);
    const [uri, setUri] = useState<string | null>(() => {
        if (!track) return null;
        const hit = cache.get(cacheKey(artist, album, path, size));
        return typeof hit === "string" ? hit : null;
    });

    useEffect(() => {
        if (!track) { setUri(null); return; }
        const hit = cache.get(cacheKey(artist, album, path, size));
        if (typeof hit === "string" || hit === null) { setUri(hit); return; }
        let alive = true;
        resolve(artist, album, path, size).then((v) => { if (alive) setUri(v); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track, artist, album, path, size, gen]);

    return uri;
}

// ---- full-size "now playing" artwork --------------------------------------
// Separate, small cache: full-size data URIs are much heavier than 96/256px
// thumbnails, and there's only ever one or a couple of "current" tracks at a
// time (armed + actually loaded), unlike the whole visible track list.

// A `null` (nothing found yet) is deliberately NOT cached: an armed track
// resolves without the online fallback (see `online` below), and caching that
// miss would keep the online lookup from ever running once the same track is
// actually loaded and plays.
const fullCache = createCappedCache<string>({ max: 8, cacheNull: false });

async function resolveFullUncached(artist: string, album: string, path: string, online: boolean, allowOnline: boolean): Promise<string | null> {
    try {
        const override = await getAlbumCover(artist, album);
        if (override) return override;
    } catch {
        /* fall through */
    }
    try {
        const embedded = await invoke<string | null>("get_track_artwork", { path });
        if (embedded) return embedded;
    } catch {
        /* fall through */
    }
    if (!online || !allowOnline) return null;
    try {
        return (await invoke<string | null>("fetch_album_art", { artist, album })) ?? null;
    } catch {
        return null;
    }
}

function resolveFull(artist: string, album: string, path: string, online: boolean, allowOnline: boolean): Promise<string | null> {
    // `online` only ever adds a fallback step, so a cache hit found without it
    // is still valid once `online` turns true — no need to key by it.
    const key = cacheKey(artist, album, path, 0);
    return resolveCached(fullCache, key, () => resolveFullUncached(artist, album, path, online, allowOnline));
}

/**
 * Full-size cover for the currently armed/playing track: a user override,
 * else the file's embedded art, else — only once `online` is true (the track
 * is actually loaded, not merely selected) — an iTunes lookup cached on disk
 * by the Rust side. Switching tracks clears the result immediately so a
 * stale cover never lingers from the previous selection.
 *
 * The iTunes lookup is skipped entirely for a track with no album tag of its
 * own: its "album" is just the containing folder's name (see albumName.ts),
 * and searching iTunes for a folder name would likely match an unrelated
 * release rather than leave the cover blank.
 */
export function useNowPlayingArtwork(track: Track | null, online: boolean): string | null {
    const artist = track?.artist ?? "";
    const album = (track && effectiveAlbum(track)) ?? "";
    const path = track?.file_path ?? "";
    const allowOnline = track ? !isFolderAlbum(track) : true;
    const gen = useSyncExternalStore(changeSignal.subscribe, changeSignal.getVersion, changeSignal.getVersion);
    const [uri, setUri] = useState<string | null>(null);

    useEffect(() => {
        if (!track) { setUri(null); return; }
        setUri(null); // don't show the previous track's cover while resolving
        let alive = true;
        resolveFull(artist, album, path, online, allowOnline).then((v) => { if (alive) setUri(v); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track, artist, album, path, online, allowOnline, gen]);

    return uri;
}

/** Drop both the thumbnail and now-playing caches and tell every subscribed
 *  component to re-resolve — call after setAlbumCover()/clearing an override,
 *  or after set_track_artwork rewrites a file's embedded cover, so already
 *  rendered art picks up the change. */
export function invalidateAlbumArt() {
    cache.clear();
    fullCache.clear();
    changeSignal.bump();
}

/** Test-only alias, kept for existing test call sites. */
export const _resetAlbumThumbCache = invalidateAlbumArt;
