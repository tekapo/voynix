package com.voynix.playback

import com.voynix.logic.RepeatMode
import org.junit.Assert.assertEquals
import org.junit.Test

class AutoButtonsTest {

    @Test
    fun `a podcast always gets the 10s skip pair, regardless of shuffle or repeat`() {
        assertEquals(
            listOf(AutoButton.SKIP_BACK_10, AutoButton.SKIP_FORWARD_10),
            autoButtons(isPodcast = true, shuffle = true, repeat = RepeatMode.ONE),
        )
        assertEquals(
            listOf(AutoButton.SKIP_BACK_10, AutoButton.SKIP_FORWARD_10),
            autoButtons(isPodcast = true, shuffle = false, repeat = RepeatMode.OFF),
        )
    }

    @Test
    fun `music gets shuffle and repeat, reflecting their current on-off state`() {
        assertEquals(
            listOf(AutoButton.SHUFFLE_OFF, AutoButton.REPEAT_OFF),
            autoButtons(isPodcast = false, shuffle = false, repeat = RepeatMode.OFF),
        )
        assertEquals(
            listOf(AutoButton.SHUFFLE_ON, AutoButton.REPEAT_OFF),
            autoButtons(isPodcast = false, shuffle = true, repeat = RepeatMode.OFF),
        )
    }

    @Test
    fun `repeat button reflects all 3 modes`() {
        assertEquals(
            AutoButton.REPEAT_ALL,
            autoButtons(isPodcast = false, shuffle = false, repeat = RepeatMode.ALL).last(),
        )
        assertEquals(
            AutoButton.REPEAT_ONE,
            autoButtons(isPodcast = false, shuffle = false, repeat = RepeatMode.ONE).last(),
        )
    }
}
