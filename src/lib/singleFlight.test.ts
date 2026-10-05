import { describe, expect, it, vi } from "vitest";
import { createKeyedSingleFlight, createRunOnce } from "./singleFlight";

describe("createRunOnce", () => {
    it("runs the job once even when called concurrently before it settles", async () => {
        const start = vi.fn(() => Promise.resolve(42));
        const once = createRunOnce(start);
        const [a, b] = await Promise.all([once.run(), once.run()]);
        expect(a).toBe(42);
        expect(b).toBe(42);
        expect(start).toHaveBeenCalledTimes(1);
    });

    it("does not re-run after success", async () => {
        const start = vi.fn(() => Promise.resolve("ok"));
        const once = createRunOnce(start);
        await once.run();
        await once.run();
        expect(start).toHaveBeenCalledTimes(1);
    });

    it("lets a later call retry after a failure", async () => {
        const start = vi.fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce("recovered");
        const once = createRunOnce(start);
        await expect(once.run()).rejects.toThrow("boom");
        await expect(once.run()).resolves.toBe("recovered");
        expect(start).toHaveBeenCalledTimes(2);
    });

    it("reset() forces the job to run again", async () => {
        const start = vi.fn(() => Promise.resolve("v"));
        const once = createRunOnce(start);
        await once.run();
        once.reset();
        await once.run();
        expect(start).toHaveBeenCalledTimes(2);
    });
});

describe("createKeyedSingleFlight", () => {
    it("dedupes concurrent calls for the same key", async () => {
        const singleFlight = createKeyedSingleFlight<string, number>();
        const start = vi.fn(() => Promise.resolve(1));
        const [a, b] = await Promise.all([
            singleFlight("k", start),
            singleFlight("k", start),
        ]);
        expect(a).toBe(1);
        expect(b).toBe(1);
        expect(start).toHaveBeenCalledTimes(1);
    });

    it("runs independently for different keys", async () => {
        const singleFlight = createKeyedSingleFlight<string, number>();
        const [a, b] = await Promise.all([
            singleFlight("a", () => Promise.resolve(1)),
            singleFlight("b", () => Promise.resolve(2)),
        ]);
        expect(a).toBe(1);
        expect(b).toBe(2);
    });

    it("allows a key to be re-run after it settles, on success or failure", async () => {
        const singleFlight = createKeyedSingleFlight<string, number>();
        const start = vi.fn(() => Promise.resolve(1));
        await singleFlight("k", start);
        await singleFlight("k", start);
        expect(start).toHaveBeenCalledTimes(2);

        const failing = vi.fn(() => Promise.reject(new Error("boom")));
        await expect(singleFlight("k2", failing)).rejects.toThrow("boom");
        await singleFlight("k2", () => Promise.resolve(9));
        expect(failing).toHaveBeenCalledTimes(1);
    });
});
