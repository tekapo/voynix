package com.voynix.logic

import com.voynix.data.db.PlaylistEntity
import com.voynix.data.db.TrackWithStats
import java.text.Normalizer
import java.util.Locale

// Free-text filtering for the search box, ported from src/search.ts. The
// query is split on whitespace and every term must appear somewhere in the
// haystack (case-insensitive, full-width/half-width folded), so "beatles
// yellow" matches "The Beatles - Yellow Submarine" and a half-width "ｱ"
// matches a full-width "ア" tag. Empty / whitespace-only queries match
// everything.
//
// Java's Normalizer.Form.NFKC is the same normalization JS's
// `String.prototype.normalize('NFKC')` performs (both implement Unicode
// Normalization, UAX #15) — see textNormalize.ts on the desktop side, kept in
// step by hand (no shared runtime between Kotlin and TS).
private fun normalizeText(s: String): String =
    Normalizer.normalize(s, Normalizer.Form.NFKC).trim().lowercase(Locale.ROOT)

fun queryTerms(query: String): List<String> =
    normalizeText(query).split(Regex("\\s+")).filter { it.isNotEmpty() }

fun haystackMatches(haystack: String, terms: List<String>): Boolean {
    if (terms.isEmpty()) return true
    val hay = normalizeText(haystack)
    return terms.all { hay.contains(it) }
}

/** Narrow a track list by title / artist / album (not file path — too noisy). */
fun filterTracks(tracks: List<TrackWithStats>, query: String): List<TrackWithStats> {
    val terms = queryTerms(query)
    if (terms.isEmpty()) return tracks
    return tracks.filter {
        haystackMatches("${it.track.title} ${it.track.artist ?: ""} ${it.track.album ?: ""}", terms)
    }
}

/** Narrow the artist / album card lists. */
fun filterStrings(items: List<String>, query: String): List<String> {
    val terms = queryTerms(query)
    if (terms.isEmpty()) return items
    return items.filter { haystackMatches(it, terms) }
}

/** Narrow playlists (including podcast shows) by name — the home search screen. */
fun filterPlaylists(playlists: List<PlaylistEntity>, query: String): List<PlaylistEntity> {
    val terms = queryTerms(query)
    if (terms.isEmpty()) return playlists
    return playlists.filter { haystackMatches(it.name, terms) }
}
