package com.voynix.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

/**
 * What diffTracks() compares: identity/refetch columns plus everything
 * updateMirrorTrackMeta writes. Deliberately excludes favorite, play_state,
 * resume_position and the *_updated_at stamps — those are LWW-merged by applyManifestStats and
 * are NOT written by updateMirrorTrackMeta, so comparing them could never converge.
 */
data class LocalMirrorTrackRow(
    val id: String,
    @androidx.room.ColumnInfo(name = "track_key") val trackKey: String,
    @androidx.room.ColumnInfo(name = "content_hash") val contentHash: String?,
    @androidx.room.ColumnInfo(name = "file_path") val filePath: String,
    val title: String,
    val artist: String?,
    val album: String?,
    val duration: Double?,
    val kind: String,
    @androidx.room.ColumnInfo(name = "disc_no") val discNo: Int?,
    @androidx.room.ColumnInfo(name = "track_no") val trackNo: Int?,
    @androidx.room.ColumnInfo(name = "added_at") val addedAt: Long?,
)

data class TrackKeyId(
    val id: String,
    @androidx.room.ColumnInfo(name = "track_key") val trackKey: String,
)

data class FavoriteRowEntity(
    @androidx.room.ColumnInfo(name = "track_key") val trackKey: String,
    val favorite: Boolean,
    @androidx.room.ColumnInfo(name = "favorite_updated_at") val favoriteUpdatedAt: Long?,
)

data class PlayStateRowEntity(
    @androidx.room.ColumnInfo(name = "track_key") val trackKey: String,
    @androidx.room.ColumnInfo(name = "play_state") val playState: String,
    @androidx.room.ColumnInfo(name = "resume_position") val resumePosition: Double,
    @androidx.room.ColumnInfo(name = "play_state_updated_at") val playStateUpdatedAt: Long?,
)

