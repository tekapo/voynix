package com.voynix.data.db

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SettingsDaoTest {
    private lateinit var db: VoynixDatabase
    private lateinit var dao: SettingsDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), VoynixDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        dao = db.settingsDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `get returns null for a missing key`() = runTest {
        assertNull(dao.get("device_id"))
    }

    @Test
    fun `set upserts a value`() = runTest {
        dao.set(SettingEntity("device_id", "abc"))
        assertEquals("abc", dao.get("device_id"))

        dao.set(SettingEntity("device_id", "xyz"))
        assertEquals("xyz", dao.get("device_id"))
    }

    @Test
    fun `delete removes a key`() = runTest {
        dao.set(SettingEntity("last_track_id", "t1"))
        dao.delete("last_track_id")
        assertNull(dao.get("last_track_id"))
    }
}
