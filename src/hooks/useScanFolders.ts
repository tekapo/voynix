import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import i18n from "../i18n";
import { albumOf } from "../albumName";
import { useTauriEvent } from "./useTauriEvent";
import {
  addScanFolder,
  addTracksToPlaylist,
  clearPlaylistTracks,
  createPlaylist as dbCreatePlaylist,
  deleteOrphanedTracksUnder,
  deletePlaylist as dbDeletePlaylist,
  getPlaylistTrackPositions,
  getScanFolders,
  loadHashCache,
  reapplyPlaylistKind,
  removeScanFolder,
  saveHashCache,
  setFolderDefaultKind,
  setPlaylistTrackOrder,
} from "../db";
import { restoreManualOrder } from "../playlistOrder";
import { Playlist, ScanFolder, ScanResult, TrackKind, ViewMode } from "../types";

interface UseScanFoldersParams {
  playlists: Playlist[];
  refreshPlaylists: () => Promise<void>;
  currentPlaylistId: string | null;
  setCurrentPlaylistId: (id: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  /** App's own deletePlaylist (not db's) — it also resets the view and closes
   *  the playlist context menu; the rollback paths depend on that. */
  deletePlaylist: (id: string) => Promise<void>;
  setError: (message: string | null) => void;
}

/**
 * Scan folders + iTunes XML import: native scan/import, playlist creation,
 * rescan (with manual-order restore), folder removal/kind, and the
 * scan-progress listener that backs all of it.
 */
export function useScanFolders({
  playlists,
  refreshPlaylists,
  currentPlaylistId,
  setCurrentPlaylistId,
  setViewMode,
  deletePlaylist,
  setError,
}: UseScanFoldersParams) {
  const [scanFolders, setScanFolders] = useState<ScanFolder[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  // Per-file progress emitted by the native scanner while isScanning is true.
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number } | null>(null);
  // Per-album progress from prewarmForTracks below, shown in the sidebar once
  // a scan finishes (see Sidebar.tsx's "Loading artwork…" status).
  const [artworkProgress, setArtworkProgress] = useState<{ done: number; total: number } | null>(null);

  // Get ahead of the Albums grid's on-demand `get_album_thumb` calls right
  // after a scan, so opening it resolves from an already-warm cache instead
  // of decoding/downscaling one card at a time (see metadata.rs's
  // prewarm_album_thumbs). One representative track per album — grouped the
  // same way the Albums view itself groups (albumOf: folder name when a
  // track has no album tag, see albumName.ts) — is enough to resolve a cover.
  // Deliberately not awaited by callers: it's a nice-to-have that shouldn't
  // hold up the scan's own success/error handling.
  async function prewarmForTracks(tracks: { artist?: string; album?: string; file_path: string }[]) {
    const reps = new Map<string, { artist: string; album: string; path: string }>();
    for (const t of tracks) {
      const album = albumOf(t);
      const key = `${t.artist ?? ""}␟${album}`;
      if (!reps.has(key)) reps.set(key, { artist: t.artist ?? "", album, path: t.file_path });
    }
    if (reps.size === 0) return;
    try {
      await invoke("prewarm_album_thumbs", { items: Array.from(reps.values()) });
    } catch (e) {
      console.error("Failed to prewarm album thumbs:", e);
    }
  }

  // Cancel a running prewarm. Safe to call when nothing is prewarming.
  const cancelThumbPrewarm = () => { invoke("cancel_thumb_prewarm").catch(() => { /* nothing prewarming */ }); };

  async function refreshScanFolders() {
    try {
      setScanFolders(await getScanFolders());
    } catch (e) {
      console.error("Failed to refresh scan folders:", e);
    }
  }

  async function addPlaylist(result: ScanResult, name: string, type: 'folder' | 'xml'): Promise<string | null> {
    let createdPlaylistId: string | null = null;
    try {
      const newPl = await dbCreatePlaylist(name, type);
      createdPlaylistId = newPl.id;
      await addTracksToPlaylist(newPl.id, result.tracks);
      await refreshPlaylists();

      setCurrentPlaylistId(newPl.id);
      setViewMode('playlist');
      return newPl.id;
    } catch (err) {
      console.error("Failed to add playlist:", err);
      if (createdPlaylistId) {
        try {
          await deletePlaylist(createdPlaylistId);
        } catch (cleanupErr) {
          console.error("Failed to cleanup partially created playlist:", cleanupErr);
        }
      }
      setError(i18n.t("scanFolders.addPlaylistFailed"));
      return null;
    }
  }

  const folderName = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() || p;

  // Wraps a native scan/import: feeds in the content_hash cache so unchanged
  // files aren't re-hashed, and persists the refreshed rows afterward.
  async function scanWithCache(command: "scan_music_dir" | "import_itunes_xml", args: Record<string, unknown>): Promise<ScanResult> {
    try {
      const result = await invoke<ScanResult>(command, { ...args, hashCache: await loadHashCache() });
      try {
        // Persist the refreshed rows even on a cancelled scan — every file the
        // walk did reach is one the next scan can now skip.
        await saveHashCache(result.hash_cache);
      } catch (e) {
        console.error("Failed to persist hash cache:", e);
      }
      // The single choke point for every scan/rescan/import path (see
      // handleAddScanFolder, rescanFolder, importXml below), so one prewarm
      // call here covers all of them. Not awaited — see prewarmForTracks.
      if (!result.cancelled) void prewarmForTracks(result.tracks);
      return result;
    } finally {
      setScanProgress(null);
    }
  }

  // Cancel a running native scan / import. Safe to call when nothing is running.
  const cancelScan = () => { invoke("cancel_scan").catch(() => { /* nothing scanning */ }); };

  // "3 files not downloaded" note appended to a successful scan message.
  const cloudNote = (n: number) => (n > 0 ? i18n.t("scanFolders.cloudNote", { count: n }) : "");

  // Scan a folder, create its playlist, and register it in scan_folders —
  // the part of handleAddScanFolder that doesn't involve a file-picker
  // dialog, so it can also be driven by a backup import (see useBackup.ts).
  // Does not touch isScanning/setError bookkeeping beyond what scanWithCache
  // already does; callers own the surrounding try/finally.
  async function registerFolder(path: string, defaultKind?: TrackKind): Promise<{ playlistId: string; result: ScanResult } | null> {
    const result = await scanWithCache("scan_music_dir", { directory: path });
    if (result.cancelled) {
      setError(i18n.t("scanFolders.scanCancelled"));
      return null;
    }
    const playlistId = await addPlaylist(result, folderName(path), 'folder');
    if (!playlistId) return null;
    try {
      await addScanFolder(path, playlistId);
      if (defaultKind && defaultKind !== 'music') {
        await setFolderDefaultKind(path, defaultKind);
      }
      return { playlistId, result };
    } catch (err) {
      await deletePlaylist(playlistId);
      throw err;
    }
  }

  const handleAddScanFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: i18n.t("scanFolders.selectMusicFolder") });
      if (!selected || typeof selected !== "string") return;

      if (scanFolders.some(f => f.path === selected)) {
        setError(i18n.t("scanFolders.alreadyRegistered"));
        return;
      }

      setIsScanning(true);
      const registered = await registerFolder(selected);
      if (!registered) return;
      await refreshScanFolders();
      setError(registered.result.skipped_cloud > 0 ? i18n.t("scanFolders.folderAdded", { cloudNote: cloudNote(registered.result.skipped_cloud) }) : null);
    } catch (err) {
      console.error("Failed to add scan folder:", err);
      setError(i18n.t("scanFolders.addFolderFailed", { error: String(err) }));
    } finally {
      setIsScanning(false);
    }
  };

  // Returns the scan result so the caller can stop the loop on cancel. The
  // existing playlist is left untouched until we know the scan completed.
  const rescanFolder = async (folder: ScanFolder): Promise<ScanResult> => {
    const result = await scanWithCache("scan_music_dir", { directory: folder.path });
    if (result.cancelled) return result;
    let playlistId = folder.playlist_id;
    const existing = playlistId ? playlists.find(p => p.id === playlistId) : undefined;
    // A hand-arranged (drag & drop) playlist otherwise loses its order every
    // rescan, since clearPlaylistTracks + addTracksToPlaylist below re-adds
    // everything in scan order with freshly-numbered positions. Snapshot the
    // old file_path -> position mapping so it can be restored afterwards.
    const oldPositions = existing?.manual_order ? await getPlaylistTrackPositions(existing.id) : null;

    if (playlistId && existing) {
      await clearPlaylistTracks(playlistId);
    } else {
      const newPl = await dbCreatePlaylist(folderName(folder.path), 'folder');
      playlistId = newPl.id;
      await addScanFolder(folder.path, playlistId);
    }

    await addTracksToPlaylist(playlistId, result.tracks, folder.default_kind ?? 'music');
    await reapplyPlaylistKind(playlistId); // preserve a playlist-level Podcast mark across rescans

    if (oldPositions) {
      // track.id is a deterministic hash of file_path, so ids line up with
      // what's now in playlist_tracks without a re-query.
      const restored = restoreManualOrder(result.tracks, oldPositions, t => t.file_path);
      await setPlaylistTrackOrder(playlistId, restored.map(t => t.id));
    }

    // A file that's genuinely gone from this folder (renamed, moved, deleted)
    // lost its playlist link above but not its `tracks` row. Only safe to
    // prune here because scan_music_dir already rejected an unreachable
    // folder above instead of returning zero tracks.
    await deleteOrphanedTracksUnder(folder.path);

    return result;
  };

  const handleRescanFolders = async () => {
    if (scanFolders.length === 0) return;
    try {
      setIsScanning(true);
      let cancelled = false;
      let skippedCloud = 0;
      for (const folder of scanFolders) {
        const result = await rescanFolder(folder);
        skippedCloud += result.skipped_cloud;
        if (result.cancelled) { cancelled = true; break; }
      }
      await refreshScanFolders();
      await refreshPlaylists();
      setError(
        cancelled ? i18n.t("scanFolders.rescanCancelledAll")
          : skippedCloud > 0 ? i18n.t("scanFolders.rescanComplete", { cloudNote: cloudNote(skippedCloud) })
          : null,
      );
    } catch (err) {
      console.error("Failed to rescan folders:", err);
      setError(i18n.t("scanFolders.rescanFailed", { error: String(err) }));
    } finally {
      setIsScanning(false);
    }
  };

  // Same as handleRescanFolders but scoped to one folder — the deletion
  // detection inside rescanFolder/clearPlaylistTracks is already keyed by
  // playlist_id, so scanning just this folder can't touch any other folder's
  // tracks.
  const handleRescanFolder = async (folder: ScanFolder) => {
    try {
      setIsScanning(true);
      const result = await rescanFolder(folder);
      await refreshScanFolders();
      await refreshPlaylists();
      setError(
        result.cancelled ? i18n.t("scanFolders.rescanCancelledOne")
          : result.skipped_cloud > 0 ? i18n.t("scanFolders.rescanComplete", { cloudNote: cloudNote(result.skipped_cloud) })
          : null,
      );
    } catch (err) {
      console.error("Failed to rescan folder:", err);
      setError(i18n.t("scanFolders.rescanFailed", { error: String(err) }));
    } finally {
      setIsScanning(false);
    }
  };

  const handleRemoveScanFolder = async (folder: ScanFolder) => {
    try {
      if (folder.playlist_id) {
        await dbDeletePlaylist(folder.playlist_id);
        if (currentPlaylistId === folder.playlist_id) {
          setCurrentPlaylistId(null);
          setViewMode('all_songs');
        }
      }
      await removeScanFolder(folder.path);
      await refreshScanFolders();
      await refreshPlaylists();
    } catch (err) {
      console.error("Failed to remove scan folder:", err);
      setError(i18n.t("scanFolders.removeFolderFailed", { error: String(err) }));
    }
  };

  async function importXml(path: string) {
    setIsScanning(true);
    try {
      const result = await scanWithCache("import_itunes_xml", { xmlPath: path });
      if (result.cancelled) {
        setError(i18n.t("scanFolders.importCancelled"));
        return;
      }
      const name = path.split(/[/\\]/).pop() || "iTunes XML";
      await addPlaylist(result, name, 'xml');
      setError(result.skipped_cloud > 0 ? i18n.t("scanFolders.libraryImported", { cloudNote: cloudNote(result.skipped_cloud) }) : null);
    } catch (err) {
      console.error("Failed to import XML:", err);
      setError(i18n.t("scanFolders.importXmlFailed", { error: String(err) }));
    } finally {
      setIsScanning(false);
    }
  }

  const handleSetFolderKind = async (folder: ScanFolder, kind: TrackKind) => {
    try {
      await setFolderDefaultKind(folder.path, kind);
      await refreshScanFolders();
      await refreshPlaylists();
    } catch (e) {
      console.error("Failed to set folder kind:", e);
      setError(i18n.t("scanFolders.setFolderKindFailed", { error: String(e) }));
    }
  };

  const handleImportXml = async () => {
    try {
      const selected = await open({ directory: false, multiple: false, filters: [{ name: 'XML', extensions: ['xml'] }], title: i18n.t("scanFolders.selectItunesLibraryXml") });
      if (selected && typeof selected === "string") await importXml(selected);
    } catch (err) {
      console.error(err);
      setError(i18n.t("scanFolders.openDialogFailed"));
    }
  };

  // Per-file progress from the native library scanner / iTunes import.
  useTauriEvent<{ done: number; total: number }>("scan-progress", ({ done, total }) => {
    setScanProgress(total > 0 ? { done, total } : null);
  });

  // Per-album progress from prewarm_album_thumbs, running in the background
  // after a scan (see prewarmForTracks above).
  useTauriEvent<{ done: number; total: number }>("thumb-progress", ({ done, total }) => {
    setArtworkProgress(done < total ? { done, total } : null);
  });

  return {
    scanFolders,
    isScanning,
    scanProgress,
    artworkProgress,
    refreshScanFolders,
    cancelScan,
    cancelThumbPrewarm,
    handleAddScanFolder,
    handleRescanFolders,
    handleRescanFolder,
    handleRemoveScanFolder,
    handleSetFolderKind,
    handleImportXml,
    registerFolder,
    setIsScanning,
  };
}
