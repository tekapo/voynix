import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
const setWindowTheme = vi.hoisted(() => vi.fn());
const db = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme: setWindowTheme }) }));
vi.mock("../db", () => db);

import i18n from "../i18n";
import { useAppearance } from "./useAppearance";

const lastCall = (cmd: string) => {
  const calls = invoke.mock.calls.filter(c => c[0] === cmd);
  return calls[calls.length - 1][1];
};

let dark = true;
let mqListeners: Array<() => void> = [];

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockResolvedValue(undefined);
  setWindowTheme.mockResolvedValue(undefined);
  db.getSetting.mockResolvedValue(null);
  db.setSetting.mockResolvedValue(undefined);
  dark = true;
  mqListeners = [];
  document.documentElement.removeAttribute("data-theme");
  window.matchMedia = ((query: string) => ({
    media: query,
    get matches() { return dark; },
    addEventListener: (_: string, cb: () => void) => { mqListeners.push(cb); },
    removeEventListener: (_: string, cb: () => void) => { mqListeners = mqListeners.filter(l => l !== cb); },
  })) as never;
});

describe("language", () => {
  it("defaults to 'system' and persists a change", () => {
    const { result } = renderHook(() => useAppearance());
    expect(result.current.uiLanguage).toBe("system");
    act(() => result.current.setUiLanguage("ja"));
    expect(result.current.uiLanguage).toBe("ja");
    expect(db.setSetting).toHaveBeenCalledWith("ui_language", "ja");
  });

  it("switches i18next, <html lang> and the native Dock and menu labels", () => {
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.setUiLanguage("ja"));

    expect(i18n.language).toBe("ja");
    expect(document.documentElement.lang).toBe("ja");

    const dock = lastCall("set_dock_labels");
    expect(dock.labels).toEqual([
      i18n.t("dock.playPause"), i18n.t("dock.next"), i18n.t("dock.previous"),
      i18n.t("dock.like"), i18n.t("dock.dislike"),
    ]);
    const menu = lastCall("set_app_menu");
    expect(menu.labels.quit).toBe(i18n.t("appMenu.quit", { name: "Voynix" }));
    expect(menu.labels.file).toBe(i18n.t("appMenu.file"));
  });

  it("does not crash when the native menu commands are unavailable (dev server)", async () => {
    invoke.mockRejectedValue(new Error("no tauri"));
    const { result } = renderHook(() => useAppearance());
    await expect(act(async () => result.current.setUiLanguage("en"))).resolves.not.toThrow();
  });

  it("ignores an unknown stored value on load", async () => {
    db.getSetting.mockResolvedValue("fr");
    const { result } = renderHook(() => useAppearance());
    await act(() => result.current.loadUiLanguage());
    expect(result.current.uiLanguage).toBe("system");
  });

  it("applies a valid stored value on load", async () => {
    db.getSetting.mockResolvedValue("ja");
    const { result } = renderHook(() => useAppearance());
    await act(() => result.current.loadUiLanguage());
    expect(result.current.uiLanguage).toBe("ja");
    expect(i18n.language).toBe("ja");
  });
});

describe("theme", () => {
  it("'system' follows the OS and hands the native window theme back (null)", () => {
    renderHook(() => useAppearance());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(setWindowTheme).toHaveBeenLastCalledWith(null);
  });

  it("an explicit choice sets <html data-theme> and the native window theme", () => {
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.setUiTheme("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(setWindowTheme).toHaveBeenLastCalledWith("light");
    expect(db.setSetting).toHaveBeenCalledWith("ui_theme", "light");
  });

  it("'system' follows a live OS appearance change", () => {
    renderHook(() => useAppearance());
    expect(document.documentElement.dataset.theme).toBe("dark");
    dark = false;
    act(() => mqListeners.forEach(l => l()));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("stops listening to the OS once a fixed theme is chosen", () => {
    const { result } = renderHook(() => useAppearance());
    expect(mqListeners.length).toBe(1);
    act(() => result.current.setUiTheme("dark"));
    expect(mqListeners.length).toBe(0);
    dark = false;
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("removes its OS listener on unmount", () => {
    const { unmount } = renderHook(() => useAppearance());
    expect(mqListeners.length).toBe(1);
    unmount();
    expect(mqListeners.length).toBe(0);
  });

  it("survives the native window call rejecting", () => {
    setWindowTheme.mockRejectedValue(new Error("no window"));
    expect(() => renderHook(() => useAppearance())).not.toThrow();
  });
});
