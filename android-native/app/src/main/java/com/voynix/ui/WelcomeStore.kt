package com.voynix.ui

import com.voynix.data.db.SettingEntity
import com.voynix.data.db.VoynixDatabase

/** Remembers in `settings` that the first-launch welcome guide has been shown. */
class WelcomeStore(private val db: VoynixDatabase) {
    suspend fun isSeen(): Boolean = db.settingsDao().get(KEY_SEEN) == "1"

    suspend fun markSeen() {
        db.settingsDao().set(SettingEntity(KEY_SEEN, "1"))
    }

    private companion object {
        const val KEY_SEEN = "welcome_seen"
    }
}
