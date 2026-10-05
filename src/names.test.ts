import { describe, expect, it } from "vitest";
import { artistLabel, artistOf, UNKNOWN_ARTIST } from "./names";

describe("artistOf", () => {
    it("returns the track's own artist tag when present", () => {
        expect(artistOf({ artist: "Radiohead" })).toBe("Radiohead");
    });

    it("falls back to UNKNOWN_ARTIST for blank/missing artist", () => {
        expect(artistOf({ artist: "" })).toBe(UNKNOWN_ARTIST);
        expect(artistOf({ artist: undefined })).toBe(UNKNOWN_ARTIST);
        expect(artistOf({})).toBe(UNKNOWN_ARTIST);
    });

    // artistOf's return value is used as a filter key (App.tsx) and persisted
    // as last_view_filter (db/settings.ts) — it must stay language-independent
    // regardless of what `t` would translate UNKNOWN_ARTIST to.
    it("is independent of the active language", () => {
        const translate = (key: string) => (key === "common.unknownArtist" ? "不明なアーティスト" : key);
        expect(artistOf({ artist: undefined })).toBe(UNKNOWN_ARTIST);
        expect(artistLabel({ artist: undefined }, translate)).toBe("不明なアーティスト");
    });
});

describe("artistLabel", () => {
    const t = (key: "common.unknownArtist") => `[${key}]`;

    it("passes through a real artist tag untranslated", () => {
        expect(artistLabel({ artist: "Radiohead" }, t)).toBe("Radiohead");
    });

    it("translates the UNKNOWN_ARTIST fallback for display", () => {
        expect(artistLabel({ artist: "" }, t)).toBe("[common.unknownArtist]");
        expect(artistLabel({}, t)).toBe("[common.unknownArtist]");
    });
});
