package com.voynix.artwork

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.util.Base64
import android.util.Log
import com.voynix.data.db.VoynixDatabase
import com.voynix.sync.albumArtCacheKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Resolves a track's album art, ported from albumArt.ts's resolution order:
 * a user-set override wins, else the file's own embedded art, else whatever
 * the Mac already resolved (its own embedded-tag/iTunes lookup) and this
 * device cached during sync (see SyncEngine.fetchAlbumArtBestEffort) — Voynix
 * never calls iTunes itself, since the Mac already did that server-side.
 */
class AlbumArtResolver(private val context: Context, private val db: VoynixDatabase) {
    private val albumArtDir = File(context.cacheDir, "album_art")
    private val cache = LruBitmapCache(maxEntries = 80)

    suspend fun resolve(artist: String?, album: String?, filePath: String): Bitmap? {
        val a = artist ?: ""
        val b = album ?: ""
        val key = "$a$b$filePath"
        cache.get(key)?.let { return it }

        val bitmap = withContext(Dispatchers.IO) {
            resolveOverride(a, b)
                ?: resolveEmbedded(filePath)
                ?: resolveMacCache(a, b)
        }
        if (bitmap != null) cache.put(key, bitmap)
        return bitmap
    }

    private suspend fun resolveOverride(artist: String, album: String): Bitmap? {
        // Overrides are stored under the Mac's albumCoverKey(): trimmed + lowercased,
        // blank album -> "Unknown Album". Query with the same normalization or any
        // mixed-case tag (e.g. "THE BLUE HEARTS") never matches.
        val dataUri = db.albumCoverDao().getImageDataUri(
            artist.trim().lowercase(),
            album.ifEmpty { "Unknown Album" }.trim().lowercase(),
        ) ?: return null
        return decodeDataUri(dataUri)
    }

    private fun resolveEmbedded(filePath: String): Bitmap? {
        val retriever = MediaMetadataRetriever()
        return try {
            if (filePath.startsWith("content://")) {
                retriever.setDataSource(context, Uri.parse(filePath))
            } else {
                retriever.setDataSource(filePath)
            }
            val art = retriever.embeddedPicture ?: return null
            BitmapFactory.decodeByteArray(art, 0, art.size)
        } catch (e: Exception) {
            Log.w("AlbumArtResolver", "embedded art read failed for $filePath", e)
            null
        } finally {
            retriever.release()
        }
    }

    private fun resolveMacCache(artist: String, album: String): Bitmap? {
        val key = albumArtCacheKey(artist, album)
        val file = File(albumArtDir, "$key.jpg")
        if (!file.isFile) return null
        return BitmapFactory.decodeFile(file.absolutePath)
    }

    private fun decodeDataUri(dataUri: String): Bitmap? {
        val comma = dataUri.indexOf(',')
        if (!dataUri.startsWith("data:") || comma < 0) return null
        return try {
            val bytes = Base64.decode(dataUri.substring(comma + 1), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (e: Exception) {
            Log.w("AlbumArtResolver", "override data URI decode failed", e)
            null
        }
    }
}

/** Small fixed-capacity LRU, mirroring albumArt.ts's cache Map + MAX cap. */
private class LruBitmapCache(maxEntries: Int) {
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
