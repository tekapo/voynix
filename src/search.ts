import { Track } from './types';
import { normalizeText } from './textNormalize';

/**
 * Free-text filtering for the header search box. The query is split on
 * whitespace and every term must appear somewhere in the haystack
 * (case-insensitive, full-width/half-width folded — see textNormalize.ts), so
 * "beatles yellow" matches "The Beatles – Yellow Submarine" and a half-width
 * "ｱ" matches a full-width "ア" tag. Empty / whitespace-only queries match
 * everything.
 */
export function queryTerms(query: string): string[] {
    return normalizeText(query).split(/\s+/).filter(Boolean);
}

export function haystackMatches(haystack: string, terms: string[]): boolean {
    if (terms.length === 0) return true;
    const hay = normalizeText(haystack);
    return terms.every(t => hay.includes(t));
}

/** Narrow a track list by title / artist / album (not file path — too noisy). */
export function filterTracks(tracks: Track[], query: string): Track[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return tracks;
    return tracks.filter(t =>
        haystackMatches(`${t.title} ${t.artist ?? ''} ${t.album ?? ''}`, terms),
    );
}

/** Narrow the artist / album card lists. */
export function filterStrings(items: string[], query: string): string[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return items;
    return items.filter(item => haystackMatches(item, terms));
}
