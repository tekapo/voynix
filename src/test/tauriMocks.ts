// Shared Tauri mock factory for tests that render/exercise App.tsx or db.ts
// against a fake native layer. Centralizes what used to be copy-pasted into
// db.test.ts, App.test.tsx, albumArt.test.ts and LyricsPanel.test.tsx.
//
// Usage (must stay in this exact shape — vi.mock() is hoisted per-file, so
// the registration calls themselves can't live in a shared helper, only the
// vi.fn() objects they close over):
//
//   import { vi } from "vitest";
//   import { createTauriTestMocks } from "./test/tauriMocks";
//   const t = createTauriTestMocks();
//   vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => t.invoke(...a) }));
//   vi.mock("@tauri-apps/api/event", () => ({
//       listen: (...a: [string, (e: unknown) => void]) => t.listen(...a),
//       emit: (...a: [string, unknown?]) => t.emit(...a),
//   }));
//   vi.mock("@tauri-apps/plugin-dialog", () => ({
//       open: (...a: unknown[]) => t.open(...a),
//       ask: (...a: unknown[]) => t.ask(...a),
//   }));
//   vi.mock("@tauri-apps/plugin-fs", () => ({
//       BaseDirectory: { AppLocalData: 1 },
//       exists: (...a: unknown[]) => t.fsExists(...a),
//       readTextFile: (...a: unknown[]) => t.fsReadTextFile(...a),
//       readFile: (...a: unknown[]) => t.fsReadFile(...a),
//   }));
//   vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => t.fakeDb } }));
//
//   beforeEach(() => t.reset());
import { vi } from "vitest";

export interface FakeDb {
    execute: ReturnType<typeof vi.fn<(sql: string, params?: unknown[]) => Promise<{ rowsAffected: number; lastInsertId: number }>>>;
    select: ReturnType<typeof vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>>;
}

export interface TauriTestMocks {
    invoke: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    ask: ReturnType<typeof vi.fn>;
    fsExists: ReturnType<typeof vi.fn>;
    fsReadTextFile: ReturnType<typeof vi.fn>;
    fsReadFile: ReturnType<typeof vi.fn>;
    fakeDb: FakeDb;
    /** Resets every fn's calls and restores default resolved values. Call in beforeEach. */
    reset(): void;
}

export function createTauriTestMocks(): TauriTestMocks {
    const invoke = vi.fn(async (_cmd: string, _args?: unknown) => null as unknown);
    const listen = vi.fn(async (_event: string, _handler: (e: unknown) => void) => () => {});
    const emit = vi.fn(async (_event: string, _payload?: unknown) => {});
    const open = vi.fn(async (..._a: unknown[]) => null as unknown);
    const ask = vi.fn(async (..._a: unknown[]) => true as unknown);
    const fsExists = vi.fn(async (..._a: unknown[]) => false);
    const fsReadTextFile = vi.fn(async (..._a: unknown[]) => "[]");
    const fsReadFile = vi.fn(async (..._a: unknown[]) => new Uint8Array());
    const fakeDb: FakeDb = {
        execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowsAffected: 0, lastInsertId: 0 })),
        select: vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]),
    };

    function reset() {
        invoke.mockReset().mockResolvedValue(null);
        listen.mockReset().mockResolvedValue(() => {});
        emit.mockReset().mockResolvedValue(undefined);
        open.mockReset().mockResolvedValue(null);
        ask.mockReset().mockResolvedValue(true);
        fsExists.mockReset().mockResolvedValue(false);
        fsReadTextFile.mockReset().mockResolvedValue("[]");
        fsReadFile.mockReset().mockResolvedValue(new Uint8Array());
        fakeDb.execute.mockReset().mockResolvedValue({ rowsAffected: 0, lastInsertId: 0 });
        fakeDb.select.mockReset().mockResolvedValue([]);
    }

    return { invoke, listen, emit, open, ask, fsExists, fsReadTextFile, fsReadFile, fakeDb, reset };
}
