import { exists } from "@tauri-apps/plugin-fs";
import { getDb } from "./core";
import { getSetting, setSetting } from "./settings";
import { getPlaylists, createPlaylist, createSmartPlaylist, linkTracksToPlaylist } from "./playlists";
import { setPlaylistKind } from "./tracks";
import { setPlaylistSyncToDevice } from "./syncSnapshot";
import {
    BACKUP_FORMAT,
    BACKUP_SETTING_KEYS,
    BACKUP_VERSION,
    BackupFile,
    BackupFolder,
    BackupPlaylist,
    BackupSmartPlaylist,
    BackupTrack,
    BackupAlbumCover,
    BackupArtistCover,
    bytesToDataUri,
    dataUriToBytes,
    remapSmartRules,
} from "../backup";
import { Track } from "../types";
import { getAllAlbumCovers, getAllArtistCovers, getAlbumCoverKeys, getArtistCoverKeys, applyAlbumCovers, applyArtistCovers } from "./covers";

/** Everything buildBackup needs to know about the app to fill in `app_version`. */
export async function buildBackup(appVersion: string): Promise<BackupFile> {
    const playlists = await getPlaylists();

    const settings: BackupFile["settings"] = {};
    for (const key of BACKUP_SETTING_KEYS) {
        const v = await getSetting(key);
        if (v !== null) settings[key] = v;
    }

    const folders: BackupFolder[] = [];
    const backedUpPlaylists: (BackupPlaylist | BackupSmartPlaylist)[] = [];

    for (const pl of playlists) {
        if (pl.type === 'folder') continue; // handled via scan_folders below
        if (pl.type === 'mirror') continue; // received over sync, not user-authored
        if (pl.type === 'smart') {
            backedUpPlaylists.push({ id: pl.id, name: pl.name, type: 'smart', rules: pl.rules! });
        } else {
            backedUpPlaylists.push({
                id: pl.id,
                name: pl.name,
                type: pl.type,
                kind: pl.kind ?? 'music',
                sync_to_device: pl.sync_to_device ?? 0,
                tracks: pl.tracks.map(trackToBackup),
            });
        }
    }

    const db = await getDb();
    const scanFolders: { path: string; playlist_id: string | null; default_kind: string | null }[] =
        await db.select("SELECT path, playlist_id, default_kind FROM scan_folders ORDER BY added_at ASC");

    for (const sf of scanFolders) {
        const pl = sf.playlist_id ? playlists.find(p => p.id === sf.playlist_id) : undefined;
        folders.push({
            path: sf.path,
            default_kind: (sf.default_kind as BackupFolder["default_kind"]) ?? 'music',
            playlist: pl ? {
                id: pl.id,
                kind: pl.kind ?? 'music',
                sync_to_device: pl.sync_to_device ?? 0,
                manual_order: pl.manual_order ?? 0,
                track_paths: pl.manual_order ? pl.tracks.map(t => t.file_path) : undefined,
            } : null,
        });
    }

    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: Date.now(),
        app_version: appVersion,
        settings,
        folders,
        playlists: backedUpPlaylists,
    };
}

/** Cover/image overrides as ZIP entries: JSON references + `path -> bytes`. */
export async function buildCoverImages(): Promise<{
    artist_covers: BackupArtistCover[];
    album_covers: BackupAlbumCover[];
    images: Map<string, Uint8Array>;
}> {
    const images = new Map<string, Uint8Array>();
    const artist_covers: BackupArtistCover[] = [];
    const album_covers: BackupAlbumCover[] = [];
    const pad = (n: number) => String(n).padStart(4, "0");

    for (const c of await getAllArtistCovers()) {
        const img = c.image_data_uri ? dataUriToBytes(c.image_data_uri) : null;
        if (!img) continue;
        const file = `images/artists/${pad(artist_covers.length + 1)}.${img.ext}`;
        images.set(file, img.bytes);
        artist_covers.push({ artist: c.artist, file, updated_at: c.updated_at });
    }
    for (const c of await getAllAlbumCovers()) {
        const img = c.image_data_uri ? dataUriToBytes(c.image_data_uri) : null;
        if (!img) continue;
        const file = `images/albums/${pad(album_covers.length + 1)}.${img.ext}`;
        images.set(file, img.bytes);
        album_covers.push({ artist: c.artist, album: c.album, file, updated_at: c.updated_at });
    }
    return { artist_covers, album_covers, images };
}

