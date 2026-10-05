package com.voynix.data.db

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert

@Dao
interface SettingsDao {
    @Query("SELECT value FROM settings WHERE `key` = :key")
    suspend fun get(key: String): String?

    @Upsert
    suspend fun set(setting: SettingEntity)

    @Query("DELETE FROM settings WHERE `key` = :key")
    suspend fun delete(key: String)
}

data class PlayEventRow(
    @androidx.room.ColumnInfo(name = "track_key") val trackKey: String,
    @androidx.room.ColumnInfo(name = "played_at") val playedAt: Long,
)

@Dao
interface PlayEventDao {
    @androidx.room.Insert(onConflict = androidx.room.OnConflictStrategy.IGNORE)
    suspend fun insert(event: PlayEventEntity)

    @androidx.room.Insert(onConflict = androidx.room.OnConflictStrategy.IGNORE)
    suspend fun insertAll(events: List<PlayEventEntity>)

    /** This device's own events — what a push sends (db.ts's getLocalPlayEvents). */
    @Query("SELECT track_key, played_at FROM play_events WHERE device_id = :deviceId")
    suspend fun getLocalPlayEvents(deviceId: String): List<PlayEventRow>

    // Perf note: the full local log grows without bound, so re-pushing all of it every
    // sync gets more wasteful over time even though the server-side dedup makes
    // it *correct*. Only pushing events since the last successful push (see
    // SyncEngine's "last_stats_push_at" marker) keeps each push O(new events).
    @Query("SELECT track_key, played_at FROM play_events WHERE device_id = :deviceId AND played_at > :sinceMillis")
    suspend fun getLocalPlayEventsSince(deviceId: String, sinceMillis: Long): List<PlayEventRow>
}
