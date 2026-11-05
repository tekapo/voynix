import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("./settings", () => ({
  getSetting: vi.fn(async (k: string) => store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
}));

import {
  DEFAULT_REMOTE_PORT,
  getRemoteSecret,
  getRemoteSettings,
  regenerateRemoteSecret,
  setRemoteCertPaths,
  setRemoteEnabled,
  setRemotePort,
} from "./remoteSettings";

beforeEach(() => store.clear());

describe("remote settings", () => {
  it("defaults to off with the default port and empty paths", async () => {
    expect(await getRemoteSettings()).toEqual({
      enabled: false, port: DEFAULT_REMOTE_PORT, certPath: "", keyPath: "",
    });
  });

  it("round-trips enabled, port and trimmed cert paths", async () => {
    await setRemoteEnabled(true);
    await setRemotePort(9443);
    await setRemoteCertPaths("  /c.pem ", "/k.pem\n");
    expect(await getRemoteSettings()).toEqual({
      enabled: true, port: 9443, certPath: "/c.pem", keyPath: "/k.pem",
    });
    await setRemoteEnabled(false);
    expect((await getRemoteSettings()).enabled).toBe(false);
  });

  it.each(["0", "-1", "65536", "1.5", "abc", ""])("falls back to the default port for %j", async (raw) => {
    store.set("remote_port", raw);
    expect((await getRemoteSettings()).port).toBe(DEFAULT_REMOTE_PORT);
  });

  it("generates the secret once and keeps it", async () => {
    const a = await getRemoteSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await getRemoteSecret()).toBe(a);
  });

  it("regenerating replaces the stored secret", async () => {
    const a = await getRemoteSecret();
    const b = await regenerateRemoteSecret();
    expect(b).not.toBe(a);
    expect(await getRemoteSecret()).toBe(b);
  });
});