export interface ImportCoversResult {
    artistImagesAdded: number;
    albumCoversAdded: number;
}

/** Local wins: only artists/albums with no row at all (a cleared `null` row
 *  counts as set, so a deliberate reset isn't undone) get the backup's image. */
export async function importCovers(backup: BackupFile, images: Map<string, Uint8Array>): Promise<ImportCoversResult> {
    const artistKeys = await getArtistCoverKeys();
    const albumKeys = await getAlbumCoverKeys();

    const artistRows = (backup.artist_covers ?? [])
        .filter(c => !artistKeys.has(c.artist) && images.has(c.file))
        .map(c => ({ artist: c.artist, image_data_uri: bytesToDataUri(c.file, images.get(c.file)!), updated_at: c.updated_at }));
    const albumRows = (backup.album_covers ?? [])
        .filter(c => !albumKeys.has(`${c.artist}\u0000${c.album}`) && images.has(c.file))
        .map(c => ({ artist: c.artist, album: c.album, image_data_uri: bytesToDataUri(c.file, images.get(c.file)!), updated_at: c.updated_at }));

    await applyArtistCovers(artistRows);
    await applyAlbumCovers(albumRows);
    return { artistImagesAdded: artistRows.length, albumCoversAdded: albumRows.length };
}

function trackToBackup(t: Track): BackupTrack {
    return {
        file_path: t.file_path,
        file_name: t.file_name,
        title: t.title,
        artist: t.artist ?? null,
        album: t.album ?? null,
        duration: t.duration ?? null,
        track_key: t.track_key ?? null,
        content_hash: t.content_hash ?? null,
        disc_no: t.disc_no ?? null,
        track_no: t.track_no ?? null,
        genre: t.genre ?? null,
        year: t.year ?? null,
        album_artist: t.album_artist ?? null,
        composer: t.composer ?? null,
    };
}

/** Apply a backup's settings onto the local `settings` table. Only keys in
 *  BACKUP_SETTING_KEYS are ever present (parseBackup already filters), so
 *  nothing device-specific (device_id, sync_token, …) can slip in here. */
export async function importSettings(settings: BackupFile["settings"]) {
    for (const key of BACKUP_SETTING_KEYS) {
        const value = settings[key];
        if (value !== undefined) await setSetting(key, value);
    }
}

export interface ImportPlaylistsResult {
    /** Number of custom/xml/smart playlists newly created. */
    added: number;
    /** Number of custom/xml/smart playlists skipped (id or name+type already exists). */
    skipped: number;
    /** Tracks referenced by a playlist that couldn't be resolved locally
     *  (not already in the library, and not found on disk at their backed-up
     *  path) — left out of the imported playlist. */
    missingTracks: number;
}

/**
 * Merge a backup's custom/xml/smart playlists into the local library.
 *
 * `idMap` is both an input and an output: the caller (useBackup.ts) seeds it
 * with backed-up-folder-playlist-id -> freshly-scanned-playlist-id pairs
 * (folders are re-created by a real scan, not by this function — see
 * useBackup's registerFolder step), and this function adds an entry for
 * every custom/smart playlist it processes, so a smart playlist's `playlist
 * in/not_in` condition — however it references it, whether by id backed up
 * from a folder playlist or from another custom/smart one — resolves
 * correctly via remapSmartRules regardless of import order.
 */
