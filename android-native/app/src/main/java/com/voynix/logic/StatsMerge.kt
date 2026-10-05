package com.voynix.logic

// Executable spec for the bidirectional stats merge (play counts + favorites +
// podcast play state), ported from src/statsMerge.ts. Mirrors the SQL in
// db.ts (applyFavoritesBatch / applyPlayStatesBatch / insertPlayEventsBatch)
// without a DB, so the merge functions themselves are what the real sync
// engine calls — not just a spec exercised by tests.
//
//   - play events are a grow-only set: the union of two logs, deduped on
//     (device_id, played_at, track_key) — the UNIQUE index migration 3 adds.
//   - favorites are last-write-wins by favorite_updated_at (strict >; a tie
//     keeps the incumbent).
//   - podcast play_state + resume_position are last-write-wins by
//     play_state_updated_at, merged as one atomic unit (same tie rule).
//
// Topology assumption: the Mac is the hub. Voynix only ever syncs with the
// Mac, so this always runs in the "phone" role of a two-party merge.

private const val US = "␟" // unit separator, same delimiter track_key's hash uses

data class PlayEvent(val trackKey: String, val playedAt: Long, val deviceId: String)

data class FavoriteRow(val trackKey: String, val favorite: Boolean, val favoriteUpdatedAt: Long?)

data class PlayStateRow(
    val trackKey: String,
    val playState: PlayState,
    val resumePosition: Double,
    val playStateUpdatedAt: Long?,
)

private fun eventKey(e: PlayEvent) = "${e.deviceId}$US${e.playedAt}$US${e.trackKey}"

/**
 * Union of two play-event logs, deduped on (device_id, played_at, track_key).
 * Grow-only and commutative: order of merges doesn't matter.
 */
fun mergeEvents(into: List<PlayEvent>, incoming: List<PlayEvent>): List<PlayEvent> {
    val seen = into.mapTo(HashSet()) { eventKey(it) }
    val out = into.toMutableList()
    for (e in incoming) {
        val k = eventKey(e)
        if (seen.add(k)) out.add(e)
    }
    return out
}

/** Last-write-wins by timestamp; a null timestamp is treated as oldest. */
fun favoriteWins(local: FavoriteRow, remote: FavoriteRow): FavoriteRow {
    val lt = local.favoriteUpdatedAt ?: -1
    val rt = remote.favoriteUpdatedAt ?: -1
    return if (rt > lt) remote else local
}

/**
 * play_state + resume_position share one play_state_updated_at and are
 * merged as a single atomic unit — the two fields are mutually constraining
 * (PLAYED implies resume_position == 0), so an independent-timestamp merge
 * could produce an incoherent pair.
 */
fun playStateWins(local: PlayStateRow, remote: PlayStateRow): PlayStateRow {
    val lt = local.playStateUpdatedAt ?: -1
    val rt = remote.playStateUpdatedAt ?: -1
    return if (rt > lt) remote else local
}

/** LWW merge of favorite rows by track_key. Incoming rows with a null timestamp are ignored. */
fun mergeFavorites(into: List<FavoriteRow>, incoming: List<FavoriteRow>): List<FavoriteRow> {
    val byKey = LinkedHashMap<String, FavoriteRow>()
    into.forEach { byKey[it.trackKey] = it }
    for (r in incoming) {
        if (r.favoriteUpdatedAt == null) continue
        val cur = byKey[r.trackKey]
        byKey[r.trackKey] = if (cur == null) r else favoriteWins(cur, r)
    }
    return byKey.values.toList()
}

/** LWW merge of podcast play-state rows by track_key. Incoming rows with a null timestamp are ignored. */
fun mergePlayStates(into: List<PlayStateRow>, incoming: List<PlayStateRow>): List<PlayStateRow> {
    val byKey = LinkedHashMap<String, PlayStateRow>()
    into.forEach { byKey[it.trackKey] = it }
    for (r in incoming) {
        if (r.playStateUpdatedAt == null) continue
        val cur = byKey[r.trackKey]
        byKey[r.trackKey] = if (cur == null) r else playStateWins(cur, r)
    }
    return byKey.values.toList()
}
