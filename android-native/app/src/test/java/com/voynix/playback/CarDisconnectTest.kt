package com.voynix.playback

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CarDisconnectTest {

    @Test
    fun `android auto and automotive os packages are car controllers`() {
        assertTrue(isCarController("com.google.android.projection.gearhead"))
        assertTrue(isCarController("com.google.android.gms.car"))
        assertTrue(isCarController("com.google.android.autos"))
    }

    @Test
    fun `the phone's own app and unrelated controllers are not car controllers`() {
        assertFalse(isCarController("com.tekapo.voynix"))
        assertFalse(isCarController("com.android.systemui"))
        assertFalse(isCarController("com.google.android.gms"))
        assertFalse(isCarController(""))
    }

    @Test
    fun `pauses when the last car controller disconnects`() {
        assertTrue(shouldPauseOnCarDisconnect("com.google.android.projection.gearhead", remainingControllerPackages = emptyList()))
    }

    @Test
    fun `does not pause while another car controller is still connected`() {
        assertFalse(
            shouldPauseOnCarDisconnect(
                "com.google.android.projection.gearhead",
                remainingControllerPackages = listOf("com.google.android.gms.car"),
            )
        )
    }

    @Test
    fun `does not pause for a non-car controller disconnecting`() {
        assertFalse(shouldPauseOnCarDisconnect("com.tekapo.voynix", remainingControllerPackages = emptyList()))
    }

    @Test
    fun `a non-car controller disconnecting is ignored even if a car controller remains connected`() {
        assertFalse(
            shouldPauseOnCarDisconnect(
                "com.android.systemui",
                remainingControllerPackages = listOf("com.google.android.projection.gearhead"),
            )
        )
    }
}
