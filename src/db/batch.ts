import type Database from "@tauri-apps/plugin-sql";
import { chunk } from "../sync";

/**
 * Shared "insert/update many rows in a multi-row VALUES statement, chunked to
 * stay under sqlite's bound-parameter limit" pattern — six call sites
 * (hashCache.ts, covers.ts x2, syncStats.ts x3) used to each write their own
 * copy of the `($1, $2, …), ($6, $7, …)` tuple-building loop. The SQL shape
 * itself (`INSERT … ON CONFLICT`, `INSERT OR IGNORE`, `UPDATE … FROM VALUES`)
 * still varies per call site, so `sql` stays a caller-supplied template
 * rather than something this tries to generalize away.
 */
export interface BatchWriteSpec<T> {
    rows: T[];
    /** Bound params per row — must match `cols` and the order `sql`'s tuples expect. */
    cols: number;
    /** Rows per statement. Sized per call site: either sqlite's ~999-param cap
     * (params = rows-per-chunk * cols) or, for large payloads like a cover's
     * base64 image, well under that to keep any one statement's bound-data
     * size down. */
    perChunk: number;
    /** One row -> its bound params, in the same order every time (matches `cols`). */
    toParams: (row: T) => unknown[];
    /** Given this chunk's `($1, $2, …), …` tuple list, the full statement to run. */
    sql: (tuples: string) => string;
    onChunk?: (done: number, total: number) => void;
}

/** Builds `($1, $2, …), ($cols+1, $cols+2, …), …` for `count` rows of `cols` columns each. */
function tupleList(count: number, cols: number): string {
    return Array.from({ length: count }, (_, j) => {
        const base = j * cols;
        const placeholders = Array.from({ length: cols }, (_, k) => `$${base + k + 1}`).join(", ");
        return `(${placeholders})`;
    }).join(", ");
}

/**
 * Runs `spec.sql` once per chunk of `spec.rows`, reporting progress via
 * `onChunk` as each completes. Returns the summed `rowsAffected` across every
 * chunk (0 if the driver doesn't report it, or the caller doesn't need it —
 * see `applyFavoritesBatch` vs. `applyPlayStatesBatch` in syncStats.ts, which
 * differ only in whether they use this return value).
 */
export async function batchExecute<T>(db: Database, spec: BatchWriteSpec<T>): Promise<number> {
    const { rows, cols, perChunk, toParams, sql, onChunk } = spec;
    if (rows.length === 0) return 0;
    let done = 0;
    let rowsAffected = 0;
    for (const part of chunk(rows, perChunk)) {
        const params = part.flatMap(toParams);
        const result = await db.execute(sql(tupleList(part.length, cols)), params);
        rowsAffected += result?.rowsAffected ?? 0;
        done += part.length;
        onChunk?.(done, rows.length);
    }
    return rowsAffected;
}
