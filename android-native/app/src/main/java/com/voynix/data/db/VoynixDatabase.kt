package com.voynix.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        TrackEntity::class,
        PlaylistEntity::class,
        PlaylistTrackEntity::class,
        PlayEventEntity::class,
        SettingEntity::class,
        AlbumCoverEntity::class,
        ArtistCoverEntity::class,
    ],
    version = 4,
    exportSchema = true,
)
abstract class VoynixDatabase : RoomDatabase() {
    abstract fun trackDao(): TrackDao
    abstract fun playlistDao(): PlaylistDao
    abstract fun settingsDao(): SettingsDao
    abstract fun playEventDao(): PlayEventDao
    abstract fun albumCoverDao(): AlbumCoverDao
    abstract fun artistCoverDao(): ArtistCoverDao

    companion object {
        // Adds `artist_covers`, mirroring the `album_covers` table this same
        // migration would have created had it existed at v2. See
        // ArtistCoverEntity's doc comment for the column shapes.
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `artist_covers` (
                        `artist` TEXT NOT NULL,
                        `image_data_uri` TEXT,
                        `updated_at` INTEGER NOT NULL,
                        PRIMARY KEY(`artist`)
                    )
                    """.trimIndent()
                )
            }
        }

        // Adds `tracks.added_at`, mirroring migration 11 in db/migrations.ts —
        // needed for the "Recently Added" smart playlist. Nullable, so
        // existing rows just come back null (not shown in Recently Added)
        // until the next sync backfills it from the Mac's added_at.
        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE tracks ADD COLUMN added_at INTEGER")
            }
        }

        @Volatile
        private var instance: VoynixDatabase? = null

        fun get(context: Context): VoynixDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    VoynixDatabase::class.java,
                    "voynix.db",
                )
                    // No fallbackToDestructiveMigration: a schema bump without a
                    // matching Migration() must fail loudly (crash on open) rather
                    // than silently wipe installed users' track metadata, local
                    // play history, and settings. Add a Migration(n, n+1) here —
                    // and a matching MigrationTest — whenever `version` above changes.
                    .addMigrations(MIGRATION_2_3, MIGRATION_3_4)
                    .build().also { instance = it }
            }
    }
}
