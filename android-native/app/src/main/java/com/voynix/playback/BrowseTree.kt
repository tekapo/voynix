package com.voynix.playback

import android.os.Bundle
import androidx.media3.session.MediaConstants
import com.voynix.data.db.TrackWithStats
import com.voynix.logic.albumOf
import com.voynix.logic.artistOf
import com.voynix.logic.mostPlayed
import com.voynix.logic.recentlyAdded
import com.voynix.logic.recentlyPlayed
import java.net.URLDecoder
import java.net.URLEncoder
import java.text.Normalizer

const val ROOT_ID = "root"
const val ALL_SONGS_ID = "all_songs"
const val ARTISTS_ID = "artists"
const val ALBUMS_ID = "albums"
const val FAVORITES_ID = "favorites"
const val MOST_PLAYED_ID = "most_played"
const val RECENTLY_ADDED_ID = "recently_added"
const val RECENTLY_PLAYED_ID = "recently_played"
const val PLAYLISTS_ID = "playlists"
const val HOME_ID = "home"
const val LIBRARY_ID = "library"

private const val CONTENT_STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"

/**
 * Android Auto's media template reads these per-item extras to decide how to
 * lay out that item's *children* (grid vs. list) — see
 * MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE/_PLAYABLE. Mirrors the
 * getContentStyle() helper in VLC Android's MediaSessionBrowser.kt.
 */
fun contentStyleExtras(browsableHint: Int, playableHint: Int): Bundle =
    Bundle().apply {
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, browsableHint)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, playableHint)
    }

/** Root-level extras telling Android Auto this app opts into content-style hints at all. */
fun rootContentStyleExtras(): Bundle = Bundle().apply { putBoolean(CONTENT_STYLE_SUPPORTED, true) }

/**
 * Android Auto's media template reads these per-item extras to render the
 * "played" checkmark / partial-progress ring on a playable leaf. Music
 * tracks (kind != "podcast") get none of this — null means "don't set
 * extras at all". [resumePosition]/[durationSecs] are only consulted for
 * IN_PROGRESS: nextPlayState() (logic/Playback.kt) resets resume_position to
 * 0 once a podcast is marked PLAYED, so the percentage for that state is
 * hard-coded to 1.0 rather than derived from the (stale) position.
 */
fun completionExtras(kind: String, playState: String, resumePosition: Double, durationSecs: Double?): Bundle? {
    if (kind != "podcast") return null
    val status = when (playState) {
        "in_progress" -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED
        "played" -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_FULLY_PLAYED
        else -> MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_NOT_PLAYED
    }
    return Bundle().apply {
        putInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS, status)
        when (playState) {
            "played" -> putDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE, 1.0)
            "in_progress" -> if (durationSecs != null && durationSecs > 0) {
                putDouble(
                    MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE,
                    (resumePosition / durationSecs).coerceIn(0.0, 1.0),
                )
            }
        }
    }
}

/**
 * A real library can hold thousands of tracks; Android Auto (and any other
 * MediaBrowser client) pages onGetChildren via `page`/`pageSize` specifically
 * so the whole list never has to cross the Binder transaction in one shot —
 * ignoring those and returning everything risks a TransactionTooLargeException
 * that shows up on the head unit as an empty or broken folder.
 */
fun <T> pageSlice(items: List<T>, page: Int, pageSize: Int): List<T> {
    if (page < 0 || pageSize <= 0 || items.isEmpty()) return emptyList()

    // page/pageSize come straight from the calling controller and can be
    // arbitrarily large (some browsers pass Int.MAX_VALUE to mean "no
    // paging") — compute the skip count in Long to avoid Int overflow on
    // page * pageSize.
    val skip = (page.toLong() * pageSize.toLong()).coerceIn(0, items.size.toLong()).toInt()
    return items.drop(skip).take(pageSize)
}

