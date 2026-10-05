import { describe, expect, it } from "vitest";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { BACKUP_FORMAT, BACKUP_VERSION, BackupParseError, bytesToDataUri, dataUriToBytes, parseBackup, remapSmartRules } from "./backup";
import { DEFAULT_SMART_RULES } from "./smartPlaylist";

function validBackupJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exported_at: 1700000000000,
        app_version: "0.15.0",
        settings: { ui_language: "ja", show_path_column: "1", unknown_key: "x" },
        folders: [
            {
                path: "/Music/Rock",
                default_kind: "music",
                playlist: { id: "pl-folder", kind: "music", sync_to_device: 1, manual_order: 1, track_paths: ["/Music/Rock/a.mp3"] },
            },
        ],
        playlists: [
            {
                id: "pl-1", name: "My Mix", type: "custom", kind: "music", sync_to_device: 0,
                tracks: [{ file_path: "/Music/a.mp3", file_name: "a.mp3", title: "A" }],
            },
            { id: "pl-2", name: "Smart", type: "smart", rules: DEFAULT_SMART_RULES },
        ],
        ...overrides,
    });
}

describe("parseBackup smart playlist rules", () => {
    const smartBackup = (rules: unknown) =>
        validBackupJson({ playlists: [{ id: "pl-s", name: "S", type: "smart", rules }] });

    it("skips a smart playlist whose rules have no conditions array", () => {
        expect(parseBackup(smartBackup({ match: "all" })).playlists).toEqual([]);
        expect(parseBackup(smartBackup("nope")).playlists).toEqual([]);
    });

    it("keeps valid conditions, drops malformed ones, and defaults bad scalars", () => {
        const parsed = parseBackup(smartBackup({
            match: "bogus",
            sortBy: "nonsense",
            limit: -3,
            conditions: [
                { field: "genre", op: "contains", value: "Rock" },
                { field: "genre", op: "contains" },                // missing value
                { field: "play_count", op: "between", value: 1 },   // missing value2
                { field: "added_at", op: "in_last", value: 7, unit: "years" },
                { field: "mystery", op: "is", value: "x" },
                null,
            ],
        })).playlists;
        expect(parsed).toHaveLength(1);
        if (parsed[0].type !== "smart") throw new Error("unexpected type");
        expect(parsed[0].rules).toEqual({
            v: 1, match: "all", sortBy: "natural", sortDesc: false, limit: null,
            conditions: [{ field: "genre", op: "contains", value: "Rock" }],
        });
    });
});

describe("parseBackup", () => {
    it("parses a well-formed backup", () => {
        const backup = parseBackup(validBackupJson());
        expect(backup.format).toBe(BACKUP_FORMAT);
        // Unknown settings keys are dropped; only the allow-listed ones survive.
        expect(backup.settings).toEqual({ ui_language: "ja", show_path_column: "1" });
        expect(backup.folders).toHaveLength(1);
        expect(backup.folders[0].playlist?.track_paths).toEqual(["/Music/Rock/a.mp3"]);
        expect(backup.playlists).toHaveLength(2);
        const custom = backup.playlists.find(p => p.type === "custom");
        expect(custom).toMatchObject({ id: "pl-1", name: "My Mix" });
    });

    it("rejects invalid JSON", () => {
        expect(() => parseBackup("{not json")).toThrow(BackupParseError);
    });

    it("rejects a non-object root", () => {
        expect(() => parseBackup("[1,2,3]")).toThrow(BackupParseError);
    });

    it("rejects the wrong format tag", () => {
        expect(() => parseBackup(validBackupJson({ format: "something-else" }))).toThrow(BackupParseError);
    });

    it("rejects a newer version than this app understands", () => {
        expect(() => parseBackup(validBackupJson({ version: BACKUP_VERSION + 1 }))).toThrow(BackupParseError);
    });

    it("rejects a missing settings object", () => {
        expect(() => parseBackup(validBackupJson({ settings: null }))).toThrow(BackupParseError);
    });

    it("rejects folders/playlists that aren't arrays", () => {
        expect(() => parseBackup(validBackupJson({ folders: {} }))).toThrow(BackupParseError);
        expect(() => parseBackup(validBackupJson({ playlists: "nope" }))).toThrow(BackupParseError);
    });

    it("drops a malformed entry within folders/playlists instead of throwing", () => {
        const backup = parseBackup(validBackupJson({
            folders: [{ path: "/ok" }, { no_path: true }],
            playlists: [{ id: "x", name: "ok", type: "custom", tracks: [] }, { type: "custom" /* missing id/name */ }],
        }));
        expect(backup.folders).toHaveLength(1);
        expect(backup.playlists).toHaveLength(1);
    });
});

