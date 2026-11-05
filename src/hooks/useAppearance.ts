import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import i18n, { LanguagePreference, resolveLanguage } from "../i18n";
import { ThemePreference, THEME_QUERY, resolveTheme } from "../theme";
import { usePersistedSetting } from "./usePersistedSetting";

/**
 * The two persisted look-and-feel preferences (language, theme) and the side
 * effects that apply them: <html lang>/i18next, the native Dock + app menu
 * labels, <html data-theme> and the native window theme.
 */
export function useAppearance() {
  const [uiLanguage, setUiLanguage, loadUiLanguage] = usePersistedSetting<LanguagePreference>(
    "ui_language", "system",
    raw => (raw === "en" || raw === "ja" || raw === "system" ? raw : undefined),
    v => v);
  // Applies whenever the preference changes (including the initial load from
  // the DB, once loadUiLanguage() resolves it away from the "system" default)
  // — i18next re-renders every `useTranslation()` consumer, and the Dock
  // menu (native, outside React) is kept in sync via invoke.
  useEffect(() => {
    const resolved = resolveLanguage(uiLanguage);
    document.documentElement.lang = resolved;
    if (i18n.language !== resolved) i18n.changeLanguage(resolved);
    invoke("set_dock_labels", {
      labels: [i18n.t('dock.playPause'), i18n.t('dock.next'), i18n.t('dock.previous')],
    }).catch(() => { /* non-macOS / dev-server: no Dock to update */ });
    const name = "Voynix";
    const t = i18n.t.bind(i18n);
    invoke("set_app_menu", {
      labels: {
        about: t('appMenu.about', { name }), services: t('appMenu.services'),
        hide: t('appMenu.hide', { name }), hideOthers: t('appMenu.hideOthers'),
        quit: t('appMenu.quit', { name }), file: t('appMenu.file'),
        closeWindow: t('appMenu.closeWindow'), edit: t('appMenu.edit'),
        undo: t('appMenu.undo'), redo: t('appMenu.redo'), cut: t('appMenu.cut'),
        copy: t('appMenu.copy'), paste: t('appMenu.paste'),
        selectAll: t('appMenu.selectAll'), view: t('appMenu.view'),
        fullscreen: t('appMenu.fullscreen'), window: t('appMenu.window'),
        minimize: t('appMenu.minimize'), maximize: t('appMenu.maximize'),
        help: t('appMenu.help'), helpManual: t('appMenu.helpManual'),
        helpWelcome: t('appMenu.helpWelcome'), helpReport: t('appMenu.helpReport'),
      },
    }).catch(() => { /* non-macOS / dev-server: no menu bar to update */ });
  }, [uiLanguage]);
  const [uiTheme, setUiTheme, loadUiTheme] = usePersistedSetting<ThemePreference>(
    "ui_theme", "system",
    raw => (raw === "light" || raw === "dark" || raw === "system" ? raw : undefined),
    v => v);
  // Sets <html data-theme> (App.css keys its light variable set off it) and,
  // for "system", follows the OS appearance live. The native window theme is
  // kept in step so the title bar matches; null hands control back to the OS.
  useEffect(() => {
    const mq = window.matchMedia?.(THEME_QUERY);
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(uiTheme, mq?.matches ?? true);
    };
    apply();
    try {
      getCurrentWindow().setTheme(uiTheme === "system" ? null : uiTheme)
        .catch(() => { /* non-Tauri / dev-server: no native window to theme */ });
    } catch { /* getCurrentWindow() throws outside Tauri */ }
    if (uiTheme !== "system" || !mq) return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [uiTheme]);
  return { uiLanguage, setUiLanguage, loadUiLanguage, uiTheme, setUiTheme, loadUiTheme };
}
