import "i18next";
import en from "./locales/en.json";

// Types the `t()` keys against the English dictionary, so a typo in a
// translation key is a build-time (tsc) error rather than a silent
// missing-string fallback at runtime.
declare module "i18next" {
    interface CustomTypeOptions {
        defaultNS: "translation";
        resources: { translation: typeof en };
    }
}
