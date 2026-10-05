package com.voynix.sync

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * Cheap change-detector: file size + first 64KB + last 64KB, SHA-256 hex.
 * Must match `compute_content_hash` in src-tauri/src/lib.rs bit-for-bit —
 * this is how a downloaded file is verified against the manifest's
 * `content_hash` (see SyncApi.downloadFile).
 */
fun computeContentHash(file: File): String {
    val chunk = 64 * 1024L
    val len = file.length()
    val digest = MessageDigest.getInstance("SHA-256")

    // len.to_le_bytes() — an 8-byte little-endian u64.
    digest.update(
        ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(len).array()
    )

    RandomAccessFile(file, "r").use { raf ->
        val headLen = minOf(len, chunk).toInt()
        val head = ByteArray(headLen)
        raf.readFully(head)
        digest.update(head)

        if (len > chunk) {
            val tailLen = minOf(len - chunk, chunk).toInt()
            raf.seek(len - tailLen)
            val tail = ByteArray(tailLen)
            raf.readFully(tail)
            digest.update(tail)
        }
    }

    return digest.digest().joinToString("") { "%02x".format(it) }
}

// U+001F INFORMATION SEPARATOR ONE — the exact delimiter metadata.rs's
// cache_key() and lib.rs's compute_track_key() both hash with.
private const val UNIT_SEPARATOR = ""

/**
 * Album-art cache key: SHA-256 hex of trim+lowercase(artist) + U+001F +
 * trim+lowercase(album). Must match `cache_key` in src-tauri/src/metadata.rs
 * bit-for-bit — the Mac's `GET /api/album-art/:key` route and this Android
 * client both derive it independently from the same (artist, album) pair, no
 * lookup table involved. Note: unlike track_key's `norm`, internal whitespace
 * is NOT collapsed here.
 */
fun albumArtCacheKey(artist: String, album: String): String {
    val joined = listOf(artist, album).joinToString(UNIT_SEPARATOR) { it.trim().lowercase() }
    val digest = MessageDigest.getInstance("SHA-256")
    return digest.digest(joined.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
