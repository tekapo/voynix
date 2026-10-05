package com.voynix.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity

// Mirrors db.ts's `artist_covers` table: per-artist image overrides, synced
// from the Mac (LWW by updated_at). Non-destructive, same convention as
// `album_covers`. Keys arrive already normalized (trim+lowercase, blank ->
// "unknown artist") from the Mac's own artistCoverKey().
@Entity(tableName = "artist_covers", primaryKeys = ["artist"])
data class ArtistCoverEntity(
    val artist: String,
    @ColumnInfo(name = "image_data_uri")
    val imageDataUri: String?,
    @ColumnInfo(name = "updated_at")
    val updatedAt: Long,
)
