package com.voynix.data.db

import androidx.room.Dao
import androidx.room.Query

@Dao
interface ArtistCoverDao {
    @Query("SELECT image_data_uri FROM artist_covers WHERE artist = :artist")
    suspend fun getImageDataUri(artist: String): String?

    // LWW upsert — matches applyArtistCovers's guard in db.ts
    // (`WHERE excluded.updated_at > artist_covers.updated_at`).
    @Query(
        """
        INSERT INTO artist_covers (artist, image_data_uri, updated_at)
        VALUES (:artist, :imageDataUri, :updatedAt)
        ON CONFLICT(artist) DO UPDATE SET
          image_data_uri = excluded.image_data_uri, updated_at = excluded.updated_at
        WHERE excluded.updated_at > artist_covers.updated_at
        """
    )
    suspend fun upsertIfNewer(artist: String, imageDataUri: String?, updatedAt: Long)
}
