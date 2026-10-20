import { describe, expect, it } from "vitest";
import { playlistSlotType } from "./echoSlot";

describe("playlistSlotType", () => {
    it("lists each playlist name once, as a PLAYLIST slot type", () => {
        const type = playlistSlotType(["ヒロト＆マーシー", "For Drive", "  Music ", "For Drive"]);
        expect(type.name).toBe("PLAYLIST");
        expect(type.values.map(v => v.name.value)).toEqual(["ヒロト＆マーシー", "For Drive", "Music"]);
    });

    it("drops blank and over-long names, which Alexa would reject", () => {
        const type = playlistSlotType(["", "   ", "x".repeat(141), "ok"]);
        expect(type.values.map(v => v.name.value)).toEqual(["ok"]);
    });

    it("is valid JSON to paste into the model's types array", () => {
        const text = JSON.stringify(playlistSlotType(["a"]), null, 2);
        expect(JSON.parse(text)).toEqual({ name: "PLAYLIST", values: [{ name: { value: "a" } }] });
    });
});
