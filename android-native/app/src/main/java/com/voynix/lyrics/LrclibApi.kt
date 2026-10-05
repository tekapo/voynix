package com.voynix.lyrics

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

// Lyrics lookup against the public LRCLIB API, ported from
// lrclib_lookup/fetch_lyrics/pick_lyrics in src-tauri/src/metadata.rs. Unlike
// album art, this needs no Mac round-trip — LRCLIB is a public internet API,
// so Voynix calls it directly and caches the result on the track row itself
// (TrackEntity.lyrics), matching the Mac's own "cache once, keep forever
// until a miss TTL" shape closely enough for a mirror client that never
// re-tags a track's lyrics.

@Serializable
internal data class LrclibResult(
    @SerialName("plainLyrics") val plainLyrics: String? = null,
    @SerialName("syncedLyrics") val syncedLyrics: String? = null,
)

private val json = Json { ignoreUnknownKeys = true }

/** Prefer plain lyrics, fall back to synced (LRC) — timestamps are harmless as leading text. */
internal fun pickLyrics(r: LrclibResult): String? {
    r.plainLyrics?.takeIf { it.isNotBlank() }?.let { return it }
    return r.syncedLyrics?.takeIf { it.isNotBlank() }
}

class LrclibApi {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    /** Lyrics for a track with none embedded, or null if LRCLIB has nothing. */
    suspend fun fetchLyrics(artist: String, title: String, album: String, durationSecs: Double?): String? {
        if (artist.isBlank() || title.isBlank()) return null
        // Both blocking OkHttp calls must run under Dispatchers.IO — this is
        // typically invoked from a Compose LaunchedEffect (Main dispatcher).
        return withContext(Dispatchers.IO) {
            exactGet(artist, title, album, durationSecs) ?: fuzzySearch(artist, title)
        }
    }

    private fun exactGet(artist: String, title: String, album: String, durationSecs: Double?): String? {
        val urlBuilder = "https://lrclib.net/api/get".toHttpUrl().newBuilder()
            .addQueryParameter("artist_name", artist)
            .addQueryParameter("track_name", title)
        if (album.isNotBlank()) urlBuilder.addQueryParameter("album_name", album)
        if (durationSecs != null && durationSecs > 0) {
            urlBuilder.addQueryParameter("duration", durationSecs.toLong().toString())
        }
        val request = Request.Builder().url(urlBuilder.build()).build()

        client.newCall(request).execute().use { resp ->
            if (resp.code == 404) return null
            if (!resp.isSuccessful) throw IOException("LRCLIB HTTP ${resp.code}")
            val body = resp.body?.string() ?: return null
            return pickLyrics(json.decodeFromString(LrclibResult.serializer(), body))
        }
    }

    private fun fuzzySearch(artist: String, title: String): String? {
        val url = "https://lrclib.net/api/search".toHttpUrl().newBuilder()
            .addQueryParameter("artist_name", artist)
            .addQueryParameter("track_name", title)
            .build()
        val request = Request.Builder().url(url).build()

        client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val body = resp.body?.string() ?: return null
            val results = json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(LrclibResult.serializer()), body)
            for (r in results) {
                pickLyrics(r)?.let { return it }
            }
            return null
        }
    }
}
