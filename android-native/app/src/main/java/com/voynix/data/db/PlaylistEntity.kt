package com.voynix.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

// Mirrors the `playlists` table from src/db.ts.
@Entity(tableName = "playlists")
data class PlaylistEntity(
    @PrimaryKey
    val id: String,
    val name: String,
    /** 'folder' | 'manual' | 'xml' | 'mirror' | ... */
    val type: String,
    @ColumnInfo(name = "sync_to_device")
    val syncToDevice: Boolean = false,
    /** 'music' | 'podcast' | 'other'. */
    val kind: String = "music",
    @ColumnInfo(name = "manual_order")
    val manualOrder: Boolean = false,
)

// Mirrors the `playlist_tracks` join table from src/db.ts.
@Entity(
    tableName = "playlist_tracks",
    primaryKeys = ["playlist_id", "track_id"],
    foreignKeys = [
        ForeignKey(
            entity = PlaylistEntity::class,
            parentColumns = ["id"],
            childColumns = ["playlist_id"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = TrackEntity::class,
            parentColumns = ["id"],
            childColumns = ["track_id"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [Index(value = ["track_id"])],
)
data class PlaylistTrackEntity(
    @ColumnInfo(name = "playlist_id")
    val playlistId: String,
    @ColumnInfo(name = "track_id")
    val trackId: String,
    val position: Int,
)
