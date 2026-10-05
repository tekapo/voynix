package com.voynix.sync

import com.voynix.data.db.SettingEntity
import com.voynix.data.db.VoynixDatabase
import com.voynix.logic.SyncPeer

/** Persists the paired Mac's url/token/pin/last-sync in `settings`, matching db.ts's getSyncPeer/saveSyncPeer/clearSyncPeer. */
class SyncPeerStore(private val db: VoynixDatabase) {
    suspend fun get(): SyncPeer? {
        val dao = db.settingsDao()
        val url = dao.get(KEY_URL) ?: return null
        val token = dao.get(KEY_TOKEN) ?: return null
        val pin = dao.get(KEY_PIN)
        // A peer saved before the TLS migration (http:// URL, no pin) can't
        // be trusted over HTTPS — treat it as unpaired so the UI asks to re-pair.
        if (!url.startsWith("https://") || pin.isNullOrEmpty()) return null
        val lastSync = dao.get(KEY_LAST_SYNC)?.toLongOrNull()
        return SyncPeer(url, token, lastSync, pin)
    }

    suspend fun save(url: String, token: String, pin: String) {
        val dao = db.settingsDao()
        // A different Mac (or a reinstalled one) hasn't received any of this
        // phone's play history yet — start the push watermark over.
        if (dao.get(KEY_PIN) != pin.trim()) resetStatsWatermarks()
        dao.set(SettingEntity(KEY_URL, url.trim().trimEnd('/')))
        dao.set(SettingEntity(KEY_TOKEN, token.trim()))
        dao.set(SettingEntity(KEY_PIN, pin.trim()))
    }

    /** True if a peer was saved before the TLS migration (rejected by [get] as unpaired). */
    suspend fun hasStaleHttpPeer(): Boolean {
        val dao = db.settingsDao()
        val url = dao.get(KEY_URL) ?: return false
        return !url.startsWith("https://") || dao.get(KEY_PIN).isNullOrEmpty()
    }

    suspend fun setLastSync(atMillis: Long) {
        db.settingsDao().set(SettingEntity(KEY_LAST_SYNC, atMillis.toString()))
    }

    suspend fun clear() {
        val dao = db.settingsDao()
        dao.delete(KEY_URL)
        dao.delete(KEY_TOKEN)
        dao.delete(KEY_PIN)
        dao.delete(KEY_LAST_SYNC)
        resetStatsWatermarks()
    }

    private suspend fun resetStatsWatermarks() {
        val dao = db.settingsDao()
        dao.delete(SyncEngine.LAST_STATS_PUSH_KEY)
        dao.delete(SyncEngine.LAST_STATS_FULL_PUSH_KEY)
    }

    private companion object {
        const val KEY_URL = "sync_peer_url"
        const val KEY_TOKEN = "sync_peer_token"
        const val KEY_PIN = "sync_peer_pin"
        const val KEY_LAST_SYNC = "sync_peer_last_sync"
    }
}
