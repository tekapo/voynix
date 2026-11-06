import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
const relaunch = vi.hoisted(() => vi.fn());
const check = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));

import { useUpdater } from "./useUpdater";

function fakeUpdate(downloadAndInstall = vi.fn().mockResolvedValue(undefined)) {
  return { version: "9.9.9", body: "notes", downloadAndInstall };
}

async function readyToInstall(update: ReturnType<typeof fakeUpdate>) {
  check.mockResolvedValue(update);
  const hook = renderHook(() => useUpdater(false));
  await act(async () => { hook.result.current.checkNow(); });
  await waitFor(() => expect(hook.result.current.status.kind).toBe("available"));
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useUpdater install", () => {
  it("relaunches through relaunch_app so the new window comes to the front", async () => {
    invoke.mockResolvedValue(true);
    const update = fakeUpdate();
    const hook = await readyToInstall(update);
    await act(async () => { hook.result.current.install(); });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("relaunch_app"));
    expect(update.downloadAndInstall).toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("falls back to the plugin's relaunch outside an app bundle", async () => {
    invoke.mockResolvedValue(false);
    const hook = await readyToInstall(fakeUpdate());
    await act(async () => { hook.result.current.install(); });
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1));
  });

  it("does not relaunch when the download fails", async () => {
    const hook = await readyToInstall(fakeUpdate(vi.fn().mockRejectedValue(new Error("offline"))));
    await act(async () => { hook.result.current.install(); });
    await waitFor(() => expect(hook.result.current.status.kind).toBe("error"));
    expect(invoke).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe("useUpdater periodic check", () => {
  const HOUR = 60 * 60 * 1000;

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("DEV", false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("checks after launch and every 6 hours without opening the dialog", async () => {
    check.mockResolvedValue(null);
    renderHook(() => useUpdater(true));
    await advance(5000);
    expect(check).toHaveBeenCalledTimes(1);
    await advance(6 * HOUR);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("raises the notice but not the dialog on a background hit", async () => {
    check.mockResolvedValue(fakeUpdate());
    const { result } = renderHook(() => useUpdater(true));
    await advance(5000);
    expect(result.current.status.kind).toBe("available");
    expect(result.current.dialogOpen).toBe(false);
    act(() => result.current.openDialog());
    expect(result.current.dialogOpen).toBe(true);
  });

  it("does not check when auto-check is off", async () => {
    renderHook(() => useUpdater(false));
    await advance(12 * HOUR);
    expect(check).not.toHaveBeenCalled();
  });

  it("does not re-check while an update is already waiting", async () => {
    check.mockResolvedValue(fakeUpdate());
    renderHook(() => useUpdater(true));
    await advance(5000);
    await advance(6 * HOUR);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("brings the notice back only for a newer version", async () => {
    check.mockResolvedValue(fakeUpdate());
    const { result } = renderHook(() => useUpdater(true));
    await advance(5000);
    act(() => result.current.dismissNotice());
    expect(result.current.noticeDismissed).toBe(true);
    await act(async () => { result.current.checkNow(); });
    expect(result.current.noticeDismissed).toBe(true);
    check.mockResolvedValue({ ...fakeUpdate(), version: "10.0.0" });
    await act(async () => { result.current.checkNow(); });
    expect(result.current.noticeDismissed).toBe(false);
  });
});
