package com.voynix.logic

import com.voynix.sync.SnapshotTrackDto
import com.voynix.sync.toManifestTrack
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun manifestTrack(
    key: String,
    contentHash: String = "hash-$key",
    title: String = "Title $key",
    artist: String? = null,
    album: String? = null,
    duration: Double? = 100.0,
    kind: TrackKind = TrackKind.MUSIC,
    discNo: Int? = null,
    trackNo: Int? = null,
    favorite: Boolean = false,
    favoriteUpdatedAt: Long? = null,
    playState: PlayState = PlayState.UNPLAYED,
    resumePosition: Double = 0.0,
    playStateUpdatedAt: Long? = null,
    addedAt: Long? = null,
) = ManifestTrack(
    trackKey = key,
    title = title,
    artist = artist,
    album = album,
    duration = duration,
    fileName = "$key.mp3",
    filePath = "/mac/$key.mp3",
    contentHash = contentHash,
    size = 1000,
    favorite = favorite,
    favoriteUpdatedAt = favoriteUpdatedAt,
    kind = kind,
    discNo = discNo,
    trackNo = trackNo,
    playState = playState,
    resumePosition = resumePosition,
    playStateUpdatedAt = playStateUpdatedAt,
    addedAt = addedAt,
)

/** A local row that agrees with [m] on every compared column — the steady state. */
private fun localMatching(m: ManifestTrack, contentHash: String? = m.contentHash) = LocalMirrorTrack(
    id = "id-${m.trackKey}", trackKey = m.trackKey, contentHash = contentHash, filePath = "content://${m.trackKey}",
    title = m.title, artist = m.artist, album = m.album, duration = m.duration,
    kind = m.kind, discNo = m.discNo, trackNo = m.trackNo, addedAt = m.addedAt,
)

private fun localTrack(key: String, contentHash: String? = "hash-$key") =
    localMatching(manifestTrack(key), contentHash)

private fun localPlaylist(id: String, name: String = "P $id", kind: TrackKind = TrackKind.MUSIC, trackIds: List<String> = emptyList()) =
    LocalMirrorPlaylist(id, name, kind, trackIds)

private fun manifestPlaylist(id: String, name: String = "P $id", kind: TrackKind = TrackKind.MUSIC, keys: List<String> = emptyList()) =
    ManifestPlaylist(id, name, kind, keys)

/** Resolver backed by a plain key -> id map, like SyncEngine's keyToId. */
private fun resolver(vararg pairs: Pair<String, String>): (String) -> String? = mapOf(*pairs)::get

class SyncTest {
    @Test
    fun `diffTracks classifies new local-changed and gone tracks`() {
        val manifest = listOf(manifestTrack("a"), manifestTrack("b", contentHash = "new-hash"), manifestTrack("c"))
        val local = listOf(localTrack("b", contentHash = "old-hash"), localTrack("c"), localTrack("d"))

        val plan = diffTracks(manifest, local)

        assertEquals(listOf("a"), plan.toAdd.map { it.trackKey })
        assertEquals(listOf("b"), plan.toRefetch.map { it.trackKey })
        // "c" has identical bytes and metadata: nothing to write.
        assertTrue(plan.toUpdateMeta.isEmpty())
        assertEquals(listOf("d"), plan.toDelete.map { it.trackKey })
    }

    @Test
    fun `diffTracks skips a track whose metadata already matches`() {
        val m = manifestTrack("a", artist = "Art", album = "Alb", discNo = 1, trackNo = 2)
        val plan = diffTracks(listOf(m), listOf(localMatching(m)))
        assertTrue(plan.toUpdateMeta.isEmpty())
        assertTrue(plan.toAdd.isEmpty())
        assertTrue(plan.toRefetch.isEmpty())
        assertTrue(plan.toDelete.isEmpty())
    }

    @Test
    fun `diffTracks flags each changed metadata field on its own`() {
        val base = manifestTrack("a", artist = "Art", album = "Alb", duration = 100.0, discNo = 1, trackNo = 2)
        val local = localMatching(base)
        val changed = mapOf(
            "title" to base.copy(title = "Other"),
            "artist" to base.copy(artist = "Other"),
            "album" to base.copy(album = "Other"),
            "duration" to base.copy(duration = 101.0),
            "kind" to base.copy(kind = TrackKind.PODCAST),
            "discNo" to base.copy(discNo = 9),
            "trackNo" to base.copy(trackNo = 9),
            "addedAt" to base.copy(addedAt = 12345L),
        )
        for ((field, m) in changed) {
            val plan = diffTracks(listOf(m), listOf(local))
            assertEquals("$field change should be flagged", listOf("a"), plan.toUpdateMeta.map { it.trackKey })
        }
    }

