import { SmartCondition, SmartRules, SmartSortKey, Track } from "./types";
import { compareNatural } from "./trackSort";
import { normalizeText } from "./textNormalize";

// Smart playlists: user-defined rules (iTunes style), evaluated live over the
// in-memory library. Stored as JSON in playlists.rules (see migration 12).
// Pure and DB-free, same shape as smartLists.ts's built-in lists, so it's
// unit-testable without a DB and reusable from both the live view (App.tsx)
// and the sync snapshot (buildSyncSnapshot).

export const DEFAULT_SMART_RULES: SmartRules = {
    v: 1,
    match: 'all',
    conditions: [],
    sortBy: 'natural',
    sortDesc: false,
    limit: null,
};

const SORT_KEYS: readonly SmartSortKey[] = ['natural', 'title', 'artist', 'album', 'play_count', 'last_played', 'added_at', 'year'];
const TEXT_FIELDS = ['title', 'artist', 'album', 'album_artist', 'genre', 'composer'];
const TEXT_OPS = ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'ends_with'];
const NUMBER_FIELDS = ['play_count', 'year', 'duration', 'track_no', 'disc_no'];
const NUMBER_OPS = ['eq', 'ne', 'gt', 'lt'];
const DATE_FIELDS = ['added_at', 'last_played'];
const DATE_UNITS = ['days', 'weeks', 'months'];
const KIND_VALUES = ['music', 'podcast', 'other'];
const PLAY_STATE_VALUES = ['unplayed', 'in_progress', 'played'];

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** True when [c] has exactly the shape one of SmartCondition's variants requires. */
function isValidCondition(c: unknown): c is SmartCondition {
    if (!c || typeof c !== 'object') return false;
    const { field, op, value, value2, unit } = c as Record<string, unknown>;
    if (typeof field !== 'string' || typeof op !== 'string') return false;
    if (TEXT_FIELDS.includes(field)) return TEXT_OPS.includes(op) && typeof value === 'string';
    if (NUMBER_FIELDS.includes(field)) {
        if (op === 'between') return isFiniteNumber(value) && isFiniteNumber(value2);
        return NUMBER_OPS.includes(op) && isFiniteNumber(value);
    }
    if (DATE_FIELDS.includes(field)) {
        return (op === 'in_last' || op === 'not_in_last') && isFiniteNumber(value) && typeof unit === 'string' && DATE_UNITS.includes(unit);
    }
    if (field === 'kind') return (op === 'is' || op === 'is_not') && typeof value === 'string' && KIND_VALUES.includes(value);
    if (field === 'favorite') return op === 'is_true' || op === 'is_false';
    if (field === 'play_state') return (op === 'is' || op === 'is_not') && typeof value === 'string' && PLAY_STATE_VALUES.includes(value);
    if (field === 'playlist') return (op === 'in' || op === 'not_in') && typeof value === 'string';
    return false;
}

/**
 * Normalizes untrusted rules (an imported backup, or stored JSON that may have
 * been hand-edited or corrupted) into a SmartRules the evaluator and the editor
 * can't choke on: malformed conditions are dropped, and bad scalar fields fall
 * back to their defaults. Returns null when there's no `conditions` array at all —
 * that isn't a rule set.
 */
export function sanitizeSmartRules(raw: unknown): SmartRules | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (!Array.isArray(r.conditions)) return null;
    return {
        v: 1,
        match: r.match === 'any' ? 'any' : 'all',
        conditions: r.conditions.filter(isValidCondition),
        sortBy: SORT_KEYS.includes(r.sortBy as SmartSortKey) ? (r.sortBy as SmartSortKey) : 'natural',
        sortDesc: !!r.sortDesc,
        limit: isFiniteNumber(r.limit) && r.limit > 0 ? r.limit : null,
    };
}

/**
 * Parses playlists.rules (JSON text, possibly NULL/corrupt). Falls back to
 * DEFAULT_SMART_RULES — an empty rule set matches every track, which is a
 * safer failure mode than throwing or silently showing nothing.
 */
export function parseSmartRules(json: string | null | undefined): SmartRules {
    if (!json) return DEFAULT_SMART_RULES;
    try {
        return sanitizeSmartRules(JSON.parse(json)) ?? DEFAULT_SMART_RULES;
    } catch {
        return DEFAULT_SMART_RULES;
    }
}

export function serializeSmartRules(rules: SmartRules): string {
    return JSON.stringify(rules);
}

// ---- Text -------------------------------------------------------------

const TEXT_GETTERS: Record<string, (t: Track) => string> = {
    title: t => t.title || '',
    artist: t => t.artist || '',
    album: t => t.album || '',
    album_artist: t => t.album_artist || '',
    genre: t => t.genre || '',
    composer: t => t.composer || '',
};

function matchText(t: Track, field: string, op: string, value: string): boolean {
    const actual = normalizeText(TEXT_GETTERS[field](t));
    const needle = normalizeText(value);
    switch (op) {
        case 'contains': return actual.includes(needle);
        case 'not_contains': return !actual.includes(needle);
        case 'is': return actual === needle;
        case 'is_not': return actual !== needle;
        case 'starts_with': return actual.startsWith(needle);
        case 'ends_with': return actual.endsWith(needle);
        default: return false;
    }
}