@Dao
interface TrackDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(track: TrackEntity): Long

    // ---- Sync (mirror) ----------------------------------------------------
    // Voynix is a mirror-only client (see plan): every track it ever writes
    // outside manual test-import has origin='mirror'. Mirrors db.ts's
    // upsertMirrorTrack/updateMirrorTrackMeta/getLocalMirrorTracks/deleteMirrorTrack.

    @Query(
        """
        SELECT id, track_key, content_hash, file_path, title, artist, album, duration, kind, disc_no, track_no, added_at
        FROM tracks WHERE origin = 'mirror' AND track_key IS NOT NULL
        """
    )
    suspend fun getMirrorTracks(): List<LocalMirrorTrackRow>

    // favorite/play_state are deliberately absent from DO UPDATE SET — a
    // refetch (retagged file) must not blind-overwrite a locally-newer LWW
    // value with the Mac's older one; those ride the stats push/pull instead.
    // added_at is also absent from DO UPDATE SET, mirroring addTracksToPlaylist
    // in playlists.ts: a refetch of the same track_key keeps its original add
    // date instead of jumping to the top of Recently Added.
    @Query(
        """
        INSERT INTO tracks
          (id, title, artist, album, file_path, file_name, duration, track_key, content_hash,
           favorite, favorite_updated_at, kind, disc_no, track_no, play_state, resume_position,
           play_state_updated_at, added_at, origin)
        VALUES
          (:id, :title, :artist, :album, :filePath, :fileName, :duration, :trackKey, :contentHash,
           :favorite, :favoriteUpdatedAt, :kind, :discNo, :trackNo, :playState, :resumePosition,
           :playStateUpdatedAt, :addedAt, 'mirror')
        ON CONFLICT(file_path) DO UPDATE SET
          title = excluded.title, artist = excluded.artist, album = excluded.album,
          duration = excluded.duration, track_key = excluded.track_key,
          content_hash = excluded.content_hash, kind = excluded.kind,
          disc_no = excluded.disc_no, track_no = excluded.track_no
        """
    )
    suspend fun upsertMirrorTrack(
        id: String,
        title: String,
        artist: String?,
        album: String?,
        filePath: String,
        fileName: String,
        duration: Double?,
        trackKey: String,
        contentHash: String,
        favorite: Boolean,
        favoriteUpdatedAt: Long?,
        kind: String,
        discNo: Int?,
        trackNo: Int?,
        playState: String,
        resumePosition: Double,
        playStateUpdatedAt: Long?,
        addedAt: Long?,
    )

    // play_state / favorite deliberately absent — see upsertMirrorTrack.
    @Query(
        """
        UPDATE tracks SET title = :title, artist = :artist, album = :album, duration = :duration,
          kind = :kind, disc_no = :discNo, track_no = :trackNo, added_at = :addedAt
        WHERE track_key = :trackKey AND origin = 'mirror'
        """
    )
    suspend fun updateMirrorTrackMeta(
        trackKey: String,
        title: String,
        artist: String?,
        album: String?,
        duration: Double?,
        kind: String,
        discNo: Int?,
        trackNo: Int?,
        addedAt: Long?,
    )

    @Query("SELECT id, track_key FROM tracks WHERE track_key IS NOT NULL ORDER BY (origin = 'mirror') DESC, id ASC")
    suspend fun getAllTrackKeyIdPairsMirrorFirst(): List<TrackKeyId>

    @Transaction
    suspend fun deleteMirrorTrack(id: String) {
        deleteById(id)
        deletePlaylistTracksForTrack(id)
    }

    @Query("DELETE FROM tracks WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM playlist_tracks WHERE track_id = :id")
    suspend fun deletePlaylistTracksForTrack(id: String)

    // ---- Stats (favorites / play_state / play_events pull+push) -----------

    @Query(
        "SELECT track_key, favorite, favorite_updated_at FROM tracks WHERE favorite_updated_at IS NOT NULL AND track_key IS NOT NULL"
    )
    suspend fun getLocalFavorites(): List<FavoriteRowEntity>

    @Query(
        "SELECT track_key, play_state, resume_position, play_state_updated_at FROM tracks WHERE play_state_updated_at IS NOT NULL AND track_key IS NOT NULL"
    )
    suspend fun getLocalPlayStates(): List<PlayStateRowEntity>

    @Query(
        "UPDATE tracks SET favorite = :favorite, favorite_updated_at = :updatedAt WHERE track_key = :trackKey AND (favorite_updated_at IS NULL OR favorite_updated_at < :updatedAt)"
    )
    suspend fun applyFavoriteIfNewer(trackKey: String, favorite: Boolean, updatedAt: Long)

    @Query(
        """
        UPDATE tracks SET play_state = :state, resume_position = :resume, play_state_updated_at = :updatedAt
        WHERE track_key = :trackKey AND (play_state_updated_at IS NULL OR play_state_updated_at < :updatedAt)
        """
    )
    suspend fun applyPlayStateIfNewer(trackKey: String, state: String, resume: Double, updatedAt: Long)

    // play_count is derived from the append-only play_events log, joined on
    // track_key — same shape as TRACK_COLUMNS_WITH_STATS in db.ts. No ORDER BY,
    // same as getAllTracks() in db.ts: the views (All Songs, Artists, Albums,
    // Favorites, ...) each apply their own order in-memory (see logic/TrackSort.kt).
    @Query(
        """
        SELECT t.*,
          (SELECT COUNT(*) FROM play_events pe WHERE pe.track_key = t.track_key) AS play_count,
          (SELECT MAX(played_at) FROM play_events pe WHERE pe.track_key = t.track_key) AS last_played
        FROM tracks t
        """
    )
    fun observeAllWithStats(): Flow<List<TrackWithStats>>

    @Query("SELECT * FROM tracks WHERE id = :id")
    suspend fun getById(id: String): TrackEntity?

    @Query("UPDATE tracks SET favorite = :favorite, favorite_updated_at = :updatedAt WHERE id = :id")
    suspend fun setFavorite(id: String, favorite: Boolean, updatedAt: Long)

    @Query(
        "UPDATE tracks SET play_state = :state, resume_position = :resume, play_state_updated_at = :updatedAt WHERE id = :id"
    )
    suspend fun setPlayState(id: String, state: String, resume: Double, updatedAt: Long)

    @Query("DELETE FROM tracks WHERE id = :id")
    suspend fun delete(id: String)

    /** Caches an LRCLIB lookup result on the track row itself — see LrclibApi. */
    @Query("UPDATE tracks SET lyrics = :lyrics WHERE id = :id")
    suspend fun setLyrics(id: String, lyrics: String)
}
