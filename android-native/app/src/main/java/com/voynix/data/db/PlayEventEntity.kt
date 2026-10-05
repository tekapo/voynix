package com.voynix.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

// Mirrors the `play_events` table from src/db.ts: an append-only log, one row
// per counted play. play_count is derived by joining on track_key (see
// TRACK_COLUMNS_WITH_STATS in db.ts / TrackDao.getAllWithStats).
@Entity(
    tableName = "play_events",
    indices = [
        Index(value = ["track_key"]),
        Index(value = ["device_id", "played_at"]),
        Index(value = ["device_id", "played_at", "track_key"], unique = true),
    ],
)
data class PlayEventEntity(
    @PrimaryKey
    val id: String,
    @ColumnInfo(name = "track_key")
    val trackKey: String,
    @ColumnInfo(name = "played_at")
    val playedAt: Long,
    @ColumnInfo(name = "device_id")
    val deviceId: String,
)

// Mirrors the `settings` key/value table from src/db.ts (device id, sync
// token, last-playback cursor, etc).
@Entity(tableName = "settings")
data class SettingEntity(
    @PrimaryKey
    val key: String,
    val value: String,
)