// ---- Number -------------------------------------------------------------

// play_count is derived (never null in practice — see TRACK_COLUMNS_WITH_STATS)
// but is treated as 0 when absent, unlike the other numeric fields, which are
// tag-derived and simply don't match (except `ne`) when the tag is missing.
const NUMBER_GETTERS: Record<string, (t: Track) => number | null | undefined> = {
    play_count: t => t.play_count ?? 0,
    year: t => t.year,
    duration: t => t.duration,
    track_no: t => t.track_no,
    disc_no: t => t.disc_no,
};

function matchNumber(t: Track, cond: Extract<SmartCondition, { field: 'play_count' | 'year' | 'duration' | 'track_no' | 'disc_no' }>): boolean {
    const actual = NUMBER_GETTERS[cond.field](t);
    if (actual == null || actual === undefined) return cond.op === 'ne';
    switch (cond.op) {
        case 'eq': return actual === cond.value;
        case 'ne': return actual !== cond.value;
        case 'gt': return actual > cond.value;
        case 'lt': return actual < cond.value;
        case 'between': return actual >= cond.value && actual <= (cond.value2 ?? cond.value);
        default: return false;
    }
}

// ---- Date -----------------------------------------------------------------

const UNIT_MS: Record<'days' | 'weeks' | 'months', number> = {
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
    months: 30 * 24 * 60 * 60 * 1000,
};

const DATE_GETTERS: Record<string, (t: Track) => number | null | undefined> = {
    added_at: t => t.added_at,
    last_played: t => t.last_played,
};

function matchDate(t: Track, cond: Extract<SmartCondition, { field: 'added_at' | 'last_played' }>, now: number): boolean {
    const actual = DATE_GETTERS[cond.field](t);
    if (actual == null) return cond.op === 'not_in_last';
    const cutoff = now - cond.value * UNIT_MS[cond.unit];
    const within = actual >= cutoff;
    return cond.op === 'in_last' ? within : !within;
}

// ---- One condition ----------------------------------------------------

function matchCondition(
    t: Track,
    cond: SmartCondition,
    membership: Map<string, Set<string>>,
    now: number
): boolean {
    switch (cond.field) {
        case 'title': case 'artist': case 'album': case 'album_artist': case 'genre': case 'composer':
            return matchText(t, cond.field, cond.op, cond.value);
        case 'play_count': case 'year': case 'duration': case 'track_no': case 'disc_no':
            return matchNumber(t, cond);
        case 'added_at': case 'last_played':
            return matchDate(t, cond, now);
        case 'kind': {
            const actual = t.kind || 'music';
            return cond.op === 'is' ? actual === cond.value : actual !== cond.value;
        }
        case 'favorite': {
            const isFav = !!t.favorite;
            return cond.op === 'is_true' ? isFav : !isFav;
        }
        case 'play_state': {
            const actual = t.play_state || 'unplayed';
            return cond.op === 'is' ? actual === cond.value : actual !== cond.value;
        }
        case 'playlist': {
            const members = membership.get(cond.value);
            const isMember = !!members?.has(t.id);
            return cond.op === 'in' ? isMember : !isMember;
        }
        default:
            return false;
    }
}

// ---- Sort -----------------------------------------------------------------

const SORT_GETTERS: Partial<Record<SmartSortKey, (t: Track) => number | string>> = {
    title: t => t.title || '',
    artist: t => t.artist || '',
    album: t => t.album || '',
    play_count: t => t.play_count ?? 0,
    last_played: t => t.last_played ?? 0,
    added_at: t => t.added_at ?? 0,
    year: t => t.year ?? 0,
};

function sortByRules(tracks: Track[], rules: SmartRules): Track[] {
    if (rules.sortBy === 'natural') {
        const natural = [...tracks].sort(compareNatural);
        return rules.sortDesc ? natural.reverse() : natural;
    }
    const getter = SORT_GETTERS[rules.sortBy];
    if (!getter) return tracks;
    const factor = rules.sortDesc ? -1 : 1;
    return [...tracks].sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (typeof va === 'string' || typeof vb === 'string') {
            return factor * String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
        }
        return factor * ((va as number) - (vb as number));
    });
}

/**
 * Evaluates a smart playlist's rules over the whole library. `membership`
 * maps a (non-smart) playlist id to the set of track ids it contains — used
 * only by the 'playlist' field/op. Pure and DB-free.
 */
export function evaluateSmartPlaylist(
    rules: SmartRules,
    allTracks: Track[],
    membership: Map<string, Set<string>>,
    now: number = Date.now()
): Track[] {
    const matches = rules.conditions.length === 0
        ? allTracks
        : allTracks.filter(t => {
            const results = rules.conditions.map(c => matchCondition(t, c, membership, now));
            return rules.match === 'all' ? results.every(Boolean) : results.some(Boolean);
        });
    const sorted = sortByRules(matches, rules);
    return rules.limit ? sorted.slice(0, rules.limit) : sorted;
}
