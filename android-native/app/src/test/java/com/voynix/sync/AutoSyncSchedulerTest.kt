package com.voynix.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.WorkManagerTestInitHelper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AutoSyncSchedulerTest {
    private lateinit var context: Context
    private lateinit var workManager: WorkManager

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        val config = Configuration.Builder().build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
        workManager = WorkManager.getInstance(context)
    }

    private fun workInfos(): List<WorkInfo> =
        workManager.getWorkInfosForUniqueWork("auto_sync").get()

    @Test
    fun `enabling enqueues periodic work`() {
        AutoSyncScheduler.reschedule(context, enabled = true, chargingOnly = false)
        val infos = workInfos()
        assertEquals(1, infos.size)
        assertTrue(infos.single().state == WorkInfo.State.ENQUEUED)
    }

    @Test
    fun `disabling cancels the work`() {
        AutoSyncScheduler.reschedule(context, enabled = true, chargingOnly = false)
        AutoSyncScheduler.reschedule(context, enabled = false, chargingOnly = false)

        val infos = workInfos()
        assertTrue(infos.isEmpty() || infos.all { it.state == WorkInfo.State.CANCELLED })
    }

    @Test
    fun `charging-only is reflected in the work's constraints`() {
        AutoSyncScheduler.reschedule(context, enabled = true, chargingOnly = true)
        val info = workInfos().single()
        assertTrue(info.constraints.requiresCharging())

        AutoSyncScheduler.reschedule(context, enabled = true, chargingOnly = false)
        val updated = workInfos().single()
        assertTrue(!updated.constraints.requiresCharging())
    }
}