    @Test
    fun `diffTracks treats null and empty-string artist as different`() {
        // Deliberately not normalized: one UPDATE writes the manifest's value and the
        // next sync matches, so it converges. Normalizing would leave the columns
        // silently different forever.
        val nullArtist = manifestTrack("a", artist = null)
        val emptyArtist = manifestTrack("a", artist = "")
        assertEquals(listOf("a"), diffTracks(listOf(emptyArtist), listOf(localMatching(nullArtist))).toUpdateMeta.map { it.trackKey })
        assertEquals(listOf("a"), diffTracks(listOf(nullArtist), listOf(localMatching(emptyArtist))).toUpdateMeta.map { it.trackKey })
    }

    @Test
    fun `diffTracks treats a missing wire kind as music`() {
        val dto = Json.decodeFromString<SnapshotTrackDto>(
            """{"track_key":"a","title":"Title a","file_name":"a.mp3","file_path":"/mac/a.mp3","content_hash":"hash-a"}"""
        )
        val m = dto.toManifestTrack()
        val local = localMatching(manifestTrack("a", duration = null))
        assertTrue(diffTracks(listOf(m), listOf(local)).toUpdateMeta.isEmpty())
    }

    @Test
    fun `diffTracks tolerates sub-millisecond duration drift but not real changes`() {
        fun flagged(local: Double?, remote: Double?) = diffTracks(
            listOf(manifestTrack("a", duration = remote)),
            listOf(localMatching(manifestTrack("a", duration = local))),
        ).toUpdateMeta.isNotEmpty()

        assertFalse(flagged(180.0, 180.0000001))
        assertTrue(flagged(180.0, 180.5))
        assertTrue(flagged(null, 180.0))
        assertTrue(flagged(180.0, null))
        assertFalse(flagged(null, null))
    }

    @Test
    fun `diffTracks ignores favorite and play_state which updateMirrorTrackMeta never writes`() {
        // Comparing these would flag the track on every sync forever: the resulting
        // UPDATE doesn't touch those columns, so they could never converge.
        val local = localMatching(manifestTrack("a"))
        val m = manifestTrack(
            "a", favorite = true, favoriteUpdatedAt = 999, playState = PlayState.PLAYED,
            resumePosition = 42.0, playStateUpdatedAt = 999,
        )
        assertTrue(diffTracks(listOf(m), listOf(local)).toUpdateMeta.isEmpty())
    }

    @Test
    fun `diffTracks still refetches on a content hash change even when metadata matches`() {
        val m = manifestTrack("a", contentHash = "new")
        val plan = diffTracks(listOf(m), listOf(localMatching(m, contentHash = "old")))
        assertEquals(listOf("a"), plan.toRefetch.map { it.trackKey })
        assertTrue(plan.toUpdateMeta.isEmpty())
    }

    @Test
    fun `diffPlaylists skips an unchanged playlist`() {
        val plan = diffPlaylists(
            listOf(manifestPlaylist("p1", keys = listOf("a", "b"))),
            listOf(localPlaylist("p1", trackIds = listOf("t1", "t2"))),
            resolver("a" to "t1", "b" to "t2"),
        )
        assertTrue(plan.toUpsert.isEmpty())
        assertTrue(plan.toDelete.isEmpty())
    }

    @Test
    fun `diffPlaylists upserts on a name kind or membership change`() {
        val res = resolver("a" to "t1", "b" to "t2", "c" to "t3")
        val local = listOf(localPlaylist("p1", name = "Car", trackIds = listOf("t1", "t2")))
        fun upserts(p: ManifestPlaylist) = diffPlaylists(listOf(p), local, res).toUpsert.map { it.id }

        assertEquals(emptyList<String>(), upserts(manifestPlaylist("p1", name = "Car", keys = listOf("a", "b"))))
        assertEquals(listOf("p1"), upserts(manifestPlaylist("p1", name = "Renamed", keys = listOf("a", "b"))))
        assertEquals(listOf("p1"), upserts(manifestPlaylist("p1", name = "Car", kind = TrackKind.PODCAST, keys = listOf("a", "b"))))
        assertEquals(listOf("p1"), upserts(manifestPlaylist("p1", name = "Car", keys = listOf("a", "b", "c"))))
    }

