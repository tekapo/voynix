package com.voynix.artwork

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import com.voynix.data.db.VoynixDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Resolves an artist's image from the `artist_covers` override synced from
 * the Mac (see ArtistCoverDao / SyncEngine.applyArtistCovers). Unlike album
 * art there's no embedded-tag or Mac-cache fallback — an artist with no
 * override just has no image, same as on the Mac (artistArt.ts).
 */
class ArtistArtResolver(private val db: VoynixDatabase) {
    private val cache = ArtistLruBitmapCache(maxEntries = 200)

    suspend fun resolve(artist: String?): Bitmap? {
        val key = (artist ?: "").ifEmpty { "Unknown Artist" }.trim().lowercase()
        cache.get(key)?.let { return it }

        val bitmap = withContext(Dispatchers.IO) {
            val dataUri = db.artistCoverDao().getImageDataUri(key) ?: return@withContext null
            decodeDataUri(dataUri)
        }
        if (bitmap != null) cache.put(key, bitmap)
        return bitmap
    }

    private fun decodeDataUri(dataUri: String): Bitmap? {
        val comma = dataUri.indexOf(',')
        if (!dataUri.startsWith("data:") || comma < 0) return null
        return try {
            val bytes = Base64.decode(dataUri.substring(comma + 1), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (e: Exception) {
            Log.w("ArtistArtResolver", "override data URI decode failed", e)
            null
        }
    }
}

/** Small fixed-capacity LRU, same shape as AlbumArtResolver's private one. */
private class ArtistLruBitmapCache(maxEntries: Int) {
    private val map = object : LinkedHashMap<String, Bitmap>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?): Boolean =
            size > maxEntries
    }

    @Synchronized
    fun get(key: String): Bitmap? = map[key]

    @Synchronized
    fun put(key: String, value: Bitmap) {
        map[key] = value
    }
}
