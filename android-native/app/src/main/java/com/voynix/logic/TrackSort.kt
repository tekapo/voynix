package com.voynix.logic

import com.voynix.data.db.TrackWithStats
import java.text.Collator

// Column sorting + natural order for the track list, ported from
// src/trackSort.ts. Kept pure and separate so it can be unit-tested without
// Room or Compose (same as Queue.kt / Playback.kt).

enum class SortKey { TITLE, ARTIST, ALBUM, PLAYS, DURATION }
enum class SortDir { ASC, DESC }
data class SortState(val key: SortKey, val dir: SortDir)

// A numeric, case-insensitive comparison approximating JS's
// localeCompare(..., { numeric: true, sensitivity: 'base' }).
private val collator: Collator = Collator.getInstance().apply { strength = Collator.SECONDARY }
private fun textCmp(a: String, b: String): Int = collator.compare(a, b)

// Shared with LibraryViewModel (phone UI) and BrowseTree (Android Auto) so
// both group "no artist/album tag" tracks under the same fallback label.
fun artistOf(t: TrackWithStats) = t.track.artist?.takeIf { it.isNotEmpty() } ?: "Unknown Artist"
fun albumOf(t: TrackWithStats) = t.track.album?.takeIf { it.isNotEmpty() } ?: "Unknown Album"

/**
 * The header-tap cycle: a different column starts ascending; tapping the
 * active column flips asc -> desc; tapping it once more clears the sort
 * (back to the view's natural order).
 */
fun nextSort(cur: SortState?, key: SortKey): SortState? {
    if (cur == null || cur.key != key) return SortState(key, SortDir.ASC)
    if (cur.dir == SortDir.ASC) return SortState(key, SortDir.DESC)
    return null
}

private fun compare(a: TrackWithStats, b: TrackWithStats, key: SortKey): Int = when (key) {
    SortKey.TITLE -> textCmp(a.track.title, b.track.title)
    SortKey.ARTIST -> textCmp(artistOf(a), artistOf(b))
    SortKey.ALBUM -> textCmp(albumOf(a), albumOf(b))
    SortKey.PLAYS -> a.playCount - b.playCount
    SortKey.DURATION -> ((a.track.duration ?: 0.0) - (b.track.duration ?: 0.0)).let {
        if (it < 0) -1 else if (it > 0) 1 else 0
    }
}

/** Sort a copy of [tracks] by the given column; returns [tracks] unchanged when [sort] is null. */
fun sortTracks(tracks: List<TrackWithStats>, sort: SortState?): List<TrackWithStats> {
    if (sort == null) return tracks
    val factor = if (sort.dir == SortDir.DESC) -1 else 1
    return tracks.sortedWith { a, b -> factor * compare(a, b, sort.key) }
}

// The Kotlin twin of NATURAL_ORDER (db.ts) / compareNatural (trackSort.ts):
// artist -> album -> disc -> track -> title, blank artist/album sorting last.
private fun blankLast(a: String, b: String): Int {
    val ea = a.trim().isEmpty()
    val eb = b.trim().isEmpty()
    if (ea != eb) return if (ea) 1 else -1
    return textCmp(a, b)
}

fun compareNatural(a: TrackWithStats, b: TrackWithStats): Int {
    blankLast(a.track.artist ?: "", b.track.artist ?: "").let { if (it != 0) return it }
    blankLast(a.track.album ?: "", b.track.album ?: "").let { if (it != 0) return it }
    ((a.track.discNo ?: 1) - (b.track.discNo ?: 1)).let { if (it != 0) return it }
    ((a.track.trackNo ?: 999999) - (b.track.trackNo ?: 999999)).let { if (it != 0) return it }
    return textCmp(a.track.title, b.track.title)
}

/** A copy of [tracks] in NATURAL_ORDER. Stable via the title tiebreaker. */
fun sortNatural(tracks: List<TrackWithStats>): List<TrackWithStats> =
    tracks.sortedWith(::compareNatural)