    @Test
    fun `diffPlaylists upserts on a reorder`() {
        val plan = diffPlaylists(
            listOf(manifestPlaylist("p1", keys = listOf("b", "a"))),
            listOf(localPlaylist("p1", trackIds = listOf("t1", "t2"))),
            resolver("a" to "t1", "b" to "t2"),
        )
        assertEquals(listOf("p1"), plan.toUpsert.map { it.id })
    }

    @Test
    fun `diffPlaylists upserts a playlist that is not local yet and deletes what dropped out`() {
        val plan = diffPlaylists(
            listOf(manifestPlaylist("p1", keys = listOf("a"))),
            listOf(localPlaylist("p2", name = "Gone")),
            resolver("a" to "t1"),
        )
        assertEquals(listOf("p1"), plan.toUpsert.map { it.id })
        assertEquals(listOf("p2"), plan.toDelete.map { it.id })
    }

    @Test
    fun `diffPlaylists heals a playlist once a missing track downloads`() {
        val manifest = listOf(manifestPlaylist("p1", keys = listOf("a", "b")))

        // "b" failed to download: what we'd write is just [t1], which is already stored — don't churn.
        assertTrue(diffPlaylists(manifest, listOf(localPlaylist("p1", trackIds = listOf("t1"))), resolver("a" to "t1")).toUpsert.isEmpty())

        // Stored membership has a stale extra id for a since-removed track — rewrite it.
        assertEquals(
            listOf("p1"),
            diffPlaylists(manifest, listOf(localPlaylist("p1", trackIds = listOf("t1", "t2"))), resolver("a" to "t1")).toUpsert.map { it.id },
        )

        // "b" has now downloaded: the resolved list grew, so the playlist is upserted (healed).
        assertEquals(
            listOf("p1"),
            diffPlaylists(manifest, listOf(localPlaylist("p1", trackIds = listOf("t1"))), resolver("a" to "t1", "b" to "t2")).toUpsert.map { it.id },
        )
    }

    @Test
    fun `diffPlaylists collapses a repeated track key the same way the writer does`() {
        // playlist_tracks' PK is (playlist_id, track_id), so a repeated key is stored once.
        // If the diff compared the raw list it would flag this playlist on every sync forever.
        val plan = diffPlaylists(
            listOf(manifestPlaylist("p1", keys = listOf("a", "a", "b"))),
            listOf(localPlaylist("p1", trackIds = listOf("t1", "t2"))),
            resolver("a" to "t1", "b" to "t2"),
        )
        assertTrue(plan.toUpsert.isEmpty())
    }

    @Test
    fun `hasEnoughSpace proceeds when free space is unknown`() {
        assertTrue(hasEnoughSpace(neededBytes = 1_000_000, freeBytes = null, cushionBytes = 0))
    }

    @Test
    fun `hasEnoughSpace requires the cushion on top of the need`() {
        assertTrue(hasEnoughSpace(neededBytes = 100, freeBytes = 200, cushionBytes = 100))
        assertFalse(hasEnoughSpace(neededBytes = 100, freeBytes = 199, cushionBytes = 100))
    }

    @Test
    fun `resolvePeer returns unchanged when the direct probe succeeds`() = runTest {
        val peer = SyncPeer("https://old:1", "tok", null, "pin-abc")
        val result = resolvePeer(peer, probe = { _, _, _ -> PeerProbeResult.OK }, discover = { emptyList() })
        assertEquals(peer, result.peer)
        assertFalse(result.changed)
    }

    @Test(expected = PeerUnauthorizedError::class)
    fun `resolvePeer throws unauthorized without discovering`() = runTest {
        val peer = SyncPeer("https://old:1", "tok", null, "pin-abc")
        resolvePeer(
            peer,
            probe = { _, _, _ -> PeerProbeResult.UNAUTHORIZED },
            discover = { throw AssertionError("must not discover after an unauthorized probe") },
        )
    }

