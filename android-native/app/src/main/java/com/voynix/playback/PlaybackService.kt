package com.voynix.playback

import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.voynix.MainActivity
import com.voynix.R
import com.voynix.artwork.AlbumArtResolver
import com.voynix.data.db.SettingEntity
import com.voynix.data.db.TrackWithStats
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.PlayState
import com.voynix.logic.QueueSnapshot
import com.voynix.logic.alignSnapshotCursor
import com.voynix.logic.decodeQueueSnapshot
import com.voynix.logic.playStateFromDb
import com.voynix.logic.remapSnapshot
import com.voynix.logic.sortNatural
import com.voynix.sync.StatsPusher
import com.voynix.sync.SyncEngine
import com.voynix.sync.SyncPeerStore
import com.voynix.ui.tracks.podcastStatusLabel
import com.voynix.ui.tracks.toText
import com.voynix.widget.pushWidgetState
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

/**
 * Owns the ExoPlayer + MediaSession for the whole app. Runs as a
 * foreground service so playback survives the Activity being destroyed —
 * screen off, task swipe, or Android Auto binding without ever starting
 * MainActivity. [PlayerController]/[QueuePlayer] live here now instead of in
 * MainActivity; the Activity reaches this instance through
 * [LocalBinder] since it's always in-process.
 *
 * The browse tree has 6 top-level folders, matching the phone app's home
 * (HomeScreen.kt): 曲/お気に入り/よく再生 are the static folders resolved by
 * [browseTreeChildren], アーティスト/アルバム are name lists whose leaves route
 * back through the same function, and プレイリスト is resolved straight from
 * [com.voynix.data.db.PlaylistDao] (see onGetChildren). A podcast "show" is
 * just a playlist whose kind is "podcast" — there's no separate subsystem.
 */
class PlaybackService : MediaLibraryService() {

    private lateinit var db: VoynixDatabase
    private lateinit var exoPlayer: ExoPlayer
    private lateinit var albumArt: AlbumArtResolver
    lateinit var playerController: PlayerController
        private set
    private lateinit var mediaSession: MediaLibrarySession
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // Debounces the "car controller disconnected" pause (see CarDisconnect.kt)
    // — Android Auto rebinds its MediaBrowser far more often than the car
    // itself actually goes away, and pausing on every one of those transient
    // unbinds was the "stops every few minutes" bug. Cancelled by onConnect
    // if a car controller reconnects within the window.
    private var carDisconnectPauseJob: Job? = null

    // The retry ladder that re-pushes the Auto custom buttons after a car
    // controller connects (see ButtonRepush.kt). Restarted on every car
    // connect, cancelled when the last car controller goes away.
    private var autoButtonRepushJob: Job? = null

    // onCreate's session-restore launch, awaited by onConnect's car-resume
    // path (see below) so "is the queue empty" isn't checked before the
    // restore has actually landed.
    private var restoreJob: Job? = null

    inner class LocalBinder : android.os.Binder() {
        val service: PlaybackService get() = this@PlaybackService
    }

    private val binder = LocalBinder()

    override fun onCreate() {
        super.onCreate()
        playbackLog("onCreate pid=${Process.myPid()}")
        db = VoynixDatabase.get(this)
        // AudioAttributes + handleAudioFocus=true make ExoPlayer request/react
        // to audio focus (ducking or pausing for nav prompts and calls, which
        // was previously just missing) and setHandleAudioBecomingNoisy makes
        // it pause on ACTION_AUDIO_BECOMING_NOISY — Bluetooth/car audio output
        // disappearing (e.g. the engine being turned off) or headphones being
        // unplugged. Without these, a bare ExoPlayer just keeps playing on
        // whatever output is left (the phone speaker) once the car drops.
        exoPlayer = ExoPlayer.Builder(this)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build()
        exoPlayer.addListener(DiagnosticPlayerListener())
        albumArt = AlbumArtResolver(this, db)
        playerController = PlayerController(exoPlayer, db, serviceScope, albumArt)
        // Push podcast position to the paired Mac right after each settle point
        // (pause / ended). Off the main thread; never from onDestroy.
        val syncEngine = SyncEngine(this, db)
        val peerStore = SyncPeerStore(db)
        val statsPusher = StatsPusher(peerProvider = { peerStore.get() }, push = { syncEngine.pushStats(it) })
        playerController.onPodcastSettled = { withContext(Dispatchers.IO) { statsPusher.pushIfDue() } }

        val sessionActivity = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )

        mediaSession = MediaLibrarySession.Builder(this, QueuePlayer(exoPlayer, playerController), LibrarySessionCallback())
            .setSessionActivity(sessionActivity)
            .build()
        // Registers the session with this service's own MediaNotificationManager
        // — without this, playback and the OS-level MediaSession both work, but
        // the standard media notification (and with it, foreground-service
        // promotion) is never posted.
        addSession(mediaSession)
        // If a car-caused pause ever leaves the foreground service down by
        // the time resumeIfCarJustCameBack calls play() (see CarResume.kt's
        // foregroundTimeoutFor doc), this is the exception that fires instead
        // of the notification just reappearing — log it so a real-drive
        // logcat can tell "resume was blocked here" apart from "the resume
        // check itself never ran".
        setListener(object : MediaSessionService.Listener {
            override fun onForegroundServiceStartNotAllowedException() {
                playbackLog("onForegroundServiceStartNotAllowedException")
            }
        })

