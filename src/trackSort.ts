import { Track } from './types';
import { albumOf } from './albumName';
import { artistOf } from './names';

// Column sorting for the track list. Kept pure and separate so it can be
// unit-tested without React or the DB (same as queue.ts / playback.ts).

export type SortKey = 'title' | 'artist' | 'album' | 'plays' | 'duration';
export type SortDir = 'asc' | 'desc';
export interface SortState {
    key: SortKey;
    dir: SortDir;
}

/**
 * The header-click cycle: a different column starts ascending; clicking the
 * active column flips asc -> desc; clicking it once more clears the sort (back
 * to the view's natural order).
 */
export function nextSort(cur: SortState | null, key: SortKey): SortState | null {
    if (!cur || cur.key !== key) return { key, dir: 'asc' };
    if (cur.dir === 'asc') return { key, dir: 'desc' };
    return null;
}

const textCmp = (a: string, b: string) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function compare(a: Track, b: Track, key: SortKey): number {
    switch (key) {
        case 'title': return textCmp(a.title, b.title);
        case 'artist': return textCmp(artistOf(a), artistOf(b));
        case 'album': return textCmp(albumOf(a), albumOf(b));
        case 'plays': return (a.play_count ?? 0) - (b.play_count ?? 0);
        case 'duration': return (a.duration ?? 0) - (b.duration ?? 0);
    }
}

/**
 * Sort a copy of `tracks` by the given column. Returns the input array
 * unchanged (same reference) when `sort` is null. `Array.prototype.sort` is
 * stable, so equal rows keep their incoming (natural) order.
 */
export function sortTracks(tracks: Track[], sort: SortState | null): Track[] {
    if (!sort) return tracks;
    const factor = sort.dir === 'desc' ? -1 : 1;
    return [...tracks].sort((a, b) => factor * compare(a, b, sort.key));
}

// The JS twin of NATURAL_ORDER (db.ts). The library views (All Songs, an
// artist's or album's tracks, Favorites) are built by filtering an in-memory
// array — they never touch the DB's ORDER BY — so this keeps them in the same
// artist -> album -> disc -> track -> title order. Sentinels match the SQL:
// blank artist/album sort last, missing disc = 1, missing track = end of album.
// A blank artist/album sorts after every real name (the SQL uses a '~~~'
// COALESCE sentinel; locale collation of '~' is unreliable, so compare the
// blank flag explicitly here).
const blankLast = (a: string, b: string) => {
    const ea = a.trim() === '', eb = b.trim() === '';
    if (ea !== eb) return ea ? 1 : -1;
    return textCmp(a, b);
};

export function compareNatural(a: Track, b: Track): number {
    return (
        blankLast(a.artist || '', b.artist || '') ||
        blankLast(a.album || '', b.album || '') ||
        (a.disc_no ?? 1) - (b.disc_no ?? 1) ||
        (a.track_no ?? 999999) - (b.track_no ?? 999999) ||
        textCmp(a.title, b.title)
    );
}

/** A copy of `tracks` in NATURAL_ORDER. Stable via the title tiebreaker. */
export function sortNatural(tracks: Track[]): Track[] {
    return [...tracks].sort(compareNatural);
}
