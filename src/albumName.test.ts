import { describe, expect, it } from "vitest";
import { albumOf, effectiveAlbum, isFolderAlbum } from "./albumName";

describe("effectiveAlbum", () => {
    it("uses the tag when present", () => {
        expect(effectiveAlbum({ album: "Abbey Road", file_path: "/Music/Beatles/Abbey Road/01.mp3" }))
            .toBe("Abbey Road");
    });

    it("falls back to the parent folder name when untagged", () => {
        expect(effectiveAlbum({ album: "", file_path: "/Music/Live 2019/01.mp3" }))
            .toBe("Live 2019");
        expect(effectiveAlbum({ album: undefined, file_path: "/Music/Demos/a.mp3" }))
            .toBe("Demos");
    });

    it("trims whitespace-only tags before falling back", () => {
        expect(effectiveAlbum({ album: "   ", file_path: "/Music/Demos/a.mp3" }))
            .toBe("Demos");
    });

    it("skips a disc-numbering subfolder and uses its parent", () => {
        expect(effectiveAlbum({ album: "", file_path: "/Music/X/Disc 1/01.mp3" }))
            .toBe("X");
        expect(effectiveAlbum({ album: "", file_path: "/Music/X/CD2/01.mp3" }))
            .toBe("X");
        expect(effectiveAlbum({ album: "", file_path: "/Music/X/Disk 01/01.mp3" }))
            .toBe("X");
    });

    it("handles Windows-style path separators", () => {
        expect(effectiveAlbum({ album: "", file_path: "C:\\Music\\Demos\\a.mp3" }))
            .toBe("Demos");
    });

    it("returns null when there is no usable parent folder", () => {
        expect(effectiveAlbum({ album: "", file_path: "song.mp3" })).toBeNull();
        expect(effectiveAlbum({ album: "", file_path: "" })).toBeNull();
    });
});

describe("albumOf", () => {
    it("falls back to 'Unknown Album' when nothing else is available", () => {
        expect(albumOf({ album: "", file_path: "song.mp3" })).toBe("Unknown Album");
    });

    it("otherwise matches effectiveAlbum", () => {
        expect(albumOf({ album: "", file_path: "/Music/Demos/a.mp3" })).toBe("Demos");
    });
});

describe("isFolderAlbum", () => {
    it("is true when there is no album tag", () => {
        expect(isFolderAlbum({ album: "" })).toBe(true);
        expect(isFolderAlbum({ album: undefined })).toBe(true);
        expect(isFolderAlbum({ album: "   " })).toBe(true);
    });

    it("is false when a tag is present", () => {
        expect(isFolderAlbum({ album: "Abbey Road" })).toBe(false);
    });
});
