import { describe, expect, it } from "vitest";
import { formatBytes, formatSeconds } from "./format";

describe("formatSeconds", () => {
    it("formats under an hour as m:ss", () => {
        expect(formatSeconds(5)).toBe("0:05");
        expect(formatSeconds(65)).toBe("1:05");
        expect(formatSeconds(600)).toBe("10:00");
        expect(formatSeconds(3599)).toBe("59:59");
    });

    it("switches to h:mm:ss at an hour and beyond", () => {
        expect(formatSeconds(3600)).toBe("1:00:00");
        expect(formatSeconds(7384)).toBe("2:03:04");
        expect(formatSeconds(2 * 3600)).toBe("2:00:00");
    });

    it("truncates fractional seconds", () => {
        expect(formatSeconds(65.9)).toBe("1:05");
    });
});

describe("formatBytes", () => {
    it("formats bytes under 1024 as-is", () => {
        expect(formatBytes(512)).toBe("512 B");
    });

    it("formats KB/MB/GB with one decimal under 10, none at or above", () => {
        expect(formatBytes(2048)).toBe("2.0 KB");
        expect(formatBytes(15 * 1024)).toBe("15 KB");
        expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
        expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    });
});
