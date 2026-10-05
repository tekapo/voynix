import { describe, expect, it, vi } from "vitest";
import { createCappedCache, resolveCached } from "./cappedCache";

describe("createCappedCache", () => {
    it("get() is undefined for a key that was never set", () => {
        const cache = createCappedCache<string>({ max: 10 });
        expect(cache.get("x")).toBeUndefined();
    });

    it("remember() then get() returns the stored value, including null", () => {
        const cache = createCappedCache<string>({ max: 10 });
        cache.remember("a", "value");
        cache.remember("b", null);
        expect(cache.get("a")).toBe("value");
        expect(cache.get("b")).toBeNull();
    });

    it("evicts the oldest entry once over max, keeping newer ones", () => {
        const cache = createCappedCache<string>({ max: 2 });
        cache.remember("a", "1");
        cache.remember("b", "2");
        cache.remember("c", "3"); // pushes "a" out
        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe("2");
        expect(cache.get("c")).toBe("3");
    });

    it("cacheNull: false drops a null instead of storing it", () => {
        const cache = createCappedCache<string>({ max: 10, cacheNull: false });
        cache.remember("a", "value");
        cache.remember("a", null); // a miss on a re-resolve clears the prior hit too
        expect(cache.get("a")).toBeUndefined();
    });

    it("clear() drops everything", () => {
        const cache = createCappedCache<string>({ max: 10 });
        cache.remember("a", "1");
        cache.clear();
        expect(cache.get("a")).toBeUndefined();
    });
});

describe("resolveCached", () => {
    it("resolves once and caches the result", async () => {
        const cache = createCappedCache<string>({ max: 10 });
        const resolveUncached = vi.fn(async () => "value");
        const v1 = await resolveCached(cache, "k", resolveUncached);
        const v2 = await resolveCached(cache, "k", resolveUncached);
        expect(v1).toBe("value");
        expect(v2).toBe("value");
        expect(resolveUncached).toHaveBeenCalledTimes(1);
    });

    it("two concurrent callers for the same uncached key share one in-flight resolve", async () => {
        const cache = createCappedCache<string>({ max: 10 });
        let resolveIt!: (v: string) => void;
        const resolveUncached = vi.fn(
            () => new Promise<string>((resolve) => { resolveIt = resolve; }),
        );
        const p1 = resolveCached(cache, "k", resolveUncached);
        const p2 = resolveCached(cache, "k", resolveUncached);
        resolveIt("value");
        expect(await p1).toBe("value");
        expect(await p2).toBe("value");
        expect(resolveUncached).toHaveBeenCalledTimes(1);
    });

    it("a cacheNull:false miss is retried on the next call instead of staying cached", async () => {
        const cache = createCappedCache<string>({ max: 10, cacheNull: false });
        const resolveUncached = vi.fn(async () => null);
        await resolveCached(cache, "k", resolveUncached);
        await resolveCached(cache, "k", resolveUncached);
        expect(resolveUncached).toHaveBeenCalledTimes(2);
    });
});
