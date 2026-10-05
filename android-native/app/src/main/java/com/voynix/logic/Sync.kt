package com.voynix.logic

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicInteger

// Pure reconciliation logic for the Android (client) side of sync, ported
// from src/sync.ts. No network or DB here so the diffing stays unit-testable.

data class SyncProgress(
    val phase: String,
    val message: String,
    /** Item count within the current phase, when the phase tracks one. */
    val current: Int? = null,
    val total: Int? = null,
)

data class SyncSummary(
    val added: Int,
    val refetched: Int,
    val deleted: Int,
    val playlists: Int,
    val errors: List<String>,
)

/** Mirrors one entry of SyncSnapshot.tracks (the Mac's /api/manifest response). */
data class ManifestTrack(
    val trackKey: String,
    val title: String,
    val artist: String?,
    val album: String?,
    val duration: Double?,
    val fileName: String,
    val filePath: String,
    val contentHash: String,
    /** Byte length of the file to download; 0 when unknown. */
    val size: Long,
    val favorite: Boolean,
    val favoriteUpdatedAt: Long?,
    val kind: TrackKind,
    val discNo: Int?,
    val trackNo: Int?,
    val playState: PlayState,
    val resumePosition: Double,
    val playStateUpdatedAt: Long?,
    val addedAt: Long?,
)

/** Mirrors one entry of SyncSnapshot.playlists. */
data class ManifestPlaylist(
    val id: String,
    val name: String,
    val kind: TrackKind,
    val trackKeys: List<String>,
)

// The metadata fields deliberately have no defaults: a default would let a test
// fixture agree with a manifest fixture by accident.
data class LocalMirrorTrack(
    val id: String,
    val trackKey: String,
    val contentHash: String?,
    val filePath: String,
    val title: String,
    val artist: String?,
    val album: String?,
    val duration: Double?,
    val kind: TrackKind,
    val discNo: Int?,
    val trackNo: Int?,
    val addedAt: Long?,
)

data class LocalMirrorPlaylist(
    val id: String,
    val name: String,
    val kind: TrackKind,
    /** Current membership, ordered by position. */
    val trackIds: List<String>,
)

data class TrackPlan(
    /** In the manifest, no local copy — download. */
    val toAdd: List<ManifestTrack> = emptyList(),
    /** Local copy exists but the byte fingerprint changed — re-download. */
    val toRefetch: List<ManifestTrack> = emptyList(),
    /** Same file, but title/artist/album/duration/kind/disc/track number changed. */
    val toUpdateMeta: List<ManifestTrack> = emptyList(),
    /** Local mirror track no longer in the manifest — delete (file + row). */
    val toDelete: List<LocalMirrorTrack> = emptyList(),
)

fun diffTracks(manifest: List<ManifestTrack>, local: List<LocalMirrorTrack>): TrackPlan {
    val localByKey = local.associateBy { it.trackKey }
    val manifestKeys = manifest.mapTo(HashSet()) { it.trackKey }

    val toAdd = mutableListOf<ManifestTrack>()
    val toRefetch = mutableListOf<ManifestTrack>()
    val toUpdateMeta = mutableListOf<ManifestTrack>()

    for (t in manifest) {
        val existing = localByKey[t.trackKey]
        when {
            existing == null -> toAdd.add(t)
            (existing.contentHash ?: "") != t.contentHash -> toRefetch.add(t)
            !metaMatches(existing, t) -> toUpdateMeta.add(t)
            // else: identical bytes and identical metadata — nothing to do.
        }
    }
    val toDelete = local.filter { it.trackKey !in manifestKeys }
    return TrackPlan(toAdd, toRefetch, toUpdateMeta, toDelete)
}

/**
 * Whether the manifest's metadata already matches what's stored, i.e. whether
 * `updateMirrorTrackMeta(...)` would be a no-op. Compares exactly — and only —
 * the columns that UPDATE writes.
 *
 * Deliberately NOT compared: content_hash (already the toRefetch discriminator)
 * and favorite / favorite_updated_at / play_state / resume_position /
 * play_state_updated_at / kind_updated_at. Those are LWW fields merged by
 * applyManifestStats, and updateMirrorTrackMeta doesn't write them — comparing
 * any of them would flag the track on every sync forever, because the resulting
 * UPDATE could never make them agree.
 *
 * artist/album use exact equality (no null-vs-empty normalization): if the two
 * ever disagree, one UPDATE writes the manifest's value and the next sync
 * matches. Normalizing would leave the columns silently different forever.
 *
 * addedAt is included so a track mirrored before the added_at column existed
 * (local null) gets backfilled from the Mac's value on the first sync after
 * the app update, without needing a full re-download.
 */
