package com.voynix.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity

// Mirrors db.ts's `album_covers` table: per-(artist, album) cover overrides,
// synced from the Mac (LWW by updated_at). Non-destructive — never touches a
// music file's own tags. Keys arrive already normalized (trim+lowercase,
// blank album -> "Unknown Album") from the Mac's own albumCoverKey().
@Entity(tableName = "album_covers", primaryKeys = ["artist", "album"])
data class AlbumCoverEntity(
    val artist: String,
    val album: String,
    @ColumnInfo(name = "image_data_uri")
    val imageDataUri: String?,
    @ColumnInfo(name = "updated_at")
    val updatedAt: Long,
)
