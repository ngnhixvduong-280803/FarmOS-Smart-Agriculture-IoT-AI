import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { vi } from "./locales/vi";
import { en } from "./locales/en";

export type AppLanguage = "vi" | "en";

export const defaultNS = "translation";
export const resources = {
  vi: { translation: vi },
  en: { translation: en },
} as const;

i18n.use(initReactI18next).init({
  compatibilityJSON: "v4",
  fallbackLng: "vi",
  interpolation: { escapeValue: false },
  resources,
});

export default i18n;
