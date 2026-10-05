import { getDb } from "./core";
import { isLibrarySyncSource, LibrarySyncSource } from "../smartLists";

export async function getSetting(key: string): Promise<string | null> {
    const db = await getDb();
    const rows: any[] = await db.select("SELECT value FROM settings WHERE key = $1", [key]);
    return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string) {
    const db = await getDb();
    await db.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value]
    );
}

// ---- Last-playback restore -------------------------------------------------
// The playing track / position / view live only in React state, so a cold
// start (Android killed the process) would otherwise reset to the first track
// at 0:00. We persist a lightweight cursor here and re-arm it on launch.

export interface LastPlayback {
    trackId: string;
    position: number;
    viewMode: string;
    playlistId: string | null;
    viewFilter: string | null;
}

export async function saveLastPlayback(p: LastPlayback) {
    await setSetting("last_track_id", p.trackId);
    await setSetting("last_position", String(Math.max(0, Math.floor(p.position))));
    await setSetting("last_view_mode", p.viewMode);
    await setSetting("last_playlist_id", p.playlistId ?? "");
    await setSetting("last_view_filter", p.viewFilter ?? "");
}

export async function loadLastPlayback(): Promise<LastPlayback | null> {
    const trackId = await getSetting("last_track_id");
    if (!trackId) return null;
    return {
        trackId,
        position: Number(await getSetting("last_position")) || 0,
        viewMode: (await getSetting("last_view_mode")) || "all_songs",
        playlistId: (await getSetting("last_playlist_id")) || null,
        viewFilter: (await getSetting("last_view_filter")) || null,
    };
}

/** Random per-install identifier, used to attribute play events and pair devices. */
export async function getDeviceId(): Promise<string> {
    let id = await getSetting("device_id");
    if (!id) {
        id = crypto.randomUUID();
        await setSetting("device_id", id);
    }
    return id;
}

/** Bearer token a paired device must present. Stable across server restarts. */
export async function getSyncToken(): Promise<string> {
    let token = await getSetting("sync_token");
    if (!token) {
        token = crypto.randomUUID().replace(/-/g, "");
        await setSetting("sync_token", token);
    }
    return token;
}

/**
 * The last port the sync server bound, so a Mac restart can ask to reuse it
 * (server.rs falls back to an ephemeral port if it's taken). Without this a
 * paired phone's saved URL goes stale on every restart.
 */
export async function getSyncServerPort(): Promise<number | null> {
    const raw = await getSetting("sync_server_port");
    const port = raw ? Number(raw) : NaN;
    return Number.isInteger(port) && port > 0 ? port : null;
}

export async function setSyncServerPort(port: number) {
    await setSetting("sync_server_port", String(port));
}

export type TranscodeFormat = "aac" | "flac";

/** UI-configurable sync transcode target. Defaults
 *  to the long-standing 256k AAC when unset. */
export async function getTranscodeOptions(): Promise<{ format: TranscodeFormat; bitrate: number }> {
    const [formatRaw, bitrateRaw] = await Promise.all([
        getSetting("transcode_format"),
        getSetting("transcode_bitrate"),
    ]);
    const format: TranscodeFormat = formatRaw === "flac" ? "flac" : "aac";
    const bitrate = Number(bitrateRaw);
    return { format, bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 256000 };
}

export async function setTranscodeFormat(format: TranscodeFormat) {
    await setSetting("transcode_format", format);
}

export async function setTranscodeBitrate(bitrate: number) {
    await setSetting("transcode_bitrate", String(bitrate));
}

/** Sidebar Library entries flagged "Sync to Device" (stored as a JSON array). */
export async function getLibrarySyncSources(): Promise<LibrarySyncSource[]> {
    try {
        const parsed = JSON.parse((await getSetting("library_sync_sources")) ?? "[]");
        return Array.isArray(parsed) ? parsed.filter(isLibrarySyncSource) : [];
    } catch {
        return [];
    }
}

export async function setLibrarySyncSources(sources: LibrarySyncSource[]) {
    await setSetting("library_sync_sources", JSON.stringify(sources));
}
