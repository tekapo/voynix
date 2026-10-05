import { describe, expect, it } from "vitest";
import { Track } from "./types";
import { filterStrings, filterTracks, haystackMatches, queryTerms } from "./search";

const t = (title: string, artist?: string, album?: string): Track =>
    ({ id: title, title, artist, album, file_path: `/m/${title}.mp3` } as Track);

const lib = [
    t("Yellow Submarine", "The Beatles", "Revolver"),
    t("Come Together", "The Beatles", "Abbey Road"),
    t("Paranoid Android", "Radiohead", "OK Computer"),
];

describe("queryTerms", () => {
    it("lowercases, splits on whitespace, drops empties", () => {
        expect(queryTerms("  Beatles   Yellow ")).toEqual(["beatles", "yellow"]);
        expect(queryTerms("   ")).toEqual([]);
    });
});

describe("full-width / half-width folding", () => {
    it("matches a half-width query against a full-width tag, and vice versa", () => {
        // NFKC folds full-width Latin/digits and half-width katakana to their
        // canonical form, so these compare equal regardless of which width the
        // user typed or the tag was written in.
        expect(haystackMatches("ｱｲｳｴｵ", queryTerms("アイウエオ"))).toBe(true);
        expect(haystackMatches("Ｔｒａｃｋ１", queryTerms("Track1"))).toBe(true);
    });
});

describe("haystackMatches", () => {
    it("requires every term, case-insensitive", () => {
        expect(haystackMatches("The Beatles Yellow Submarine", ["beatles", "yellow"])).toBe(true);
        expect(haystackMatches("The Beatles Come Together", ["beatles", "yellow"])).toBe(false);
        expect(haystackMatches("anything", [])).toBe(true);
    });
});

describe("filterTracks", () => {
    it("returns the same list for an empty query", () => {
        expect(filterTracks(lib, "  ")).toBe(lib);
    });
    it("matches across title, artist and album", () => {
        expect(filterTracks(lib, "beatles").map(x => x.title)).toEqual(["Yellow Submarine", "Come Together"]);
        expect(filterTracks(lib, "abbey").map(x => x.title)).toEqual(["Come Together"]);
        expect(filterTracks(lib, "radiohead computer").map(x => x.title)).toEqual(["Paranoid Android"]);
    });
    it("does not match on file path", () => {
        expect(filterTracks(lib, "mp3")).toEqual([]);
    });
    it("tolerates missing artist/album", () => {
        expect(filterTracks([t("Untitled")], "untitled").length).toBe(1);
    });
});

describe("filterStrings", () => {
    it("filters card lists with the same rules", () => {
        expect(filterStrings(["The Beatles", "Radiohead"], "beat")).toEqual(["The Beatles"]);
        expect(filterStrings(["A", "B"], "")).toEqual(["A", "B"]);
    });
});
