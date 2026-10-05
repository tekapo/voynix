import { getDb } from "./core";
import { ScanFolder, TrackKind } from "../types";

export async function getScanFolders(): Promise<ScanFolder[]> {
    const db = await getDb();
    const rows: any[] = await db.select(
        "SELECT path, playlist_id, default_kind FROM scan_folders ORDER BY added_at ASC"
    );
    return rows.map(r => ({
        path: r.path,
        playlist_id: r.playlist_id ?? null,
        default_kind: (r.default_kind ?? 'music') as TrackKind,
    }));
}

export async function addScanFolder(path: string, playlistId: string | null) {
    const db = await getDb();
    await db.execute(
        `INSERT INTO scan_folders (path, playlist_id, added_at)
         VALUES ($1, $2, $3)
         ON CONFLICT(path) DO UPDATE SET playlist_id = excluded.playlist_id`,
        [path, playlistId, Date.now()]
    );
}

export async function removeScanFolder(path: string) {
    const db = await getDb();
    await db.execute("DELETE FROM scan_folders WHERE path = $1", [path]);
}
