package com.voynix.data.db

import androidx.room.Dao
import androidx.room.Query

@Dao
interface AlbumCoverDao {
    @Query("SELECT image_data_uri FROM album_covers WHERE artist = :artist AND album = :album")
    suspend fun getImageDataUri(artist: String, album: String): String?

    // LWW upsert — matches applyAlbumCovers's guard in db.ts
    // (`WHERE excluded.updated_at > album_covers.updated_at`).
    @Query(
        """
        INSERT INTO album_covers (artist, album, image_data_uri, updated_at)
        VALUES (:artist, :album, :imageDataUri, :updatedAt)
        ON CONFLICT(artist, album) DO UPDATE SET
          image_data_uri = excluded.image_data_uri, updated_at = excluded.updated_at
        WHERE excluded.updated_at > album_covers.updated_at
        """
    )
    suspend fun upsertIfNewer(artist: String, album: String, imageDataUri: String?, updatedAt: Long)
}
