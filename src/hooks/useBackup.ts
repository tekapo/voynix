import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import i18n from "../i18n";
import { BackupParseError, parseBackup } from "../backup";
import {
  buildBackup,
  buildCoverImages,
  importCovers,
  getPlaylistTrackIdsByPath,
  importPlaylists,
  importSettings,
  setPlaylistTrackOrder,
} from "../db";
import { restoreManualOrder } from "../playlistOrder";
import type { ScanFolder, TrackKind } from "../types";

interface UseBackupParams {
  scanFolders: ScanFolder[];
  /** The part of registerFolder in useScanFolders.ts that scans a folder,
   *  creates its playlist and links it into scan_folders. */
  registerFolder: (path: string, defaultKind?: TrackKind) => Promise<{ playlistId: string } | null>;
  refreshScanFolders: () => Promise<void>;
  refreshPlaylists: () => Promise<void>;
  /** Re-apply the settings table onto React state — App's own reloadSettings
   *  plus useSyncServer's reloadSyncSettings, run one after the other by the
   *  caller so an imported ui_language / transcode_format etc. take effect
   *  immediately instead of waiting for the next launch. */
  reloadSettings: () => Promise<void>;
  /** useScanFolders' own isScanning setter — reused so the Settings modal's
   *  existing "scanning…" UI (and disabled folder/import buttons) covers a
   *  backup import's re-scan of any newly-registered folders too. */
  setIsScanning: (value: boolean) => void;
  /** Called after cover/artist images were imported so cached art re-renders. */
  onCoversImported?: () => void;
  setError: (message: string | null) => void;
}

/**
 * Export/import a single JSON snapshot of playlists (custom/xml/smart),
 * registered music folders, and a fixed allow-list of settings — desktop
 * only. Import merges onto whatever is already in the library: an existing
 * folder is left alone (never re-scanned or overwritten), and an existing
 * playlist (same id, or same name+type) is skipped rather than duplicated —
 * see db/backup.ts's importPlaylists.
 */
export function useBackup({
  scanFolders,
  registerFolder,
  refreshScanFolders,
  refreshPlaylists,
  reloadSettings,
  setIsScanning,
  onCoversImported,
  setError,
}: UseBackupParams) {
  const handleExportBackup = async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const path = await save({
        title: i18n.t("backup.exportDialogTitle"),
        defaultPath: `voynix-backup-${date}.zip`,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!path) return;
      const appVersion = await getVersion().catch(() => "");
      const backup = await buildBackup(appVersion);
      // Images ride as plain files next to backup.json instead of base64 in
      // it. They're already JPEG/PNG, so store them uncompressed (level 0).
      const { artist_covers, album_covers, images } = await buildCoverImages();
      backup.artist_covers = artist_covers;
      backup.album_covers = album_covers;
      const entries: Zippable = { "backup.json": strToU8(JSON.stringify(backup, null, 2)) };
      for (const [file, bytes] of images) entries[file] = [bytes, { level: 0 }];
      await writeFile(path, zipSync(entries));
      setError(i18n.t("backup.exportSucceeded"));
    } catch (err) {
      console.error("Failed to export backup:", err);
      setError(i18n.t("backup.exportFailed", { error: String(err) }));
    }
  };

  const handleImportBackup = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: "Backup", extensions: ["zip", "json"] }],
        title: i18n.t("backup.importDialogTitle"),
      });
      if (!selected || typeof selected !== "string") return;

      // .zip = backup.json + images/; a bare .json is the older, image-less format.
      let text: string;
      let images = new Map<string, Uint8Array>();
      if (selected.toLowerCase().endsWith(".zip")) {
        let files: Record<string, Uint8Array>;
        try {
          files = unzipSync(await readFile(selected));
        } catch {
          throw new BackupParseError("backup.errors.invalidArchive", "Not a valid ZIP");
        }
        if (!files["backup.json"]) throw new BackupParseError("backup.errors.invalidArchive", "backup.json missing");
        text = strFromU8(files["backup.json"]);
        images = new Map(Object.entries(files));
      } else {
        text = strFromU8(await readFile(selected));
      }
      const backup = parseBackup(text);

      setIsScanning(true);
      await importSettings(backup.settings);
      await reloadSettings();

      // idMap seeds every backed-up-playlist-id -> local-playlist-id pair, so
      // a smart playlist's `playlist in/not_in` condition (whether it points
      // at a folder playlist or another custom/smart one) remaps correctly
      // regardless of which section of the backup created it.
      const idMap = new Map<string, string>();
      let foldersAdded = 0;
      let foldersSkipped = 0;

      for (const folder of backup.folders) {
        if (scanFolders.some(f => f.path === folder.path)) {
          foldersSkipped += 1;
          continue;
        }
        const registered = await registerFolder(folder.path, folder.default_kind).catch(err => {
          console.error(`Failed to import folder ${folder.path}:`, err);
          return null;
        });
        if (!registered) {
          foldersSkipped += 1;
          continue;
        }
        foldersAdded += 1;
        const pl = folder.playlist;
        if (pl) {
          idMap.set(pl.id, registered.playlistId);
          if (pl.track_paths && pl.track_paths.length > 0) {
            // Same restoreManualOrder trick rescanFolder uses (App.tsx):
            // paths the backup knew about keep the backed-up relative order,
            // anything new (scanned but not in the backup) falls to the end.
            const positions = new Map(pl.track_paths.map((p, i) => [p, i]));
            const idByPath = await getPlaylistTrackIdsByPath(registered.playlistId);
            const orderedPaths = restoreManualOrder(Array.from(idByPath.keys()), positions, p => p);
            await setPlaylistTrackOrder(registered.playlistId, orderedPaths.map(p => idByPath.get(p)!));
          }
        }
      }

      const { added, skipped, missingTracks } = await importPlaylists(backup.playlists, idMap);

      const { artistImagesAdded, albumCoversAdded } = await importCovers(backup, images);
      if (artistImagesAdded + albumCoversAdded > 0) onCoversImported?.();

      await refreshScanFolders();
      await refreshPlaylists();

      setError(i18n.t("backup.importSucceeded", {
        playlistsAdded: added,
        playlistsSkipped: skipped,
        foldersAdded,
        foldersSkipped,
        missingTracks,
        imagesAdded: artistImagesAdded + albumCoversAdded,
      }));
    } catch (err) {
      if (err instanceof BackupParseError) {
        console.error("Failed to import backup:", err);
        setError(i18n.t(err.i18nKey));
      } else {
        console.error("Failed to import backup:", err);
        setError(i18n.t("backup.importFailed", { error: String(err) }));
      }
    } finally {
      setIsScanning(false);
    }
  };

  return { handleExportBackup, handleImportBackup };
}