/**
 * Resolves a browse-tree leaf folder id to its page-sliced tracks: the 3
 * static folders (all songs/favorites/most played) plus any artist or album
 * folder, all filtered in-memory over [allTracks]. PLAYLISTS_ID and any
 * per-playlist folder id are resolved by the caller against PlaylistDao
 * instead, since their contents live in the DB rather than a pure filter over
 * [allTracks]. [allTracks] must already be sorted by the caller. Returns null
 * for anything that isn't one of these leaves (ROOT_ID, PLAYLISTS_ID, a
 * playlist folder id, or an unknown id) so the caller can tell "empty folder"
 * apart from "not my folder".
 */
fun browseTreeChildren(
    parentId: String,
    allTracks: List<TrackWithStats>,
    page: Int,
    pageSize: Int,
): List<TrackWithStats>? {
    val matched = when {
        parentId == ALL_SONGS_ID -> allTracks
        parentId == FAVORITES_ID -> allTracks.filter { it.track.favorite }
        parentId == MOST_PLAYED_ID -> mostPlayed(allTracks)
        parentId == RECENTLY_ADDED_ID -> recentlyAdded(allTracks)
        parentId == RECENTLY_PLAYED_ID -> recentlyPlayed(allTracks)
        artistNameOfFolder(parentId) != null -> allTracks.filter { artistOf(it) == artistNameOfFolder(parentId) }
        albumNameOfFolder(parentId) != null -> allTracks.filter { albumOf(it) == albumNameOfFolder(parentId) }
        else -> return null
    }
    return pageSlice(matched, page, pageSize)
}

/** Distinct artist names across [allTracks], sorted — same derivation as LibraryViewModel.artists. */
fun artistNames(allTracks: List<TrackWithStats>): List<String> =
    allTracks.map(::artistOf).distinct().sorted()

/** Distinct album names across [allTracks], sorted — same derivation as LibraryViewModel.albums. */
fun albumNames(allTracks: List<TrackWithStats>): List<String> =
    allTracks.map(::albumOf).distinct().sorted()

// --- Hierarchical media ids ------------------------------------------------
//
// Android Auto's onAddMediaItems only reliably hands back the mediaId of the
// tapped item, not which browse folder it was reached through — so the
// browsed-from folder is encoded into the id itself (the same trick UAMP
// uses). Folder ids use '/' (e.g. "playlist/<id>"); a playable leaf tacks its
// parent folder id on with '|' (e.g. "all_songs|<trackId>" or
// "playlist/<id>|<trackId>") so a tap can both resolve the track and rebuild
// the right queue.

private const val PLAYLIST_FOLDER_PREFIX = "playlist/"
private const val ARTIST_FOLDER_PREFIX = "artist/"
private const val ALBUM_FOLDER_PREFIX = "album/"

/** The browse-tree folder id for one playlist's track list. */
fun playlistFolderId(playlistId: String): String = "$PLAYLIST_FOLDER_PREFIX$playlistId"

/** The playlist id a folder id like "playlist/<id>" refers to, or null if it isn't one. */
fun playlistIdOfFolder(mediaId: String): String? =
    mediaId.takeIf { it.startsWith(PLAYLIST_FOLDER_PREFIX) }?.removePrefix(PLAYLIST_FOLDER_PREFIX)

// Artist/album names (unlike playlist ids) are free-form user data — they can
// contain '/' or '|', which would otherwise corrupt the folder id itself
// (leafMediaId splits on '|', playlist folders split on '/') or collide with
// the leaf-tagging separator below. URL-encoding keeps the id a single safe
// token; UTF-8 round-trips any Japanese/emoji artist name unchanged.
private fun encodeFolderName(name: String): String = URLEncoder.encode(name, "UTF-8")
private fun decodeFolderName(value: String): String = URLDecoder.decode(value, "UTF-8")

/** The browse-tree folder id for one artist's tracks. */
fun artistFolderId(artist: String): String = "$ARTIST_FOLDER_PREFIX${encodeFolderName(artist)}"

