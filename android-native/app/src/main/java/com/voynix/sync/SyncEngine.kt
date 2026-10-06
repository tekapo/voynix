package com.voynix.sync

import android.content.Context
import com.voynix.data.db.PlayEventEntity
import com.voynix.data.db.SettingEntity
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.LocalMirrorPlaylist
import com.voynix.logic.LocalMirrorTrack
import com.voynix.logic.ManifestPlaylist
import com.voynix.logic.ManifestTrack
import com.voynix.logic.SyncPeer
import com.voynix.logic.SyncProgress
import com.voynix.logic.SyncSummary
import com.voynix.logic.diffPlaylists
import com.voynix.logic.diffTracks
import com.voynix.logic.hasEnoughSpace
import com.voynix.logic.pool
import com.voynix.logic.resolvedTrackIds
import java.io.File
import java.util.Collections
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/**
 * Orchestrates one phone->Mac sync, mirroring syncEngine.ts's runSync order:
 * manifest -> push local stats -> reconcile tracks (download/refetch/delete) ->
 * apply the manifest's own favorite/play_state/play_events (LWW + grow-only
 * union, see logic/StatsMerge.kt) -> playlists -> album art -> persist peer.
 *
 * Voynix never scans/imports locally, so unlike the Mac there's no local
 * "push tracks" direction — only stats (play_events/favorites/play_states)
 * travel phone->Mac; tracks and playlists only ever travel Mac->phone.
 */