internal fun metaMatches(local: LocalMirrorTrack, m: ManifestTrack): Boolean =
    local.title == m.title &&
        local.artist == m.artist &&
        local.album == m.album &&
        local.kind == m.kind &&
        local.discNo == m.discNo &&
        local.trackNo == m.trackNo &&
        local.addedAt == m.addedAt &&
        durationsEqual(local.duration, m.duration)

/**
 * Durations round-trip bit-exactly today (Rust f64 -> serde_json -> kotlinx
 * Double -> SQLite REAL, all IEEE-754 binary64), so `==` would work too. The
 * epsilon guards against a future lossy hop: sub-millisecond drift is not a
 * metadata change worth an UPDATE.
 */
private fun durationsEqual(a: Double?, b: Double?): Boolean = when {
    a == null || b == null -> a == b
    else -> kotlin.math.abs(a - b) < 1e-3
}

data class PlaylistPlan(
    val toUpsert: List<ManifestPlaylist>,
    val toDelete: List<LocalMirrorPlaylist>,
)

/**
 * [resolveTrackId] maps a manifest track_key to the local track id, or null when
 * the track isn't present locally (download failed or not yet happened) — the
 * same resolution the upsert itself uses.
 *
 * A playlist is skipped only when the upsert would be a literal no-op: same name,
 * same kind and the same *resolved* id list as what's stored. Comparing resolved
 * ids rather than the manifest's track_keys is what makes this self-healing: an
 * unresolvable key is in neither list, and once its track downloads the resolved
 * list changes and the playlist is upserted.
 */
fun diffPlaylists(
    manifest: List<ManifestPlaylist>,
    local: List<LocalMirrorPlaylist>,
    resolveTrackId: (String) -> String?,
): PlaylistPlan {
    val manifestIds = manifest.mapTo(HashSet()) { it.id }
    val localById = local.associateBy { it.id }
    return PlaylistPlan(
        toUpsert = manifest.filter { p ->
            val existing = localById[p.id] ?: return@filter true
            existing.name != p.name ||
                existing.kind != p.kind ||
                existing.trackIds != resolvedTrackIds(p, resolveTrackId)
        },
        toDelete = local.filter { it.id !in manifestIds },
    )
}

/**
 * The exact id list an upsert stores: unresolvable keys dropped, repeats removed
 * keep-first. Must match PlaylistDao.upsertMirrorPlaylist (playlist_tracks' PK is
 * (playlist_id, track_id), so a repeated id can't be stored twice) — otherwise a
 * playlist with a repeated track would differ from its stored form on every sync.
 */
fun resolvedTrackIds(p: ManifestPlaylist, resolveTrackId: (String) -> String?): List<String> =
    p.trackKeys.mapNotNull(resolveTrackId).distinct()

/**
 * Whether [freeBytes] can hold [neededBytes] while keeping [cushionBytes] spare.
 * A null [freeBytes] (couldn't be read) is treated as "proceed".
 */
fun hasEnoughSpace(neededBytes: Long, freeBytes: Long?, cushionBytes: Long): Boolean {
    if (freeBytes == null) return true
    return freeBytes >= neededBytes + cushionBytes
}

// ---- Peer self-healing --------------------------------------------------
// The saved peer's port goes stale whenever the Mac restarts (its HTTP server
// binds a fresh ephemeral port unless it can reclaim the last one). Rather
// than make the user re-pair, a sync probes the saved URL first and, if it's
// dead, re-resolves the same Mac via mDNS using the still-valid saved token.

enum class PeerProbeResult { OK, UNAUTHORIZED, UNREACHABLE }

data class SyncPeer(
    val url: String,
    val token: String,
    val lastSyncAt: Long?,
    /** SHA-256 of the Mac's TLS public key (SPKI), lowercase hex; pinned at
     *  pairing time. Null only for a peer saved before the TLS migration —
     *  such a peer is treated as unpaired (see `SyncPeerStore.get`). */
    val pin: String?,
)

data class DiscoveredPeer(val name: String, val host: String, val port: Int, val url: String)

data class ResolvedPeer(
    val peer: SyncPeer,
    /** Set when the URL differs from what was passed in, so the caller persists the correction. */
    val changed: Boolean,
)

class PeerUnauthorizedError : Exception("Pairing was reset on the Mac. Please pair again.")
class PeerUnreachableError : Exception("Mac not found. Check that the sync server is running on the Mac.")

/**
 * Confirms [peer.url] is still live, or finds where the same Mac moved to.
 *
 * [probe] should hit a cheap authenticated endpoint (/api/ping) and never
 * throw. [discover] should list current mDNS candidates.
 */
