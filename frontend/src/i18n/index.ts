import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "@/i18n/locales/en-US";
import zhCN from "@/i18n/locales/zh-CN";
import { RUNTIME_SETTINGS } from "@/constant/runtime-config";

export type AppLocale = "zh-CN" | "en-US";

const LOCALE_SETTING_KEY = "locale";

/**
 * The workspace's language, read from the first-paint script (`GET /config.js`).
 *
 * It comes from `window.__RUNTIME_CONFIG__.SETTINGS` rather than a store, because i18next is
 * initialised at import time — before any React tree exists. The gateway puts the document in the
 * script the page loads first (#155), so this is a synchronous read with nothing to wait for.
 *
 * A workspace that has never chosen a language opens in English, and English is also the fallback: a key
 * the Chinese dictionary is missing renders its English sentence rather than a raw key (decisions #170).
 */
function bootLocale(): AppLocale | null {
    const value = RUNTIME_SETTINGS[LOCALE_SETTING_KEY];
    return value === "zh-CN" || value === "en-US" ? value : null;
}

i18n.use(initReactI18next).init({
    resources: {
        "zh-CN": { translation: zhCN },
        "en-US": { translation: enUS },
    },
    lng: bootLocale() || "en-US",
    fallbackLng: "en-US",
    supportedLngs: ["zh-CN", "en-US"],
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

/**
 * Switch language.
 *
 * Storing it is not this module's job: `use-settings-store` listens for `languageChanged` and writes
 * the preference. Importing the store here would close a cycle — the store reaches the HTTP layer,
 * which reports its errors through this very dictionary.
 */
export function changeAppLocale(locale: AppLocale) {
    return i18n.changeLanguage(locale);
}

export default i18n;
