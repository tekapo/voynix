package com.voynix.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

data class LocalMirrorPlaylistRow(val id: String, val name: String, val kind: String)

data class PlaylistTrackIdRow(
    @androidx.room.ColumnInfo(name = "playlist_id") val playlistId: String,
    @androidx.room.ColumnInfo(name = "track_id") val trackId: String,
)

@Dao
interface PlaylistDao {
    @Query("SELECT * FROM playlists ORDER BY name COLLATE NOCASE")
    fun observeAll(): Flow<List<PlaylistEntity>>

    // ---- Sync (mirror) ----------------------------------------------------

    @Query("SELECT id, name, kind FROM playlists WHERE type = 'mirror'")
    suspend fun getMirrorPlaylists(): List<LocalMirrorPlaylistRow>

    /** Every mirror playlist's ordered membership in one pass (no N+1). A playlist with no tracks is simply absent. */
    @Query(
        """
        SELECT pt.playlist_id, pt.track_id
        FROM playlist_tracks pt
        JOIN playlists p ON p.id = pt.playlist_id
        WHERE p.type = 'mirror'
        ORDER BY pt.playlist_id ASC, pt.position ASC
        """
    )
    suspend fun getMirrorPlaylistTrackIds(): List<PlaylistTrackIdRow>

    // sync_to_device/manual_order have no SQL-level DEFAULT (Room only applies a
    // Kotlin-side default via the entity constructor, not to raw INSERTs), so
    // they must be listed explicitly here or this violates their NOT NULL
    // constraint. Always 0: Voynix never pushes a playlist back to the Mac
    // (sync_to_device) and always trusts the Mac's own track order (manual_order).
    @Query(
        """
        INSERT INTO playlists (id, name, type, kind, sync_to_device, manual_order)
        VALUES (:id, :name, 'mirror', :kind, 0, 0)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind
        """
    )
    suspend fun upsertMirrorPlaylistRow(id: String, name: String, kind: String)

    @Query("DELETE FROM playlists WHERE id = :id")
    suspend fun deletePlaylist(id: String)

    @Query("DELETE FROM playlist_tracks WHERE playlist_id = :playlistId")
    suspend fun clearPlaylistTracks(playlistId: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertPlaylistTracks(rows: List<PlaylistTrackEntity>)

    @Transaction
    suspend fun replacePlaylistTracks(playlistId: String, rows: List<PlaylistTrackEntity>) {
        clearPlaylistTracks(playlistId)
        if (rows.isNotEmpty()) insertPlaylistTracks(rows)
    }

    @Transaction
    suspend fun upsertMirrorPlaylist(id: String, name: String, kind: String, orderedTrackIds: List<String>) {
        upsertMirrorPlaylistRow(id, name, kind)
        // distinct(): the PK is (playlist_id, track_id), so a repeated id would collapse
        // under REPLACE and keep the LAST position. Dedupe keep-first so the stored
        // membership is exactly the list handed in — which is what diffPlaylists compares.
        replacePlaylistTracks(
            playlistId = id,
            rows = orderedTrackIds.distinct().mapIndexed { i, trackId -> PlaylistTrackEntity(id, trackId, i) },
        )
    }

    // Ordered by position only — matches playlistOrderBy() in db.ts for every
    // playlist a mirror client ever has: type is always 'mirror' (never
    // 'folder', which is the only case NATURAL_ORDER applies to) since Voynix
    // never scans. The Mac already sorted by NATURAL_ORDER before sending.
    @Query(
        """
        SELECT t.*,
          (SELECT COUNT(*) FROM play_events pe WHERE pe.track_key = t.track_key) AS play_count,
          (SELECT MAX(played_at) FROM play_events pe WHERE pe.track_key = t.track_key) AS last_played
        FROM tracks t
        JOIN playlist_tracks pt ON t.id = pt.track_id
        WHERE pt.playlist_id = :playlistId
        ORDER BY pt.position ASC
        """
    )
    fun observePlaylistTracks(playlistId: String): Flow<List<TrackWithStats>>
}
