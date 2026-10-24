/** The stored `ui_theme` setting value — see usePersistedSetting's use in App.tsx. */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_QUERY = "(prefers-color-scheme: dark)";

/** Resolves a theme preference to the concrete theme; "system" follows the OS. */
export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): "light" | "dark" {
    if (pref === "light" || pref === "dark") return pref;
    return systemPrefersDark ? "dark" : "light";
}
