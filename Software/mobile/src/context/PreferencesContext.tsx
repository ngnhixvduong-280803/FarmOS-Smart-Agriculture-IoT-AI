import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Appearance, useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import i18n, { type AppLanguage } from "../i18n";

export type ThemeMode = "light" | "dark" | "system";
export type AppColors = typeof lightColors;

const lightColors = {
  background: "#FFFFFF", surface: "#FFFFFF", surfaceMuted: "#F5F5F5", text: "#18181B", textMuted: "#71717A",
  border: "#E4E4E7", primary: "#16704A", primaryPressed: "#0E5737", primarySoft: "#F0FDF4", primaryBorder: "#BBE5C8",
  danger: "#DC2626", dangerSoft: "#FEF2F2", warning: "#B45309", overlay: "rgba(24, 24, 27, 0.44)",
};

const darkColors: AppColors = {
  background: "#0B0B0C", surface: "#141416", surfaceMuted: "#202023", text: "#F4F4F5", textMuted: "#A1A1AA",
  border: "#323237", primary: "#63C985", primaryPressed: "#82DDA0", primarySoft: "#153522", primaryBorder: "#2D6A43",
  danger: "#FCA5A5", dangerSoft: "#3A2023", warning: "#FCD34D", overlay: "rgba(0, 0, 0, 0.70)",
};

type PreferencesValue = {
  language: AppLanguage;
  themeMode: ThemeMode;
  isDark: boolean;
  colors: AppColors;
  setLanguage: (language: AppLanguage) => Promise<void>;
  setThemeMode: (theme: ThemeMode) => Promise<void>;
};

const PreferencesContext = createContext<PreferencesValue | null>(null);
const LANGUAGE_KEY = "farmos.settings.language";
const THEME_KEY = "farmos.settings.theme";

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const systemTheme = useColorScheme();
  const [language, setLanguageState] = useState<AppLanguage>("vi");
  const [themeMode, setThemeModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(LANGUAGE_KEY), AsyncStorage.getItem(THEME_KEY)]).then(([savedLanguage, savedTheme]) => {
      if (savedLanguage === "vi" || savedLanguage === "en") {
        setLanguageState(savedLanguage);
        i18n.changeLanguage(savedLanguage).catch(() => undefined);
      }
      if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") setThemeModeState(savedTheme);
    }).catch(() => undefined);
  }, []);

  const setLanguage = useCallback(async (nextLanguage: AppLanguage) => {
    await i18n.changeLanguage(nextLanguage);
    setLanguageState(nextLanguage);
    await AsyncStorage.setItem(LANGUAGE_KEY, nextLanguage);
  }, []);
  const setThemeMode = useCallback(async (nextTheme: ThemeMode) => {
    setThemeModeState(nextTheme);
    await AsyncStorage.setItem(THEME_KEY, nextTheme);
  }, []);
  const isDark = themeMode === "dark" || (themeMode === "system" && (systemTheme ?? Appearance.getColorScheme()) === "dark");
  const value = useMemo<PreferencesValue>(() => ({ language, themeMode, isDark, colors: isDark ? darkColors : lightColors, setLanguage, setThemeMode }), [isDark, language, setLanguage, setThemeMode, themeMode]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}
