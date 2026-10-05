import { getDb } from "./core";
import { batchExecute } from "./batch";
import { HashCacheEntry } from "../types";

// ---- content_hash cache ------------------------------------------------
// Lets a rescan skip re-hashing files whose (size, mtime) are unchanged. The
// Rust scan takes these rows in and hands them back refreshed.

export async function loadHashCache(): Promise<HashCacheEntry[]> {
    const db = await getDb();
    return db.select(
        "SELECT file_path, size, mtime, content_hash, track_key FROM content_hash_cache"
    );
}

export async function saveHashCache(entries: HashCacheEntry[]) {
    const db = await getDb();
    // Multi-row upserts in chunks: one statement per chunk keeps the row count
    // down without relying on an explicit transaction (the sql plugin runs each
    // execute() on a pooled connection, so BEGIN/COMMIT wouldn't be reliable).
    await batchExecute(db, {
        rows: entries,
        cols: 5,
        perChunk: 120, // 120 * 5 = 600 params, well under SQLite's 999 limit
        toParams: e => [e.file_path, e.size, e.mtime, e.content_hash, e.track_key],
        sql: tuples => `
            INSERT INTO content_hash_cache (file_path, size, mtime, content_hash, track_key)
            VALUES ${tuples}
            ON CONFLICT(file_path) DO UPDATE SET
              size = excluded.size, mtime = excluded.mtime,
              content_hash = excluded.content_hash, track_key = excluded.track_key`,
    });
}