    @Test
    fun `resolvePeer re-resolves via discovery when unreachable`() = runTest {
        val peer = SyncPeer("https://old:1", "tok", null, "pin-abc")
        val candidate = DiscoveredPeer("Mac", "new", 2, "https://new:2")
        val result = resolvePeer(
            peer,
            probe = { url, _, _ -> if (url == candidate.url) PeerProbeResult.OK else PeerProbeResult.UNREACHABLE },
            discover = { listOf(candidate) },
        )
        assertEquals("https://new:2", result.peer.url)
        assertTrue(result.changed)
    }

    @Test(expected = PeerUnreachableError::class)
    fun `resolvePeer throws unreachable when no candidate answers`() = runTest {
        val peer = SyncPeer("https://old:1", "tok", null, "pin-abc")
        resolvePeer(
            peer,
            probe = { _, _, _ -> PeerProbeResult.UNREACHABLE },
            discover = { listOf(DiscoveredPeer("Mac", "new", 2, "https://new:2")) },
        )
    }

    @Test
    fun `checkPeerConnection is CONNECTED and silent when the saved URL answers`() = runTest {
        val peer = SyncPeer("https://old:1", "tok", null, "pin-abc")
        var moved: SyncPeer? = null
        val result = checkPeerConnection(
            peer,
            probe = { _, _, _ -> PeerProbeResult.OK },
            discover = { throw AssertionError("must not discover when the saved URL answers") },
            onPeerMoved = { moved = it },
        )
        assertEquals(PeerConnection.CONNECTED, result)
        assertEquals(null, moved)
    }

    @Test
    fun `checkPeerConnection reports the new URL when the Mac moved`() = runTest {
        val peer = SyncPeer("https://old:1", "tok", null, "pin-abc")
        val candidate = DiscoveredPeer("Mac", "new", 2, "https://new:2")
        var moved: SyncPeer? = null
        val result = checkPeerConnection(
            peer,
            probe = { url, _, _ -> if (url == candidate.url) PeerProbeResult.OK else PeerProbeResult.UNREACHABLE },
            discover = { listOf(candidate) },
            onPeerMoved = { moved = it },
        )
        assertEquals(PeerConnection.CONNECTED, result)
        assertEquals("https://new:2", moved?.url)
    }

    @Test
    fun `checkPeerConnection is UNREACHABLE when neither the saved URL nor discovery answers`() = runTest {
        val peer = SyncPeer("https://old:1", "tok", null, "pin-abc")
        val result = checkPeerConnection(
            peer,
            probe = { _, _, _ -> PeerProbeResult.UNREACHABLE },
            discover = { listOf(DiscoveredPeer("Mac", "new", 2, "https://new:2")) },
        )
        assertEquals(PeerConnection.UNREACHABLE, result)
    }

    @Test
    fun `checkPeerConnection is UNAUTHORIZED when the Mac rejects the token`() = runTest {
        val peer = SyncPeer("https://old:1", "tok", null, "pin-abc")
        val result = checkPeerConnection(
            peer,
            probe = { _, _, _ -> PeerProbeResult.UNAUTHORIZED },
            discover = { throw AssertionError("must not discover after an unauthorized probe") },
        )
        assertEquals(PeerConnection.UNAUTHORIZED, result)
    }

    @Test
    fun `pool runs every item exactly once under a concurrency limit`() = runTest {
        val items = (1..20).toList()
        val seen = java.util.concurrent.ConcurrentHashMap.newKeySet<Int>()
        pool(items, limit = 4) { item, _ -> seen.add(item) }
        assertEquals(items.toSet(), seen)
    }
}

class NormalizePairingInputTest {
    @Test
    fun foldsFullWidthDigitsAndLetters() {
        assertEquals("1abcXYZ-_", normalizePairingInput("１ａｂｃＸＹＺ－＿"))
    }

    @Test
    fun trimsWhitespaceAndIdeographicSpace() {
        assertEquals("abc", normalizePairingInput("\u3000 abc \n"))
    }

    @Test
    fun leavesHalfWidthUntouched() {
        assertEquals("https://192.168.0.2:60930", normalizePairingInput("https://192.168.0.2:60930"))
    }
}
