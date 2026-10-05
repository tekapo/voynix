// Backup file shape + pure (DB-free) parsing/validation logic for the
// "export/import playlists, folders & settings" feature (desktop only). The
// DB-touching half (buildBackup/importSettings/importPlaylists) lives in
// db/backup.ts; this file exists so the format can be pinned by unit tests
// without a real SQLite instance.
import { SmartRules, TrackKind } from "./types";
import { sanitizeSmartRules } from "./smartPlaylist";

export const BACKUP_FORMAT = "voynix-backup";
export const BACKUP_VERSION = 2;

// Only these settings travel in a backup — everything else is either
// per-device identity (device_id, sync_token, sync_server_port) or session
// state that shouldn't be replayed onto another install (last_*,
// json_migrated). Keep this in sync with db/settings.ts's key list.
export const BACKUP_SETTING_KEYS = [
    "ui_language",
    "show_path_column",
    "podcast_no_shuffle",
    "podcast_speed",
    "lyrics_panel_open",
    "library_layout_artists",
    "library_layout_albums",
    "sync_server_autostart",
    "transcode_format",
    "transcode_bitrate",
    "library_sync_sources",
] as const;

export type BackupSettingKey = typeof BACKUP_SETTING_KEYS[number];

export interface BackupTrack {
    file_path: string;
    file_name: string;
    title: string;
    artist?: string | null;
    album?: string | null;
    duration?: number | null;
    track_key?: string | null;
    content_hash?: string | null;
    disc_no?: number | null;
    track_no?: number | null;
    genre?: string | null;
    year?: number | null;
    album_artist?: string | null;
    composer?: string | null;
}

export interface BackupFolder {
    path: string;
    default_kind: TrackKind;
    /** The folder's own playlist row — only its non-`tracks` metadata; the
     *  member tracks are re-derived from a fresh scan on import, not carried
     *  in the backup (they'd usually be stale anyway). `id` is kept only so a
     *  smart playlist's `playlist in/not_in` condition can be remapped onto
     *  whatever id the re-scanned folder playlist gets on import — it is not
     *  reused as the new playlist's id (registerFolder always mints a fresh
     *  one, the same as adding the folder by hand). */
    playlist: {
        id: string;
        kind: TrackKind;
        sync_to_device: number;
        manual_order: number;
        /** file_path order, present only when manual_order is 1 — restored
         *  onto the freshly-scanned playlist the same way a rescan does. */
        track_paths?: string[];
    } | null;
}

export interface BackupPlaylist {
    id: string;
    name: string;
    type: 'custom' | 'xml';
    kind: TrackKind;
    sync_to_device: number;
    tracks: BackupTrack[];
}

export interface BackupSmartPlaylist {
    id: string;
    name: string;
    type: 'smart';
    rules: SmartRules;
}

/** A cover/image override stored as a file inside the backup ZIP (not inline
 *  in the JSON — base64 would bloat it by a third). `artist`/`album` are the
 *  already-normalized keys the DB holds (see covers.ts), `file` the ZIP path. */
export interface BackupArtistCover {
    artist: string;
    file: string;
    updated_at: number;
}

export interface BackupAlbumCover extends BackupArtistCover {
    album: string;
}

export interface BackupFile {
    format: typeof BACKUP_FORMAT;
    version: number;
    exported_at: number;
    app_version: string;
    settings: Partial<Record<BackupSettingKey, string>>;
    folders: BackupFolder[];
    playlists: (BackupPlaylist | BackupSmartPlaylist)[];
    /** v2+, ZIP backups only; absent in plain-JSON / v1 backups. */
    artist_covers?: BackupArtistCover[];
    album_covers?: BackupAlbumCover[];
}

export type BackupErrorKey =
    | "backup.errors.invalidJson"
    | "backup.errors.invalidFormat"
    | "backup.errors.unsupportedVersion"
    | "backup.errors.invalidArchive";

export class BackupParseError extends Error {
    /** i18n key under `backup.errors.*`, for a translated message in the UI. */
    constructor(public readonly i18nKey: BackupErrorKey, message: string) {
        super(message);
        this.name = "BackupParseError";
    }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate a backup file's JSON text. Throws BackupParseError with an
 * i18n key on anything malformed, rather than letting a shape mismatch crash
 * deeper in the import pipeline (createPlaylist, addTracksToPlaylist, …).
 */
export function parseBackup(text: string): BackupFile {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new BackupParseError("backup.errors.invalidJson", "Not valid JSON");
    }
    if (!isPlainObject(raw)) {
        throw new BackupParseError("backup.errors.invalidFormat", "Backup root must be an object");
    }
    if (raw.format !== BACKUP_FORMAT) {
        throw new BackupParseError("backup.errors.invalidFormat", `Unexpected format: ${String(raw.format)}`);
    }
    if (typeof raw.version !== "number" || raw.version > BACKUP_VERSION) {
        throw new BackupParseError("backup.errors.unsupportedVersion", `Unsupported version: ${String(raw.version)}`);
    }
    if (!isPlainObject(raw.settings)) {
        throw new BackupParseError("backup.errors.invalidFormat", "settings must be an object");
    }
    if (!Array.isArray(raw.folders)) {
        throw new BackupParseError("backup.errors.invalidFormat", "folders must be an array");
    }
    if (!Array.isArray(raw.playlists)) {
        throw new BackupParseError("backup.errors.invalidFormat", "playlists must be an array");
    }

    const settings: Partial<Record<BackupSettingKey, string>> = {};
    for (const key of BACKUP_SETTING_KEYS) {
        const v = (raw.settings as Record<string, unknown>)[key];
        if (typeof v === "string") settings[key] = v;
    }

