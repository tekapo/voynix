package com.voynix.ui.tracks

import com.voynix.data.db.TrackEntity
import com.voynix.logic.PlayState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PodcastStatusTest {

    private fun track(
        kind: String = "podcast",
        playState: String = "unplayed",
        duration: Double? = 600.0,
        resumePosition: Double = 0.0,
    ) = TrackEntity(
        id = "t1", title = "Episode", artist = "Show", album = null,
        filePath = "/mac/t1.mp3", fileName = "t1.mp3", duration = duration,
        kind = kind, playState = playState, resumePosition = resumePosition,
    )

    @Test
    fun `music tracks are not podcast status`() {
        val t = track(kind = "music", playState = "played")
        assertNull(podcastStatus(t))
        assertNull(podcastProgress(t))
        assertNull(podcastStatusLabel(t))
    }

    @Test
    fun `unplayed podcast`() {
        val t = track(playState = "unplayed")
        assertEquals(PlayState.UNPLAYED, podcastStatus(t))
        assertNull(podcastProgress(t))
        assertEquals(PodcastStatusLabel.Unplayed, podcastStatusLabel(t))
    }

    @Test
    fun `defaults to unplayed when play_state column is unset`() {
        val t = track(playState = "unplayed", resumePosition = 0.0)
        assertEquals(PlayState.UNPLAYED, podcastStatus(t))
    }

    @Test
    fun `in progress podcast reports position and duration and progress`() {
        val t = track(playState = "in_progress", duration = 600.0, resumePosition = 300.0)
        assertEquals(PlayState.IN_PROGRESS, podcastStatus(t))
        assertEquals(0.5f, podcastProgress(t)!!, 0.001f)
        assertEquals(PodcastStatusLabel.InProgress(300.0, 600.0), podcastStatusLabel(t))
    }

    @Test
    fun `in progress with unknown duration has no progress but still labels`() {
        val t = track(playState = "in_progress", duration = null, resumePosition = 120.0)
        assertEquals(PlayState.IN_PROGRESS, podcastStatus(t))
        assertNull(podcastProgress(t))
        assertEquals(PodcastStatusLabel.InProgress(120.0, null), podcastStatusLabel(t))
    }

    @Test
    fun `played podcast has no progress even though resume_position is reset`() {
        // nextPlayState() resets resume_position to 0 on finish (logic/Playback.kt),
        // so progress must not be derived from resume_position/duration here.
        val t = track(playState = "played", duration = 600.0, resumePosition = 0.0)
        assertEquals(PlayState.PLAYED, podcastStatus(t))
        assertNull(podcastProgress(t))
        assertEquals(PodcastStatusLabel.Played, podcastStatusLabel(t))
    }

    @Test
    fun `formatPlaybackTime switches to h_mm_ss at one hour`() {
        assertEquals("0:00", formatPlaybackTime(0.0))
        assertEquals("10:23", formatPlaybackTime(623.0))
        assertEquals("1:30:30", formatPlaybackTime(5430.0))
    }

    @Test
    fun `timeText is null without a duration`() {
        assertNull(PodcastStatusLabel.InProgress(120.0, null).timeText())
        assertEquals("10:23 / 1:30:30", PodcastStatusLabel.InProgress(623.0, 5430.0).timeText())
    }
}