class SyncEngine(
    context: Context,
    private val db: VoynixDatabase,
    private val api: SyncApi = SyncApi(),
) {
    private val syncedDir = File(context.filesDir, "synced")
    private val albumArtDir = File(context.cacheDir, "album_art")
    private val peerStore = SyncPeerStore(db)

    suspend fun runSync(peer: SyncPeer, onProgress: (SyncProgress) -> Unit = {}): SyncSummary {
        val errors = mutableListOf<String>()

        onProgress(SyncProgress("manifest", "Fetching manifest"))
        val snapshot = api.fetchManifest(peer.url, peer.token, peer.pin)
        val manifestTracks = snapshot.tracks.map { it.toManifestTrack() }
        val manifestPlaylists = snapshot.playlists.map { it.toManifestPlaylist() }

        onProgress(SyncProgress("stats", "Sending play history"))
        runCatching { pushStats(peer) }.onFailure { errors.add("stats push: ${it.message}") }

        val localTracks = db.trackDao().getMirrorTracks()
            .map {
                LocalMirrorTrack(
                    id = it.id, trackKey = it.trackKey, contentHash = it.contentHash, filePath = it.filePath,
                    title = it.title, artist = it.artist, album = it.album, duration = it.duration,
                    kind = it.kind.toTrackKind(), discNo = it.discNo, trackNo = it.trackNo,
                    addedAt = it.addedAt,
                )
            }
        val plan = diffTracks(manifestTracks, localTracks)

        var deleted = 0
        for (t in plan.toDelete) {
            runCatching { File(t.filePath).delete() }
            db.trackDao().deleteMirrorTrack(t.id)
            deleted++
        }

        // One download per track key: two workers on the same key would share one `.part` file.
        val toDownload = (plan.toAdd + plan.toRefetch).distinctBy { it.trackKey }
        checkFreeSpace(toDownload)
        // Workers run concurrently (pool), so the counters and the error list must be thread-safe.
        val doneDownloads = AtomicInteger(0)
        val added = AtomicInteger(0)
        val refetched = AtomicInteger(0)
        val downloadErrors = Collections.synchronizedList(mutableListOf<String>())
        val addKeys = plan.toAdd.mapTo(HashSet()) { it.trackKey }
        onProgress(SyncProgress("download", "Downloading", 0, toDownload.size))
        pool(toDownload, limit = 4) { track, _ ->
            try {
                val path = api.downloadFile(syncedDir, peer.url, peer.token, peer.pin, track.trackKey, track.fileName, track.contentHash)
                upsertDownloadedTrack(track, path)
                if (track.trackKey in addKeys) added.incrementAndGet() else refetched.incrementAndGet()
            } catch (e: Exception) {
                downloadErrors.add("${track.title}: ${e.message}")
            }
            onProgress(SyncProgress("download", track.title, doneDownloads.incrementAndGet(), toDownload.size))
        }
        errors.addAll(downloadErrors)

        onProgress(SyncProgress("reconcile", "Updating metadata"))
        for (t in plan.toUpdateMeta) {
            db.trackDao().updateMirrorTrackMeta(t.trackKey, t.title, t.artist, t.album, t.duration, t.kind.toWire(), t.discNo, t.trackNo, t.addedAt)
        }

        applyManifestStats(manifestTracks, snapshot.playEvents)
        applyAlbumCovers(snapshot.albumCovers)
        applyArtistCovers(snapshot.artistCovers)

        onProgress(SyncProgress("playlists", "Updating playlists"))
        val playlistErrors = reconcilePlaylists(manifestPlaylists)
        errors.addAll(playlistErrors)

        onProgress(SyncProgress("artwork", "Fetching album art"))
        fetchAlbumArtBestEffort(manifestTracks, peer)

        val now = System.currentTimeMillis()
        peerStore.setLastSync(now)

        onProgress(SyncProgress("done", "Done"))
        return SyncSummary(
            added = added.get(),
            refetched = refetched.get(),
            deleted = deleted,
            playlists = manifestPlaylists.size,
            errors = errors,
        )
    }

    /**
     * Stops the sync before the first byte when the tracks to download (minus
     * what interrupted `.part` files already hold) can't fit with a safety
     * margin. An unreadable free-space value proceeds; a full disk does not.
     */
    private fun checkFreeSpace(toDownload: List<ManifestTrack>) {
        if (toDownload.isEmpty()) return
        val needed = toDownload.sumOf { (it.size - api.partialBytes(syncedDir, it.trackKey, it.fileName)).coerceAtLeast(0L) }
        val free = api.freeSpaceBytes(syncedDir)
        if (!hasEnoughSpace(needed, free, FREE_SPACE_CUSHION_BYTES)) {
            throw InsufficientSpaceException(needed, free ?: 0L)
        }
    }

    /** Also used by StatsPusher for the lightweight push at podcast settle points. */
    internal suspend fun pushStats(peer: SyncPeer) {
        val deviceId = getDeviceId()
        val settings = db.settingsDao()
        val now = System.currentTimeMillis()
        // Normally only events since the last successful push — see
        // getLocalPlayEventsSince's doc comment. Favorites/play_states stay a
        // full resend: that set is small (one row per favorited/podcast track,
        // not one per play) and a stale row must always be resend-able for the
        // LWW merge to converge even if a push was missed.
        //
        // But a 2xx only means the Mac *received* the events: they sit in its
        // in-memory inbox until the UI drains them, so quitting the app or
        // stopping the server in between loses them for good. So resend the
        // whole log once a day (the Mac dedups events, so this is safe) to
        // heal any such gap.
        val lastPush = settings.get(LAST_STATS_PUSH_KEY)?.toLongOrNull() ?: 0L
        val lastFullPush = settings.get(LAST_STATS_FULL_PUSH_KEY)?.toLongOrNull() ?: 0L
        val fullPush = now - lastFullPush >= FULL_PUSH_INTERVAL_MS
        val events = db.playEventDao().getLocalPlayEventsSince(deviceId, if (fullPush) 0L else lastPush)
        val favorites = db.trackDao().getLocalFavorites()
        val playStates = db.trackDao().getLocalPlayStates()
        // Batched: the Mac rejects request bodies over its default limit (2 MB), which
        // a first push of a long play history would otherwise exceed forever.
        val batches = events.chunked(EVENTS_PER_REQUEST).ifEmpty { listOf(emptyList()) }
        batches.forEachIndexed { i, batch ->
            api.postStats(
                peer.url,
                peer.token,
                peer.pin,
                IncomingStatsDto(
                    deviceId = deviceId,
                    events = batch.map { IncomingEventDto(it.trackKey, it.playedAt) },
                    favorites = if (i > 0) emptyList() else favorites.map {
                        FavoriteUpdateDto(it.trackKey, if (it.favorite) 1 else 0, it.favoriteUpdatedAt ?: 0)
                    },
                    playStates = if (i > 0) emptyList() else playStates.map {
                        PlayStateUpdateDto(it.trackKey, it.playState, it.resumePosition, requireNotNull(it.playStateUpdatedAt))
                    },
                ),
            )
        }
        // Only after every batch succeeded.
        settings.set(SettingEntity(LAST_STATS_PUSH_KEY, now.toString()))
        if (fullPush) settings.set(SettingEntity(LAST_STATS_FULL_PUSH_KEY, now.toString()))
    }

    /** Applies the manifest's per-track favorite/play_state (LWW) and its play_events log (grow-only union). */
    private suspend fun applyManifestStats(manifestTracks: List<ManifestTrack>, macEvents: List<PlayEventDto>) {
        for (t in manifestTracks) {
            if (t.favoriteUpdatedAt != null) {
                db.trackDao().applyFavoriteIfNewer(t.trackKey, t.favorite, t.favoriteUpdatedAt)
            }
            if (t.playStateUpdatedAt != null) {
                db.trackDao().applyPlayStateIfNewer(t.trackKey, t.playState.toWire(), t.resumePosition, t.playStateUpdatedAt)
            }
        }
        if (macEvents.isNotEmpty()) {
            db.playEventDao().insertAll(
                macEvents.map { PlayEventEntity(UUID.randomUUID().toString(), it.trackKey, it.playedAt, it.deviceId) }
            )
        }
    }

    /** LWW merge of the manifest's per-album cover overrides — mirrors db.ts's applyAlbumCovers. */
    private suspend fun applyAlbumCovers(covers: List<AlbumCoverDto>) {
        for (c in covers) {
            db.albumCoverDao().upsertIfNewer(c.artist, c.album, c.imageDataUri, c.updatedAt)
        }
    }

    /** LWW merge of the manifest's per-artist image overrides — mirrors db.ts's applyArtistCovers. */
    private suspend fun applyArtistCovers(covers: List<ArtistCoverDto>) {
        for (c in covers) {
            db.artistCoverDao().upsertIfNewer(c.artist, c.imageDataUri, c.updatedAt)
        }
    }

    private suspend fun upsertDownloadedTrack(track: ManifestTrack, filePath: String) {
        db.trackDao().upsertMirrorTrack(
            id = UUID.randomUUID().toString(),
            title = track.title,
            artist = track.artist,
            album = track.album,
            filePath = filePath,
            fileName = track.fileName,
            duration = track.duration,
            trackKey = track.trackKey,
            contentHash = track.contentHash,
            favorite = track.favorite,
            favoriteUpdatedAt = track.favoriteUpdatedAt,
            kind = track.kind.toWire(),
            discNo = track.discNo,
            trackNo = track.trackNo,
            playState = track.playState.toWire(),
            resumePosition = track.resumePosition,
            playStateUpdatedAt = track.playStateUpdatedAt,
            addedAt = track.addedAt,
        )
    }

    private suspend fun reconcilePlaylists(manifestPlaylists: List<ManifestPlaylist>): List<String> {
        val errors = mutableListOf<String>()

        // Built before the diff: the skip predicate needs the same key -> id
        // resolution the write uses. Only correct because this runs after the
        // track add/refetch/delete pass, so it reflects what actually landed.
        val keyToId = db.trackDao().getAllTrackKeyIdPairsMirrorFirst()
            .fold(LinkedHashMap<String, String>()) { acc, row -> acc.putIfAbsent(row.trackKey, row.id); acc }

        val membership = db.playlistDao().getMirrorPlaylistTrackIds().groupBy({ it.playlistId }, { it.trackId })
        val local = db.playlistDao().getMirrorPlaylists().map {
            LocalMirrorPlaylist(it.id, it.name, it.kind.toTrackKind(), membership[it.id] ?: emptyList())
        }
        val plan = diffPlaylists(manifestPlaylists, local) { keyToId[it] }

        for (p in plan.toDelete) {
            db.playlistDao().clearPlaylistTracks(p.id)
            db.playlistDao().deletePlaylist(p.id)
        }

        for (p in plan.toUpsert) {
            try {
                db.playlistDao().upsertMirrorPlaylist(p.id, p.name, p.kind.toWire(), resolvedTrackIds(p) { keyToId[it] })
            } catch (e: Exception) {
                errors.add("playlist ${p.name}: ${e.message}")
            }
        }
        return errors
    }

    private suspend fun fetchAlbumArtBestEffort(manifestTracks: List<ManifestTrack>, peer: SyncPeer) {
        val pairs = manifestTracks
            .map { (it.artist ?: "") to (it.album ?: "") }
            .distinct()
        pool(pairs, limit = 4) { (artist, album), _ ->
            runCatching { api.fetchAlbumArt(albumArtDir, peer.url, peer.token, peer.pin, artist, album) }
        }
    }

    private suspend fun getDeviceId(): String {
        val dao = db.settingsDao()
        val existing = dao.get("device_id")
        if (existing != null) return existing
        val id = UUID.randomUUID().toString()
        dao.set(SettingEntity("device_id", id))
        return id
    }

    internal companion object {
        const val LAST_STATS_PUSH_KEY = "last_stats_push_at"
        const val LAST_STATS_FULL_PUSH_KEY = "last_stats_full_push_at"
        const val FULL_PUSH_INTERVAL_MS = 24L * 60 * 60 * 1000
        const val EVENTS_PER_REQUEST = 5000
        const val FREE_SPACE_CUSHION_BYTES = 50L * 1024 * 1024
    }
}

/** The tracks to download need more room than the phone has free; nothing was downloaded. */
class InsufficientSpaceException(val neededBytes: Long, val freeBytes: Long) : Exception(
    "Not enough storage to sync: need about ${neededBytes / (1024 * 1024)} MB, " +
        "${freeBytes / (1024 * 1024)} MB free. Free up space and try again."
)
