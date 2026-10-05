import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

/** The stored `ui_language` setting value — see usePersistedSetting's use in App.tsx. */
export type LanguagePreference = "system" | "en" | "ja";

export const SUPPORTED_LANGUAGES: readonly ("en" | "ja")[] = ["en", "ja"];

/**
 * Resolves a language preference to an actual i18next language code.
 * "system" reads the browser/OS language list and picks the first supported
 * match (any `ja*` tag maps to "ja"), falling back to "en" otherwise.
 */
export function resolveLanguage(pref: LanguagePreference, systemLanguages: readonly string[] = navigator.languages ?? [navigator.language]): "en" | "ja" {
    if (pref === "en" || pref === "ja") return pref;
    for (const lang of systemLanguages) {
        if (lang?.toLowerCase().startsWith("ja")) return "ja";
    }
    return "en";
}

i18n
    .use(initReactI18next)
    .init({
        resources: { en: { translation: en }, ja: { translation: ja } },
        lng: resolveLanguage("system"),
        fallbackLng: "en",
        supportedLngs: ["en", "ja"],
        interpolation: { escapeValue: false },
        returnNull: false,
    });

export default i18n;
