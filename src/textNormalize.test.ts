import { describe, expect, it } from "vitest";
import { normalizeText } from "./textNormalize";

describe("normalizeText", () => {
    it("lowercases and trims", () => {
        expect(normalizeText("  The Beatles  ")).toBe("the beatles");
    });

    it("folds full-width Latin/digits to half-width (NFKC)", () => {
        expect(normalizeText("Ｔｒａｃｋ１")).toBe("track1");
    });

    it("folds half-width katakana to full-width (NFKC)", () => {
        expect(normalizeText("ｱｲｳｴｵ")).toBe("アイウエオ".toLowerCase());
    });
});
