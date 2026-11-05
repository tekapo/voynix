import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invalidateAlbumArt } from "../albumArt";
import { effectiveAlbum } from "../albumName";
import { invalidateArtistArt } from "../artistArt";
import type { AlbumTagFields } from "../components/AlbumInfoModal";
import type { TrackTagFields } from "../components/TrackInfoModal";
import {
  getAlbumCover,
  getArtistCoverKeys,
  setAlbumCover,
  setArtistCover,
  updateTrackTags,
} from "../db";
import { UNKNOWN_ARTIST } from "../names";
import { pool } from "../sync";
import type { Track } from "../types";

interface Params {
  setError: (message: string | null) => void;
  refreshPlaylists: () => Promise<void>;
  patchCurrentTrackIfId: (id: string, patch: Partial<Track>) => void;
  /** Every artist in the library (the bulk image fetch targets these). */
  artists: string[];
}

export type ArtistImageFetchProgress = { done: number; total: number; found: number };

/**
 * Artwork, cover and tag-editing actions triggered from the context menus and
 * the Get Info dialogs: embedded-cover writes, per-album / per-artist image
 * overrides, tag saves (which also invalidate the cover caches), and the bulk
 * "Fetch Missing Artist Images" job. Pure move out of App.tsx — behaviour is
 * unchanged.
 */
