package com.voynix.artwork

import android.graphics.Bitmap
import android.graphics.BitmapFactory

/** Longest edge, in px, art is decoded to — enough for the full-screen Now Playing cover and the lock-screen art. */
internal const val MAX_ART_EDGE_PX = 1024

/**
 * Largest power-of-two `inSampleSize` that keeps both edges at or above
 * [maxEdge] (so the result is never smaller than the size actually shown).
 * 1 when the image already fits or its size is unknown.
 */
internal fun calculateInSampleSize(width: Int, height: Int, maxEdge: Int = MAX_ART_EDGE_PX): Int {
    if (width <= 0 || height <= 0) return 1
    var sample = 1
    while (width / (sample * 2) >= maxEdge && height / (sample * 2) >= maxEdge) sample *= 2
    return sample
}

/** Decodes [bytes] downsampled to about [MAX_ART_EDGE_PX]: bounds first, then the pixels. */
internal fun decodeSampled(bytes: ByteArray): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val opts = BitmapFactory.Options().apply { inSampleSize = calculateInSampleSize(bounds.outWidth, bounds.outHeight) }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
}

/** File variant of [decodeSampled]. */
internal fun decodeSampledFile(path: String): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    val opts = BitmapFactory.Options().apply { inSampleSize = calculateInSampleSize(bounds.outWidth, bounds.outHeight) }
    return BitmapFactory.decodeFile(path, opts)
}
