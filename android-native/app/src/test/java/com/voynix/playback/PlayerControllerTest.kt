package com.voynix.playback

import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.voynix.artwork.AlbumArtResolver
import com.voynix.data.db.TrackEntity
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.RepeatMode
import com.voynix.logic.decodeQueueSnapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.kotlin.any
import org.mockito.kotlin.argumentCaptor
import org.mockito.kotlin.eq
import org.mockito.kotlin.mock
import org.mockito.kotlin.verify
import org.mockito.kotlin.whenever
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.Executor

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class PlayerControllerTest {
    private lateinit var db: VoynixDatabase
    private lateinit var player: Player
    private lateinit var listener: Player.Listener

    /** Runs Room's suspend DAO calls synchronously so tests don't race a real background thread. */
    private object SynchronousExecutor : Executor {
        override fun execute(command: Runnable) = command.run()
    }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), VoynixDatabase::class.java)
            .setQueryExecutor(SynchronousExecutor)
            .setTransactionExecutor(SynchronousExecutor)
            .allowMainThreadQueries()
            .build()
        player = mock()
    }

    @After
    fun tearDown() {
        db.close()
    }

    private fun track(id: String, trackKey: String = "k$id", duration: Double = 10.0) = TrackEntity(
        id = id, title = "Title $id", artist = "Artist", album = "Album",
        filePath = "/mac/$id.mp3", fileName = "$id.mp3", duration = duration,
        trackKey = trackKey, contentHash = "hash-$id", origin = "mirror",
    )

    private fun newController(scope: kotlinx.coroutines.CoroutineScope): PlayerController {
        val controller = PlayerController(player, db, scope, AlbumArtResolver(ApplicationProvider.getApplicationContext(), db))
        val captor = argumentCaptor<Player.Listener>()
        verify(player).addListener(captor.capture())
        listener = captor.firstValue
        return controller
    }

    @Test
    fun `setQueueAndPlay sets the media item and starts the first track`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"))

        controller.setQueueAndPlay(tracks, startIndex = 0)
        advanceUntilIdle()

        verify(player).setMediaItem(any(), eq(0L))
        verify(player).prepare()
        verify(player).playWhenReady = true
        val state = controller.uiState.value
        assertEquals("t1", state.currentTrack?.id)
        assertEquals(0.0, state.positionSecs, 0.0)
    }

    @Test
    fun `shuffle leaves a podcast queue in order but still shuffles music`() = runTest {
        val controller = newController(this)
        val identity = (0 until 30).toList()

        controller.setShuffle(true)
        controller.setQueueAndPlay((0 until 30).map { track("p$it").copy(kind = "podcast") }, startIndex = 0)
        advanceUntilIdle()
        assertEquals(identity, controller.uiState.value.order)
        assertEquals(true, controller.uiState.value.shuffle) // the toggle itself is untouched

        controller.setQueueAndPlay((0 until 30).map { track("m$it") }, startIndex = 0)
        advanceUntilIdle()
        assertNotEquals(identity, controller.uiState.value.order)

        controller.setPodcastNoShuffle(false)
        controller.setQueueAndPlay((0 until 30).map { track("q$it").copy(kind = "podcast") }, startIndex = 0)
        advanceUntilIdle()
        assertNotEquals(identity, controller.uiState.value.order)
    }

    @Test
    fun `the queue snapshot is persisted and restoreSnapshot reinstates the same shuffle pass`() = runTest {
        val controller = newController(this)
        val tracks = (0 until 20).map { track("m$it") }
        controller.setShuffle(true)
        controller.setQueueAndPlay(tracks, startIndex = 0)
        controller.next()
        advanceUntilIdle()
        controller.next()
        advanceUntilIdle()
        val before = controller.uiState.value

        val saved = decodeQueueSnapshot(db.settingsDao().get(LAST_QUEUE_KEY))!!
        assertEquals(tracks.map { it.id }, saved.ids)
        assertEquals(before.order, saved.order)
        assertEquals(2, saved.pos)

        // A fresh process gets a fresh Player; reusing the mock would trip newController's single-addListener verify.
        player = mock()
        val restored = newController(this)
        restored.restoreSnapshot(tracks, saved, positionSecs = 3.0)
        advanceUntilIdle()

        assertEquals(before.order, restored.uiState.value.order)
        assertEquals(before.orderPos, restored.uiState.value.orderPos)
        assertEquals(before.currentTrack?.id, restored.uiState.value.currentTrack?.id)
    }

    @Test
    fun `next steps forward through the play order`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"), track("t3"))
        controller.setQueueAndPlay(tracks, startIndex = 0)

        controller.next()
        advanceUntilIdle()

        assertEquals("t2", controller.uiState.value.currentTrack?.id)
    }

    @Test
    fun `previous at the start of a non-repeating queue clamps to the first track instead of wrapping`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"))
        controller.setQueueAndPlay(tracks, startIndex = 0)
        controller.setRepeat(RepeatMode.OFF)

        controller.previous()
        advanceUntilIdle()

        // Clamped to position 0, not wrapped to the last track.
        assertEquals("t1", controller.uiState.value.currentTrack?.id)
        assertEquals(0, controller.uiState.value.orderPos)
    }

    @Test
    fun `next past the end of a non-repeating queue pauses instead of wrapping`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"))
        controller.setQueueAndPlay(tracks, startIndex = 1)
        controller.setRepeat(RepeatMode.OFF)

        controller.next()
        advanceUntilIdle()

        verify(player).pause()
        assertEquals("t2", controller.uiState.value.currentTrack?.id)
    }

    @Test
    fun `previous wraps around when repeat is ALL`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"))
        controller.setQueueAndPlay(tracks, startIndex = 0)
        controller.setRepeat(RepeatMode.ALL)

        controller.previous()
        advanceUntilIdle()

        assertEquals("t2", controller.uiState.value.currentTrack?.id)
    }

    @Test
    fun `enqueue on an empty queue starts playback immediately`() = runTest {
        val controller = newController(this)
        controller.enqueue(track("t1"))
        advanceUntilIdle()

        assertEquals("t1", controller.uiState.value.currentTrack?.id)
    }

    @Test
    fun `enqueue on a non-empty queue appends without interrupting playback`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1")), startIndex = 0)
        advanceUntilIdle()
        controller.enqueue(track("t2"))

        val state = controller.uiState.value
        assertEquals(listOf("t1", "t2"), state.queue.map { it.id })
        assertEquals("t1", state.currentTrack?.id) // unchanged — still playing t1
    }

    @Test
    fun `toggleShuffle re-derives the order but keeps the current track playing`() = runTest {
        val controller = newController(this)
        val tracks = (1..5).map { track("t$it") }
        controller.setQueueAndPlay(tracks, startIndex = 2)
        advanceUntilIdle()

        val currentBefore = controller.uiState.value.currentTrack?.id
        controller.toggleShuffle()

        assertTrue(controller.uiState.value.shuffle)
        assertEquals(currentBefore, controller.uiState.value.currentTrack?.id)
    }

    @Test
    fun `cycleRepeat advances OFF to ALL to ONE and back to OFF`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1")), startIndex = 0)
        assertEquals(RepeatMode.OFF, controller.uiState.value.repeat)

        controller.cycleRepeat()
        assertEquals(RepeatMode.ALL, controller.uiState.value.repeat)
        controller.cycleRepeat()
        assertEquals(RepeatMode.ONE, controller.uiState.value.repeat)
        controller.cycleRepeat()
        assertEquals(RepeatMode.OFF, controller.uiState.value.repeat)
    }

    @Test
    fun `togglePlayPause pauses when playing and plays when paused`() = runTest {
        val controller = newController(this)
        whenever(player.isPlaying).thenReturn(true)
        controller.togglePlayPause()
        verify(player).pause()

        whenever(player.isPlaying).thenReturn(false)
        controller.togglePlayPause()
        verify(player).play()
    }

    @Test
    fun `a track ending naturally with repeat ONE replays the same track`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2")), startIndex = 0)
        controller.setRepeat(RepeatMode.ONE)

        listener.onPlaybackStateChanged(Player.STATE_ENDED)
        advanceUntilIdle()

        assertEquals("t1", controller.uiState.value.currentTrack?.id)
    }

    @Test
    fun `onIsPlayingChanged updates uiState isPlaying`() = runTest {
        val controller = newController(this)
        listener.onIsPlayingChanged(true)
        assertTrue(controller.uiState.value.isPlaying)
        listener.onIsPlayingChanged(false)
        assertFalse(controller.uiState.value.isPlaying)
    }

    @Test
    fun `a play is recorded once the listen threshold is reached and persisted to play_events`() {
        val dispatcher = StandardTestDispatcher()
        val scope = TestScope(dispatcher)
        val controller = PlayerController(player, db, scope, AlbumArtResolver(ApplicationProvider.getApplicationContext(), db))
        val captor = argumentCaptor<Player.Listener>()
        verify(player).addListener(captor.capture())
        val l = captor.firstValue

        scope.runTest {
            // 10s track; shouldCountPlay fires at 50% = 5s listened.
            controller.setQueueAndPlay(listOf(track("t1", trackKey = "k1", duration = 10.0)), startIndex = 0)
            advanceUntilIdle() // let the track actually load before the poll loop starts

            var positionMs = 0L
            whenever(player.currentPosition).thenAnswer { positionMs }
            whenever(player.duration).thenReturn(10_000L)

            l.onIsPlayingChanged(true) // starts the 500ms poll loop

            // Advance virtual time in 500ms poll steps, moving currentPosition
            // in lockstep, until enough listened-seconds accrue to count the play.
            repeat(12) {
                positionMs += 500
                dispatcher.scheduler.advanceTimeBy(500)
                dispatcher.scheduler.runCurrent()
            }

            controller.stop() // cancel the poll loop so advanceUntilIdle() can terminate
            advanceUntilIdle()
        }

        val events = kotlinx.coroutines.runBlocking { db.playEventDao().getLocalPlayEvents(deviceIdOf(db)) }
        assertEquals(1, events.size)
        assertEquals("k1", events[0].trackKey)
    }

    @Test
    fun `setQueueAndPlay with a browseParentId tags the player's mediaId with that folder`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"))

        controller.setQueueAndPlay(tracks, startIndex = 0, browseParentId = "all_songs")
        advanceUntilIdle()

        val captor = argumentCaptor<androidx.media3.common.MediaItem>()
        verify(player).setMediaItem(captor.capture(), eq(0L))
        assertEquals("all_songs|t1", captor.firstValue.mediaId)
    }

    @Test
    fun `enqueue after a browsed queue falls back to untagged mediaIds`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1")), startIndex = 0, browseParentId = "all_songs")
        advanceUntilIdle()

        controller.enqueue(track("t2"))
        controller.next()
        advanceUntilIdle()

        val captor = argumentCaptor<androidx.media3.common.MediaItem>()
        verify(player, org.mockito.kotlin.atLeastOnce()).setMediaItem(captor.capture(), any<Long>())
        assertEquals("t2", captor.lastValue.mediaId)
    }

    @Test
    fun `restoreQueueAt seeks to the saved position without auto-playing`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"))

        controller.restoreQueueAt(tracks, trackId = "t2", positionSecs = 42.0)
        advanceUntilIdle()

        verify(player).playWhenReady = false
        verify(player).setMediaItem(any(), eq(42_000L))
        assertEquals("t2", controller.uiState.value.currentTrack?.id)
        assertEquals(42.0, controller.uiState.value.positionSecs, 0.0)
    }

    @Test
    fun `restoreQueueAt is a no-op when the saved track is no longer in the library`() = runTest {
        val controller = newController(this)
        controller.restoreQueueAt(listOf(track("t1")), trackId = "missing", positionSecs = 10.0)
        assertNull(controller.uiState.value.currentTrack)
    }

    // ---- adoptResumedQueue (PlaybackService.onPlaybackResumption) ----------

    @Test
    fun `adoptResumedQueue updates uiState to match a queue applied outside the controller`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"), track("t3"))

        controller.adoptResumedQueue(tracks, startIndex = 1, positionSecs = 42.0)

        val state = controller.uiState.value
        assertEquals("t2", state.currentTrack?.id)
        assertEquals(tracks, state.queue)
        assertEquals(1, state.order[state.orderPos])
        assertEquals(42.0, state.positionSecs, 0.0)
        assertEquals(tracks[1].duration ?: 0.0, state.durationSecs, 0.0)
    }

    @Test
    fun `adoptResumedQueue never touches the player — the caller already applied the queue to it`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"))

        controller.adoptResumedQueue(tracks, startIndex = 0, positionSecs = 5.0)
        advanceUntilIdle()

        verify(player, org.mockito.kotlin.never()).setMediaItem(any<MediaItem>(), any<Long>())
        verify(player, org.mockito.kotlin.never()).prepare()
        verify(player, org.mockito.kotlin.never()).play()
    }

    @Test
    fun `adoptResumedQueue is a no-op when startIndex is out of range`() = runTest {
        val controller = newController(this)
        controller.adoptResumedQueue(listOf(track("t1")), startIndex = 5, positionSecs = 1.0)
        assertNull(controller.uiState.value.currentTrack)
    }

    // ---- Podcast resume position (play_state / resume_position) -----------

    @Test
    fun `setQueueAndPlay resumes a podcast from its saved resume_position`() = runTest {
        val controller = newController(this)
        val podcast = track("p1", duration = 600.0).copy(
            kind = "podcast", playState = "in_progress", resumePosition = 120.0,
        )

        controller.setQueueAndPlay(listOf(podcast), startIndex = 0)
        advanceUntilIdle()

        verify(player).setMediaItem(any(), eq(120_000L))
        assertEquals(120.0, controller.uiState.value.positionSecs, 0.0)
    }

    @Test
    fun `setQueueAndPlay does not resume a non-podcast track even with a resume_position set`() = runTest {
        val controller = newController(this)
        val music = track("m1").copy(resumePosition = 120.0) // kind defaults to "music"

        controller.setQueueAndPlay(listOf(music), startIndex = 0)
        advanceUntilIdle()

        verify(player).setMediaItem(any(), eq(0L))
        assertEquals(0.0, controller.uiState.value.positionSecs, 0.0)
    }

    @Test
    fun `restoreQueueAt's saved position overrides the podcast's own resume_position`() = runTest {
        val controller = newController(this)
        val podcast = track("p1", duration = 600.0).copy(kind = "podcast", resumePosition = 300.0)

        controller.restoreQueueAt(listOf(podcast), trackId = "p1", positionSecs = 60.0)
        advanceUntilIdle()

        verify(player).setMediaItem(any(), eq(60_000L))
        assertEquals(60.0, controller.uiState.value.positionSecs, 0.0)
    }

    @Test
    fun `podcast progress is saved as in_progress once it advances past the throttle window`() {
        val dispatcher = StandardTestDispatcher()
        val scope = TestScope(dispatcher)
        val controller = PlayerController(player, db, scope, AlbumArtResolver(ApplicationProvider.getApplicationContext(), db))
        val captor = argumentCaptor<Player.Listener>()
        verify(player).addListener(captor.capture())
        val l = captor.firstValue

        scope.runTest {
            val podcast = track("p1", duration = 600.0).copy(kind = "podcast")
            db.trackDao().insert(podcast)

            controller.setQueueAndPlay(listOf(podcast), startIndex = 0)
            advanceUntilIdle()

            var positionMs = 0L
            whenever(player.currentPosition).thenAnswer { positionMs }
            whenever(player.duration).thenReturn(600_000L)

            l.onIsPlayingChanged(true)

            // Advance past the 30s-of-progress throttle so a save fires.
            repeat(70) {
                positionMs += 500
                dispatcher.scheduler.advanceTimeBy(500)
                dispatcher.scheduler.runCurrent()
            }

            controller.stop()
            advanceUntilIdle()
        }

        val row = kotlinx.coroutines.runBlocking { db.trackDao().getById("p1") }
        assertEquals("in_progress", row?.playState)
        assertTrue((row?.resumePosition ?: 0.0) >= 30.0)
    }

    @Test
    fun `a podcast reaching the end is marked played with resume_position reset`() = runTest {
        val controller = newController(this)
        val podcast = track("p1", duration = 600.0).copy(
            kind = "podcast", playState = "in_progress", resumePosition = 590.0,
        )
        db.trackDao().insert(podcast)

        controller.setQueueAndPlay(listOf(podcast), startIndex = 0)
        advanceUntilIdle()

        listener.onPlaybackStateChanged(Player.STATE_ENDED)
        advanceUntilIdle()

        val row = db.trackDao().getById("p1")
        assertEquals("played", row?.playState)
        assertEquals(0.0, row?.resumePosition ?: -1.0, 0.0)
    }

    @Test
    fun `switching away from a podcast flushes its current position immediately`() {
        val dispatcher = StandardTestDispatcher()
        val scope = TestScope(dispatcher)
        val controller = PlayerController(player, db, scope, AlbumArtResolver(ApplicationProvider.getApplicationContext(), db))
        verify(player).addListener(argumentCaptor<Player.Listener>().capture())

        scope.runTest {
            val podcast = track("p1", duration = 600.0).copy(kind = "podcast")
            db.trackDao().insert(podcast)

            controller.setQueueAndPlay(listOf(podcast, track("t2")), startIndex = 0)
            advanceUntilIdle()

            whenever(player.currentPosition).thenReturn(42_000L)
            whenever(player.duration).thenReturn(600_000L)

            // Skip to the next track well before the 30s-throttled poll would save.
            controller.next()
            advanceUntilIdle()

            val row = db.trackDao().getById("p1")
            assertEquals("in_progress", row?.playState)
            assertEquals(42.0, row?.resumePosition ?: -1.0, 0.5)
        }
    }

    @Test
    fun `stop awaits the podcast position write so the scope can be cancelled right after`() = runTest {
        val controller = newController(this)
        val podcast = track("p1", duration = 600.0).copy(kind = "podcast")
        db.trackDao().insert(podcast)
        controller.setQueueAndPlay(listOf(podcast), startIndex = 0)
        advanceUntilIdle()
        whenever(player.currentPosition).thenReturn(77_000L)
        whenever(player.duration).thenReturn(600_000L)

        controller.stop()

        // No advanceUntilIdle(): the write must already be committed on return.
        val row = db.trackDao().getById("p1")
        assertEquals("in_progress", row?.playState)
        assertEquals(77.0, row?.resumePosition ?: -1.0, 0.5)
    }

    @Test
    fun `pausing a podcast signals a settle point after its position is written`() = runTest {
        val controller = newController(this)
        val podcast = track("p1", duration = 600.0).copy(kind = "podcast")
        db.trackDao().insert(podcast)
        var settledPos = -1.0
        controller.onPodcastSettled = { settledPos = db.trackDao().getById("p1")?.resumePosition ?: -1.0 }
        controller.setQueueAndPlay(listOf(podcast), startIndex = 0)
        advanceUntilIdle()
        whenever(player.currentPosition).thenReturn(42_000L)
        whenever(player.duration).thenReturn(600_000L)

        listener.onIsPlayingChanged(false)
        advanceUntilIdle()

        assertEquals(42.0, settledPos, 0.5)
    }

    // ---- skipBy (Android Auto ±10s podcast buttons) ------------------------

    @Test
    fun `skipBy moves forward from the player's actual current position`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1", duration = 600.0)), startIndex = 0)
        advanceUntilIdle()
        whenever(player.currentPosition).thenReturn(100_000L)

        controller.skipBy(10.0)

        verify(player).seekTo(110_000L)
        assertEquals(110.0, controller.uiState.value.positionSecs, 0.0)
    }

    @Test
    fun `skipBy clamps at the start of the track`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1", duration = 600.0)), startIndex = 0)
        advanceUntilIdle()
        whenever(player.currentPosition).thenReturn(5_000L)

        controller.skipBy(-10.0)

        verify(player).seekTo(0L)
    }

    @Test
    fun `skipBy clamps at the end of the track`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1", duration = 100.0)), startIndex = 0)
        advanceUntilIdle()
        whenever(player.currentPosition).thenReturn(95_000L)

        controller.skipBy(10.0)

        verify(player).seekTo(100_000L)
    }

    private suspend fun deviceIdOf(db: VoynixDatabase): String =
        db.settingsDao().get("device_id") ?: error("device_id was never persisted")

    @Test
    fun `a podcast loads at the saved speed, music always loads at 1_0`() = runTest {
        db.settingsDao().set(com.voynix.data.db.SettingEntity("podcast_speed", "1.5"))
        val controller = newController(this)
        advanceUntilIdle() // let init's settingsDao().get("podcast_speed") resolve

        controller.setQueueAndPlay(listOf(track("p1").copy(kind = "podcast")), startIndex = 0)
        advanceUntilIdle()
        verify(player).setPlaybackSpeed(1.5f)

        controller.setQueueAndPlay(listOf(track("m1")), startIndex = 0)
        advanceUntilIdle()
        verify(player).setPlaybackSpeed(1.0f)
    }

    @Test
    fun `setPodcastSpeed persists and is picked up by a freshly created controller`() = runTest {
        val controller = newController(this)
        controller.setPodcastSpeed(1.75f)
        advanceUntilIdle()
        assertEquals("1.75", db.settingsDao().get("podcast_speed"))

        val player2: Player = mock()
        val controller2 = PlayerController(player2, db, this, AlbumArtResolver(ApplicationProvider.getApplicationContext(), db))
        advanceUntilIdle()
        assertEquals(1.75f, controller2.podcastSpeed.value)
    }

    @Test
    fun `changing speed mid-podcast-playback applies immediately`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("p1").copy(kind = "podcast")), startIndex = 0)
        advanceUntilIdle()

        controller.setPodcastSpeed(2.0f)
        advanceUntilIdle()

        verify(player).setPlaybackSpeed(2.0f)
    }

    @Test
    fun `changing speed while music is loaded does not touch the player until a podcast loads`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("m1")), startIndex = 0)
        advanceUntilIdle()

        controller.setPodcastSpeed(2.0f)
        advanceUntilIdle()

        verify(player, org.mockito.kotlin.never()).setPlaybackSpeed(2.0f)
    }

    // ---- Gapless lookahead (syncNextItem / onMediaItemTransition) ----------

    @Test
    fun `the following track is queued at timeline index 1 once the current one loads`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2"), track("t3")), startIndex = 0)
        advanceUntilIdle()

        val captor = argumentCaptor<MediaItem>()
        verify(player).addMediaItem(captor.capture())
        assertEquals("t2", captor.firstValue.mediaId)
    }

    @Test
    fun `a podcast never gets a following track queued`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(
            listOf(track("p1").copy(kind = "podcast"), track("p2").copy(kind = "podcast")),
            startIndex = 0,
        )
        advanceUntilIdle()

        verify(player, org.mockito.kotlin.never()).addMediaItem(any())
    }

    @Test
    fun `nothing is queued at the end of the queue with repeat off`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1")), startIndex = 0)
        advanceUntilIdle()

        verify(player, org.mockito.kotlin.never()).addMediaItem(any())
    }

    @Test
    fun `a natural AUTO transition moves the cursor without reloading the track`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2"), track("t3")), startIndex = 0)
        advanceUntilIdle()

        listener.onMediaItemTransition(MediaItem.Builder().setMediaId("t2").build(), Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
        advanceUntilIdle()

        assertEquals("t2", controller.uiState.value.currentTrack?.id)
        assertEquals(1, controller.uiState.value.orderPos)
        verify(player).removeMediaItem(0)
        // Only the initial jump used setMediaItem — the AUTO advance itself never reloads.
        verify(player, org.mockito.kotlin.times(1)).setMediaItem(any(), any<Long>())
        // ...and the newly-current track's own follow-up ("t3") gets queued.
        val captor = argumentCaptor<MediaItem>()
        verify(player, org.mockito.kotlin.times(2)).addMediaItem(captor.capture())
        assertEquals("t3", captor.lastValue.mediaId)
    }

    @Test
    fun `a natural AUTO transition persists the queue cursor`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2"), track("t3")), startIndex = 0)
        advanceUntilIdle()

        listener.onMediaItemTransition(MediaItem.Builder().setMediaId("t2").build(), Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
        advanceUntilIdle()

        assertEquals(1, decodeQueueSnapshot(db.settingsDao().get(LAST_QUEUE_KEY))!!.pos)
    }

    @Test
    fun `an AUTO transition reason that doesn't match the queued track is ignored`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2")), startIndex = 0)
        advanceUntilIdle()

        // A stale/foreign mediaId (e.g. a race with a queue change) must not
        // be misattributed to "t2" — the only track syncNextItem could have
        // actually queued next.
        listener.onMediaItemTransition(MediaItem.Builder().setMediaId("someone-else").build(), Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
        advanceUntilIdle()

        assertEquals("t1", controller.uiState.value.currentTrack?.id)
        verify(player, org.mockito.kotlin.never()).removeMediaItem(any<Int>())
    }

    @Test
    fun `a non-AUTO transition reason is ignored`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2")), startIndex = 0)
        advanceUntilIdle()

        listener.onMediaItemTransition(MediaItem.Builder().setMediaId("t2").build(), Player.MEDIA_ITEM_TRANSITION_REASON_SEEK)
        advanceUntilIdle()

        assertEquals("t1", controller.uiState.value.currentTrack?.id)
    }

    @Test
    fun `switching to repeat ONE re-queues the current track itself as next`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2")), startIndex = 0)
        advanceUntilIdle()

        controller.setRepeat(RepeatMode.ONE)

        val captor = argumentCaptor<MediaItem>()
        verify(player).replaceMediaItem(eq(1), captor.capture())
        assertEquals("t1", captor.firstValue.mediaId)
    }

    @Test
    fun `a natural AUTO transition under repeat ONE loops the same track seamlessly`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2")), startIndex = 0)
        advanceUntilIdle()
        controller.setRepeat(RepeatMode.ONE)

        listener.onMediaItemTransition(MediaItem.Builder().setMediaId("t1").build(), Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
        advanceUntilIdle()

        assertEquals("t1", controller.uiState.value.currentTrack?.id)
        assertEquals(0, controller.uiState.value.orderPos)
        verify(player).removeMediaItem(0)
    }

    @Test
    fun `enqueueing onto a single-track queue queues the newly-possible next track`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1")), startIndex = 0)
        advanceUntilIdle()
        verify(player, org.mockito.kotlin.never()).addMediaItem(any())

        controller.enqueue(track("t2"))

        val captor = argumentCaptor<MediaItem>()
        verify(player).addMediaItem(captor.capture())
        assertEquals("t2", captor.firstValue.mediaId)
    }

    @Test
    fun `setShuffle and setRepeat persist to settings so a restart doesn't lose them`() = runTest {
        val controller = newController(this)
        controller.setShuffle(true)
        controller.cycleRepeat() // OFF -> ALL
        advanceUntilIdle()

        assertEquals("1", db.settingsDao().get("shuffle"))
        assertEquals(RepeatMode.ALL.name, db.settingsDao().get("repeat"))
    }

    @Test
    fun `a fresh controller loads shuffle and repeat back from settings`() = runTest {
        db.settingsDao().set(com.voynix.data.db.SettingEntity("shuffle", "1"))
        db.settingsDao().set(com.voynix.data.db.SettingEntity("repeat", RepeatMode.ALL.name))

        val controller = newController(this)
        controller.awaitSettings()
        advanceUntilIdle()

        assertTrue(controller.uiState.value.shuffle)
        assertEquals(RepeatMode.ALL, controller.uiState.value.repeat)
    }

    @Test
    fun `setQueueAndPlay persists its browse folder, enqueue from outside it clears that`() = runTest {
        val controller = newController(this)
        controller.setQueueAndPlay(listOf(track("t1"), track("t2")), startIndex = 0, browseParentId = "playlist_x")
        advanceUntilIdle()

        assertEquals("playlist_x", db.settingsDao().get("last_browse_parent_id"))

        controller.enqueue(track("t3"))
        advanceUntilIdle()

        assertNull(db.settingsDao().get("last_browse_parent_id"))
    }

    @Test
    fun `restoreQueueAt with a browse folder carries it into the restored queue`() = runTest {
        val controller = newController(this)
        val tracks = listOf(track("t1"), track("t2"))

        controller.restoreQueueAt(tracks, "t2", positionSecs = 5.0, browseParentId = "playlist_x")
        advanceUntilIdle()

        assertEquals("t2", controller.uiState.value.currentTrack?.id)
        assertEquals("playlist_x", db.settingsDao().get("last_browse_parent_id"))
    }
}
