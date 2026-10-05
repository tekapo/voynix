// Test-only harness: a real SQLite database behind the same {select, execute}
// surface `@tauri-apps/plugin-sql`'s `Database` exposes, so db.ts's actual SQL
// (migrations, LWW guards, the play_events UNIQUE dedup index) runs for real
// instead of against the `fakeDb` vi.fn() mock used elsewhere. Node 26 ships
// `node:sqlite`, so this adds no dependency.
//
// Two "devices" (Mac + phone) can coexist in one process by holding one
// DatabaseSync each and switching which one db.ts's module-level singleton
// points at between turns — see setActiveDevice() / statsRoundTrip.test.ts.
import { DatabaseSync } from "node:sqlite";

/** The subset of @tauri-apps/plugin-sql's `Database` that db.ts actually calls. */
export interface PluginSqlLike {
    select<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
    execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId: number }>;
}

export interface DeviceStats {
    selects: number;
    executes: number;
}

export interface Device {
    name: string;
    raw: DatabaseSync;
    adapter: PluginSqlLike;
    /** Statement counts since the last resetStats() — a cheap way to pin a
     *  statement-count reduction (batching) end-to-end, not just
     *  correctness. */
    stats: DeviceStats;
    resetStats(): void;
}

// node:sqlite's positional array binding for `$1, $2, …` placeholders throws
// ("column index out of range") — verified against v26. A named object bind
// (`{'$1': v, ...}`) works, is order-independent, and — unlike a naive
// `$N -> ?` rewrite — handles a placeholder referenced more than once in one
// statement, which db.ts's LWW guards do (`WHERE ... AND (x IS NULL OR x < $2)`
// uses `$2` twice).
function toNamedParams(params?: unknown[]): Record<string, unknown> | undefined {
    if (!params || params.length === 0) return undefined;
    const named: Record<string, unknown> = {};
    params.forEach((v, i) => { named[`$${i + 1}`] = v ?? null; });
    return named;
}

function makeAdapter(raw: DatabaseSync, stats: DeviceStats): PluginSqlLike {
    return {
        async select<T = unknown>(sql: string, params?: unknown[]): Promise<T> {
            stats.selects++;
            const stmt = raw.prepare(sql);
            const named = toNamedParams(params);
            return (named ? stmt.all(named) : stmt.all()) as T;
        },
        async execute(sql: string, params?: unknown[]) {
            stats.executes++;
            const stmt = raw.prepare(sql);
            const named = toNamedParams(params);
            const result = named ? stmt.run(named) : stmt.run();
            return { rowsAffected: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
        },
    };
}

export function createDevice(name: string): Device {
    const raw = new DatabaseSync(":memory:");
    const stats: DeviceStats = { selects: 0, executes: 0 };
    return {
        name, raw, adapter: makeAdapter(raw, stats), stats,
        resetStats() { stats.selects = 0; stats.executes = 0; },
    };
}

let active: Device | null = null;

export function setActiveDevice(d: Device): void {
    active = d;
}

export function activeAdapter(): PluginSqlLike {
    if (!active) throw new Error("No active device set — call setActiveDevice() first");
    return active.adapter;
}
