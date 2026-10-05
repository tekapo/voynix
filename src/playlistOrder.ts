/**
 * Move the item at `from` to sit at `to` (both indices into the array as it
 * is *before* the move — like a drag-and-drop drop target, not an adjacent
 * swap like queue.ts's reorderUpcoming). Returns the same array reference
 * when the move is a no-op, so a caller can skip re-rendering / re-persisting.
 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
    if (
        from === to ||
        from < 0 || from >= list.length ||
        to < 0 || to >= list.length
    ) {
        return list;
    }
    const next = list.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
}

/**
 * Rebuild a manually-ordered playlist's track order across a rescan: items
 * the old order knew about keep their old relative order, and anything new
 * (not in `oldPositions`) is appended at the end in scan order. Used by
 * rescanFolder (App.tsx) right after a folder playlist's rows are cleared and
 * re-inserted, so a hand-arranged Podcast playlist doesn't reset to scan
 * order on every rescan. `key` extracts the identity a position was recorded
 * under (file_path) — kept generic/pure so it doesn't need App's Track type.
 */
export function restoreManualOrder<T>(
    scanned: T[],
    oldPositions: Map<string, number>,
    key: (item: T) => string,
): T[] {
    const known = scanned
        .filter(item => oldPositions.has(key(item)))
        .sort((a, b) => oldPositions.get(key(a))! - oldPositions.get(key(b))!);
    const unknown = scanned.filter(item => !oldPositions.has(key(item)));
    return [...known, ...unknown];
}
