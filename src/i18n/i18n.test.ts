import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import { resolveLanguage } from "./index";

/** Flattens a nested translation object into dotted keys, e.g.
 *  { sidebar: { library: "x" } } -> ["sidebar.library"]. Keys ending in a
 *  plural suffix (i18next's `_one`/`_other`/...) are normalized back to their
 *  base key, since ja only ever needs `_other` while en may also have
 *  `_one` — that's a legitimate difference, not a missing translation. */
function flattenKeys(obj: unknown, prefix = ""): Set<string> {
    const keys = new Set<string>();
    if (obj == null || typeof obj !== "object") return keys;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v != null && typeof v === "object") {
            for (const nested of flattenKeys(v, path)) keys.add(nested);
        } else {
            keys.add(path.replace(/_(zero|one|two|few|many|other)$/, ""));
        }
    }
    return keys;
}

describe("resolveLanguage", () => {
    it("maps any ja* system language to ja", () => {
        expect(resolveLanguage("system", ["ja-JP"])).toBe("ja");
        expect(resolveLanguage("system", ["ja"])).toBe("ja");
    });

    it("falls back to en for anything else, including no match", () => {
        expect(resolveLanguage("system", ["fr-FR", "en-US"])).toBe("en");
        expect(resolveLanguage("system", [])).toBe("en");
    });

    it("an explicit en/ja preference short-circuits the system list", () => {
        expect(resolveLanguage("en", ["ja-JP"])).toBe("en");
        expect(resolveLanguage("ja", ["en-US"])).toBe("ja");
    });
});

describe("translation dictionaries", () => {
    it("ja has no keys that en lacks (and vice versa), aside from plural variants", () => {
        const enKeys = flattenKeys(en);
        const jaKeys = flattenKeys(ja);
        const missingInJa = [...enKeys].filter(k => !jaKeys.has(k));
        const missingInEn = [...jaKeys].filter(k => !enKeys.has(k));
        expect(missingInJa).toEqual([]);
        expect(missingInEn).toEqual([]);
    });
});
