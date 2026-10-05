/**
 * Picks the more-recent of two values by timestamp. A tie, or a null/missing
 * timestamp (treated as oldest), keeps `a` — matches the SQL guard shape
 * `WHERE ... IS NULL OR ... < $incoming_ts`.
 */
export function lwwPick<T>(a: T, b: T, ts: (v: T) => number | null): T {
    const at = ts(a) ?? -1;
    const bt = ts(b) ?? -1;
    return bt > at ? b : a;
}

/**
 * Merges `incoming` into `into`, keyed by `keyFn`, keeping the more-recent row
 * per key per `ts` (an incoming row with a null `ts` is ignored — it never
 * overwrites a row that has one). `pick` defaults to `lwwPick`; pass a custom
 * one when a key's value needs reshaping on merge (e.g. combining fields from
 * both the winning row and its key, as `mergeFavorites`/`mergePlayStates` do).
 *
 * `dedupeByKeyKeepMax(rows, keyFn, ts)` — collapsing a single list to one row
 * per key — is `mergeLww([], rows, keyFn, ts)`.
 */
export function mergeLww<T>(
    into: T[],
    incoming: T[],
    keyFn: (v: T) => string,
    ts: (v: T) => number | null,
    pick: (cur: T, incoming: T) => T = (cur, inc) => lwwPick(cur, inc, ts),
): T[] {
    const byKey = new Map(into.map((r) => [keyFn(r), r]));
    for (const r of incoming) {
        if (ts(r) == null) continue;
        const cur = byKey.get(keyFn(r));
        byKey.set(keyFn(r), cur ? pick(cur, r) : r);
    }
    return [...byKey.values()];
}
