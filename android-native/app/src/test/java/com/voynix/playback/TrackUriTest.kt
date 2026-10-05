package com.voynix.playback

import org.junit.Assert.assertEquals
import org.junit.Test
import org.robolectric.RobolectricTestRunner
import org.junit.runner.RunWith

@RunWith(RobolectricTestRunner::class)
class TrackUriTest {
    @Test
    fun `absolute path with a literal percent round-trips to the same file path`() {
        val path = "/data/user/0/com.tekapo.voynix/files/synced/abc123_12 シカト100万% [Live].m4a"
        val uri = trackUri(path)

        assertEquals("file", uri.scheme)
        assertEquals(path, uri.path)
    }

    @Test
    fun `absolute path with hash and question mark round-trips`() {
        val path = "/data/user/0/com.tekapo.voynix/files/synced/xyz_weird#name?.m4a"
        val uri = trackUri(path)

        assertEquals("file", uri.scheme)
        assertEquals(path, uri.path)
    }

    @Test
    fun `content uri is passed through unchanged`() {
        val raw = "content://com.android.providers.media.documents/document/audio%3A123"
        val uri = trackUri(raw)

        assertEquals(raw, uri.toString())
    }
}
