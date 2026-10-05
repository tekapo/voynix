import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Tauri mocks (the app talks to the native layer on mount) ---

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string, unknown?]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async () => () => {}),
    emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-fs", () => ({
    BaseDirectory: { AppLocalData: 1 },
    exists: vi.fn(async () => false),
    readTextFile: vi.fn(async () => "[]"),
    readFile: vi.fn(async () => new Uint8Array()),
}));

// In-memory stand-in for @tauri-apps/plugin-sql. Every query returns [] so the
// migration runner sees user_version 0, runs cleanly, and the library is empty.
const fakeDb = {
    execute: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rowsAffected: 0, lastInsertId: 0 })),
    select: vi.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]),
};
vi.mock("@tauri-apps/plugin-sql", () => ({
    default: { load: vi.fn(async () => fakeDb) },
}));

import App from "./App";
import { _resetInitForTests } from "./db";

beforeEach(() => {
    invoke.mockClear();
    fakeDb.execute.mockClear();
    fakeDb.select.mockReset();
    fakeDb.select.mockImplementation(async () => [] as unknown[]);
    _resetInitForTests();
});

describe("App", () => {
    it("boots into the empty 'All Songs' view", async () => {
        render(<App />);

        // Appears only once initialization has finished and the DB returned no tracks.
        expect(await screen.findByText("No tracks found.")).toBeInTheDocument();

        // Header reflects the default view for an empty library.
        expect(screen.getAllByText("All Songs").length).toBeGreaterThan(0);
    });

    it("runs schema migrations on startup", async () => {
        render(<App />);
        await screen.findByText("No tracks found.");

        const ran = fakeDb.execute.mock.calls.map(c => String(c[0]));
        expect(ran.some(sql => sql.includes("PRAGMA user_version = 1"))).toBe(true);
        expect(ran.some(sql => sql.includes("PRAGMA user_version = 2"))).toBe(true);
        expect(ran.some(sql => sql.includes("PRAGMA user_version = 4"))).toBe(true);
        expect(ran.some(sql => sql.includes("PRAGMA user_version = 5"))).toBe(true);
        expect(ran.some(sql => sql.includes("PRAGMA user_version = 6"))).toBe(true);
        expect(ran.some(sql => sql.includes("CREATE TABLE IF NOT EXISTS play_events"))).toBe(true);
        expect(ran.some(sql => /ALTER TABLE tracks ADD COLUMN kind /.test(sql))).toBe(true);
        expect(ran.some(sql => /ALTER TABLE tracks ADD COLUMN disc_no /.test(sql))).toBe(true);
        expect(ran.some(sql => /ALTER TABLE tracks ADD COLUMN track_no /.test(sql))).toBe(true);
        expect(ran.some(sql => /ALTER TABLE playlists ADD COLUMN kind /.test(sql))).toBe(true);
    });

    it("restores the last-played view on a cold start", async () => {
        // settings reads are keyed by params[0]; everything else stays empty so
        // the library is empty and migrations see user_version 0.
        const store: Record<string, string> = {
            last_track_id: "t-restore",
            last_position: "63",
            last_view_mode: "most_played",
            last_playlist_id: "",
            last_view_filter: "",
        };
        fakeDb.select.mockImplementation(async (sql: string, params?: unknown[]) => {
            if (sql.includes("SELECT value FROM settings WHERE key")) {
                const key = (params?.[0] as string) ?? "";
                return key in store ? [{ value: store[key] }] : [];
            }
            return [] as unknown[];
        });

        render(<App />);
        await screen.findByText("No tracks found.");

        // Header shows the restored view, not the default "All Songs".
        expect(screen.getAllByText("Most Played").length).toBeGreaterThan(0);
    });

    it("shows the library views in the sidebar", async () => {
        render(<App />);
        await screen.findByText("No tracks found.");

        expect(screen.getByText("Favorites")).toBeInTheDocument();
        expect(screen.getByText("Most Played")).toBeInTheDocument();
    });

});