export function useArtworkActions({ setError, refreshPlaylists, patchCurrentTrackIfId, artists }: Params) {
  const { t } = useTranslation();

  // Bulk "Fetch Missing Artist Images" (Settings > Library). Cancel is a flag
  // rather than an AbortController since the loop lives in a `pool()` worker.
  const [artistImageFetchProgress, setArtistImageFetchProgress] =
    useState<ArtistImageFetchProgress | null>(null);
  const artistImageFetchCancelRef = useRef(false);

  const handleShowInFinder = async (track: Track) => {
    try {
      await invoke("show_in_finder", { path: track.file_path });
    } catch (err) {
      console.error("Failed to show in finder:", err);
      setError(t('errors.showInFinderFailed', { error: String(err) }));
    }
  };

  const handleSetArtwork = async (track: Track) => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
        title: "Select Artwork Image"
      });

      if (selected && typeof selected === "string") {
        await invoke("set_track_artwork", { path: track.file_path, imagePath: selected });
        // This rewrites the file's own embedded cover, so the disk-cached
        // thumbnail (keyed by artist/album, not by content) would otherwise
        // keep showing the old image in the album grid.
        await invoke("clear_album_thumb_cache", { artist: track.artist ?? "", album: effectiveAlbum(track) ?? "" });
        invalidateAlbumArt();
      }
    } catch (err) {
      console.error("Failed to set artwork:", err);
      setError(t('errors.setArtworkFailed', { error: String(err) }));
    }
  };

  // "Get Info…" dialog's Save: rewrite the file's own tags, then the DB row.
  // Title/artist/album/duration/track_no feed track_key (see compute_track_key,
  // src-tauri/src/identity.rs), so editing them changes it — updateTrackTags carries
  // play_events over to the new key so play count / last played survive.
  const handleSaveTrackTags = async (track: Track, fields: TrackTagFields) => {
    const identity = await invoke<{ track_key: string; content_hash: string }>("write_track_tags", {
      path: track.file_path,
      edit: fields,
    });
    await updateTrackTags(track.id, track.track_key, fields, identity.track_key, identity.content_hash);
    const artistChanged = fields.artist !== (track.artist ?? "");
    const albumChanged = fields.album !== (track.album ?? "");
    if (artistChanged || albumChanged) {
      // The disk-cached album thumbnail is keyed by (artist, album) — the
      // folder-derived name when the track had no tag of its own (see
      // albumName.ts) — not by content, so it would otherwise keep showing
      // under the old key.
      await invoke("clear_album_thumb_cache", { artist: track.artist ?? "", album: effectiveAlbum(track) ?? "" });
      invalidateAlbumArt();
    }
    patchCurrentTrackIfId(track.id, {
      title: fields.title,
      artist: fields.artist || undefined,
      album: fields.album || undefined,
      disc_no: fields.disc_no,
      track_no: fields.track_no,
      track_key: identity.track_key,
      content_hash: identity.content_hash,
    });
    await refreshPlaylists();
  };

  // Album "Get Info…" dialog's Save: rewrites artist/album on every track in
  // the album (title/disc/track stay per-track, out of scope here — see
  // AlbumInfoModal). Each file write + DB update mirrors handleSaveTrackTags
  // above (including the track_key re-key), just looped with bounded
  // concurrency via pool() (same helper the bulk artist-image fetch uses).
  // Partial failures don't roll back what already succeeded — those files are
  // already renamed on disk and in the DB — but we throw a summary so the
  // dialog surfaces it instead of silently closing.
  const handleSaveAlbumTags = async (
    tracks: Track[],
    fields: AlbumTagFields,
    onProgress: (done: number, total: number) => void
  ) => {
    if (tracks.length === 0) return;
    const oldArtist = tracks[0].artist ?? "";
    // The cover/thumb cache is keyed by the *effective* album (folder-derived
    // when untagged, see albumName.ts), not the raw blank tag, so the carry-
    // over/cache-clear below must look it up under that same key.
    const oldAlbum = effectiveAlbum(tracks[0]) ?? "";

    let done = 0;
    const failures: string[] = [];
    await pool(tracks, 3, async (t) => {
      try {
        const edit = {
          title: t.title,
          artist: fields.artist,
          album: fields.album,
          disc_no: t.disc_no ?? null,
          track_no: t.track_no ?? null,
        };
        const identity = await invoke<{ track_key: string; content_hash: string }>("write_track_tags", {
          path: t.file_path,
          edit,
        });
        await updateTrackTags(t.id, t.track_key, edit, identity.track_key, identity.content_hash);
      } catch (err) {
        console.error(`Failed to update tags for ${t.file_path}:`, err);
        failures.push(t.file_name);
      } finally {
        done += 1;
        onProgress(done, tracks.length);
      }
    });

    // Carry the album cover override over to the new (artist, album) key so
    // a rename doesn't silently drop it (see setAlbumCover's cache-key note).
    // Computed the same way the cache itself is keyed (effectiveAlbum, not
    // the raw tag) so leaving an already-untagged album's field blank isn't
    // mistaken for a rename (its folder-derived key doesn't actually change).
    const newAlbumKey = effectiveAlbum({ album: fields.album, file_path: tracks[0].file_path }) ?? "";
    const renamed = fields.artist !== oldArtist || newAlbumKey !== oldAlbum;
    if (renamed) {
      const cover = await getAlbumCover(oldArtist, oldAlbum);
      if (cover) {
        await setAlbumCover(fields.artist, newAlbumKey, cover);
        await setAlbumCover(oldArtist, oldAlbum, null);
      }
      await invoke("clear_album_thumb_cache", { artist: oldArtist, album: oldAlbum });
      await invoke("clear_album_thumb_cache", { artist: fields.artist, album: newAlbumKey });
      invalidateAlbumArt();
    }
    await refreshPlaylists();

    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${tracks.length} files failed: ${failures.slice(0, 3).join(", ")}${failures.length > 3 ? "…" : ""}`
      );
    }
  };

  // Non-destructive per-album override: unlike handleSetArtwork, this never
  // touches a music file's own tags, applies to every track sharing the same
  // (artist, album) pair — NOT album name alone, so a different artist's
  // same-titled (or also-untagged) album is unaffected — and syncs to paired
  // devices via SyncSnapshot.album_covers.
  const handleSetAlbumCover = async (track: Track) => {
    const artist = track.artist ?? "";
    const album = effectiveAlbum(track) ?? "";
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
        title: "Select Album Cover Image"
      });
      if (selected && typeof selected === "string") {
        const dataUri = await invoke<string>("read_image_as_data_uri", { imagePath: selected });
        await setAlbumCover(artist, album, dataUri);
        invalidateAlbumArt();
      }
    } catch (err) {
      console.error("Failed to set album cover:", err);
      setError(t('errors.setAlbumCoverFailed', { error: String(err) }));
    }
  };

  const applyAlbumCoverUrl = async (track: Track, imageUrl: string) => {
    const dataUri = await invoke<string>("fetch_image_as_data_uri", { url: imageUrl });
    await setAlbumCover(track.artist ?? "", effectiveAlbum(track) ?? "", dataUri);
    invalidateAlbumArt();
  };

  const handleResetAlbumCover = async (track: Track) => {
    const artist = track.artist ?? "";
    const album = effectiveAlbum(track) ?? "";
    try {
      await setAlbumCover(artist, album, null);
      invalidateAlbumArt();
    } catch (err) {
      console.error("Failed to reset album cover:", err);
      setError(t('errors.resetAlbumCoverFailed', { error: String(err) }));
    }
  };

  // Non-destructive per-artist image override (see artistArt.ts), synced to
  // Android read-only like album covers.
  const handleSetArtistImage = async (artist: string) => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
        title: "Select Artist Image"
      });
      if (selected && typeof selected === "string") {
        const dataUri = await invoke<string>("read_image_as_data_uri", { imagePath: selected });
        await setArtistCover(artist, dataUri);
        invalidateArtistArt();
      }
    } catch (err) {
      console.error("Failed to set artist image:", err);
      setError(t('errors.setArtistImageFailed', { error: String(err) }));
    }
  };

  const handleResetArtistImage = async (artist: string) => {
    try {
      await setArtistCover(artist, null);
      invalidateArtistArt();
    } catch (err) {
      console.error("Failed to reset artist image:", err);
      setError(t('errors.resetArtistImageFailed', { error: String(err) }));
    }
  };

  const applyArtistImageUrl = async (artist: string, pictureUrl: string) => {
    const dataUri = await invoke<string>("fetch_image_as_data_uri", { url: pictureUrl });
    await setArtistCover(artist, dataUri);
    invalidateArtistArt();
  };

  // Bulk-fills every artist without a cover override yet, using Deezer's
  // exact-name-match auto lookup (see auto_artist_image in metadata.rs).
  // Never touches an artist that already has one — manual or automatic.
  const handleFetchMissingArtistImages = async () => {
    const targets = artists.filter(a => a !== UNKNOWN_ARTIST);
    const existing = await getArtistCoverKeys();
    const missing = targets.filter(a => !existing.has(a.trim().toLowerCase()));
    if (missing.length === 0) {
      setArtistImageFetchProgress({ done: 0, total: 0, found: 0 });
      return;
    }

    artistImageFetchCancelRef.current = false;
    let done = 0;
    let found = 0;
    setArtistImageFetchProgress({ done, total: missing.length, found });

    await pool(missing, 2, async (artist) => {
      if (artistImageFetchCancelRef.current) return;
      try {
        const dataUri = await invoke<string | null>("auto_artist_image", { artist });
        if (dataUri) {
          await setArtistCover(artist, dataUri);
          found += 1;
        }
      } catch (err) {
        console.warn(`auto_artist_image failed for ${artist}:`, err);
      }
      done += 1;
      setArtistImageFetchProgress({ done, total: missing.length, found });
    });

    invalidateArtistArt();
    setArtistImageFetchProgress(null);
  };

  const cancelFetchMissingArtistImages = () => {
    artistImageFetchCancelRef.current = true;
  };

  return {
    artistImageFetchProgress,
    handleShowInFinder,
    handleSetArtwork,
    handleSaveTrackTags,
    handleSaveAlbumTags,
    handleSetAlbumCover,
    applyAlbumCoverUrl,
    handleResetAlbumCover,
    handleSetArtistImage,
    handleResetArtistImage,
    applyArtistImageUrl,
    handleFetchMissingArtistImages,
    cancelFetchMissingArtistImages,
  };
}
