// Shared harness for App.tsx characterization tests. Renders the real <App/>
// against a real in-memory SQLite device (test/sqliteDevice.ts) seeded via
// test/seedLibrary.ts, with every other Tauri surface stubbed.
//
// vi.mock() calls are hoisted per-file by Vitest, so they must be textually
// in this module (not inside a function) — importing this file first (for
// its side effects) from a test file registers these mocks before App.tsx
// or db.ts are ever resolved in that file's module graph.
import { vi } from "vitest";
import { createDevice, setActiveDevice, type Device } from "./sqliteDevice";

export const invoke = vi.fn(async (_cmd: string, _args?: unknown) => null as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => invoke(...a) }));

export const listen = vi.fn(async (_event: string, _handler: (e: unknown) => void) => () => {});
export const emit = vi.fn(async (_event: string, _payload?: unknown) => {});
vi.mock("@tauri-apps/api/event", () => ({
    listen: (...a: [string, (e: unknown) => void]) => listen(...a),
    emit: (...a: [string, unknown?]) => emit(...a),
}));

export const open = vi.fn(async (..._a: unknown[]) => null as unknown);
export const ask = vi.fn(async (..._a: unknown[]) => true as unknown);
vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: (...a: unknown[]) => open(...a),
    ask: (...a: unknown[]) => ask(...a),
}));

// SettingsModal's About tab reads this on mount (Modals.tsx).
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.0.0-test" }));

export const fsExists = vi.fn(async (..._a: unknown[]) => false);
export const fsReadTextFile = vi.fn(async (..._a: unknown[]) => "[]");
export const fsReadFile = vi.fn(async (..._a: unknown[]) => new Uint8Array([1, 2, 3]));
vi.mock("@tauri-apps/plugin-fs", () => ({
    BaseDirectory: { AppLocalData: 1 },
    exists: (...a: unknown[]) => fsExists(...a),
    readTextFile: (...a: unknown[]) => fsReadTextFile(...a),
    readFile: (...a: unknown[]) => fsReadFile(...a),
}));

// Real SQLite behind plugin-sql's {select, execute} surface — see
// sqliteDevice.ts's header comment for why this catches things a fakeDb
// vi.fn() mock can't (LWW guards, unique-index dedup, actual query shape).
vi.mock("@tauri-apps/plugin-sql", () => ({
    default: { load: async () => (await import("./sqliteDevice")).activeAdapter() },
}));

/** Resets every mock to its default and points db.ts's singleton at a fresh
 * SQLite device. Call in beforeEach, before seeding/rendering. */
export function resetAppTestMocks(): Device {
    invoke.mockReset().mockResolvedValue(null);
    listen.mockReset().mockResolvedValue(() => {});
    emit.mockReset().mockResolvedValue(undefined);
    open.mockReset().mockResolvedValue(null);
    ask.mockReset().mockResolvedValue(true);
    fsExists.mockReset().mockResolvedValue(false);
    fsReadTextFile.mockReset().mockResolvedValue("[]");
    fsReadFile.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));

    const device = createDevice("test-device");
    setActiveDevice(device);
    return device;
}