export async function importPlaylists(
    playlists: (BackupPlaylist | BackupSmartPlaylist)[],
    idMap: Map<string, string>,
): Promise<ImportPlaylistsResult> {
    const existing = await getPlaylists();
    const byId = new Map(existing.map(p => [p.id, p]));
    const byNameType = new Map(existing.map(p => [`${p.type}\u0000${p.name}`, p]));

    let added = 0;
    let skipped = 0;
    let missingTracks = 0;

    // First pass: resolve every playlist's local id (existing or newly
    // created) and register it in idMap, *before* creating any smart
    // playlist — so a smart playlist referencing a custom playlist that
    // comes later in the backup's array still remaps correctly.
    const toCreate: (BackupPlaylist | BackupSmartPlaylist)[] = [];
    for (const pl of playlists) {
        const dup = byId.get(pl.id) ?? byNameType.get(`${pl.type}\u0000${pl.name}`);
        if (dup) {
            idMap.set(pl.id, dup.id);
            skipped += 1;
        } else {
            toCreate.push(pl);
        }
    }

    for (const pl of toCreate) {
        if (pl.type === 'smart') {
            const rules = remapSmartRules(pl.rules, idMap);
            const created = await createSmartPlaylist(pl.name, rules, pl.id);
            idMap.set(pl.id, created.id);
        } else {
            const created = await createPlaylist(pl.name, pl.type, pl.id);
            idMap.set(pl.id, created.id);
            const trackIds: string[] = [];
            for (const bt of pl.tracks) {
                const id = await resolveOrCreateTrack(bt);
                if (id) trackIds.push(id);
                else missingTracks += 1;
            }
            await linkTracksToPlaylist(created.id, trackIds);
            // Only a non-default kind needs applying (see reapplyPlaylistKind). Applying "music"
            // would reset every track already in the playlist — including podcast episodes
            // classified by their folder — and stamp them as freshly changed, which then syncs.
            if (pl.kind !== 'music') await setPlaylistKind(created.id, pl.kind);
            await setPlaylistSyncToDevice(created.id, !!pl.sync_to_device);
        }
        added += 1;
    }

    return { added, skipped, missingTracks };
}

/**
 * Resolve a backed-up track to a local track id: an existing row (by
 * file_path, then by track_key — a device whose library moved to a new
 * path can still match by identity), or a freshly-inserted row when the
 * file still exists on disk at its backed-up path. Returns null when none
 * of that resolves, so the caller can count it as missing rather than
 * silently drop it.
 */
async function resolveOrCreateTrack(bt: BackupTrack): Promise<string | null> {
    const db = await getDb();

    const byPath: { id: string }[] = await db.select("SELECT id FROM tracks WHERE file_path = $1", [bt.file_path]);
    if (byPath[0]) return byPath[0].id;

    if (bt.track_key) {
        const byKey: { id: string }[] = await db.select("SELECT id FROM tracks WHERE track_key = $1 LIMIT 1", [bt.track_key]);
        if (byKey[0]) return byKey[0].id;
    }

    if (!(await exists(bt.file_path).catch(() => false))) return null;

    const id = crypto.randomUUID();
    await db.execute(`
        INSERT INTO tracks (id, title, artist, album, file_path, file_name, duration, track_key, content_hash, disc_no, track_no, added_at, genre, year, album_artist, composer, extra_tags_read)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT(file_path) DO NOTHING
    `, [
        id,
        bt.title,
        bt.artist ?? null,
        bt.album ?? null,
        bt.file_path,
        bt.file_name,
        bt.duration ?? null,
        bt.track_key ?? null,
        bt.content_hash ?? null,
        bt.disc_no ?? null,
        bt.track_no ?? null,
        Date.now(),
        bt.genre ?? null,
        bt.year ?? null,
        bt.album_artist ?? null,
        bt.composer ?? null,
        bt.genre != null || bt.year != null || bt.album_artist != null || bt.composer != null ? 1 : 0,
    ]);

    // The INSERT may have been a no-op (ON CONFLICT DO NOTHING) if another
    // import step just raced us onto the same file_path — re-select to get
    // whichever row actually won.
    const row: { id: string }[] = await db.select("SELECT id FROM tracks WHERE file_path = $1", [bt.file_path]);
    return row[0]?.id ?? id;
}
