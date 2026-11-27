import React, { createContext, useContext, useState, useEffect } from "react";
import { vi } from "../locales/vi";
import { en } from "../locales/en";

type Language = "vi" | "en";
type Translations = typeof vi;

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem("farmos_lang") as Language;
    return saved === "en" || saved === "vi" ? saved : "vi";
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("farmos_lang", lang);
  };

  const t = language === "en" ? en : vi;

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useI18n = () => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return context;
};