    const folders: BackupFolder[] = [];
    for (const f of raw.folders) {
        if (!isPlainObject(f) || typeof f.path !== "string") continue;
        const pl = isPlainObject(f.playlist) && typeof f.playlist.id === "string" ? f.playlist : null;
        folders.push({
            path: f.path,
            default_kind: (f.default_kind as TrackKind) ?? 'music',
            playlist: pl ? {
                id: pl.id as string,
                kind: (pl.kind as TrackKind) ?? 'music',
                sync_to_device: typeof pl.sync_to_device === "number" ? pl.sync_to_device : 0,
                manual_order: typeof pl.manual_order === "number" ? pl.manual_order : 0,
                track_paths: Array.isArray(pl.track_paths)
                    ? pl.track_paths.filter((p): p is string => typeof p === "string")
                    : undefined,
            } : null,
        });
    }

    const playlists: (BackupPlaylist | BackupSmartPlaylist)[] = [];
    for (const p of raw.playlists) {
        if (!isPlainObject(p) || typeof p.id !== "string" || typeof p.name !== "string") continue;
        if (p.type === 'smart') {
            // Validated, not just cast: a malformed condition would otherwise throw while the
            // import is half-applied, or later while rendering/evaluating the playlist.
            const rules = sanitizeSmartRules(p.rules);
            if (!rules) continue;
            playlists.push({ id: p.id, name: p.name, type: 'smart', rules });
        } else if (p.type === 'custom' || p.type === 'xml') {
            const tracks: BackupTrack[] = Array.isArray(p.tracks)
                ? p.tracks.filter((t): t is Record<string, unknown> => isPlainObject(t) && typeof t.file_path === "string" && typeof t.file_name === "string" && typeof t.title === "string")
                    .map(t => ({
                        file_path: t.file_path as string,
                        file_name: t.file_name as string,
                        title: t.title as string,
                        artist: (t.artist as string | null | undefined) ?? null,
                        album: (t.album as string | null | undefined) ?? null,
                        duration: (t.duration as number | null | undefined) ?? null,
                        track_key: (t.track_key as string | null | undefined) ?? null,
                        content_hash: (t.content_hash as string | null | undefined) ?? null,
                        disc_no: (t.disc_no as number | null | undefined) ?? null,
                        track_no: (t.track_no as number | null | undefined) ?? null,
                        genre: (t.genre as string | null | undefined) ?? null,
                        year: (t.year as number | null | undefined) ?? null,
                        album_artist: (t.album_artist as string | null | undefined) ?? null,
                        composer: (t.composer as string | null | undefined) ?? null,
                    }))
                : [];
            playlists.push({
                id: p.id,
                name: p.name,
                type: p.type,
                kind: (p.kind as TrackKind) ?? 'music',
                sync_to_device: typeof p.sync_to_device === "number" ? p.sync_to_device : 0,
                tracks,
            });
        }
    }

    const imageFile = (v: unknown): v is string => typeof v === "string" && v.startsWith("images/") && !v.includes("..");
    const artist_covers: BackupArtistCover[] = Array.isArray(raw.artist_covers)
        ? raw.artist_covers.filter(isPlainObject)
            .filter(c => typeof c.artist === "string" && imageFile(c.file))
            .map(c => ({ artist: c.artist as string, file: c.file as string, updated_at: typeof c.updated_at === "number" ? c.updated_at : 0 }))
        : [];
    const album_covers: BackupAlbumCover[] = Array.isArray(raw.album_covers)
        ? raw.album_covers.filter(isPlainObject)
            .filter(c => typeof c.artist === "string" && typeof c.album === "string" && imageFile(c.file))
            .map(c => ({ artist: c.artist as string, album: c.album as string, file: c.file as string, updated_at: typeof c.updated_at === "number" ? c.updated_at : 0 }))
        : [];

    return {
        format: BACKUP_FORMAT,
        version: raw.version,
        exported_at: typeof raw.exported_at === "number" ? raw.exported_at : 0,
        app_version: typeof raw.app_version === "string" ? raw.app_version : "",
        settings,
        folders,
        playlists,
        artist_covers,
        album_covers,
    };
}

const MIME_BY_EXT: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const EXT_BY_MIME: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Split `data:<mime>;base64,<payload>` into bytes + file extension. Returns
 *  null for anything that isn't a base64 data URI. Unknown mimes fall back to jpg. */
export function dataUriToBytes(uri: string): { ext: string; bytes: Uint8Array } | null {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(uri);
    if (!m) return null;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { ext: EXT_BY_MIME[m[1]] ?? "jpg", bytes };
}

export function bytesToDataUri(path: string, bytes: Uint8Array): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "jpg";
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return `data:${MIME_BY_EXT[ext] ?? "image/jpeg"};base64,${btoa(bin)}`;
}

/**
 * A smart playlist's `playlist in/not_in` condition refers to another
 * playlist by id. When importPlaylists gives an imported playlist a new id
 * (because one with the backed-up id already exists locally, see
 * db/backup.ts), any smart-playlist condition pointing at the old id must
 * follow it — otherwise the rule silently stops matching anything after
 * import. `idMap` maps backed-up id -> resolved local id (identity when the
 * id was reused as-is).
 */
export function remapSmartRules(rules: SmartRules, idMap: Map<string, string>): SmartRules {
    return {
        ...rules,
        conditions: rules.conditions.map(c => {
            if (c.field !== 'playlist') return c;
            return { ...c, value: idMap.get(c.value) ?? c.value };
        }),
    };
}