describe("remapSmartRules", () => {
    it("rewrites a playlist condition's value through the id map", () => {
        const rules = {
            ...DEFAULT_SMART_RULES,
            conditions: [{ field: "playlist" as const, op: "in" as const, value: "old-id" }],
        };
        const idMap = new Map([["old-id", "new-id"]]);
        const remapped = remapSmartRules(rules, idMap);
        expect(remapped.conditions[0]).toEqual({ field: "playlist", op: "in", value: "new-id" });
    });

    it("leaves a condition's value alone when it has no entry in the id map", () => {
        const rules = {
            ...DEFAULT_SMART_RULES,
            conditions: [{ field: "playlist" as const, op: "in" as const, value: "unmapped-id" }],
        };
        const remapped = remapSmartRules(rules, new Map());
        expect(remapped.conditions[0]).toEqual({ field: "playlist", op: "in", value: "unmapped-id" });
    });

    it("leaves non-playlist conditions untouched", () => {
        const rules = {
            ...DEFAULT_SMART_RULES,
            conditions: [{ field: "favorite" as const, op: "is_true" as const }],
        };
        const remapped = remapSmartRules(rules, new Map([["a", "b"]]));
        expect(remapped.conditions).toEqual(rules.conditions);
    });
});

describe("cover images in backups", () => {
    const base = { format: BACKUP_FORMAT, version: BACKUP_VERSION, settings: {}, folders: [], playlists: [] };

    it("parses v2 cover refs and drops entries with unsafe/missing files", () => {
        const b = parseBackup(JSON.stringify({
            ...base,
            artist_covers: [
                { artist: "a", file: "images/artists/0001.jpg", updated_at: 5 },
                { artist: "b", file: "../etc/passwd" },
                { artist: "c" },
            ],
            album_covers: [{ artist: "a", album: "x", file: "images/albums/0001.png" }],
        }));
        expect(b.artist_covers).toEqual([{ artist: "a", file: "images/artists/0001.jpg", updated_at: 5 }]);
        expect(b.album_covers).toEqual([{ artist: "a", album: "x", file: "images/albums/0001.png", updated_at: 0 }]);
    });

    it("still parses a v1 backup with no cover fields", () => {
        const b = parseBackup(JSON.stringify({ ...base, version: 1 }));
        expect(b.artist_covers).toEqual([]);
        expect(b.album_covers).toEqual([]);
    });

    it("converts data URIs to bytes and back, through a zip", () => {
        const uri = `data:image/png;base64,${btoa("\x89PNGdata")}`;
        const img = dataUriToBytes(uri)!;
        expect(img.ext).toBe("png");
        const zip = zipSync({ "backup.json": strToU8("{}"), "images/artists/0001.png": [img.bytes, { level: 0 }] });
        const files = unzipSync(zip);
        expect(strFromU8(files["backup.json"])).toBe("{}");
        expect(bytesToDataUri("images/artists/0001.png", files["images/artists/0001.png"])).toBe(uri);
    });

    it("returns null for a non-data-URI", () => {
        expect(dataUriToBytes("https://example.com/x.jpg")).toBeNull();
    });
});
