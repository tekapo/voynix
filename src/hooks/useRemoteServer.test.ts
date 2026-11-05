import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({
  buildRemoteLibrary: vi.fn(),
  DEFAULT_REMOTE_PORT: 8443,
  getRemoteSecret: vi.fn(),
  getRemoteSettings: vi.fn(),
  regenerateRemoteSecret: vi.fn(),
  setRemoteCertPaths: vi.fn(),
  setRemoteEnabled: vi.fn(),
  setRemotePort: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../db", () => db);

import { useRemoteServer } from "./useRemoteServer";

const live = { running: true, port: 8443 };
const stored = (over = {}) => ({ enabled: false, port: 8443, certPath: "/c.pem", keyPath: "/k.pem", ...over });

function setup() {
  const setError = vi.fn();
  const hook = renderHook(() => useRemoteServer({ playlists: [], setError }));
  return { setError, hook };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  invoke.mockResolvedValue(undefined);
  db.getRemoteSecret.mockResolvedValue("secret");
  db.getRemoteSettings.mockResolvedValue(stored());
  db.setRemoteEnabled.mockResolvedValue(undefined);
  db.setRemotePort.mockResolvedValue(undefined);
  db.setRemoteCertPaths.mockResolvedValue(undefined);
  db.regenerateRemoteSecret.mockResolvedValue("new-secret");
});

describe("initRemoteFromDb", () => {
  it("loads stored settings and does not start when disabled", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "remote_server_status" ? null : undefined));
    const { hook } = setup();
    await act(() => hook.result.current.initRemoteFromDb());
    expect(hook.result.current.remote.certPath).toBe("/c.pem");
    expect(hook.result.current.remote.enabled).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("start_remote_server", expect.anything());
  });

  it("starts the server when it was enabled and nothing is running", async () => {
    db.getRemoteSettings.mockResolvedValue(stored({ enabled: true, port: 9443 }));
    invoke.mockImplementation(async (cmd: string) => (cmd === "start_remote_server" ? live : null));
    const { hook } = setup();
    await act(() => hook.result.current.initRemoteFromDb());
    await waitFor(() => expect(hook.result.current.remote.status).toEqual(live));
    expect(invoke).toHaveBeenCalledWith("start_remote_server", {
      port: 9443, secret: "secret", certPath: "/c.pem", keyPath: "/k.pem",
    });
  });

  it("adopts an already-running server instead of starting another", async () => {
    db.getRemoteSettings.mockResolvedValue(stored({ enabled: true }));
    invoke.mockImplementation(async (cmd: string) => (cmd === "remote_server_status" ? live : undefined));
    const { hook } = setup();
    await act(() => hook.result.current.initRemoteFromDb());
    expect(hook.result.current.remote.status).toEqual(live);
    expect(invoke).not.toHaveBeenCalledWith("start_remote_server", expect.anything());
  });
});

describe("setEnabled", () => {
  it("turns the server on and persists the switch", async () => {
    invoke.mockResolvedValue(live);
    const { hook } = setup();
    await act(() => hook.result.current.initRemoteFromDb());
    act(() => hook.result.current.remote.setEnabled(true));
    await waitFor(() => expect(hook.result.current.remote.status).toEqual(live));
    expect(db.setRemoteEnabled).toHaveBeenCalledWith(true);
  });

  it("switches back off and reports an error when there is no certificate", async () => {
    db.getRemoteSettings.mockResolvedValue(stored({ certPath: "", keyPath: "" }));
    invoke.mockResolvedValue(null);
    const { hook, setError } = setup();
    await act(() => hook.result.current.initRemoteFromDb());
    act(() => hook.result.current.remote.setEnabled(true));
    await waitFor(() => expect(setError).toHaveBeenCalledTimes(1));
    expect(hook.result.current.remote.enabled).toBe(false);
    expect(db.setRemoteEnabled).toHaveBeenLastCalledWith(false);
    expect(invoke).not.toHaveBeenCalledWith("start_remote_server", expect.anything());
  });

  it("stops the server when turned off", async () => {
    invoke.mockResolvedValue(live);
    const { hook } = setup();
    await act(() => hook.result.current.initRemoteFromDb());
    act(() => hook.result.current.remote.setEnabled(true));
    await waitFor(() => expect(hook.result.current.remote.status).toEqual(live));
    act(() => hook.result.current.remote.setEnabled(false));
    await waitFor(() => expect(hook.result.current.remote.status).toBeNull());
    expect(invoke).toHaveBeenCalledWith("stop_remote_server");
  });
});

describe("changePort / changeCertPaths", () => {
  it("ignores an out-of-range port", () => {
    const { hook } = setup();
    act(() => hook.result.current.remote.changePort(70000));
    act(() => hook.result.current.remote.changePort(0));
    act(() => hook.result.current.remote.changePort(1.5));
    expect(db.setRemotePort).not.toHaveBeenCalled();
  });

  it("saves a new port without restarting when the server is not running", async () => {
    const { hook } = setup();
    act(() => hook.result.current.remote.changePort(9000));
    await waitFor(() => expect(db.setRemotePort).toHaveBeenCalledWith(9000));
    expect(hook.result.current.remote.port).toBe(9000);
    expect(invoke).not.toHaveBeenCalledWith("stop_remote_server");
  });

  it("restarts a running server on the new port", async () => {
    invoke.mockResolvedValue(live);
    const { hook } = setup();
    await act(() => hook.result.current.initRemoteFromDb());
    act(() => hook.result.current.remote.setEnabled(true));
    await waitFor(() => expect(hook.result.current.remote.status).toEqual(live));
    invoke.mockClear();
    act(() => hook.result.current.remote.changePort(9000));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_remote_server", expect.objectContaining({ port: 9000 })),
    );
    expect(invoke.mock.calls[0][0]).toBe("stop_remote_server");
  });

  it("trims and saves new certificate paths", async () => {
    const { hook } = setup();
    act(() => hook.result.current.remote.changeCertPaths(" /a.pem ", " /b.pem "));
    await waitFor(() => expect(db.setRemoteCertPaths).toHaveBeenCalledWith(" /a.pem ", " /b.pem "));
    expect(hook.result.current.remote.certPath).toBe("/a.pem");
    expect(hook.result.current.remote.keyPath).toBe("/b.pem");
  });
});

describe("regenerateSecret", () => {
  it("only stores the new secret when the server is stopped", async () => {
    const { hook } = setup();
    await act(() => hook.result.current.remote.regenerateSecret());
    expect(db.regenerateRemoteSecret).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("set_remote_secret", expect.anything());
  });

  it("pushes the new secret to a running server", async () => {
    invoke.mockResolvedValue(live);
    const { hook } = setup();
    await act(() => hook.result.current.initRemoteFromDb());
    act(() => hook.result.current.remote.setEnabled(true));
    await waitFor(() => expect(hook.result.current.remote.status).toEqual(live));
    await act(() => hook.result.current.remote.regenerateSecret());
    expect(invoke).toHaveBeenCalledWith("set_remote_secret", { secret: "new-secret" });
  });

  it("reports a failure", async () => {
    db.regenerateRemoteSecret.mockRejectedValue(new Error("nope"));
    const { hook, setError } = setup();
    await act(() => hook.result.current.remote.regenerateSecret());
    expect(setError).toHaveBeenCalledTimes(1);
  });
});
