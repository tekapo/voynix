package com.voynix.logic

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WelcomeTest {
    @Test
    fun `shows on a fresh install`() = assertTrue(shouldShowWelcome(seen = false, paired = false))

    @Test
    fun `does not show again once seen`() = assertFalse(shouldShowWelcome(seen = true, paired = false))

    @Test
    fun `does not show when a Mac is already paired`() = assertFalse(shouldShowWelcome(seen = false, paired = true))
}
