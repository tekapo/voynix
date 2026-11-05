import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { strToU8, zipSync } from "fflate";
import { BACKUP_FORMAT, BACKUP_VERSION } from "../backup";

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
const fs = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
const db = vi.hoisted(() => ({
  buildBackup: vi.fn(),
  buildCoverImages: vi.fn(),
  importCovers: vi.fn(),
  getPlaylistTrackIdsByPath: vi.fn(),
  importPlaylists: vi.fn(),
  importSettings: vi.fn(),
  setPlaylistTrackOrder: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("1.2.3") }));
vi.mock("../db", () => db);

import { useBackup } from "./useBackup";

const backupJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: 1,
    settings: { ui_language: "ja" },
    folders: [],
    playlists: [],
    ...over,
  });

function setup(scanFolders: { path: string }[] = []) {
  const params = {
    scanFolders: scanFolders as never,
    registerFolder: vi.fn().mockResolvedValue({ playlistId: "local-1" }),
    refreshScanFolders: vi.fn().mockResolvedValue(undefined),
    refreshPlaylists: vi.fn().mockResolvedValue(undefined),
    reloadSettings: vi.fn().mockResolvedValue(undefined),
    setIsScanning: vi.fn(),
    onCoversImported: vi.fn(),
    setError: vi.fn(),
  };
  const { result } = renderHook(() => useBackup(params));
  return { params, ...result.current };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  db.importSettings.mockResolvedValue(undefined);
  db.importPlaylists.mockResolvedValue({ added: 2, skipped: 1, missingTracks: 0 });
  db.importCovers.mockResolvedValue({ artistImagesAdded: 0, albumCoversAdded: 0 });
  db.getPlaylistTrackIdsByPath.mockResolvedValue(new Map());
});

