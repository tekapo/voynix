import { describe, expect, it, vi } from "vitest";
import { batchExecute } from "./batch";
import type Database from "@tauri-apps/plugin-sql";

// batchExecute takes a Database directly (callers own getDb()), so it needs
// no module mocking — a plain object matching the bits it calls is enough.
const fakeDb = (rowsAffected = 0) => ({
    execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowsAffected, lastInsertId: 0 })),
}) as unknown as Database;

describe("batchExecute", () => {
    it("is a no-op for an empty row list — no statement, no onChunk call", async () => {
        const db = fakeDb();
        const onChunk = vi.fn();
        const affected = await batchExecute(db, {
            rows: [] as { id: string }[],
            cols: 1,
            perChunk: 10,
            toParams: r => [r.id],
            sql: tuples => `INSERT INTO x (id) VALUES ${tuples}`,
            onChunk,
        });
        expect(db.execute).not.toHaveBeenCalled();
        expect(onChunk).not.toHaveBeenCalled();
        expect(affected).toBe(0);
    });

    it("splits rows into perChunk-sized statements with correctly-numbered placeholders", async () => {
        const db = fakeDb();
        const rows = [{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "c", n: 3 }];
        await batchExecute(db, {
            rows,
            cols: 2,
            perChunk: 2,
            toParams: r => [r.id, r.n],
            sql: tuples => `INSERT INTO x (id, n) VALUES ${tuples}`,
        });
        const calls = (db.execute as ReturnType<typeof vi.fn>).mock.calls;
        expect(calls).toEqual([
            ["INSERT INTO x (id, n) VALUES ($1, $2), ($3, $4)", ["a", 1, "b", 2]],
            ["INSERT INTO x (id, n) VALUES ($1, $2)", ["c", 3]],
        ]);
    });

    it("reports progress against the full row count as each chunk completes", async () => {
        const db = fakeDb();
        const onChunk = vi.fn();
        const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
        await batchExecute(db, {
            rows, cols: 1, perChunk: 2,
            toParams: r => [r.id],
            sql: tuples => `INSERT INTO x (id) VALUES ${tuples}`,
            onChunk,
        });
        expect(onChunk.mock.calls).toEqual([[2, 3], [3, 3]]);
    });

    it("sums rowsAffected across every chunk", async () => {
        const db = fakeDb(2);
        const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
        const affected = await batchExecute(db, {
            rows, cols: 1, perChunk: 2,
            toParams: r => [r.id],
            sql: tuples => `UPDATE x SET y = 1 WHERE id IN (${tuples})`,
        });
        // 2 chunks (2 + 1 rows), each reporting rowsAffected: 2 -> 4 total.
        expect(affected).toBe(4);
    });
});
