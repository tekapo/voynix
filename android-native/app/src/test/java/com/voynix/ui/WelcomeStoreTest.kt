package com.voynix.ui

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.voynix.data.db.VoynixDatabase
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class WelcomeStoreTest {
    private lateinit var db: VoynixDatabase

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), VoynixDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun `is not seen by default`() = runTest {
        assertFalse(WelcomeStore(db).isSeen())
    }

    @Test
    fun `markSeen persists across store instances`() = runTest {
        WelcomeStore(db).markSeen()
        assertTrue(WelcomeStore(db).isSeen())
    }
}
