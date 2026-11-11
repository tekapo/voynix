import { describe, expect, it } from "vitest";
import i18n from "../i18n";
import { collectionMeta } from "./LibraryColumns";
import { Track } from "../types";

/** `count` songs that add up to `minutes` minutes (spread evenly; the first carries the rest). */
function tracks(count: number, minutes: number): Track[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `t${i}`, title: `S${i}`, artist: "A", album: "B",
        file_path: `/m/${i}.mp3`, file_name: `${i}.mp3`,
        duration: i === 0 ? minutes * 60 - (count - 1) : 1,
        disc_no: 1, track_no: 1,
    }));
}

describe("collectionMeta", () => {
    it("shows minutes only under an hour", () => {
        expect(collectionMeta(tracks(3, 59), i18n.t)).toBe("3 songs · 59 min");
        expect(collectionMeta(tracks(1, 3), i18n.t)).toBe("1 song · 3 min");
    });

    it("switches to hours and minutes from 60 minutes", () => {
        expect(collectionMeta(tracks(24, 92), i18n.t)).toBe("24 songs · 1 hr 32 min");
        expect(collectionMeta(tracks(2, 60), i18n.t)).toBe("2 songs · 1 hr");
        expect(collectionMeta(tracks(5, 120), i18n.t)).toBe("5 songs · 2 hr");
    });

    it("groups thousands in the song count", () => {
        expect(collectionMeta(tracks(1234, 13520), i18n.t)).toBe("1,234 songs · 225 hr 20 min");
    });

    it("reads naturally in Japanese", async () => {
        await i18n.changeLanguage("ja");
        expect(collectionMeta(tracks(24, 92), i18n.t)).toBe("24曲 · 1時間32分");
        expect(collectionMeta(tracks(5, 120), i18n.t)).toBe("5曲 · 2時間");
        expect(collectionMeta(tracks(1234, 9), i18n.t)).toBe("1,234曲 · 9分");
    });
});