suspend fun resolvePeer(
    peer: SyncPeer,
    probe: suspend (url: String, token: String, pin: String?) -> PeerProbeResult,
    discover: suspend () -> List<DiscoveredPeer>,
): ResolvedPeer {
    val direct = probe(peer.url, peer.token, peer.pin)
    if (direct == PeerProbeResult.OK) return ResolvedPeer(peer, changed = false)

    if (direct == PeerProbeResult.UNAUTHORIZED) {
        // The Mac's token changed (or was cleared) — no candidate will pass a
        // probe with our stale token, so don't bother discovering.
        throw PeerUnauthorizedError()
    }

    // Rediscovery still requires the *same* pin to pass — an mDNS responder
    // that isn't the paired Mac (or a spoofed one) fails the TLS handshake
    // here even if it happens to accept the stale token.
    for (c in discover()) {
        if (c.url == peer.url) continue // already known dead
        if (probe(c.url, peer.token, peer.pin) == PeerProbeResult.OK) {
            return ResolvedPeer(peer.copy(url = c.url), changed = true)
        }
    }
    throw PeerUnreachableError()
}

/** What the sync screen shows for the saved peer: saved ≠ reachable, so this is checked, not assumed. */
enum class PeerConnection { CHECKING, CONNECTED, UNREACHABLE, UNAUTHORIZED }

/**
 * [resolvePeer] folded into a [PeerConnection], for showing the saved peer's
 * state without syncing. Same self-heal as a real sync: a Mac that moved is
 * re-found over mDNS and reported via [onPeerMoved] so the caller persists it.
 */
suspend fun checkPeerConnection(
    peer: SyncPeer,
    probe: suspend (url: String, token: String, pin: String?) -> PeerProbeResult,
    discover: suspend () -> List<DiscoveredPeer>,
    onPeerMoved: suspend (SyncPeer) -> Unit = {},
): PeerConnection =
    try {
        val resolved = resolvePeer(peer, probe = probe, discover = discover)
        if (resolved.changed) onPeerMoved(resolved.peer)
        PeerConnection.CONNECTED
    } catch (e: PeerUnauthorizedError) {
        PeerConnection.UNAUTHORIZED
    } catch (e: PeerUnreachableError) {
        PeerConnection.UNREACHABLE
    }

/** Runs [worker] over [items] with at most [limit] coroutines in flight at once. */
suspend fun <T> pool(items: List<T>, limit: Int, worker: suspend (T, Int) -> Unit) {
    if (items.isEmpty()) return
    val next = AtomicInteger(0)
    coroutineScope {
        repeat(limit.coerceIn(1, items.size)) {
            launch {
                while (true) {
                    val i = next.getAndIncrement()
                    if (i >= items.size) break
                    worker(items[i], i)
                }
            }
        }
    }
}

/**
 * Cleans up hand-typed pairing input: trims whitespace and folds full-width
 * ASCII (U+FF01..U+FF5E, e.g. from a Japanese keyboard) and the ideographic
 * space to half-width. Without this a full-width character in the token ends
 * up in the Authorization header, which OkHttp rejects with an exception.
 */
fun normalizePairingInput(raw: String): String =
    buildString {
        for (c in raw.trim()) {
            when {
                c in '！'..'～' -> append((c.code - 0xFEE0).toChar())
                c == '　' -> append(' ')
                else -> append(c)
            }
        }
    }.trim()

/** What the Mac's pairing QR code carries — see `pairingQrPayload` in src/syncPairing.ts. */
data class PairingQr(val url: String, val token: String, val fingerprint: String)

private val FINGERPRINT_HEX = Regex("[0-9a-f]{64}")

/**
 * Parses `voynix://pair?u=<url>&t=<token>&fp=<sha256 hex>`; null for anything
 * else (a stranger's QR code, a truncated scan). Shared contract with the Mac
 * side via docs/test-vectors/pairing-qr.json.
 */
fun parsePairingQr(raw: String): PairingQr? {
    val prefix = "voynix://pair?"
    val text = raw.trim()
    if (!text.startsWith(prefix)) return null
    val params = text.removePrefix(prefix).split('&').mapNotNull { part ->
        val i = part.indexOf('=')
        if (i <= 0) null else part.substring(0, i) to runCatching { java.net.URLDecoder.decode(part.substring(i + 1).replace("+", "%2B"), "UTF-8") }.getOrNull()
    }.toMap()
    val url = params["u"]?.takeIf { it.startsWith("https://") } ?: return null
    val token = params["t"]?.takeIf { it.isNotEmpty() } ?: return null
    val fingerprint = params["fp"]?.lowercase()?.takeIf { FINGERPRINT_HEX.matches(it) } ?: return null
    return PairingQr(url, token, fingerprint)
}