describe("handleImportBackup", () => {
  it("does nothing when the dialog is cancelled", async () => {
    dialog.open.mockResolvedValue(null);
    const { params, handleImportBackup } = setup();
    await handleImportBackup();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(db.importSettings).not.toHaveBeenCalled();
    expect(params.setError).not.toHaveBeenCalled();
    expect(params.setIsScanning).not.toHaveBeenCalledWith(true);
  });

  it("imports a bare .json backup and refreshes state", async () => {
    dialog.open.mockResolvedValue("/tmp/b.json");
    fs.readFile.mockResolvedValue(strToU8(backupJson()));
    const { params, handleImportBackup } = setup();
    await handleImportBackup();
    expect(db.importSettings).toHaveBeenCalledWith({ ui_language: "ja" });
    expect(params.reloadSettings).toHaveBeenCalled();
    expect(db.importPlaylists).toHaveBeenCalled();
    expect(params.refreshScanFolders).toHaveBeenCalled();
    expect(params.refreshPlaylists).toHaveBeenCalled();
    expect(params.onCoversImported).not.toHaveBeenCalled();
    expect(params.setIsScanning.mock.calls).toEqual([[true], [false]]);
  });

  it("reads backup.json out of a .zip and passes the other entries as images", async () => {
    dialog.open.mockResolvedValue("/tmp/B.ZIP");
    const img = new Uint8Array([1, 2, 3]);
    fs.readFile.mockResolvedValue(zipSync({ "backup.json": strToU8(backupJson()), "images/a.jpg": img }));
    db.importCovers.mockResolvedValue({ artistImagesAdded: 1, albumCoversAdded: 0 });
    const { params, handleImportBackup } = setup();
    await handleImportBackup();
    const images = db.importCovers.mock.calls[0][1] as Map<string, Uint8Array>;
    expect(Array.from(images.keys())).toContain("images/a.jpg");
    expect(params.onCoversImported).toHaveBeenCalled();
  });

  it("reports an invalid archive without touching the DB", async () => {
    dialog.open.mockResolvedValue("/tmp/b.zip");
    fs.readFile.mockResolvedValue(new Uint8Array([0, 1, 2]));
    const { params, handleImportBackup } = setup();
    await handleImportBackup();
    expect(db.importSettings).not.toHaveBeenCalled();
    expect(params.setError).toHaveBeenCalledTimes(1);
    expect(params.setIsScanning).toHaveBeenLastCalledWith(false);
  });

  it("rejects a zip that has no backup.json", async () => {
    dialog.open.mockResolvedValue("/tmp/b.zip");
    fs.readFile.mockResolvedValue(zipSync({ "other.txt": strToU8("x") }));
    const { params, handleImportBackup } = setup();
    await handleImportBackup();
    expect(db.importSettings).not.toHaveBeenCalled();
    expect(params.setError).toHaveBeenCalledTimes(1);
  });

  it("reports unparseable JSON without touching the DB", async () => {
    dialog.open.mockResolvedValue("/tmp/b.json");
    fs.readFile.mockResolvedValue(strToU8("not json"));
    const { params, handleImportBackup } = setup();
    await handleImportBackup();
    expect(db.importSettings).not.toHaveBeenCalled();
    expect(params.setError).toHaveBeenCalledTimes(1);
  });

  it("skips folders that are already registered and registers new ones", async () => {
    dialog.open.mockResolvedValue("/tmp/b.json");
    fs.readFile.mockResolvedValue(strToU8(backupJson({
      folders: [{ path: "/music/old" }, { path: "/music/new" }],
    })));
    const { params, handleImportBackup } = setup([{ path: "/music/old" }]);
    await handleImportBackup();
    expect(params.registerFolder).toHaveBeenCalledTimes(1);
    expect(params.registerFolder.mock.calls[0][0]).toBe("/music/new");
  });

  it("counts a folder whose registration fails as skipped and keeps going", async () => {
    dialog.open.mockResolvedValue("/tmp/b.json");
    fs.readFile.mockResolvedValue(strToU8(backupJson({
      folders: [{ path: "/music/bad" }, { path: "/music/ok" }],
    })));
    const { params, handleImportBackup } = setup();
    params.registerFolder.mockRejectedValueOnce(new Error("boom"));
    await handleImportBackup();
    expect(params.registerFolder).toHaveBeenCalledTimes(2);
    expect(db.importPlaylists).toHaveBeenCalled();
  });

  it("restores the backed-up track order for a new folder playlist", async () => {
    dialog.open.mockResolvedValue("/tmp/b.json");
    fs.readFile.mockResolvedValue(strToU8(backupJson({
      folders: [{
        path: "/music/new",
        playlist: { id: "old-1", name: "New", track_paths: ["/b", "/a"] },
      }],
    })));
    db.getPlaylistTrackIdsByPath.mockResolvedValue(new Map([["/a", "ta"], ["/b", "tb"], ["/c", "tc"]]));
    const { handleImportBackup } = setup();
    await handleImportBackup();
    expect(db.setPlaylistTrackOrder).toHaveBeenCalledWith("local-1", ["tb", "ta", "tc"]);
    const idMap = db.importPlaylists.mock.calls[0][1] as Map<string, string>;
    expect(idMap.get("old-1")).toBe("local-1");
  });

  it("reports a DB failure and still clears the scanning flag", async () => {
    dialog.open.mockResolvedValue("/tmp/b.json");
    fs.readFile.mockResolvedValue(strToU8(backupJson()));
    db.importSettings.mockRejectedValue(new Error("db down"));
    const { params, handleImportBackup } = setup();
    await handleImportBackup();
    expect(params.setError).toHaveBeenCalledTimes(1);
    expect(params.setIsScanning).toHaveBeenLastCalledWith(false);
  });
});

describe("handleExportBackup", () => {
  it("does nothing when the save dialog is cancelled", async () => {
    dialog.save.mockResolvedValue(null);
    const { params, handleExportBackup } = setup();
    await handleExportBackup();
    expect(db.buildBackup).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(params.setError).not.toHaveBeenCalled();
  });

  it("writes a zip containing backup.json and the cover images", async () => {
    dialog.save.mockResolvedValue("/tmp/out.zip");
    db.buildBackup.mockResolvedValue({ format: BACKUP_FORMAT });
    db.buildCoverImages.mockResolvedValue({
      artist_covers: [],
      album_covers: [],
      images: new Map([["images/a.jpg", new Uint8Array([9])]]),
    });
    const { params, handleExportBackup } = setup();
    await handleExportBackup();
    expect(db.buildBackup).toHaveBeenCalledWith("1.2.3");
    const [path, bytes] = fs.writeFile.mock.calls[0];
    expect(path).toBe("/tmp/out.zip");
    const { unzipSync } = await import("fflate");
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual(["backup.json", "images/a.jpg"]);
    expect(params.setError).toHaveBeenCalledTimes(1);
  });

  it("reports a write failure", async () => {
    dialog.save.mockResolvedValue("/tmp/out.zip");
    db.buildBackup.mockResolvedValue({});
    db.buildCoverImages.mockResolvedValue({ artist_covers: [], album_covers: [], images: new Map() });
    fs.writeFile.mockRejectedValue(new Error("disk full"));
    const { params, handleExportBackup } = setup();
    await handleExportBackup();
    expect(params.setError).toHaveBeenCalledTimes(1);
    expect(String(params.setError.mock.calls[0][0])).toContain("disk full");
  });
});
