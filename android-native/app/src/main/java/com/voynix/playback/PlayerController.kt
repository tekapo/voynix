package com.voynix.playback

import android.graphics.Bitmap
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import com.voynix.artwork.AlbumArtResolver
import com.voynix.data.db.PlayEventEntity
import com.voynix.data.db.SettingEntity
import com.voynix.data.db.TrackEntity
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.BuildOrderOpts
import com.voynix.logic.QueueSnapshot
import com.voynix.logic.ListenProgress
import com.voynix.logic.PlayState
import com.voynix.logic.RepeatMode
import com.voynix.logic.accumulateListened
import com.voynix.logic.buildOrder
import com.voynix.logic.effectiveShuffle
import com.voynix.logic.effectiveSpeed
import com.voynix.logic.encodeQueueSnapshot
import com.voynix.logic.nextPlayState
import com.voynix.logic.parseSpeed
import com.voynix.logic.peekNext
import com.voynix.logic.playStateFromDb
import com.voynix.logic.shouldCountPlay
import com.voynix.logic.sleepTimerDeadlineMs
import com.voynix.logic.sleepTimerEndOfTrackDeadlineMs
import com.voynix.logic.sleepTimerFired
import com.voynix.logic.skipTarget
import com.voynix.logic.stepOrder
import com.voynix.logic.toDbString
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

private const val PODCAST_NO_SHUFFLE_KEY = "podcast_no_shuffle"
private const val PODCAST_SPEED_KEY = "podcast_speed"
private const val SHUFFLE_KEY = "shuffle"
private const val REPEAT_KEY = "repeat"

/** Shared with PlaybackService.restoreLastPlayback, which reads it directly. */
const val LAST_BROWSE_PARENT_KEY = "last_browse_parent_id"
/** The persisted play queue (QueueSnapshot JSON); PlaybackService.restoreLastPlayback reads it directly. */
const val LAST_QUEUE_KEY = "last_queue"

data class PlayerUiState(
    val queue: List<TrackEntity> = emptyList(),
    val order: List<Int> = emptyList(),
    val orderPos: Int = 0,
    val currentTrack: TrackEntity? = null,
    val isPlaying: Boolean = false,
    val positionSecs: Double = 0.0,
    val durationSecs: Double = 0.0,
    val shuffle: Boolean = false,
    val repeat: RepeatMode = RepeatMode.OFF,
)

/**
 * Local playback core: ExoPlayer + the ported queue/shuffle/repeat rules
 * (logic/Queue.kt, logic/Playback.kt) + play-count recording + session
 * restore. Owned by PlaybackService so it survives Activity
 * destruction; [player] is built and released by the caller — this class
 * only drives it. External transport commands (Android Auto, lock screen,
 * Bluetooth) reach this class through QueuePlayer, a ForwardingPlayer that
 * wraps [player] for the MediaSession.
 */
