import { invoke } from "@tauri-apps/api/core";
import { effectiveAlbum } from "../albumName";
import { getDb } from "./core";
import { getDeviceId, getLibrarySyncSources, getTranscodeOptions } from "./settings";
import { getAllAlbumCovers, getAllArtistCovers } from "./covers";
import { playlistOrderBy } from "./playlists";
import { getAllTracks } from "./tracks";
import { pool } from "../sync";
import { libraryListTracks } from "../smartLists";
import { evaluateSmartPlaylist, parseSmartRules } from "../smartPlaylist";
import { PlayState, SyncPlayEvent, SyncSnapshot, TrackKind } from "../types";

// ---- Sync ----------------------------------------------------------------

export async function setPlaylistSyncToDevice(playlistId: string, enabled: boolean) {
    const db = await getDb();
    await db.execute(
        "UPDATE playlists SET sync_to_device = $1 WHERE id = $2",
        [enabled ? 1 : 0, playlistId]
    );
}

/**
 * The desired state for paired devices: playlists flagged sync_to_device, their
 * tracks (deduped by track_key), and the full local play-event log.
 */
export async function buildSyncSnapshot(): Promise<SyncSnapshot> {
    const db = await getDb();
    const deviceId = await getDeviceId();

    const playlistRows: any[] = await db.select(
        "SELECT id, name, type, kind, manual_order, rules FROM playlists WHERE sync_to_device = 1 ORDER BY name"
    );

    // Needed only if at least one synced playlist is smart: the whole library
    // (for rule evaluation) and every (non-smart) playlist's membership (for
    // the 'playlist' rule field/op — see evaluateSmartPlaylist).
    let allTracks: Awaited<ReturnType<typeof getAllTracks>> | null = null;
    let membership: Map<string, Set<string>> | null = null;
    async function smartPlaylistContext() {
        if (!allTracks) allTracks = await getAllTracks();
        if (!membership) {
            const rows: { playlist_id: string; track_id: string }[] = await db.select(
                "SELECT playlist_id, track_id FROM playlist_tracks"
            );
            membership = new Map();
            for (const { playlist_id, track_id } of rows) {
                const set = membership.get(playlist_id);
                if (set) set.add(track_id);
                else membership.set(playlist_id, new Set([track_id]));
            }
        }
        return { allTracks, membership };
    }

    const playlists: SyncSnapshot["playlists"] = [];
    const keySet = new Set<string>();
    for (const pl of playlistRows) {
        let trackKeys: string[];
        if (pl.type === 'smart') {
            const { allTracks: tracks, membership: memb } = await smartPlaylistContext();
            const rules = parseSmartRules(pl.rules);
            trackKeys = evaluateSmartPlaylist(rules, tracks, memb, Date.now())
                .map(t => t.track_key)
                .filter((k): k is string => !!k);
        } else {
            // Same order the Mac itself shows (playlistOrderBy) so the phone
            // mirrors it verbatim (upsertMirrorPlaylist re-numbers position from
            // this order).
            const rows: any[] = await db.select(
                `SELECT t.track_key
                 FROM tracks t
                 JOIN playlist_tracks pt ON t.id = pt.track_id
                 WHERE pt.playlist_id = $1 AND t.track_key IS NOT NULL
                 ORDER BY ${playlistOrderBy(pl)}`,
                [pl.id]
            );
            trackKeys = rows.map(r => r.track_key as string);
        }
        trackKeys.forEach(k => keySet.add(k));
        // Android has no concept of a smart playlist — it only ever receives
        // the evaluated track_keys, same as any other mirror playlist (see
        // logic/Sync.kt on the Android side).
        playlists.push({ id: pl.id, name: pl.name, kind: (pl.kind ?? 'music') as TrackKind, track_keys: trackKeys });
    }

    // Library entries flagged for sync contribute their tracks only — no
    // playlist is created on the device.
    const librarySources = await getLibrarySyncSources();
    if (librarySources.length > 0) {
        const { allTracks: tracks } = await smartPlaylistContext();
        for (const source of librarySources) {
            for (const t of libraryListTracks(source, tracks)) {
                if (t.track_key) keySet.add(t.track_key);
            }
        }
    }

    const trackRows: any[] = await db.select(
        `SELECT track_key, title, artist, album, duration, file_name, file_path,
                content_hash, favorite, favorite_updated_at, kind, disc_no, track_no,
                play_state, resume_position, play_state_updated_at, added_at
         FROM tracks WHERE track_key IS NOT NULL`
    );
    const seen = new Set<string>();
    const tracks: SyncSnapshot["tracks"] = [];
    // Which pushed tracks have no album tag of their own (their `album` above
    // is folder-derived, not tag data) — used below to skip the online art
    // lookup for them, the same way albumArt.ts's useNowPlayingArtwork does.
    const folderAlbumKeys = new Set<string>();
    for (const t of trackRows) {
        if (!keySet.has(t.track_key) || seen.has(t.track_key)) continue;
        seen.add(t.track_key);
        if (!(t.album ?? "").trim()) folderAlbumKeys.add(t.track_key);
        tracks.push({
            track_key: t.track_key,
            title: t.title,
            artist: t.artist ?? null,
            // Folder-derived when the file has no album tag of its own (see
            // albumName.ts), so Android groups/shows the same album this
            // device's Albums view does, instead of every untagged track
            // across the whole library colliding into one "Unknown Album".
            album: effectiveAlbum({ album: t.album, file_path: t.file_path }),
            duration: t.duration ?? null,
            file_name: t.file_name,
            file_path: t.file_path,
            content_hash: t.content_hash ?? "",
            size: 0,
            favorite: t.favorite ?? 0,
            favorite_updated_at: t.favorite_updated_at ?? null,
            kind: (t.kind ?? 'music') as TrackKind,
            disc_no: t.disc_no ?? null,
            track_no: t.track_no ?? null,
            play_state: (t.play_state ?? 'unplayed') as PlayState,
            resume_position: t.resume_position ?? 0,
            play_state_updated_at: t.play_state_updated_at ?? null,
            added_at: t.added_at ?? null,
        });
    }

    // Make sure every album's cover ends up resolved in the Mac's `artwork/`
    // cache (any track's embedded tag, else iTunes) *before* transcoding rewrites file_path
    // below — get_album_thumb only ever reads that cache or a file's own tag,
    // and Android has no embedded art to fall back on once afconvert strips it
    // (or never had any, e.g. most Apple Music purchases). One call per distinct
    // (artist, album), using the first track's still-original path.
    const albumReps = new Map<string, { artist: string; album: string; path: string; extra: string[]; lookupOnline: boolean }>();
    for (const t of tracks) {
        const key = `${t.artist}␟${t.album}`;
        const rep = albumReps.get(key);
        if (!rep) {
            albumReps.set(key, {
                artist: t.artist ?? "", album: t.album ?? "", path: t.file_path, extra: [],
                // A folder-derived album name is not a real release title —
                // searching iTunes for it would likely match an unrelated
                // album rather than leave the cover blank (see albumArt.ts).
                lookupOnline: !folderAlbumKeys.has(t.track_key),
            });
        } else if (rep.extra.length < 20) {
            rep.extra.push(t.file_path);
        }
    }
    await pool([...albumReps.values()], 4, async (rep) => {
        try {
            await invoke("ensure_album_art", {
                artist: rep.artist, album: rep.album, path: rep.path, extraPaths: rep.extra,
                lookupOnline: rep.lookupOnline,
            });
        } catch (e) {
            console.warn(`ensure_album_art failed for ${rep.artist} / ${rep.album}:`, e);
        }
    });

    // Android can't decode ALAC (and a few other formats an Apple Music library
    // holds). Ask the Rust side to hand back a playable path per track — the
    // original when it's fine, a cached transcode (per the user's format/bitrate
    // setting) otherwise.
    try {
        const options = await getTranscodeOptions();
        const prepared = await invoke<
            { track_key: string; file_path: string; content_hash: string; size: number }[]
        >("prepare_sync_media", {
            items: tracks.map(t => ({
                track_key: t.track_key,
                file_path: t.file_path,
                content_hash: t.content_hash,
            })),
            options,
        });
        const byKey = new Map(prepared.map(p => [p.track_key, p]));
        for (const t of tracks) {
            const p = byKey.get(t.track_key);
            if (p) {
                t.file_path = p.file_path;
                t.content_hash = p.content_hash;
                t.size = p.size ?? 0;
            }
        }
    } catch (e) {
        console.error("prepare_sync_media failed, syncing originals:", e);
    }

    const play_events: SyncPlayEvent[] = await db.select(
        "SELECT track_key, played_at, device_id FROM play_events"
    );

    const album_covers = await getAllAlbumCovers();
    const artist_covers = await getAllArtistCovers();

    return { device_id: deviceId, generated_at: Date.now(), playlists, tracks, play_events, album_covers, artist_covers };
}
