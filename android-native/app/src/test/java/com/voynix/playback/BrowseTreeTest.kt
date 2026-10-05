package com.voynix.playback

import androidx.media3.session.MediaConstants
import com.voynix.data.db.TrackEntity
import com.voynix.data.db.TrackWithStats
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BrowseTreeTest {

    private fun track(
        id: String,
        favorite: Boolean = false,
        playCount: Int = 0,
        artist: String? = "Artist",
        album: String? = "Album",
    ): TrackWithStats =
        TrackWithStats(
            track = TrackEntity(
                id = id,
                title = "Title $id",
                artist = artist,
                album = album,
                filePath = "/music/$id.mp3",
                fileName = "$id.mp3",
                duration = 200.0,
                favorite = favorite,
            ),
            playCount = playCount,
        )

    @Test
    fun `unknown parent id is not a leaf folder`() {
        val tracks = listOf(track("1"))
        assertNull(browseTreeChildren(ROOT_ID, tracks, page = 0, pageSize = 50))
        assertNull(browseTreeChildren("something_else", tracks, page = 0, pageSize = 50))
    }

    @Test
    fun `the root tab ids are not resolved by browseTreeChildren`() {
        // PlaybackService's onGetChildren `when` must catch HOME_ID/LIBRARY_ID
        // itself before falling through to this — if that ever stops being
        // true, these should start returning non-null.
        val tracks = listOf(track("1"))
        for (id in listOf(HOME_ID, LIBRARY_ID)) {
            assertNull(browseTreeChildren(id, tracks, page = 0, pageSize = 50))
        }
    }

    @Test
    fun `all songs returns every track unfiltered`() {
        val tracks = listOf(track("1"), track("2"), track("3"))
        val result = browseTreeChildren(ALL_SONGS_ID, tracks, page = 0, pageSize = 50)
        assertEquals(tracks, result)
    }

    @Test
    fun `favorites filters to favorited tracks only`() {
        val tracks = listOf(track("1", favorite = true), track("2", favorite = false), track("3", favorite = true))
        val result = browseTreeChildren(FAVORITES_ID, tracks, page = 0, pageSize = 50)
        assertEquals(listOf("1", "3"), result?.map { it.track.id })
    }

    @Test
    fun `most played excludes zero plays, sorts descending, caps at 100`() {
        val tracks = (1..150).map { track(it.toString(), playCount = it) } + track("zero", playCount = 0)
        val result = browseTreeChildren(MOST_PLAYED_ID, tracks, page = 0, pageSize = 200)
        assertEquals(100, result?.size)
        assertEquals("150", result?.first()?.track?.id)
        assertTrue(result?.none { it.track.id == "zero" } == true)
    }

    @Test
    fun `pages slice the matched list without overlap`() {
        val tracks = (1..25).map { track(it.toString()) }
        val page0 = browseTreeChildren(ALL_SONGS_ID, tracks, page = 0, pageSize = 10)
        val page1 = browseTreeChildren(ALL_SONGS_ID, tracks, page = 1, pageSize = 10)
        val page2 = browseTreeChildren(ALL_SONGS_ID, tracks, page = 2, pageSize = 10)

        assertEquals((1..10).map { it.toString() }, page0?.map { it.track.id })
        assertEquals((11..20).map { it.toString() }, page1?.map { it.track.id })
        assertEquals((21..25).map { it.toString() }, page2?.map { it.track.id })
    }

    @Test
    fun `page past the end returns empty rather than erroring`() {
        val tracks = listOf(track("1"), track("2"))
        val result = browseTreeChildren(ALL_SONGS_ID, tracks, page = 5, pageSize = 10)
        assertEquals(emptyList<TrackWithStats>(), result)
    }

    @Test
    fun `huge page size does not overflow the skip computation`() {
        val tracks = listOf(track("1"), track("2"))
        val result = browseTreeChildren(ALL_SONGS_ID, tracks, page = 1, pageSize = Int.MAX_VALUE)
        assertEquals(emptyList<TrackWithStats>(), result)

        val firstPage = browseTreeChildren(ALL_SONGS_ID, tracks, page = 0, pageSize = Int.MAX_VALUE)
        assertEquals(tracks, firstPage)
    }

    @Test
    fun `negative page or non-positive page size returns empty`() {
        val tracks = listOf(track("1"))
        assertEquals(emptyList<TrackWithStats>(), browseTreeChildren(ALL_SONGS_ID, tracks, page = -1, pageSize = 10))
        assertEquals(emptyList<TrackWithStats>(), browseTreeChildren(ALL_SONGS_ID, tracks, page = 0, pageSize = 0))
    }

    @Test
    fun `browseTreeChildren does not resolve the playlists folder itself`() {
        val tracks = listOf(track("1"))
        assertNull(browseTreeChildren(PLAYLISTS_ID, tracks, page = 0, pageSize = 50))
    }

    // --- pageSlice --------------------------------------------------------
    // Same edge cases browseTreeChildren used to own directly, now covering
    // the extracted generic helper it (and the playlist branches) share.

    @Test
    fun `pageSlice slices without overlap`() {
        val items = (1..25).toList()
        assertEquals((1..10).toList(), pageSlice(items, page = 0, pageSize = 10))
        assertEquals((11..20).toList(), pageSlice(items, page = 1, pageSize = 10))
        assertEquals((21..25).toList(), pageSlice(items, page = 2, pageSize = 10))
    }

    @Test
    fun `pageSlice past the end returns empty`() {
        assertEquals(emptyList<Int>(), pageSlice(listOf(1, 2), page = 5, pageSize = 10))
    }

    @Test
    fun `pageSlice with huge page size does not overflow`() {
        val items = listOf(1, 2)
        assertEquals(emptyList<Int>(), pageSlice(items, page = 1, pageSize = Int.MAX_VALUE))
        assertEquals(items, pageSlice(items, page = 0, pageSize = Int.MAX_VALUE))
    }

    @Test
    fun `pageSlice with negative page or non-positive page size returns empty`() {
        assertEquals(emptyList<Int>(), pageSlice(listOf(1), page = -1, pageSize = 10))
        assertEquals(emptyList<Int>(), pageSlice(listOf(1), page = 0, pageSize = 0))
    }

    // --- hierarchical media ids --------------------------------------------

    @Test
    fun `playlistFolderId and playlistIdOfFolder round-trip`() {
        val folderId = playlistFolderId("pl-123")
        assertEquals("pl-123", playlistIdOfFolder(folderId))
    }

    @Test
    fun `playlistIdOfFolder is null for non-playlist ids`() {
        assertNull(playlistIdOfFolder(ROOT_ID))
        assertNull(playlistIdOfFolder(ALL_SONGS_ID))
        assertNull(playlistIdOfFolder("track-1"))
    }

    @Test
    fun `leafMediaId round-trips through parentIdOfLeaf and trackIdOfLeaf`() {
        val leaf = leafMediaId(ALL_SONGS_ID, "track-1")
        assertEquals(ALL_SONGS_ID, parentIdOfLeaf(leaf))
        assertEquals("track-1", trackIdOfLeaf(leaf))
    }

    @Test
    fun `leafMediaId round-trips for a playlist folder parent`() {
        val parent = playlistFolderId("pl-123")
        val leaf = leafMediaId(parent, "track-1")
        assertEquals(parent, parentIdOfLeaf(leaf))
        assertEquals("track-1", trackIdOfLeaf(leaf))
    }

    @Test
    fun `a bare untagged mediaId has no parent and passes through as its own track id`() {
        assertNull(parentIdOfLeaf("track-1"))
        assertEquals("track-1", trackIdOfLeaf("track-1"))
    }

    // --- artist / album folders ---------------------------------------------

    @Test
    fun `artistFolderId and albumFolderId round-trip through their name-of-folder functions`() {
        assertEquals("Artist Name", artistNameOfFolder(artistFolderId("Artist Name")))
        assertEquals("Album Name", albumNameOfFolder(albumFolderId("Album Name")))
    }

    @Test
    fun `artist and album names containing the leaf or playlist separators still round-trip`() {
        // '|' would corrupt leafMediaId's split, '/' would look like a nested
        // path — both must survive being URL-encoded into the folder id.
        val name = "A/B|C 日本語"
        assertEquals(name, artistNameOfFolder(artistFolderId(name)))
        assertEquals(name, albumNameOfFolder(albumFolderId(name)))

        val leaf = leafMediaId(artistFolderId(name), "track-1")
        assertEquals(artistFolderId(name), parentIdOfLeaf(leaf))
        assertEquals("track-1", trackIdOfLeaf(leaf))
        assertEquals(name, artistNameOfFolder(parentIdOfLeaf(leaf)!!))
    }

    @Test
    fun `artistNameOfFolder and albumNameOfFolder are null for unrelated ids`() {
        assertNull(artistNameOfFolder(ROOT_ID))
        assertNull(artistNameOfFolder(playlistFolderId("pl-1")))
        assertNull(albumNameOfFolder(ROOT_ID))
        assertNull(albumNameOfFolder(artistFolderId("Some Artist")))
    }

    @Test
    fun `browseTreeChildren filters to one artist's tracks`() {
        val tracks = listOf(
            track("1", artist = "A"),
            track("2", artist = "B"),
            track("3", artist = "A"),
        )
        val result = browseTreeChildren(artistFolderId("A"), tracks, page = 0, pageSize = 50)
        assertEquals(listOf("1", "3"), result?.map { it.track.id })
    }

    @Test
    fun `browseTreeChildren filters to one album's tracks`() {
        val tracks = listOf(
            track("1", album = "X"),
            track("2", album = "Y"),
            track("3", album = "X"),
        )
        val result = browseTreeChildren(albumFolderId("X"), tracks, page = 0, pageSize = 50)
        assertEquals(listOf("1", "3"), result?.map { it.track.id })
    }

    @Test
    fun `artistNames and albumNames are sorted and deduplicated, with a fallback for blank tags`() {
        val tracks = listOf(
            track("1", artist = "Bob", album = "Zed"),
            track("2", artist = "Amy", album = "Alpha"),
            track("3", artist = "Amy", album = "Alpha"),
            track("4", artist = "", album = null),
        )
        assertEquals(listOf("Amy", "Bob", "Unknown Artist"), artistNames(tracks))
        assertEquals(listOf("Alpha", "Unknown Album", "Zed"), albumNames(tracks))
    }

    // --- content style extras -----------------------------------------------

    @Test
    fun `contentStyleExtras sets the browsable and playable hint keys`() {
        val extras = contentStyleExtras(
            browsableHint = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM,
            playableHint = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
        )
        assertEquals(
            MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM,
            extras.getInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE),
        )
        assertEquals(
            MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
            extras.getInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE),
        )
    }

    @Test
    fun `rootContentStyleExtras opts into content style hints`() {
        assertTrue(rootContentStyleExtras().getBoolean("android.media.browse.CONTENT_STYLE_SUPPORTED"))
    }

    // --- completion status extras --------------------------------------------

    @Test
    fun `completionExtras is null for non-podcast tracks`() {
        assertNull(completionExtras("music", "played", 0.0, 200.0))
    }

    @Test
    fun `completionExtras marks unplayed with no percentage`() {
        val extras = completionExtras("podcast", "unplayed", 0.0, 200.0)!!
        assertEquals(
            MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_NOT_PLAYED,
            extras.getInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS),
        )
        assertTrue(extras.getDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE, -1.0) == -1.0)
    }

    @Test
    fun `completionExtras derives percentage from resume position while in progress`() {
        val extras = completionExtras("podcast", "in_progress", 50.0, 200.0)!!
        assertEquals(
            MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED,
            extras.getInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS),
        )
        assertEquals(0.25, extras.getDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE), 0.0001)
    }

    @Test
    fun `completionExtras skips percentage when in progress with unknown duration`() {
        val extras = completionExtras("podcast", "in_progress", 50.0, null)!!
        assertTrue(extras.getDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE, -1.0) == -1.0)
    }

    @Test
    fun `completionExtras is fully played at 1_0 even though resume position was reset to 0`() {
        // nextPlayState() resets resume_position to 0 once a podcast finishes
        // (logic/Playback.kt) — percentage must not be derived from it here.
        val extras = completionExtras("podcast", "played", 0.0, 200.0)!!
        assertEquals(
            MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_FULLY_PLAYED,
            extras.getInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS),
        )
        assertEquals(1.0, extras.getDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE), 0.0001)
    }

    @Test
    fun rangeFolders_splitsUntilEveryListFits() {
        val small = (1..20).map { "n$it" }
        assertTrue(rangeFolders(small).isEmpty())

        val fifty = (1..50).map { "n$it" }
        val top = rangeFolders(fifty)
        assertEquals(3, top.size)
        assertEquals(20, top[0].second.size)
        assertEquals(10, top[2].second.size)

        // 450 names: 20 folders of 20 — every level stays within the limit.
        val big = (1..450).map { "n$it" }
        val level1 = rangeFolders(big)
        assertTrue(level1.size <= BROWSE_LIST_LIMIT)
        assertEquals(big, level1.flatMap { it.second })

        // 1000 names need two levels; the leaves still cover everything once.
        val huge = (1..1000).map { "n$it" }
        fun leaves(path: List<Int>): List<String> {
            val slice = rangeSlice(huge, path)!!
            val ranges = rangeFolders(slice)
            assertTrue(ranges.size <= BROWSE_LIST_LIMIT)
            return if (ranges.isEmpty()) slice else ranges.flatMap { leaves(path + it.first) }
        }
        assertEquals(huge, leaves(emptyList()))
    }

    @Test
    fun rangeSlice_rejectsBadPaths() {
        val fifty = (1..50).map { "n$it" }
        assertEquals(fifty.take(20), rangeSlice(fifty, listOf(0)))
        assertNull(rangeSlice(fifty, listOf(3)))
        assertNull(rangeSlice(fifty, listOf(0, 0)))
    }

    @Test
    fun indexFolderIds_roundTrip() {
        assertEquals(listOf(2, 1), artistIndexPathOfFolder(artistIndexFolderId(listOf(2, 1))))
        assertEquals(listOf(0), albumIndexPathOfFolder(albumIndexFolderId(listOf(0))))
        assertNull(artistNameOfFolder(artistIndexFolderId(listOf(0))))
        assertNull(artistIndexPathOfFolder(artistFolderId("A")))
        assertNull(artistIndexPathOfFolder("artists-index/x"))
    }

    @Test
    fun letterKeyOf_groupsByInitial() {
        assertEquals("A", indexOf("abba"))
        assertEquals("A", indexOf("Ａｂｂａ"))
        assertEquals("E", indexOf("Élan"))
        assertEquals("あ", indexOf("アイドル"))
        assertEquals("か", indexOf("ガガ"))
        assertEquals("さ", indexOf("ザ・クロマニヨンズ"))
        assertEquals("た", indexOf("っ"))
        assertEquals("や", indexOf("ゃ"))
        assertEquals("#", indexOf("2Pac"))
        assertEquals("#", indexOf("!!!"))
        assertEquals("#", indexOf(""))
        assertEquals("他", indexOf("宇多田ヒカル"))
    }

    private fun indexOf(name: String) = letterKeyOf(name)

    @Test
    fun letterBuckets_orderedAndMergedToFit() {
        val few = letterBuckets(listOf("宇多田", "Bob", "Abe", "1", "あき"))
        assertEquals(listOf("#", "A", "B", "あ", "他"), few.map { it.first })

        // 26 Latin initials + a kana row: must merge down to the limit, losing no names.
        val names = ('A'..'Z').map { "$it name" } + "さくら"
        val merged = letterBuckets(names, limit = 20)
        assertEquals(20, merged.size)
        assertEquals(names.sorted(), merged.flatMap { it.second }.sorted())
        assertTrue(merged.any { " – " in it.first })
    }
}
