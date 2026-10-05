package com.voynix.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

// Mirrors the `tracks` table from src/db.ts (MIGRATIONS 1-9), minus the
// scan-only columns (content_hash_cache lives in a separate table on the Mac
// side; Voynix never scans, see the plan's "Android はミラー専用クライアント").
@Entity(
    tableName = "tracks",
    indices = [
        Index(value = ["file_path"], unique = true),
        Index(value = ["track_key"]),
    ],
)
data class TrackEntity(
    @PrimaryKey
    val id: String,
    val title: String,
    val artist: String?,
    val album: String?,
    @ColumnInfo(name = "file_path")
    val filePath: String,
    @ColumnInfo(name = "file_name")
    val fileName: String,
    /** Seconds. Null until metadata is known. */
    val duration: Double?,
    val lyrics: String? = null,
    @ColumnInfo(name = "track_key")
    val trackKey: String? = null,
    @ColumnInfo(name = "content_hash")
    val contentHash: String? = null,
    val favorite: Boolean = false,
    @ColumnInfo(name = "favorite_updated_at")
    val favoriteUpdatedAt: Long? = null,
    /** 'local' (added on this device) | 'mirror' (received from a sync peer). */
    val origin: String = "local",
    /** 'music' | 'podcast' | 'other' — see logic.TrackKind. */
    val kind: String = "music",
    @ColumnInfo(name = "kind_updated_at")
    val kindUpdatedAt: Long? = null,
    /** 'unplayed' | 'in_progress' | 'played' — see logic.PlayState. */
    @ColumnInfo(name = "play_state")
    val playState: String = "unplayed",
    @ColumnInfo(name = "resume_position")
    val resumePosition: Double = 0.0,
    @ColumnInfo(name = "play_state_updated_at")
    val playStateUpdatedAt: Long? = null,
    @ColumnInfo(name = "disc_no")
    val discNo: Int? = null,
    @ColumnInfo(name = "track_no")
    val trackNo: Int? = null,
    /** When this track was first added, ms epoch (migration 3->4). Null for
     * rows added before this column existed and not yet re-synced. */
    @ColumnInfo(name = "added_at")
    val addedAt: Long? = null,
)

/** A track plus its derived play_count / last_played, exactly like TRACK_COLUMNS_WITH_STATS in db.ts. */
data class TrackWithStats(
    @androidx.room.Embedded
    val track: TrackEntity,
    @ColumnInfo(name = "play_count")
    val playCount: Int,
    @ColumnInfo(name = "last_played")
    val lastPlayed: Long? = null,
)
