package com.voynix.artwork

import android.graphics.Bitmap
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayOutputStream

class CalculateInSampleSizeTest {
    @Test
    fun `an image that already fits is not downsampled`() {
        assertEquals(1, calculateInSampleSize(800, 800))
        assertEquals(1, calculateInSampleSize(1024, 1024))
    }

    @Test
    fun `a large image is halved while both edges stay at or above the max`() {
        assertEquals(2, calculateInSampleSize(2048, 2048))
        assertEquals(4, calculateInSampleSize(4096, 4096))
        assertEquals(1, calculateInSampleSize(3000, 1500)) // 1500/2 < 1024
    }

    @Test
    fun `an unknown size is left alone`() {
        assertEquals(1, calculateInSampleSize(0, 0))
        assertEquals(1, calculateInSampleSize(-1, 500))
    }
}

@RunWith(RobolectricTestRunner::class)
class DecodeSampledTest {
    @Test
    fun `a huge cover is decoded smaller than its source`() {
        val src = Bitmap.createBitmap(4096, 4096, Bitmap.Config.ARGB_8888)
        val bytes = ByteArrayOutputStream().also { src.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()

        val out = decodeSampled(bytes)

        assertNotNull(out)
        assertTrue(out!!.width < 4096 && out.width >= MAX_ART_EDGE_PX)
    }
}
