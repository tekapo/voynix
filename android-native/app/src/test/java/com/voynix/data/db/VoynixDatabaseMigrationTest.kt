package com.voynix.data.db

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Guards the removal of fallbackToDestructiveMigration() from VoynixDatabase.
 * Before that change, any schema bump without a matching Migration() silently
 * dropped every table — local track metadata, unsynced play history,
 * favorites, settings. Now it must fail loudly instead (validated below), and
 * an ordinary restart at an unchanged version must keep existing rows.
 */
@RunWith(RobolectricTestRunner::class)
class VoynixDatabaseMigrationTest {

    // Reads the schema JSON exported by ksp (room.schemaLocation, see
    // app/build.gradle.kts) from the "schemas/" test assets dir wired up in
    // the same file.
    @get:Rule
    val helper: MigrationTestHelper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        VoynixDatabase::class.java,
    )

    @Test
    fun `exported v4 schema opens cleanly with zero migrations`() {
        // Builds a DB from the committed schemas/.../4.json and asks Room to
        // validate it against the live @Database/@Entity definitions. If
        // someone edits an entity without bumping `version` and exporting a
        // new schema, this fails — the safety net that replaces the old
        // destructive fallback.
        helper.createDatabase(DB_NAME, 4).close()
        helper.runMigrationsAndValidate(DB_NAME, 4, true)
    }

    @Test
    fun `migrating v2 to v3 adds artist_covers without touching existing rows`() {
        val v2 = helper.createDatabase(DB_NAME, 2)
        v2.execSQL(
            "INSERT INTO tracks (id, title, artist, album, file_path, file_name, duration, track_key, content_hash, favorite, origin, kind, resume_position, play_state) " +
                "VALUES ('t1', 'Title', 'Artist', 'Album', '/mac/t1.mp3', 't1.mp3', 180.0, 'k1', 'hash-t1', 0, 'mirror', 'music', 0.0, 'unplayed')"
        )
        v2.close()

        val v3 = helper.runMigrationsAndValidate(DB_NAME, 3, true, VoynixDatabase.MIGRATION_2_3)
        val cursor = v3.query("SELECT title FROM tracks WHERE id = 't1'")
        assertEquals(true, cursor.moveToFirst())
        assertEquals("Title", cursor.getString(0))
        cursor.close()
        v3.close()
    }

    @Test
    fun `migrating v3 to v4 adds added_at without touching existing rows`() {
        val v3 = helper.createDatabase(DB_NAME, 3)
        v3.execSQL(
            "INSERT INTO tracks (id, title, artist, album, file_path, file_name, duration, track_key, content_hash, favorite, origin, kind, resume_position, play_state) " +
                "VALUES ('t1', 'Title', 'Artist', 'Album', '/mac/t1.mp3', 't1.mp3', 180.0, 'k1', 'hash-t1', 0, 'mirror', 'music', 0.0, 'unplayed')"
        )
        v3.close()

        val v4 = helper.runMigrationsAndValidate(DB_NAME, 4, true, VoynixDatabase.MIGRATION_3_4)
        val cursor = v4.query("SELECT title, added_at FROM tracks WHERE id = 't1'")
        assertEquals(true, cursor.moveToFirst())
        assertEquals("Title", cursor.getString(0))
        assertEquals(true, cursor.isNull(1))
        cursor.close()
        v4.close()
    }

    @Test
    fun `reopening the database at the same version preserves existing rows`() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.deleteDatabase(DB_NAME)

        val first = Room.databaseBuilder(context, VoynixDatabase::class.java, DB_NAME).build()
        first.trackDao().upsertMirrorTrack(
            id = "t1", title = "Title", artist = "Artist", album = "Album", filePath = "/mac/t1.mp3",
            fileName = "t1.mp3", duration = 180.0, trackKey = "k1", contentHash = "hash-t1",
            favorite = false, favoriteUpdatedAt = null, kind = "music", discNo = null, trackNo = null,
            playState = "unplayed", resumePosition = 0.0, playStateUpdatedAt = null, addedAt = null,
        )
        first.close()

        // A second Room instance over the same file, same version, no
        // migrations — this is what an ordinary app restart does. Before
        // removing fallbackToDestructiveMigration(dropAllTables = true), Room
        // never even needed to run it here (versions match), so this mainly
        // documents the invariant the removal must not break.
        val reopened = Room.databaseBuilder(context, VoynixDatabase::class.java, DB_NAME).build()
        val row = reopened.trackDao().getById("t1")
        reopened.close()

        assertNotNull(row)
        assertEquals("Title", row?.title)
    }

    companion object {
        private const val DB_NAME = "migration-test.db"
    }
}
