package com.voynix.logic

/**
 * Pure helpers for the "where's the now-playing track" indicator on a long
 * track list (`TrackListScreen`): a jump button when the playing row has
 * scrolled out of view, and a marker on a rail mirroring its position in the
 * full list. Kept separate from Compose so the geometry is unit-testable
 * without a `LazyListState`.
 */
enum class NowPlayingDirection { ABOVE, BELOW }

/**
 * Which way to jump to reach [index] given the currently visible item range
 * [firstVisible]..[lastVisible] (inclusive, as reported by
 * `LazyListState.layoutInfo.visibleItemsInfo`). Null means "already visible"
 * (or there's nothing playing / [index] is out of range) — the jump button
 * should be hidden.
 */
fun nowPlayingDirection(index: Int, firstVisible: Int, lastVisible: Int): NowPlayingDirection? {
    if (index < 0) return null
    return when {
        index < firstVisible -> NowPlayingDirection.ABOVE
        index > lastVisible -> NowPlayingDirection.BELOW
        else -> null
    }
}

/**
 * [index]'s position within a list of [count] items, as a 0f..1f fraction
 * along the rail — 0 at the top, 1 at the bottom. A single-item (or empty)
 * list has no meaningful position, so it's pinned to the top.
 */
fun markerFraction(index: Int, count: Int): Float {
    if (index < 0 || count <= 1) return 0f
    return (index.toFloat() / (count - 1).toFloat()).coerceIn(0f, 1f)
}