        // Keeps the Android Auto playback screen's shuffle/repeat buttons in
        // sync with actual state (pressed-toggle feedback) for any already
        // connected controller — Auto doesn't derive these from player
        // commands on its own (confirmed: a plain COMMAND_SET_SHUFFLE_MODE/
        // REPEAT_MODE advertisement alone never rendered anything), so this
        // pushes real CommandButtons instead. See AutoButtons.kt.
        serviceScope.launch {
            playerController.uiState
                .map { s -> autoButtons(s.currentTrack?.kind == "podcast", s.shuffle, s.repeat) }
                .distinctUntilChanged()
                .collect { buttons -> pushAutoButtons(buttons.map(::toCommandButton)) }
        }

        // The restored track decides podcast-vs-music buttons, and the
        // collector's distinctUntilChanged won't re-emit when the restore
        // happens to produce the same list as before — so push once
        // unconditionally when the restore lands.
        restoreJob = serviceScope.launch {
            restoreLastPlayback()
            pushAutoButtons()
        }

        // Keeps the home-screen widget's track/artwork and play/pause icon in
        // sync with actual playback — keyed on track id + isPlaying (not
        // positionSecs) so this doesn't redraw the widget every second.
        serviceScope.launch {
            playerController.uiState
                .map { it.currentTrack?.id to it.isPlaying }
                .distinctUntilChanged()
                .collect { (trackId, isPlaying) -> pushWidgetState(this@PlaybackService, trackId, isPlaying) }
        }
    }

    /** Records that playback just stopped because the car went away (see onConnect's resume). */
    private fun markCarPaused() {
        serviceScope.launch { db.settingsDao().set(SettingEntity(CAR_PAUSED_AT_KEY, System.currentTimeMillis().toString())) }
    }

    /** The full (unpaged) track list for a browse folder id, or null if [parentId] isn't one we recognize. */
    private suspend fun resolveFolderTracks(parentId: String): List<TrackWithStats>? {
        playlistIdOfFolder(parentId)?.let { playlistId ->
            return db.playlistDao().observePlaylistTracks(playlistId).first()
        }
        return browseTreeChildren(parentId, allTracksSorted(), page = 0, pageSize = Int.MAX_VALUE)
    }

    /** A persisted queue resolved against the current library: tracks in queue order + the remapped order/cursor. */
    private class SavedQueue(val tracks: List<TrackWithStats>, val snapshot: QueueSnapshot) {
        /** Queue index of the track under the cursor. */
        val currentIndex: Int get() = snapshot.order[snapshot.pos]
    }

    /** Null when nothing was saved (e.g. right after an app update), it's corrupt, or every track is gone. */
    private suspend fun loadSavedQueue(): SavedQueue? {
        val saved = decodeQueueSnapshot(db.settingsDao().get(LAST_QUEUE_KEY)) ?: return null
        val byId = allTracksSorted().associateBy { it.track.id }
        val remapped = remapSnapshot(saved, byId.keys)
            ?.let { alignSnapshotCursor(it, db.settingsDao().get("last_track_id")) }
            ?: return null
        return SavedQueue(remapped.ids.map { byId.getValue(it) }, remapped)
    }

    private suspend fun restoreLastPlayback() {
        // Must land before setQueueAndPlay/buildOrder below run, or the
        // restored queue is built with shuffle still at its default (false).
        playerController.awaitSettings()
        val lastTrackId = db.settingsDao().get("last_track_id") ?: return
        val lastPosition = db.settingsDao().get("last_position")?.toDoubleOrNull() ?: 0.0
        val lastBrowseParentId = db.settingsDao().get(LAST_BROWSE_PARENT_KEY)

        // Prefer the exact queue (playlist/search/shuffle pass) that was playing.
        loadSavedQueue()?.let { saved ->
            val current = saved.tracks[saved.currentIndex].track
            playerController.restoreSnapshot(
                saved.tracks.map { it.track },
                saved.snapshot,
                // The saved position belongs to lastTrackId; if that track was
                // removed the cursor moved on to a different one.
                if (current.id == lastTrackId) lastPosition else 0.0,
                lastBrowseParentId,
            )
            return
        }

        // Restore into the same playlist/folder the queue was last playing
        // from, not the whole library — falls back to "all songs" if that
        // folder is gone, or doesn't actually contain the last-played track
        // (e.g. it was removed from the playlist since).
        val folderTracks = lastBrowseParentId?.let { resolveFolderTracks(it) }
            ?.takeIf { tracks -> tracks.any { it.track.id == lastTrackId } }
        val (tracks, browseParentId) = if (folderTracks != null) {
            folderTracks to lastBrowseParentId
        } else {
            allTracksSorted() to null
        }
        if (tracks.isEmpty()) return
        playerController.restoreQueueAt(tracks.map { it.track }, lastTrackId, lastPosition, browseParentId)
    }

    /**
     * The counterpart to onDisconnected's "car went away" pause: if playback
     * was stopped because the car disconnected (markCarPaused, within
     * [CAR_RESUME_WINDOW_MS]) and this same kind of controller just
     * reconnected, resume automatically — "エンジンを入れたら続きが鳴り出す".
     * Does nothing for a user-initiated pause (no marker was
     * ever written) or a stale one (car left running/off for a long time).
     */
    private fun resumeIfCarJustCameBack(connectedPackage: String) {
        serviceScope.launch {
            restoreJob?.join()
            val pausedAt = db.settingsDao().get(CAR_PAUSED_AT_KEY)?.toLongOrNull()
            if (!shouldResumeOnCarConnect(connectedPackage, pausedAt, System.currentTimeMillis())) {
                playbackLog("car reconnected: not resuming (pausedAt=$pausedAt)")
                return@launch
            }
            db.settingsDao().delete(CAR_PAUSED_AT_KEY) // one-shot: don't re-fire on the next browse rebind
            if (exoPlayer.mediaItemCount == 0) restoreLastPlayback() // process was killed while the car was away
            delay(CAR_RESUME_DELAY_MS) // let the car's audio route finish establishing first
            playbackLog("car reconnected: resuming")
            playerController.play()
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession = mediaSession

    override fun onBind(intent: Intent?): android.os.IBinder? {
        // MainActivity's in-process bind (LocalBinder) vs. the session
        // framework's own bind (super, used by MediaController/Auto/Bluetooth).
        return if (intent?.action == ACTION_LOCAL_BIND) binder else super.onBind(intent)
    }

    // The app was swiped away from recents: keep running if something is
    // still playing (background/Bluetooth/Auto playback must survive that),
    // otherwise let the service — and its notification — go away.
    override fun onTaskRemoved(rootIntent: Intent?) {
        playbackLog("onTaskRemoved isPlaying=${exoPlayer.isPlaying}")
        if (!exoPlayer.isPlaying) {
            stopSelf()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        playbackLog("onDestroy pid=${Process.myPid()}")
        carDisconnectPauseJob?.cancel()
        autoButtonRepushJob?.cancel()
        // Await the final podcast position write: it used to be launched on
        // serviceScope and then cancelled by the serviceScope.cancel() below.
        // Single Room UPDATE, so blocking teardown for it is fine.
        runBlocking {
            playerController.stop()
            pushWidgetState(this@PlaybackService, playerController.uiState.value.currentTrack?.id, isPlaying = false)
        }
        removeSession(mediaSession)
        mediaSession.release()
        exoPlayer.release()
        serviceScope.cancel()
        super.onDestroy()
    }

    /**
     * Logs every path that can flip playWhenReady/isPlaying so a single drive
     * can tell apart a car-controller disconnect (see LibrarySessionCallback),
     * an audio-focus loss/suppression from the head unit, and a player error
     * (the "Podcast の再生が5分おきに停止する" report).
     */
    private inner class DiagnosticPlayerListener : Player.Listener {
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            playbackLog("playWhenReady=$playWhenReady reason=${playWhenReadyChangeReasonName(reason)}")
            // ACTION_AUDIO_BECOMING_NOISY (Bluetooth/car audio route
            // disappearing, e.g. the engine turning off) doesn't go through
            // LibrarySessionCallback.onDisconnected at all — ExoPlayer's own
            // setHandleAudioBecomingNoisy(true) pauses it directly. Mark it
            // the same way so a Bluetooth-only car (no Android Auto
            // projection) still gets the onConnect resume below.
            if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY) {
                markCarPaused()
            }
        }

        override fun onPlaybackSuppressionReasonChanged(playbackSuppressionReason: Int) {
            playbackLog("suppression=${playbackSuppressionReasonName(playbackSuppressionReason)}")
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            playbackLog("isPlaying=$isPlaying")
            // Undo onConnect's extended foreground-service timeout once
            // there's no car controller left to resume for — otherwise a
            // phone-only listen started after a drive would keep the
            // 12-hour timeout from that drive's connection around.
            if (isPlaying && mediaSession.connectedControllers.none { isCarController(it.packageName) }) {
                setForegroundServiceTimeoutMs(MediaSessionService.DEFAULT_FOREGROUND_SERVICE_TIMEOUT_MS)
            }
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            playbackLog("playbackState=${playbackStateName(playbackState)}")
        }

        override fun onPlayerError(error: PlaybackException) {
            playbackLog("playerError=${error.errorCodeName} ${error.message}")
        }
    }

    private inner class LibrarySessionCallback : MediaLibraryService.MediaLibrarySession.Callback {

        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult {
            if (isCarController(controller.packageName)) {
                playbackLog("onConnect pkg=${controller.packageName}")
                // While a car controller is connected, a pause (engine off)
                // must not let media3 drop the foreground service before the
                // engine comes back on — see foregroundTimeoutFor's doc
                // (CarResume.kt) for why the 10-minute platform default
                // silently broke a resume after a longer stop.
                // connectedControllers doesn't include this controller yet
                // (it's only added once onConnect returns an accepted
                // result), so add its package explicitly.
                setForegroundServiceTimeoutMs(
                    foregroundTimeoutFor(
                        mediaSession.connectedControllers.map { it.packageName } + controller.packageName
                    )
                )
                // A car controller reconnected (e.g. the browse rebind that
                // caused the disconnect in the first place) — cancel any
                // pending "car went away" pause from onDisconnected below.
                carDisconnectPauseJob?.cancel()
                carDisconnectPauseJob = null
                // The buttons may have been pushed before media3's own
                // notification controller connected (which the legacy Auto
                // bridge silently drops) — retry on a schedule. See ButtonRepush.kt.
                startAutoButtonRepush()
                resumeIfCarJustCameBack(controller.packageName)
            }
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
                .setAvailableSessionCommands(
                    MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
                        .add(SessionCommand(CMD_TOGGLE_SHUFFLE, android.os.Bundle.EMPTY))
                        .add(SessionCommand(CMD_CYCLE_REPEAT, android.os.Bundle.EMPTY))
                        .add(SessionCommand(CMD_SKIP_BACK_10, android.os.Bundle.EMPTY))
                        .add(SessionCommand(CMD_SKIP_FORWARD_10, android.os.Bundle.EMPTY))
                        .build()
                )
                // Installed together with the commands above when media3's
                // notification controller connects, so there is no window in
                // which a pushed button is filtered out as "unavailable".
                .setMediaButtonPreferences(currentAutoCommandButtons())
                .build()
        }

        // The shuffle/repeat/±10s playback-screen buttons (AutoButtons.kt) —
        // Android Auto has no built-in shuffle/repeat/podcast-skip action on
        // its own playback screen (confirmed: standard Player commands alone
        // never render anything), so these route through a session command
        // instead of a player command.
        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: android.os.Bundle,
        ): ListenableFuture<SessionResult> {
            when (customCommand.customAction) {
                CMD_TOGGLE_SHUFFLE -> playerController.toggleShuffle()
                CMD_CYCLE_REPEAT -> playerController.cycleRepeat()
                CMD_SKIP_BACK_10 -> playerController.skipBy(-PODCAST_SKIP_SECS)
                CMD_SKIP_FORWARD_10 -> playerController.skipBy(PODCAST_SKIP_SECS)
                else -> return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
            }
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }

        // A USB Android Auto connection dropping (engine off) doesn't
        // guarantee an ACTION_AUDIO_BECOMING_NOISY broadcast, so on top of
        // setHandleAudioBecomingNoisy above we also stop when the car's own
        // controller disconnects from the session. But Android Auto also
        // unbinds/rebinds its MediaBrowser controller on its own (browse-tree
        // refreshes, head-unit app switches) far more often than the car
        // actually disconnects — pausing on every one of those was the
        // "stops every few minutes" bug. shouldPauseOnCarDisconnect only
        // fires when no car controller is left connected at all, and even
        // then a short debounce gives a same-session reconnect (handled by
        // onConnect above) a chance to cancel it before playback actually stops.
        override fun onDisconnected(session: MediaSession, controller: MediaSession.ControllerInfo) {
            val remaining = mediaSession.connectedControllers.map { it.packageName }
            if (!shouldPauseOnCarDisconnect(controller.packageName, remaining)) return
            playbackLog("car controller disconnected pkg=${controller.packageName}, debouncing pause")
            autoButtonRepushJob?.cancel()
            autoButtonRepushJob = null
            carDisconnectPauseJob?.cancel()
            carDisconnectPauseJob = serviceScope.launch {
                delay(CAR_DISCONNECT_PAUSE_DEBOUNCE_MS)
                if (exoPlayer.isPlaying) {
                    playbackLog("pause: car controller still gone after debounce")
                    exoPlayer.pause()
                    markCarPaused()
                }
            }
        }

        override fun onGetLibraryRoot(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            params: LibraryParams?,
        ): ListenableFuture<LibraryResult<MediaItem>> {
            val root = browsableFolder(ROOT_ID, getString(R.string.app_name))
            val rootParams = LibraryParams.Builder().setExtras(rootContentStyleExtras()).build()
            return Futures.immediateFuture(LibraryResult.ofItem(root, rootParams))
        }

        override fun onGetChildren(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            parentId: String,
            page: Int,
            pageSize: Int,
            params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
            serviceScope.launch {
                val items: List<MediaItem> = when {
                    // Android Auto's media template only ever renders the
                    // first 4 browsable root items as tabs — a 5th+ gets
                    // folded into an app-generated "その他" tab (confirmed on
                    // DHU 2.1). 3 tabs here, well under
                    // that limit. ホーム is a grid of every playlist (music and
                    // podcast alike — a podcast "show" is just a playlist whose
                    // kind is "podcast", so there's no separate Podcasts tab);
                    // ライブラリ groups 曲/アーティスト/アルバム/お気に入り/よく再生
                    // one level deeper, and プレイリスト is the same playlists
                    // as a list instead of a grid.
                    parentId == ROOT_ID -> listOf(
                        browsableFolder(
                            HOME_ID, getString(R.string.auto_home),
                            iconRes = R.drawable.ic_auto_home,
                            extras = contentStyleExtras(GRID_ITEM, GRID_ITEM),
                        ),
                        browsableFolder(
                            LIBRARY_ID, getString(R.string.auto_library),
                            iconRes = R.drawable.ic_auto_library,
                            extras = contentStyleExtras(LIST_ITEM, LIST_ITEM),
                        ),
                        browsableFolder(
                            PLAYLISTS_ID, getString(R.string.auto_playlists),
                            iconRes = R.drawable.ic_auto_playlist,
                            extras = contentStyleExtras(LIST_ITEM, LIST_ITEM),
                        ),
                    )
                    parentId == HOME_ID -> {
                        // Paged like everything else (see pageSlice's doc) —
                        // each tile also carries a decoded Bitmap over the
                        // Binder (see tileArtworkData), so a large playlist
                        // count needs this even more than a plain text list.
                        val playlists = pageSlice(db.playlistDao().observeAll().first(), page, pageSize)
                        playlists.map { playlist ->
                            val tracks = db.playlistDao().observePlaylistTracks(playlist.id).first()
                            browsableFolder(
                                playlistFolderId(playlist.id), playlist.name,
                                subtitle = playlistSubtitle(playlist.kind, tracks),
                                artworkData = tileArtworkData(tracks, params),
                            )
                        }
                    }
                    parentId == LIBRARY_ID -> listOf(
                        browsableFolder(ALL_SONGS_ID, getString(R.string.auto_songs)),
                        browsableFolder(ARTISTS_ID, getString(R.string.auto_artists)),
                        browsableFolder(ALBUMS_ID, getString(R.string.auto_albums)),
                        browsableFolder(FAVORITES_ID, getString(R.string.auto_favorites)),
                        browsableFolder(MOST_PLAYED_ID, getString(R.string.auto_most_played)),
                        browsableFolder(RECENTLY_ADDED_ID, getString(R.string.auto_recently_added)),
                        browsableFolder(RECENTLY_PLAYED_ID, getString(R.string.auto_recently_played)),
                    )
                    parentId == ARTISTS_ID -> nameFolders(
                        artistNames(allTracksSorted()), emptyList(), page, pageSize, ::artistFolderId, ::artistIndexFolderId,
                    )
                    parentId == ALBUMS_ID -> nameFolders(
                        albumNames(allTracksSorted()), emptyList(), page, pageSize, ::albumFolderId, ::albumIndexFolderId,
                    )
                    artistIndexPathOfFolder(parentId) != null -> nameFolders(
                        artistNames(allTracksSorted()), artistIndexPathOfFolder(parentId)!!, page, pageSize,
                        ::artistFolderId, ::artistIndexFolderId,
                    )
                    albumIndexPathOfFolder(parentId) != null -> nameFolders(
                        albumNames(allTracksSorted()), albumIndexPathOfFolder(parentId)!!, page, pageSize,
                        ::albumFolderId, ::albumIndexFolderId,
                    )
                    parentId == PLAYLISTS_ID -> {
                        val playlists = db.playlistDao().observeAll().first()
                        pageSlice(playlists, page, pageSize).map { playlist ->
                            // Only a podcast playlist needs its tracks fetched
                            // here (for the "未再生 N / 全 M" subtitle) — a
                            // music playlist gets none, so this doesn't add a
                            // query per row for the common case.
                            val subtitle = if (playlist.kind == "podcast") {
                                playlistSubtitle(playlist.kind, db.playlistDao().observePlaylistTracks(playlist.id).first())
                            } else null
                            browsableFolder(playlistFolderId(playlist.id), playlist.name, subtitle = subtitle)
                        }
                    }
                    playlistIdOfFolder(parentId) != null -> {
                        val tracks = db.playlistDao().observePlaylistTracks(playlistIdOfFolder(parentId)!!).first()
                        pageSlice(tracks, page, pageSize).map { playableItem(parentId, it) }
                    }
                    else -> {
                        // page/pageSize-sliced by browseTreeChildren — a library
                        // with thousands of tracks must never cross the Binder in
                        // one transaction (see BrowseTree.kt). Also handles
                        // artist/album leaf folders (their tracks, not names).
                        val children = browseTreeChildren(parentId, allTracksSorted(), page, pageSize)
                        children?.map { playableItem(parentId, it) } ?: emptyList()
                    }
                }
                future.set(LibraryResult.ofItemList(ImmutableList.copyOf(items), params))
            }
            return future
        }

        override fun onGetItem(
            session: MediaLibrarySession,
            browser: MediaSession.ControllerInfo,
            mediaId: String,
        ): ListenableFuture<LibraryResult<MediaItem>> {
            val future = SettableFuture.create<LibraryResult<MediaItem>>()
            serviceScope.launch {
                val trackId = trackIdOfLeaf(mediaId)
                val track = db.trackDao().getById(trackId)
                if (track == null) {
                    future.set(LibraryResult.ofError(SessionResult.RESULT_ERROR_BAD_VALUE))
                } else {
                    future.set(LibraryResult.ofItem(playableItem(parentIdOfLeaf(mediaId), TrackWithStats(track, 0)), null))
                }
            }
            return future
        }

        // Resolves a car/notification/lock-screen "play this media id" request
        // (Player.setMediaItem[s] on any MediaController) into our own queue —
        // PlayerController.setQueueAndPlay drives the actual ExoPlayer instance
        // that QueuePlayer wraps, so this doesn't also let the framework's
        // default add-items pipeline push a second item. It still must return
        // the resolved MediaItem(s) rather than an empty list: per the media3
        // contract, an empty result means "nothing was added", which left a
        // controller like Android Auto believing the tap produced no item.
        //
        // The mediaId is folder-tagged (see BrowseTree.kt's leafMediaId) when
        // it was reached by browsing — that folder's own tracks become the
        // queue, not the whole library, so "next" advances within the tapped
        // playlist/folder instead of jumping into "all songs". An untagged
        // mediaId (e.g. a voice-assistant request with no browse context)
        // falls back to the previous whole-library behavior.
        override fun onAddMediaItems(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<List<MediaItem>> {
            val future = SettableFuture.create<List<MediaItem>>()
            val requestedMediaId = mediaItems.firstOrNull()?.mediaId
            val requestedTrackId = requestedMediaId?.let(::trackIdOfLeaf)
            val parentId = requestedMediaId?.let(::parentIdOfLeaf)
            serviceScope.launch {
                // A tap reaching this straight after process restart (e.g. the
                // car re-browsing before restoreLastPlayback's own await below
                // resolves) must not stomp the just-loaded shuffle/repeat back
                // to their defaults.
                playerController.awaitSettings()
                val folderTracks = parentId?.let { resolveFolderTracks(it) }
                val queueTracks = folderTracks ?: allTracksSorted()
                val startIndex = queueTracks.indexOfFirst { it.track.id == requestedTrackId }.coerceAtLeast(0)
                if (queueTracks.isNotEmpty()) {
                    playerController.setQueueAndPlay(
                        queueTracks.map { it.track },
                        startIndex,
                        browseParentId = folderTracks?.let { parentId },
                    )
                }
                val resolved = mediaItems.mapNotNull { item ->
                    val id = trackIdOfLeaf(item.mediaId)
                    queueTracks.firstOrNull { it.track.id == id }?.let { playableItem(parentId, it) }
                }
                future.set(resolved)
            }
            return future
        }

        // Lets the system (Android 13+'s resume-playback affordances, and the
        // car requesting "resume last session" after the service/process was
        // recreated) rebuild the queue without MainActivity ever having run —
        // previously unimplemented, so those entry points had nothing to resume.
        // Mirrors restoreLastPlayback()'s own last_track_id/last_position read.
        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            isForPlayback: Boolean,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val future = SettableFuture.create<MediaSession.MediaItemsWithStartPosition>()
            serviceScope.launch {
                val lastTrackId = db.settingsDao().get("last_track_id")
                val lastPosition = db.settingsDao().get("last_position")?.toDoubleOrNull() ?: 0.0
                val saved = loadSavedQueue()
                val tracks = saved?.tracks ?: allTracksSorted()
                if (tracks.isEmpty()) {
                    future.setException(UnsupportedOperationException("Voynix: no tracks to resume"))
                } else {
                    val startIndex = saved?.currentIndex
                        ?: tracks.indexOfFirst { it.track.id == lastTrackId }.coerceAtLeast(0)
                    val startSecs = if (saved == null || tracks[startIndex].track.id == lastTrackId) lastPosition else 0.0
                    // The items below are applied straight to ExoPlayer by
                    // the framework (see PlayerController.adoptResumedQueue's
                    // doc) without ever going through setQueueAndPlay/
                    // playOrderPos, so uiState.currentTrack — and the
                    // home-screen widget reading it — would otherwise stay
                    // stale despite playback genuinely resuming.
                    playerController.adoptResumedQueue(tracks.map { it.track }, startIndex, startSecs, saved?.snapshot)
                    future.set(
                        MediaSession.MediaItemsWithStartPosition(
                            tracks.map { playableItem(null, it) },
                            startIndex,
                            (startSecs * 1000).toLong(),
                        )
                    )
                }
            }
            return future
        }
    }

    // Sorted once here (NATURAL_ORDER — same as the phone UI's "All Songs",
    // see logic/TrackSort.kt) rather than in each browse-tree caller, and off
    // the main thread: Auto pages through onGetChildren repeatedly, and this
    // re-reads + re-sorts the whole library every time it's called.
    private suspend fun allTracksSorted(): List<TrackWithStats> {
        val all = db.trackDao().observeAllWithStats().first()
        return withContext(Dispatchers.Default) { sortNatural(all) }
    }

    /**
     * [iconRes] supplies a root-tab icon via an android.resource:// URI (the
     * same scheme VLC Android's MediaSessionBrowser uses) — media3's legacy
     * bridge maps MediaMetadata.artworkUri straight onto
     * MediaDescriptionCompat.setIconUri, which is what Android Auto reads for
     * tab icons. [artworkData] is a real bitmap (JPEG bytes) for a grid tile
     * instead; the two are mutually exclusive in practice (tabs get an icon,
     * home tiles get artwork). [extras] carries CONTENT_STYLE_* hints that
     * tell Auto how to lay out *this folder's children* (grid vs. list).
     */
    // Artist/album names as folders, split into range folders when the list is
    // longer than Android Auto will show (see BROWSE_LIST_LIMIT in BrowseTree.kt).
    private fun nameFolders(
        names: List<String>,
        path: List<Int>,
        page: Int,
        pageSize: Int,
        leafFolderId: (String) -> String,
        indexFolderId: (List<Int>) -> String,
    ): List<MediaItem> {
        if (names.size <= BROWSE_LIST_LIMIT) {
            return pageSlice(names, page, pageSize).map { browsableFolder(leafFolderId(it), it) }
        }
        // First path element picks the initial-letter bucket; the rest are range chunks inside it.
        val buckets = letterBuckets(names)
        if (path.isEmpty()) {
            return pageSlice(buckets, page, pageSize).mapIndexed { i, (title, group) ->
                browsableFolder(indexFolderId(listOf(i)), title, subtitle = group.size.toString())
            }
        }
        val slice = rangeSlice(buckets.getOrNull(path[0])?.second ?: return emptyList(), path.drop(1))
            ?: return emptyList()
        val ranges = rangeFolders(slice)
        if (ranges.isEmpty()) {
            return pageSlice(slice, page, pageSize).map { browsableFolder(leafFolderId(it), it) }
        }
        return pageSlice(ranges, page, pageSize).map { (i, group) ->
            browsableFolder(indexFolderId(path + i), rangeTitle(group), subtitle = group.size.toString())
        }
    }

    private fun browsableFolder(
        id: String,
        title: String,
        subtitle: String? = null,
        iconRes: Int? = null,
        extras: Bundle? = null,
        artworkData: ByteArray? = null,
    ): MediaItem =
        MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    // media3 ignores `subtitle` unless displayTitle is set (it
                    // otherwise derives the legacy subtitle from artist/album).
                    .setDisplayTitle(title)
                    .setSubtitle(subtitle)
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
                    .apply {
                        if (iconRes != null) {
                            setArtworkUri(Uri.parse("android.resource://$packageName/$iconRes"))
                        }
                        if (artworkData != null) {
                            setArtworkData(artworkData, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                        }
                        if (extras != null) setExtras(extras)
                    }
                    .build()
            )
            .build()

    /**
     * A playlist folder's subtitle in Auto: track count for music, or
     * unplayed/total for a podcast show — the Auto counterpart of the
     * podcast icon HomeScreen.kt shows on the phone (there's no icon slot
     * free here; the home grid tile already uses artworkData).
     */
    private fun playlistSubtitle(kind: String, tracks: List<TrackWithStats>): String {
        if (kind != "podcast") return getString(R.string.auto_track_count, tracks.size)
        val unplayed = tracks.count { playStateFromDb(it.track.playState) != PlayState.PLAYED }
        return getString(R.string.auto_podcast_subtitle, unplayed, tracks.size)
    }

    /**
     * Cover art for a home-grid tile, taken from its first track (a
     * playlist's own track order) via the same [AlbumArtResolver] the
     * now-playing session uses — override → embedded → Mac's synced cache.
     * Scaled down to [params]'s EXTRAS_KEY_MEDIA_ART_SIZE_PIXELS hint (or
     * [DEFAULT_TILE_ART_SIZE]) since this rides the Binder as a decoded
     * Bitmap, not a content:// URI.
     */
    private suspend fun tileArtworkData(tracks: List<TrackWithStats>, params: LibraryParams?): ByteArray? {
        val track = tracks.firstOrNull()?.track ?: return null
        val bitmap = albumArt.resolve(track.artist, track.album, track.filePath) ?: return null
        val targetSize = params?.extras
            ?.getInt(MediaConstants.EXTRAS_KEY_MEDIA_ART_SIZE_PIXELS, DEFAULT_TILE_ART_SIZE)
            ?.takeIf { it > 0 }
            ?: DEFAULT_TILE_ART_SIZE
        val scaled = if (bitmap.width > targetSize || bitmap.height > targetSize) {
            Bitmap.createScaledBitmap(bitmap, targetSize, targetSize, true)
        } else {
            bitmap
        }
        return ByteArrayOutputStream().use { out ->
            scaled.compress(Bitmap.CompressFormat.JPEG, 90, out)
            out.toByteArray()
        }
    }

    /**
     * [parentId] is the browse folder this item is listed under, or null when
     * playing outside a browse (e.g. onGetItem). Carries a real URI: media3's
     * default onSetMediaItems can apply the MediaItems onAddMediaItems
     * resolves straight onto the (Forwarding)Player, so a browse item without
     * one risks the framework handing ExoPlayer a source-less item even
     * though PlayerController.setQueueAndPlay already built the real one.
     */
    private fun playableItem(parentId: String?, item: TrackWithStats): MediaItem {
        val track = item.track
        val isPodcast = track.kind == "podcast"
        return MediaItem.Builder()
            .setMediaId(parentId?.let { leafMediaId(it, track.id) } ?: track.id)
            .setUri(trackUri(track.filePath))
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(track.title)
                    .setArtist(track.artist)
                    .setAlbumTitle(track.album)
                    .setIsBrowsable(false)
                    .setIsPlayable(true)
                    .setMediaType(
                        if (isPodcast) MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE
                        else MediaMetadata.MEDIA_TYPE_MUSIC
                    )
                    .apply {
                        // Auto's "played" checkmark / progress ring, plus a
                        // text fallback (via subtitle) for head units that
                        // don't render the completion-status extras. Music
                        // rows get neither — see PodcastStatus.kt for the
                        // phone-UI equivalent this mirrors.
                        if (isPodcast) {
                            // displayTitle is required for media3 to pass
                            // `subtitle` through to Auto's MediaDescription.
                            setDisplayTitle(track.title)
                            setSubtitle(podcastStatusLabel(track)?.toText(this@PlaybackService))
                            completionExtras(track.kind, track.playState, track.resumePosition, track.duration)
                                ?.let(::setExtras)
                        }
                    }
                    .build()
            )
            .build()
    }

    private fun currentAutoCommandButtons(): List<CommandButton> {
        val s = playerController.uiState.value
        return autoButtons(s.currentTrack?.kind == "podcast", s.shuffle, s.repeat).map(::toCommandButton)
    }

    /**
     * Session-wide push only: the per-controller overloads are a no-op for
     * Android Auto (its legacy callbacks don't implement them — see
     * ButtonRepush.kt), while these republish the PlaybackStateCompat custom
     * actions Auto renders.
     */
    private fun pushAutoButtons(buttons: List<CommandButton> = currentAutoCommandButtons()) {
        mediaSession.setMediaButtonPreferences(buttons)
        mediaSession.setCustomLayout(buttons)
        playbackLog("auto buttons pushed n=${buttons.size}")
    }

    private fun startAutoButtonRepush() {
        autoButtonRepushJob?.cancel()
        autoButtonRepushJob = serviceScope.launch {
            for (step in repushStepsMs()) {
                delay(step)
                pushAutoButtons()
            }
        }
    }

    /**
     * Converts one [AutoButton] (AutoButtons.kt's pure, testable enum) into
     * the real media3 [CommandButton] the Auto playback screen renders.
     *
     * Sets both the semantic [icon] (what a modern mediaButtonPreferences
     * client renders itself) and a real [iconResId] drawable — confirmed
     * against a real DHU session that the icon-less legacy customLayout
     * bridge silently drops a button that has no iconResId, since the
     * platform's legacy CustomAction needs an actual drawable to bundle
     * across processes.
     */
    private fun toCommandButton(button: AutoButton): CommandButton = when (button) {
        AutoButton.SHUFFLE_ON -> CommandButton.Builder(CommandButton.ICON_SHUFFLE_ON)
            .setCustomIconResId(R.drawable.ic_auto_shuffle_on)
            .setSessionCommand(SessionCommand(CMD_TOGGLE_SHUFFLE, android.os.Bundle.EMPTY))
            .setDisplayName(getString(R.string.auto_shuffle))
            .setSlots(CommandButton.SLOT_BACK_SECONDARY)
            .build()
        AutoButton.SHUFFLE_OFF -> CommandButton.Builder(CommandButton.ICON_SHUFFLE_OFF)
            .setCustomIconResId(R.drawable.ic_auto_shuffle_off)
            .setSessionCommand(SessionCommand(CMD_TOGGLE_SHUFFLE, android.os.Bundle.EMPTY))
            .setDisplayName(getString(R.string.auto_shuffle))
            .setSlots(CommandButton.SLOT_BACK_SECONDARY)
            .build()
        AutoButton.REPEAT_OFF -> CommandButton.Builder(CommandButton.ICON_REPEAT_OFF)
            .setCustomIconResId(R.drawable.ic_auto_repeat_off)
            .setSessionCommand(SessionCommand(CMD_CYCLE_REPEAT, android.os.Bundle.EMPTY))
            .setDisplayName(getString(R.string.auto_repeat))
            .setSlots(CommandButton.SLOT_FORWARD_SECONDARY)
            .build()
        AutoButton.REPEAT_ALL -> CommandButton.Builder(CommandButton.ICON_REPEAT_ALL)
            .setCustomIconResId(R.drawable.ic_auto_repeat_all)
            .setSessionCommand(SessionCommand(CMD_CYCLE_REPEAT, android.os.Bundle.EMPTY))
            .setDisplayName(getString(R.string.auto_repeat))
            .setSlots(CommandButton.SLOT_FORWARD_SECONDARY)
            .build()
        AutoButton.REPEAT_ONE -> CommandButton.Builder(CommandButton.ICON_REPEAT_ONE)
            .setCustomIconResId(R.drawable.ic_auto_repeat_one)
            .setSessionCommand(SessionCommand(CMD_CYCLE_REPEAT, android.os.Bundle.EMPTY))
            .setDisplayName(getString(R.string.auto_repeat))
            .setSlots(CommandButton.SLOT_FORWARD_SECONDARY)
            .build()
        // ICON_UNDEFINED (not ICON_SKIP_BACK_10/FORWARD_10) is deliberate —
        // confirmed on a real DHU session that this Auto host's semantic-icon
        // table maps ICON_SKIP_BACK_10/FORWARD_10 to a phone/call glyph
        // (probably added to media3 after this Auto build shipped), while
        // shuffle/repeat's semantic icons render correctly. ICON_UNDEFINED
        // forces the host to fall back to iconResId instead.
        AutoButton.SKIP_BACK_10 -> CommandButton.Builder(CommandButton.ICON_UNDEFINED)
            .setCustomIconResId(R.drawable.ic_auto_skip_back_10)
            .setSessionCommand(SessionCommand(CMD_SKIP_BACK_10, android.os.Bundle.EMPTY))
            .setDisplayName(getString(R.string.auto_back_10))
            .setSlots(CommandButton.SLOT_BACK_SECONDARY)
            .build()
        AutoButton.SKIP_FORWARD_10 -> CommandButton.Builder(CommandButton.ICON_UNDEFINED)
            .setCustomIconResId(R.drawable.ic_auto_skip_forward_10)
            .setSessionCommand(SessionCommand(CMD_SKIP_FORWARD_10, android.os.Bundle.EMPTY))
            .setDisplayName(getString(R.string.auto_forward_10))
            .setSlots(CommandButton.SLOT_FORWARD_SECONDARY)
            .build()
    }

    companion object {
        const val ACTION_LOCAL_BIND = "com.voynix.action.LOCAL_BIND"

        /** How long to wait for a reconnect after a car controller disconnects before actually pausing. */
        private const val CAR_DISCONNECT_PAUSE_DEBOUNCE_MS = 5_000L

        /** Grace period after onConnect's car-resume before starting playback — lets the car's audio route settle. */
        private const val CAR_RESUME_DELAY_MS = 1_500L

        private const val GRID_ITEM = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM
        private const val LIST_ITEM = MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM

        /** Fallback square size (px) for home-grid tile artwork when Auto doesn't send a size hint. */
        private const val DEFAULT_TILE_ART_SIZE = 256
    }
}