/** The artist name a folder id like "artist/<encoded>" refers to, or null if it isn't one. */
fun artistNameOfFolder(mediaId: String): String? =
    mediaId.takeIf { it.startsWith(ARTIST_FOLDER_PREFIX) }?.removePrefix(ARTIST_FOLDER_PREFIX)?.let(::decodeFolderName)

/** The browse-tree folder id for one album's tracks. */
fun albumFolderId(album: String): String = "$ALBUM_FOLDER_PREFIX${encodeFolderName(album)}"

/** The album name a folder id like "album/<encoded>" refers to, or null if it isn't one. */
fun albumNameOfFolder(mediaId: String): String? =
    mediaId.takeIf { it.startsWith(ALBUM_FOLDER_PREFIX) }?.removePrefix(ALBUM_FOLDER_PREFIX)?.let(::decodeFolderName)

/** A playable leaf's mediaId, tagged with the folder it was browsed from. */
fun leafMediaId(parentId: String, trackId: String): String = "$parentId|$trackId"

/** The browse folder a leaf mediaId was reached through, or null for an untagged (bare) track id. */
fun parentIdOfLeaf(mediaId: String): String? = mediaId.substringBeforeLast('|', missingDelimiterValue = "").ifEmpty { null }

/** The raw track id inside a (possibly folder-tagged) leaf mediaId. Untagged ids pass through unchanged. */
fun trackIdOfLeaf(mediaId: String): String = mediaId.substringAfterLast('|')

// --- Range folders for long artist/album lists --------------------------------
//
// Android Auto displays only the first 20 rows of a browse list even though
// onGetChildren returns them all (DHU 2.1, measured: a 453-track flat list
// stops at row 20 with page=0 pageSize=Int.MAX and 453 items returned; same
// with `restrict none`). Auto's own "Jump to letter" picker only covers A-Z and
// "#" (digits/symbols), so names that sort after Z — Japanese, in practice —
// can't be reached from a flat list. A longer list is therefore split first by
// initial letter (see letterBuckets, kana grouped by row), and any bucket still
// over BROWSE_LIST_LIMIT into range folders ("A – B"), recursively. A folder is
// addressed by its path of indices ("2.0.1": bucket, then range chunks).

const val BROWSE_LIST_LIMIT = 20

private const val ARTIST_INDEX_PREFIX = "artists-index/"
private const val ALBUM_INDEX_PREFIX = "albums-index/"

/** Size of one chunk when [size] names don't fit in one list: the smallest power of the limit that yields <= limit folders. */
private fun rangeChunkSize(size: Int): Int {
    var c = 1
    while (c.toLong() * BROWSE_LIST_LIMIT < size) c *= BROWSE_LIST_LIMIT
    return c
}

/** The names under the folder at [path] (empty = the whole list); null if the path doesn't exist. */
fun rangeSlice(names: List<String>, path: List<Int>): List<String>? {
    var cur = names
    for (idx in path) {
        if (cur.size <= BROWSE_LIST_LIMIT || idx < 0) return null
        val size = rangeChunkSize(cur.size)
        cur = cur.drop(idx * size).take(size)
        if (cur.isEmpty()) return null
    }
    return cur
}

/** The child range folders of [names] as (chunk index, names), or empty when [names] fits in one list. */
fun rangeFolders(names: List<String>): List<Pair<Int, List<String>>> =
    if (names.size <= BROWSE_LIST_LIMIT) emptyList()
    else names.chunked(rangeChunkSize(names.size)).mapIndexed { i, chunk -> i to chunk }

fun rangeTitle(group: List<String>): String =
    if (group.size == 1) group.first() else "${group.first()} – ${group.last()}"

private fun indexFolderId(prefix: String, path: List<Int>) = "$prefix${path.joinToString(".")}"

private fun indexPathOfFolder(prefix: String, mediaId: String): List<Int>? =
    mediaId.takeIf { it.startsWith(prefix) }?.removePrefix(prefix)?.split('.')?.map { it.toIntOrNull() ?: return null }

