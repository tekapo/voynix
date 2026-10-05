package com.voynix.sync

import com.voynix.logic.ManifestPlaylist
import com.voynix.logic.ManifestTrack
import com.voynix.logic.PlayState
import com.voynix.logic.TrackKind
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Wire types for the Mac's LAN sync protocol (src-tauri/src/server.rs). Field
// names/shapes must match the Rust structs exactly — see the protocol
// (POST /pair, GET /api/manifest, POST /api/sync/stats).

@Serializable
data class PairRequestDto(@SerialName("device_name") val deviceName: String)

@Serializable
data class PairGrantedDto(val url: String, val token: String, val fingerprint: String)

@Serializable
data class SnapshotTrackDto(
    @SerialName("track_key") val trackKey: String,
    val title: String,
    val artist: String? = null,
    val album: String? = null,
    val duration: Double? = null,
    @SerialName("file_name") val fileName: String,
    @SerialName("file_path") val filePath: String,
    @SerialName("content_hash") val contentHash: String,
    val size: Long = 0,
    val favorite: Int = 0,
    @SerialName("favorite_updated_at") val favoriteUpdatedAt: Long? = null,
    val kind: String = "music",
    @SerialName("disc_no") val discNo: Int? = null,
    @SerialName("track_no") val trackNo: Int? = null,
    @SerialName("play_state") val playState: String = "unplayed",
    @SerialName("resume_position") val resumePosition: Double = 0.0,
    @SerialName("play_state_updated_at") val playStateUpdatedAt: Long? = null,
    @SerialName("added_at") val addedAt: Long? = null,
)

@Serializable
data class SnapshotPlaylistDto(
    val id: String,
    val name: String,
    val kind: String = "music",
    @SerialName("track_keys") val trackKeys: List<String> = emptyList(),
)

@Serializable
data class PlayEventDto(
    @SerialName("track_key") val trackKey: String,
    @SerialName("played_at") val playedAt: Long,
    @SerialName("device_id") val deviceId: String,
)

@Serializable
data class AlbumCoverDto(
    val artist: String,
    val album: String,
    @SerialName("image_data_uri") val imageDataUri: String? = null,
    @SerialName("updated_at") val updatedAt: Long,
)

@Serializable
data class ArtistCoverDto(
    val artist: String,
    @SerialName("image_data_uri") val imageDataUri: String? = null,
    @SerialName("updated_at") val updatedAt: Long,
)

@Serializable
data class SyncSnapshotDto(
    @SerialName("device_id") val deviceId: String,
    @SerialName("generated_at") val generatedAt: Long,
    val playlists: List<SnapshotPlaylistDto> = emptyList(),
    val tracks: List<SnapshotTrackDto> = emptyList(),
    @SerialName("play_events") val playEvents: List<PlayEventDto> = emptyList(),
    @SerialName("album_covers") val albumCovers: List<AlbumCoverDto> = emptyList(),
    @SerialName("artist_covers") val artistCovers: List<ArtistCoverDto> = emptyList(),
)

@Serializable
data class IncomingEventDto(
    @SerialName("track_key") val trackKey: String,
    @SerialName("played_at") val playedAt: Long,
)

@Serializable
data class FavoriteUpdateDto(
    @SerialName("track_key") val trackKey: String,
    val favorite: Int,
    @SerialName("updated_at") val updatedAt: Long,
)

@Serializable
data class PlayStateUpdateDto(
    @SerialName("track_key") val trackKey: String,
    @SerialName("play_state") val playState: String,
    @SerialName("resume_position") val resumePosition: Double,
    @SerialName("updated_at") val updatedAt: Long,
)

@Serializable
data class IncomingStatsDto(
    @SerialName("device_id") val deviceId: String,
    val events: List<IncomingEventDto> = emptyList(),
    val favorites: List<FavoriteUpdateDto> = emptyList(),
    @SerialName("play_states") val playStates: List<PlayStateUpdateDto> = emptyList(),
)

// ---- wire <-> pure-logic mapping -------------------------------------------

fun String.toTrackKind(): TrackKind = when (this) {
    "podcast" -> TrackKind.PODCAST
    "other" -> TrackKind.OTHER
    else -> TrackKind.MUSIC
}

fun String.toPlayState(): PlayState = when (this) {
    "in_progress" -> PlayState.IN_PROGRESS
    "played" -> PlayState.PLAYED
    else -> PlayState.UNPLAYED
}

fun PlayState.toWire(): String = when (this) {
    PlayState.UNPLAYED -> "unplayed"
    PlayState.IN_PROGRESS -> "in_progress"
    PlayState.PLAYED -> "played"
}

fun TrackKind.toWire(): String = when (this) {
    TrackKind.MUSIC -> "music"
    TrackKind.PODCAST -> "podcast"
    TrackKind.OTHER -> "other"
}

fun SnapshotTrackDto.toManifestTrack(): ManifestTrack = ManifestTrack(
    trackKey = trackKey,
    title = title,
    artist = artist,
    album = album,
    duration = duration,
    fileName = fileName,
    filePath = filePath,
    contentHash = contentHash,
    size = size,
    favorite = favorite != 0,
    favoriteUpdatedAt = favoriteUpdatedAt,
    kind = kind.toTrackKind(),
    discNo = discNo,
    trackNo = trackNo,
    playState = playState.toPlayState(),
    resumePosition = resumePosition,
    playStateUpdatedAt = playStateUpdatedAt,
    addedAt = addedAt,
)

fun SnapshotPlaylistDto.toManifestPlaylist(): ManifestPlaylist =
    ManifestPlaylist(id = id, name = name, kind = kind.toTrackKind(), trackKeys = trackKeys)
