package com.voynix.widget

import android.graphics.Bitmap
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// scaledForWidget guards against the "コンテンツを表示できません" / "Can't
// show content" bug: a full-resolution embedded cover sent through
// RemoteViews (baked into all 4 SizeMode.Responsive buckets) can exceed
// Android's per-update bitmap-memory budget, and Glance doesn't recover from
// that on its own — confirmed via a debug-only AppWidgetHost harness before
// this fix (see WidgetTestHostActivity's doc). These tests pin the resize
// contract that avoids it.
@RunWith(RobolectricTestRunner::class)
class NowPlayingWidgetTest {

    @Test
    fun `downscales a large square bitmap so its long side fits the widget's real display size`() {
        val bitmap = Bitmap.createBitmap(3000, 3000, Bitmap.Config.ARGB_8888)

        val scaled = scaledForWidget(bitmap)

        assertEquals(256, scaled.width)
        assertEquals(256, scaled.height)
    }

    @Test
    fun `preserves aspect ratio for a non-square bitmap`() {
        val bitmap = Bitmap.createBitmap(4000, 2000, Bitmap.Config.ARGB_8888)

        val scaled = scaledForWidget(bitmap)

        assertEquals(256, scaled.width)
        assertEquals(128, scaled.height)
    }

    @Test
    fun `leaves a bitmap already within the size budget untouched`() {
        val bitmap = Bitmap.createBitmap(200, 200, Bitmap.Config.ARGB_8888)

        val scaled = scaledForWidget(bitmap)

        assertEquals(200, scaled.width)
        assertEquals(200, scaled.height)
    }

    @Test
    fun `does not upscale a smaller bitmap`() {
        val bitmap = Bitmap.createBitmap(40, 40, Bitmap.Config.ARGB_8888)

        val scaled = scaledForWidget(bitmap)

        assertEquals(40, scaled.width)
        assertEquals(40, scaled.height)
    }
}
