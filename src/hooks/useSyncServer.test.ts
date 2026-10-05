import { describe, expect, it } from "vitest";
import { nextServerStatus } from "./useSyncServer";
import type { ServerStatus } from "../types";

const status = (over: Partial<ServerStatus> = {}): ServerStatus => ({
  running: true,
  ip: "192.168.0.2",
  port: 60930,
  url: "https://192.168.0.2:60930",
  token: "t",
  fingerprint: "f",
  ...over,
} as ServerStatus);

describe("nextServerStatus", () => {
  it("keeps the previous object when nothing changed", () => {
    const prev = status();
    expect(nextServerStatus(prev, status())).toBe(prev);
  });

  it("adopts the live status when only the IP changed", () => {
    const live = status({ ip: "192.168.1.10" });
    expect(nextServerStatus(status(), live)).toBe(live);
  });

  it("adopts the live status when the port changed", () => {
    const live = status({ port: 1234 });
    expect(nextServerStatus(status(), live)).toBe(live);
  });

  it("clears when the server is gone", () => {
    expect(nextServerStatus(status(), null)).toBeNull();
    expect(nextServerStatus(null, null)).toBeNull();
  });
});