fun artistIndexFolderId(path: List<Int>): String = indexFolderId(ARTIST_INDEX_PREFIX, path)
fun artistIndexPathOfFolder(mediaId: String): List<Int>? = indexPathOfFolder(ARTIST_INDEX_PREFIX, mediaId)
fun albumIndexFolderId(path: List<Int>): String = indexFolderId(ALBUM_INDEX_PREFIX, path)
fun albumIndexPathOfFolder(mediaId: String): List<Int>? = indexPathOfFolder(ALBUM_INDEX_PREFIX, mediaId)

private const val KANA_ROWS = "あいうえお:かきくけこ:さしすせそ:たちつてと:なにぬねの:はひふへほ:まみむめも:やゆよ:らりるれろ:わをん"
private const val SYMBOL_KEY = "#"
private const val OTHER_KEY = "他"

private val kanaRowOf: Map<Char, Char> = buildMap {
    KANA_ROWS.split(':').forEach { row -> row.forEach { put(it, row[0]) } }
}

private val letterKeyOrder: List<String> =
    listOf(SYMBOL_KEY) + ('A'..'Z').map { it.toString() } + KANA_ROWS.split(':').map { it.take(1) } + OTHER_KEY

private fun smallKanaToLarge(c: Char): Char = when (c) {
    'ぁ' -> 'あ'; 'ぃ' -> 'い'; 'ぅ' -> 'う'; 'ぇ' -> 'え'; 'ぉ' -> 'お'
    'っ' -> 'つ'; 'ゃ' -> 'や'; 'ゅ' -> 'ゆ'; 'ょ' -> 'よ'; 'ゎ' -> 'わ'
    else -> c
}

/**
 * The initial-letter key of a name: A-Z for Latin (full-width/accented folded),
 * the kana row head (あ/か/さ/…) for hiragana/katakana (voiced and small kana
 * fold into their row), "#" for digits/symbols, "他" for kanji and the rest.
 */
fun letterKeyOf(name: String): String {
    val first = name.trim().firstOrNull() ?: return SYMBOL_KEY
    // NFKC folds full-width forms; NFD splits accents/dakuten off the base char.
    val base = Normalizer.normalize(Normalizer.normalize(first.toString(), Normalizer.Form.NFKC), Normalizer.Form.NFD)
        .firstOrNull() ?: return SYMBOL_KEY
    return when {
        base in 'a'..'z' || base in 'A'..'Z' -> base.uppercaseChar().toString()
        base in 'ァ'..'ヶ' -> kanaRowOf[base - 0x60]?.toString() ?: OTHER_KEY
        base in 'ぁ'..'ん' -> kanaRowOf[smallKanaToLarge(base)]?.toString() ?: OTHER_KEY
        base.isDigit() -> SYMBOL_KEY
        base.isLetter() -> OTHER_KEY
        else -> SYMBOL_KEY
    }
}

/**
 * Initial-letter buckets of [names] in display order (#, A-Z, あ-わ, 他), empty
 * ones dropped. If that is still more than [limit] buckets, the adjacent pair
 * with the fewest names between them is merged repeatedly (titles like "B – D").
 */
fun letterBuckets(names: List<String>, limit: Int = BROWSE_LIST_LIMIT): List<Pair<String, List<String>>> {
    val byKey = names.groupBy(::letterKeyOf)
    val buckets = letterKeyOrder.filter { it in byKey }
        .map { Triple(it, it, byKey.getValue(it)) }
        .toMutableList() // first key, last key, names
    while (buckets.size > limit) {
        val i = (0 until buckets.size - 1).minBy { buckets[it].third.size + buckets[it + 1].third.size }
        val a = buckets[i]; val b = buckets[i + 1]
        buckets[i] = Triple(a.first, b.second, a.third + b.third)
        buckets.removeAt(i + 1)
    }
    return buckets.map { (from, to, group) -> (if (from == to) from else "$from – $to") to group }
}