class PlayerController(
    private val player: Player,
    private val db: VoynixDatabase,
    private val scope: CoroutineScope,
    private val albumArt: AlbumArtResolver,
) {
    private val _uiState = MutableStateFlow(PlayerUiState())
    val uiState: StateFlow<PlayerUiState> = _uiState.asStateFlow()

    // Setting "podcast_no_shuffle" (default on): a Podcast queue plays in order
    // even while shuffle is on. The shuffle toggle itself is untouched, so the
    // next music queue still shuffles.
    private val _podcastNoShuffle = MutableStateFlow(true)
    val podcastNoShuffle: StateFlow<Boolean> = _podcastNoShuffle.asStateFlow()

    fun setPodcastNoShuffle(enabled: Boolean) {
        _podcastNoShuffle.value = enabled
        scope.launch { db.settingsDao().set(SettingEntity(PODCAST_NO_SHUFFLE_KEY, if (enabled) "1" else "0")) }
    }

    // Podcast playback speed (0.8–2.0x), shared across every podcast — not
    // per-episode. Music always plays at 1.0x (effectiveSpeed) regardless of
    // this value.
    private val _podcastSpeed = MutableStateFlow(1.0f)
    val podcastSpeed: StateFlow<Float> = _podcastSpeed.asStateFlow()

    fun setPodcastSpeed(speed: Float) {
        _podcastSpeed.value = speed
        scope.launch { db.settingsDao().set(SettingEntity(PODCAST_SPEED_KEY, speed.toString())) }
        if (currentIsPodcast) {
            player.setPlaybackSpeed(speed)
        }
    }

    private fun shuffleFor(queue: List<TrackEntity>, shuffle: Boolean) =
        effectiveShuffle(shuffle, _podcastNoShuffle.value, queue.map { it.kind })

    // Sleep timer: a wall-clock deadline (epoch ms), or null when off. Checked
    // in onTick (see below) rather than a dedicated coroutine — it only needs
    // to fire while something is actually playing, which is exactly when
    // onTick's ~500ms poll is already running.
    private val _sleepTimerDeadlineMs = MutableStateFlow<Long?>(null)
    val sleepTimerDeadline: StateFlow<Long?> = _sleepTimerDeadlineMs.asStateFlow()

    fun setSleepTimer(minutes: Int) {
        _sleepTimerDeadlineMs.value = sleepTimerDeadlineMs(System.currentTimeMillis(), minutes)
    }

    /** Pauses when the current track/episode finishes, not after a fixed duration. */
    fun setSleepTimerToEndOfTrack() {
        val s = _uiState.value
        // Uses the player's actual current speed, not just the podcast
        // setting — correct whether or not the current track is a podcast.
        val speed = player.playbackParameters.speed.toDouble().takeIf { it > 0 } ?: 1.0
        val deadline = sleepTimerEndOfTrackDeadlineMs(System.currentTimeMillis(), s.positionSecs, s.durationSecs, speed)
        if (deadline != null) _sleepTimerDeadlineMs.value = deadline
    }

    fun cancelSleepTimer() {
        _sleepTimerDeadlineMs.value = null
    }

    private var listenProgress = ListenProgress.empty()
    private var countedCurrentTrack = false
    private var pollJob: Job? = null
    private var lastPersistedAt = 0L

    // Podcast resume-position tracking for the *current* track only (ported
    // from src/App.tsx's handleTimeUpdate/onEnded podcast branches). Not part
    // of PlayerUiState since it never needs to drive recomposition.
    private var playToken = 0
    private var currentIsPodcast = false
    private var currentPlayState = PlayState.UNPLAYED
    private var lastSavedPodcastPos = 0.0

    /**
     * Invoked after a podcast's position has been committed to the DB at a
     * settle point (pause / track switch / ended) — PlaybackService hooks a
     * best-effort stats push to the paired Mac here.
     */
    var onPodcastSettled: (suspend () -> Unit)? = null

    /** The Android Auto browse folder the current queue was started from, if any — see setQueueAndPlay. */
    private var browseParentId: String? = null
        set(value) {
            field = value
            scope.launch {
                val dao = db.settingsDao()
                if (value != null) dao.set(SettingEntity(LAST_BROWSE_PARENT_KEY, value)) else dao.delete(LAST_BROWSE_PARENT_KEY)
            }
        }

    // Loaded once at startup (see init) — awaited by PlaybackService's session
    // restore so it never builds the restored queue's shuffle order before
    // the persisted shuffle/repeat state has actually landed.
    private lateinit var settingsJob: Job
    suspend fun awaitSettings() = settingsJob.join()

    // Set the instant setShuffle/setRepeat is called (synchronously, not from
    // inside their own scope.launch) — see settingsJob's guard above.
    private var shuffleExplicitlySet = false
    private var repeatExplicitlySet = false

    // --- Gapless lookahead (music only — see syncNextItem) ------------------
    // ExoPlayer plays consecutive timeline items back-to-back with no gap, so
    // keeping the track that should play next sitting at timeline index 1
    // (behind the current one at index 0) gets a real gapless transition for
    // free. Podcasts opt out entirely (see syncNextItem) — they're commonly
    // played at >1x speed, gapless is far less valuable there, and it avoids
    // any interaction with the podcast resume/PLAYED bookkeeping below.
    //
    // The id this controller itself last queued at index 1, or null when
    // nothing is queued there. Tracked here rather than read back off `player`
    // (e.g. `mediaItemCount`) so this stays a plain, mockable Player call
    // count in tests — matches every other piece of per-track state in this
    // class (playToken, currentIsPodcast, ...).
    private var nextQueuedTrackId: String? = null

    init {
        // A single job so PlaybackService's session restore can await every
        // persisted setting — shuffle/repeat in particular — landing before it
        // builds the restored queue's play order (see awaitSettings above).
        settingsJob = scope.launch {
            val dao = db.settingsDao()
            _podcastNoShuffle.value = dao.get(PODCAST_NO_SHUFFLE_KEY) != "0"
            _podcastSpeed.value = parseSpeed(dao.get(PODCAST_SPEED_KEY))
            val shuffle = dao.get(SHUFFLE_KEY) == "1"
            val repeat = dao.get(REPEAT_KEY)?.let { name -> RepeatMode.entries.find { it.name == name } } ?: RepeatMode.OFF
            // Guard against this suspend load losing a race with a setShuffle/
            // setRepeat call already made (synchronously) since construction —
            // e.g. a session command arriving before this DB read resolves —
            // which would otherwise get clobbered back to the stale persisted
            // value the instant this coroutine catches up.
            _uiState.value = _uiState.value.copy(
                shuffle = if (shuffleExplicitlySet) _uiState.value.shuffle else shuffle,
                repeat = if (repeatExplicitlySet) _uiState.value.repeat else repeat,
            )
        }
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                _uiState.value = _uiState.value.copy(isPlaying = isPlaying)
                if (isPlaying) {
                    startPolling()
                    // Playback resumed for *any* reason (the user tapped
                    // play, a track auto-advanced, PlaybackService's own
                    // car-reconnect resume) — the "car went away" marker
                    // (see PlaybackService.markCarPaused/CarResume.kt) no
                    // longer applies once this fires. A harmless no-op write
                    // when nothing was ever marked.
                    scope.launch { db.settingsDao().delete(CAR_PAUSED_AT_KEY) }
                } else {
                    stopPolling()
                    flushPodcastPosition()
                }
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    if (currentIsPodcast) {
                        currentPlayState = PlayState.PLAYED
                        lastSavedPodcastPos = 0.0
                        _uiState.value.currentTrack?.let { track ->
                            scope.launch {
                                db.trackDao().setPlayState(track.id, PlayState.PLAYED.toDbString(), 0.0, System.currentTimeMillis())
                                onPodcastSettled?.invoke()
                            }
                        }
                        // Suppress the redundant flushPodcastPosition() the
                        // following advance()/playOrderPos() would otherwise
                        // run against this now-ended track: ExoPlayer's
                        // currentPosition can read back near 0 right after
                        // STATE_ENDED, which would look like a deliberate
                        // rewind-to-start and flip PLAYED back to UNPLAYED.
                        currentIsPodcast = false
                    }
                    scope.launch { advance(dir = 1, naturalEnd = true) }
                }
            }

            // Fires when ExoPlayer itself moves from one timeline item to the
            // next. AUTO means it did so on its own — having played the first
            // one to its end and, with a second item already sitting at index
            // 1 (see syncNextItem), started the next one with no gap. Any
            // other reason (a manual jump via setMediaItem/setMediaItems, or a
            // seek) is handled by whichever call already triggered it — see
            // playOrderPos — so this only ever needs to react to AUTO.
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                if (reason != Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) return
                val trackId = mediaItem?.mediaId?.let(::trackIdOfLeaf) ?: return
                val s = _uiState.value

                // Recompute exactly what syncNextItem would have queued as
                // "next" from the state as of *before* this transition, and
                // confirm it's what actually just started playing. A mismatch
                // means the queue/order changed after the item was queued but
                // before playback reached it — rare, and not worth
                // misattributing this transition to the wrong track for.
                val newPos = when {
                    s.repeat == RepeatMode.ONE -> s.orderPos
                    s.orderPos + 1 < s.order.size -> s.orderPos + 1
                    else -> 0 // only reachable for an unshuffled repeat-ALL wrap — see peekNext
                }
                val idx = s.order.getOrNull(newPos)
                val track = idx?.let { s.queue.getOrNull(it) }
                if (track == null || track.id != trackId) return

                // The item that just finished (formerly index 0) is gone from
                // the timeline's *content* the instant we swap our own notion
                // of "current" — drop it so index 0 means "current" again.
                player.removeMediaItem(0)
                nextQueuedTrackId = null
                applyAutoAdvancedTrack(track, newPos)
                syncNextItem()
            }
        })
    }

    /**
     * Bookkeeping-only counterpart to [playOrderPos]'s tail, for a track
     * ExoPlayer already started playing on its own (a gapless auto-advance).
     * Never called with a podcast track — [syncNextItem] only ever queues a
     * music track at index 1 — so, unlike playOrderPos, there's no podcast
     * resume-position DB read, no `setMediaItem`/`prepare`, and no
     * `playWhenReady` to reconcile: the audio is already flowing.
     */
    private fun applyAutoAdvancedTrack(track: TrackEntity, orderPos: Int) {
        flushPodcastPosition() // in case the *outgoing* track was, unusually, a podcast
        listenProgress = ListenProgress.empty()
        countedCurrentTrack = false
        val token = ++playToken
        currentIsPodcast = false
        currentPlayState = PlayState.UNPLAYED

        val mediaId = browseParentId?.let { leafMediaId(it, track.id) } ?: track.id
        player.setPlaybackSpeed(effectiveSpeed(track.kind, _podcastSpeed.value))

        _uiState.value = _uiState.value.copy(
            orderPos = orderPos,
            currentTrack = track,
            positionSecs = 0.0,
            durationSecs = track.duration ?: 0.0,
        )
        persistLastPlayback(track.id, 0.0)
        // The saved queue's cursor must follow the gapless advance too, or a
        // restore lands back on the track the queue was originally started at.
        persistQueue()
        loadArtwork(token, mediaId, track)
    }

    /**
     * Keeps ExoPlayer's timeline index 1 in sync with whatever track should
     * play next for a gapless hand-off (see the "Gapless lookahead" fields
     * above) — added, replaced or dropped as `queue`/`order`/`orderPos`/
     * `repeat`/`shuffle` change. A no-op whenever nothing actually needs to
     * change, so calling it liberally (after every state update that could
     * affect the answer) is cheap.
     *
     * Deliberately opts a podcast all the way out — as either the *current*
     * or the *candidate next* track — rather than just the current one: a
     * podcast landing at index 1 would need its own pitch-preserving speed
     * applied only once playback actually reaches it, which reopens the same
     * complexity this whole split exists to avoid.
     */
    private fun syncNextItem() {
        val s = _uiState.value
        val current = currentOrderTrack()
        val nextIdx = if (current == null || current.kind == "podcast") {
            null
        } else {
            peekNext(s.orderPos, s.order, s.repeat, shuffleFor(s.queue, s.shuffle))
        }
        val nextTrack = nextIdx?.let { s.queue.getOrNull(it) }?.takeUnless { it.kind == "podcast" }

        if (nextTrack == null) {
            if (nextQueuedTrackId != null) {
                player.removeMediaItem(1)
                nextQueuedTrackId = null
            }
            return
        }
        if (nextTrack.id == nextQueuedTrackId) return // already queued — nothing to do

        val mediaItem = buildMediaItem(nextTrack)
        if (nextQueuedTrackId != null) player.replaceMediaItem(1, mediaItem) else player.addMediaItem(mediaItem)
        nextQueuedTrackId = nextTrack.id
    }

    private fun buildMediaItem(track: TrackEntity): MediaItem {
        val mediaId = browseParentId?.let { leafMediaId(it, track.id) } ?: track.id
        return MediaItem.Builder()
            .setUri(trackUri(track.filePath))
            .setMediaId(mediaId)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(track.title)
                    .setArtist(track.artist)
                    .setAlbumTitle(track.album)
                    .build()
            )
            .build()
    }

    private fun currentOrderTrack(): TrackEntity? {
        val s = _uiState.value
        val idx = s.order.getOrNull(s.orderPos) ?: return null
        return s.queue.getOrNull(idx)
    }

    /**
     * Replace the queue (e.g. "all tracks" or a playlist) and start playing at
     * [startIndex]. [startPositionSecs], when given, overrides any podcast
     * resume position (used for session restore, see [restoreQueueAt]).
     * [browseParentId], when given, is the Android Auto browse-tree folder
     * this queue came from (see BrowseTree.kt's leafMediaId) — carried through
     * to the MediaItem built for the player so the session's "now playing"
     * mediaId matches the id the browse tree used for that same track,
     * letting the head unit highlight the right row.
     */
    fun setQueueAndPlay(
        tracks: List<TrackEntity>,
        startIndex: Int,
        playWhenReady: Boolean = true,
        startPositionSecs: Double? = null,
        browseParentId: String? = null,
    ) {
        val s = _uiState.value
        val order = buildOrder(tracks.size, BuildOrderOpts(shuffle = shuffleFor(tracks, s.shuffle), first = startIndex))
        val orderPos = order.indexOf(startIndex).coerceAtLeast(0)
        _uiState.value = s.copy(queue = tracks, order = order, orderPos = orderPos)
        this.browseParentId = browseParentId
        playOrderPos(orderPos, playWhenReady, startPositionSecs)
    }

    /**
     * Append [track] to the end of the play order — the track-row context
     * menu's "add to queue" action (App.tsx's addToQueue). `order` is always a
     * permutation of [0, queue.length), so the new track's index is the old length.
     */
    fun enqueue(track: TrackEntity) {
        val s = _uiState.value
        if (s.queue.isEmpty()) {
            setQueueAndPlay(listOf(track), 0)
            return
        }
        // The appended track didn't come from the queue's original browse
        // folder, so the queue is no longer purely "that one folder" —
        // fall back to plain (untagged) mediaIds for the rest of this queue.
        browseParentId = null
        _uiState.value = s.copy(queue = s.queue + track, order = s.order + s.queue.size)
        persistQueue()
        syncNextItem() // the queue may have just gained the only possible "next" track
    }

    private fun playOrderPos(orderPos: Int, playWhenReady: Boolean, startPositionSecs: Double? = null) {
        val s = _uiState.value
        val idx = s.order.getOrNull(orderPos) ?: return
        val track = s.queue.getOrNull(idx) ?: return

        // The outgoing track's own position must be flushed before we stomp
        // currentTrack/lastSavedPodcastPos below (persistLastPlayback right
        // after would otherwise overwrite it with 0 first).
        flushPodcastPosition()

        listenProgress = ListenProgress.empty()
        countedCurrentTrack = false
        val token = ++playToken

        val mediaItem = buildMediaItem(track)
        val mediaId = mediaItem.mediaId
        // player.setMediaItem below replaces the *entire* timeline, so
        // whatever this controller thought was queued at index 1 is gone too.
        nextQueuedTrackId = null

        currentIsPodcast = track.kind == "podcast"
        currentPlayState = playStateFromDb(track.playState)

        scope.launch {
            // Re-read the row rather than trusting `track` (a possibly-stale
            // list snapshot): the 5s-throttled saves below update the DB
            // directly without necessarily refreshing every in-memory list —
            // see src/App.tsx's loadAndPlay for the same reasoning.
            val fresh = if (currentIsPodcast) db.trackDao().getById(track.id) else null
            if (fresh != null) currentPlayState = playStateFromDb(fresh.playState)

            val start = startPositionSecs
                ?: (fresh?.resumePosition ?: track.resumePosition).takeIf { currentIsPodcast && it > 1 }
                ?: 0.0

            if (token != playToken) return@launch // superseded by a later play before this resolved

            lastSavedPodcastPos = start
            listenProgress = ListenProgress(last = start, secs = 0.0)

            player.setMediaItem(mediaItem, (start * 1000).toLong())
            player.prepare()
            player.setPlaybackSpeed(effectiveSpeed(track.kind, _podcastSpeed.value))
            // A session-restore call (playWhenReady=false, see restoreQueueAt)
            // must not stomp a PLAY that already arrived from the car/AVRCP/
            // lock screen while this coroutine was still resolving the DB
            // reads above — only downgrade to "not playing" if nothing else
            // has already started it.
            if (playWhenReady || !player.playWhenReady) {
                player.playWhenReady = playWhenReady
            }

            _uiState.value = _uiState.value.copy(
                orderPos = orderPos,
                currentTrack = track,
                positionSecs = start,
                durationSecs = (track.duration ?: 0.0),
            )
            persistLastPlayback(track.id, start)
            persistQueue()
            loadArtwork(token, mediaId, track)
            syncNextItem()
        }
    }

    // The MediaItem built above never carries artwork — AlbumArtResolver's
    // lookup (override → embedded → Mac cache) is too slow to block
    // setMediaItem/prepare on, and it's this session's MediaMetadata (not the
    // Compose-side AlbumArtResolver calls in NowPlayingScreen/MiniPlayer) that
    // Android Auto, the lock screen, and the notification actually read their
    // cover art from. So once it resolves, patch it onto the *current*
    // MediaItem via replaceMediaItem, which pushes the updated MediaMetadata
    // back out to the session automatically.
    private fun loadArtwork(token: Int, mediaId: String, track: TrackEntity) {
        scope.launch {
            val bitmap = albumArt.resolve(track.artist, track.album, track.filePath) ?: return@launch
            if (token != playToken) return@launch // superseded before artwork resolved

            val current = player.currentMediaItem
            if (current == null || current.mediaId != mediaId) return@launch

            val artworkData = ByteArrayOutputStream().use { out ->
                bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out)
                out.toByteArray()
            }
            val updated = current.buildUpon()
                .setMediaMetadata(
                    current.mediaMetadata.buildUpon()
                        .setArtworkData(artworkData, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
                        .build()
                )
                .build()
            player.replaceMediaItem(player.currentMediaItemIndex, updated)
        }
    }

    /** Resume a track at a saved position without immediately playing (session restore). */
    fun restoreQueueAt(
        tracks: List<TrackEntity>,
        trackId: String,
        positionSecs: Double,
        browseParentId: String? = null,
    ) {
        val index = tracks.indexOfFirst { it.id == trackId }
        if (index < 0) return
        setQueueAndPlay(tracks, index, playWhenReady = false, startPositionSecs = positionSecs, browseParentId = browseParentId)
    }

    /**
     * Session restore from a persisted [QueueSnapshot] (already remapped onto
     * [tracks], the snapshot's ids resolved in queue order): reinstates the
     * exact play order and cursor instead of dealing a fresh shuffle.
     */
    fun restoreSnapshot(
        tracks: List<TrackEntity>,
        snapshot: QueueSnapshot,
        positionSecs: Double,
        browseParentId: String? = null,
    ) {
        _uiState.value = _uiState.value.copy(queue = tracks, order = snapshot.order, orderPos = snapshot.pos)
        this.browseParentId = browseParentId
        playOrderPos(snapshot.pos, playWhenReady = false, startPositionSecs = positionSecs)
    }

    /**
     * Syncs this controller's own bookkeeping (queue/order/currentTrack, …)
     * to a queue that was already applied straight to the player by someone
     * else — specifically PlaybackService.onPlaybackResumption, whose
     * returned MediaItemsWithStartPosition is applied directly to ExoPlayer
     * by the Media3 framework (QueuePlayer doesn't override setMediaItems),
     * bypassing setQueueAndPlay/playOrderPos entirely. Without this,
     * uiState.currentTrack — and everything reading it, like the home-screen
     * widget — stays stale even though playback is genuinely running.
     *
     * Deliberately does *not* touch the player (no setMediaItem/prepare/
     * play/syncNextItem): the timeline it's syncing to was already set up by
     * the caller. The next controller-driven action (skip, pause/resume,
     * natural end) goes through playOrderPos as usual and rebuilds the
     * timeline into this controller's normal current+next shape, so any
     * mismatch with what the framework applied (e.g. it hands over the
     * whole library, not just current+next) is self-correcting from there.
     */
    fun adoptResumedQueue(
        tracks: List<TrackEntity>,
        startIndex: Int,
        positionSecs: Double,
        snapshot: QueueSnapshot? = null,
    ) {
        val track = tracks.getOrNull(startIndex) ?: return
        val order = snapshot?.order
            ?: buildOrder(tracks.size, BuildOrderOpts(shuffle = shuffleFor(tracks, _uiState.value.shuffle), first = startIndex))
        val orderPos = snapshot?.pos ?: order.indexOf(startIndex).coerceAtLeast(0)

        // Invalidates any playOrderPos coroutine still in flight from a
        // racing restoreLastPlayback (see PlaybackService.restoreJob) so it
        // bails out at its own token check instead of overwriting this.
        ++playToken
        nextQueuedTrackId = null
        browseParentId = null
        currentIsPodcast = track.kind == "podcast"
        currentPlayState = playStateFromDb(track.playState)
        listenProgress = ListenProgress(last = positionSecs, secs = 0.0)
        lastSavedPodcastPos = positionSecs
        countedCurrentTrack = false

        _uiState.value = _uiState.value.copy(
            queue = tracks,
            order = order,
            orderPos = orderPos,
            currentTrack = track,
            positionSecs = positionSecs,
            durationSecs = track.duration ?: 0.0,
        )
        persistLastPlayback(track.id, positionSecs)
        persistQueue()
    }

    fun togglePlayPause() {
        if (player.isPlaying) player.pause() else player.play()
    }

    /**
     * Explicit play (not a toggle) — used by PlaybackService's car-reconnect
     * resume, where "already playing" must stay a no-op rather than pausing.
     */
    fun play() {
        if (!player.isPlaying) player.play()
    }

    fun seekTo(positionSecs: Double) {
        player.seekTo((positionSecs * 1000).toLong())
        listenProgress = ListenProgress(last = positionSecs, secs = listenProgress.secs)
        _uiState.value = _uiState.value.copy(positionSecs = positionSecs)
    }

    /**
     * Jump [deltaSecs] forward (positive) or back (negative) from the actual
     * player position — the Android Auto ±10s podcast buttons. Reads
     * `player.currentPosition` directly rather than `uiState.positionSecs`
     * (only refreshed on the ~1s poll tick, see startPolling) so two taps in
     * quick succession don't both compute from a stale position. Routes
     * through [seekTo] so listenProgress/lastSavedPodcastPos — and therefore
     * play-count accounting and podcast resume — stay correct exactly as a
     * slider seek does.
     */
    fun skipBy(deltaSecs: Double) {
        val currentSecs = player.currentPosition / 1000.0
        val target = skipTarget(currentSecs, deltaSecs, _uiState.value.durationSecs)
        seekTo(target)
    }

    fun next() = scope.launch { advance(dir = 1, naturalEnd = false) }
    fun previous() = scope.launch { advance(dir = -1, naturalEnd = false) }

    fun toggleShuffle() = setShuffle(!_uiState.value.shuffle)

    /** Also reachable from the MediaSession side (QueuePlayer.setShuffleModeEnabled). */
    fun setShuffle(newShuffle: Boolean) {
        shuffleExplicitlySet = true
        val s = _uiState.value
        val currentIdx = s.order.getOrNull(s.orderPos)
        val newOrder = buildOrder(
            s.queue.size,
            BuildOrderOpts(shuffle = shuffleFor(s.queue, newShuffle), first = if (newShuffle) currentIdx else null),
        )
        val newPos = if (currentIdx != null) newOrder.indexOf(currentIdx).coerceAtLeast(0) else 0
        _uiState.value = s.copy(shuffle = newShuffle, order = newOrder, orderPos = newPos)
        persistQueue()
        scope.launch { db.settingsDao().set(SettingEntity(SHUFFLE_KEY, if (newShuffle) "1" else "0")) }
        syncNextItem() // shuffling re-deals what comes after the current track
    }

    fun cycleRepeat() = setRepeat(_uiState.value.repeat.cycle())

    /** Also reachable from the MediaSession side (QueuePlayer.setRepeatMode). */
    fun setRepeat(mode: RepeatMode) {
        repeatExplicitlySet = true
        _uiState.value = _uiState.value.copy(repeat = mode)
        scope.launch { db.settingsDao().set(SettingEntity(REPEAT_KEY, mode.name)) }
        syncNextItem() // e.g. switching to ONE means the next item is now the current track again
    }

    private fun advance(dir: Int, naturalEnd: Boolean) {
        val s = _uiState.value
        if (s.queue.isEmpty()) return

        // Natural end with repeat ONE replays the same track instead of stepping.
        if (naturalEnd && s.repeat == RepeatMode.ONE) {
            playOrderPos(s.orderPos, playWhenReady = true)
            return
        }

        val result = stepOrder(s.orderPos, s.order.size, dir, s.repeat) ?: run {
            player.pause()
            return
        }

        val order = if (result.reshuffle) {
            val avoid = s.order.getOrNull(s.orderPos)
            buildOrder(s.queue.size, BuildOrderOpts(shuffle = shuffleFor(s.queue, s.shuffle), avoidFirst = avoid))
        } else {
            s.order
        }
        _uiState.value = s.copy(order = order)
        playOrderPos(result.pos, playWhenReady = true)
    }

    private fun startPolling() {
        stopPolling()
        pollJob = scope.launch {
            while (true) {
                delay(500)
                onTick()
            }
        }
    }

    private fun stopPolling() {
        pollJob?.cancel()
        pollJob = null
    }

    private fun onTick() {
        val positionSecs = player.currentPosition / 1000.0
        val durationMs = player.duration
        val durationSecs = if (durationMs > 0) durationMs / 1000.0 else _uiState.value.durationSecs

        listenProgress = accumulateListened(listenProgress, positionSecs)
        _uiState.value = _uiState.value.copy(positionSecs = positionSecs, durationSecs = durationSecs)

        if (!countedCurrentTrack && shouldCountPlay(listenProgress.secs, durationSecs)) {
            countedCurrentTrack = true
            recordPlay()
        }

        val now = System.currentTimeMillis()
        if (now - lastPersistedAt > 5000) {
            lastPersistedAt = now
            _uiState.value.currentTrack?.let { persistLastPlayback(it.id, positionSecs) }
        }

        // Podcasts: persist a resume point, throttled to once per ~30s of
        // progress (originally ~5s, ported from src/App.tsx's handleTimeUpdate
        // podcast branch). Each write invalidates observeAllWithStats() —
        // Room recomputes the whole library's play_count join and every
        // observer (LibraryViewModel's derived StateFlows, PlaybackService's
        // browse-tree snapshot) redoes its work — so a 5s cadence during
        // podcast playback was firing that far more than needed. pause/track
        // switch/stop still flush immediately via flushPodcastPosition(), so
        // this only widens the window of position lost to a crash to ~30s.
        if (currentIsPodcast && durationSecs > 0 && abs(positionSecs - lastSavedPodcastPos) >= 30) {
            savePodcastProgress(positionSecs, durationSecs)
        }

        // Sleep timer: this only runs while playing (startPolling/stopPolling
        // follow isPlaying), which is exactly when there's something to pause.
        _sleepTimerDeadlineMs.value?.let { deadline ->
            if (sleepTimerFired(deadline, now)) {
                player.pause()
                _sleepTimerDeadlineMs.value = null
            }
        }
    }

    /** Computes and writes the next podcast play_state/resume_position for the current track. */
    private fun savePodcastProgress(positionSecs: Double, durationSecs: Double, settle: Boolean = false) {
        val write = preparePodcastWrite(positionSecs, durationSecs) ?: return
        scope.launch {
            write()
            if (settle) onPodcastSettled?.invoke()
        }
    }

    /**
     * Updates the in-memory podcast state now and returns the DB write for it
     * (or null if there's no current track). Splitting "decide" from "write"
     * lets [flushPodcastPositionNow] await the write instead of racing a
     * scope that may be cancelled right after.
     */
    private fun preparePodcastWrite(positionSecs: Double, durationSecs: Double): (suspend () -> Unit)? {
        lastSavedPodcastPos = positionSecs
        val next = nextPlayState(currentPlayState, positionSecs, durationSecs)
        currentPlayState = next.state
        val trackId = _uiState.value.currentTrack?.id ?: return null
        return { db.trackDao().setPlayState(trackId, next.state.toDbString(), next.resume, System.currentTimeMillis()) }
    }

    private fun currentPodcastPosition(): Pair<Double, Double>? {
        if (!currentIsPodcast) return null
        val positionSecs = player.currentPosition / 1000.0
        val durationMs = player.duration
        val durationSecs = if (durationMs > 0) durationMs / 1000.0 else _uiState.value.durationSecs
        return if (durationSecs > 0) positionSecs to durationSecs else null
    }

    /** Flushes the current podcast's position immediately (pause / track switch), then signals a settle point. */
    private fun flushPodcastPosition() {
        val (pos, dur) = currentPodcastPosition() ?: run {
            playbackLog("podcast settle skipped: current track is not a podcast (or duration unknown)")
            return
        }
        savePodcastProgress(pos, dur, settle = true)
    }

    /**
     * Awaitable flush for teardown: the write completes before this returns, so
     * the caller can cancel [scope] right after without losing the position.
     */
    suspend fun flushPodcastPositionNow() {
        val (pos, dur) = currentPodcastPosition() ?: return
        preparePodcastWrite(pos, dur)?.invoke()
    }

    private fun recordPlay() {
        val trackKey = _uiState.value.currentTrack?.trackKey ?: return
        scope.launch {
            db.playEventDao().insert(
                PlayEventEntity(
                    id = UUID.randomUUID().toString(),
                    trackKey = trackKey,
                    playedAt = System.currentTimeMillis(),
                    deviceId = getDeviceId(),
                )
            )
        }
    }

    private var cachedDeviceId: String? = null
    private suspend fun getDeviceId(): String {
        cachedDeviceId?.let { return it }
        val dao = db.settingsDao()
        val existing = dao.get("device_id")
        val id = existing ?: UUID.randomUUID().toString().also { dao.set(SettingEntity("device_id", it)) }
        cachedDeviceId = id
        return id
    }

    // Not called from the position tick: only when the queue, its order or the
    // cursor actually changed.
    private fun persistQueue() {
        val s = _uiState.value
        if (s.queue.isEmpty()) return
        val snapshot = QueueSnapshot(s.queue.map { it.id }, s.order, s.orderPos)
        scope.launch { db.settingsDao().set(SettingEntity(LAST_QUEUE_KEY, encodeQueueSnapshot(snapshot))) }
    }

    private fun persistLastPlayback(trackId: String, positionSecs: Double) {
        scope.launch {
            val dao = db.settingsDao()
            dao.set(SettingEntity("last_track_id", trackId))
            dao.set(SettingEntity("last_position", positionSecs.toInt().coerceAtLeast(0).toString()))
        }
    }

    /**
     * Stops the position-poll loop and awaits the final podcast position write,
     * so the caller can cancel [scope] straight afterwards. The player itself is
     * owned (and released) by the caller.
     */
    suspend fun stop() {
        stopPolling()
        flushPodcastPositionNow()
    }
}
