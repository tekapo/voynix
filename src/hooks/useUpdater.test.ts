import { beforeEach, describe, expect, it, vi } from "vitest";
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
