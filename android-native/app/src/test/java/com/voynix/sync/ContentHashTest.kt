package com.voynix.sync

import com.voynix.testutil.testVectorFile
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.io.File
import java.security.MessageDigest

private val vectorJson = Json { ignoreUnknownKeys = true }

@Serializable
private data class ContentHashVector(val size: Int, val hash: String)

@Serializable
private data class ContentHashVectorsFile(val vectors: List<ContentHashVector>)

@Serializable
private data class AlbumArtKeyVector(val artist: String, val album: String, val key: String)

@Serializable
private data class AlbumArtKeyVectorsFile(val vectors: List<AlbumArtKeyVector>)

class ContentHashTest {
    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test
    fun `small file hashes len plus full content as head`() {
        val file = File.createTempFile("chtest", ".bin")
        try {
            val content = "hello world".toByteArray()
            file.writeBytes(content)

            val lenLe = byteArrayOf(content.size.toByte(), 0, 0, 0, 0, 0, 0, 0)
            val expected = sha256Hex(lenLe + content)

            assertEquals(expected, computeContentHash(file))
        } finally {
            file.delete()
        }
    }

    @Test
    fun `large file hashes len plus head 64KiB plus tail 64KiB`() {
        val file = File.createTempFile("chtest", ".bin")
        try {
            val chunk = 64 * 1024
            // 3 chunks: distinct head/middle/tail so a middle-inclusion bug would fail this.
            val head = ByteArray(chunk) { 1 }
            val middle = ByteArray(chunk) { 2 }
            val tail = ByteArray(chunk) { 3 }
            file.writeBytes(head + middle + tail)

            val len = file.length()
            val lenLe = java.nio.ByteBuffer.allocate(8)
                .order(java.nio.ByteOrder.LITTLE_ENDIAN).putLong(len).array()
            val expected = sha256Hex(lenLe + head + tail)

            assertEquals(expected, computeContentHash(file))
        } finally {
            file.delete()
        }
    }

    @Test
    fun `different content produces different hash`() {
        val a = File.createTempFile("chtest", ".bin").apply { writeBytes("aaa".toByteArray()) }
        val b = File.createTempFile("chtest", ".bin").apply { writeBytes("bbb".toByteArray()) }
        try {
            assertNotEquals(computeContentHash(a), computeContentHash(b))
        } finally {
            a.delete()
            b.delete()
        }
    }

    @Test
    fun `album art cache key ignores case and trims but keeps internal whitespace`() {
        val a = albumArtCacheKey("The Beatles", "Abbey Road")
        val b = albumArtCacheKey("  the beatles  ", "ABBEY ROAD")
        assertEquals(a, b)

        val c = albumArtCacheKey("Foo  Bar", "Album")
        val d = albumArtCacheKey("Foo Bar", "Album")
        assertNotEquals("internal whitespace must not collapse", c, d)
    }

    /** Shared contract with Rust's `compute_content_hash` (src-tauri/src/lib.rs)
     *  — see docs/test-vectors/content-hash.json and the matching Rust test. */
    @Test
    fun `computeContentHash matches shared test vectors`() {
        val doc = vectorJson.decodeFromString<ContentHashVectorsFile>(
            testVectorFile("content-hash.json").readText()
        )
        for (v in doc.vectors) {
            val file = File.createTempFile("vectest", ".bin")
            try {
                file.writeBytes(ByteArray(v.size) { (it % 251).toByte() })
                assertEquals("mismatch for size ${v.size}", v.hash, computeContentHash(file))
            } finally {
                file.delete()
            }
        }
    }

    /** Shared contract with Rust's `cache_key` (src-tauri/src/metadata.rs) —
     *  see docs/test-vectors/album-art-key.json and the matching Rust test. */
    @Test
    fun `albumArtCacheKey matches shared test vectors`() {
        val doc = vectorJson.decodeFromString<AlbumArtKeyVectorsFile>(
            testVectorFile("album-art-key.json").readText()
        )
        for (v in doc.vectors) {
            assertEquals(
                "mismatch for (${v.artist}, ${v.album})",
                v.key,
                albumArtCacheKey(v.artist, v.album),
            )
        }
    }
}
