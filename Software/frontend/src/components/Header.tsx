import React from "react";
import { Sun, Moon, Bell } from "lucide-react";
import { WaterTankState } from "../types";
import { useI18n } from "../context/I18nContext";
import { useTheme } from "../context/ThemeContext";

export type TabType = "overview" | "analytics" | "logs";

interface HeaderProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
  isConnected: boolean;
  tankState: WaterTankState;
  activeAlertsCount: number;
  onOpenAlerts: () => void;
  onEmergencyStop: () => void;
  isStopping: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onTabChange,
  isConnected,
  tankState,
  activeAlertsCount,
  onOpenAlerts,
  onEmergencyStop,
  isStopping,
}) => {
  const { t, language, setLanguage } = useI18n();
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 sticky top-0 z-40 transition-colors duration-150">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-14">
          {/* Brand & Tabs */}
          <div className="flex items-center gap-8">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
              <span className="font-semibold text-sm tracking-tight text-neutral-900 dark:text-neutral-100">
                FarmOS
              </span>
            </div>

            {/* Desktop Tabs */}
            <nav className="hidden md:flex items-center gap-1">
              <button
                onClick={() => onTabChange("overview")}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  activeTab === "overview"
                    ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-semibold"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                }`}
              >
                {t.tabs.overview}
              </button>

              <button
                onClick={() => onTabChange("analytics")}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  activeTab === "analytics"
                    ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-semibold"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                }`}
              >
                {t.tabs.analytics}
              </button>

              <button
                onClick={() => onTabChange("logs")}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  activeTab === "logs"
                    ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-semibold"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
                }`}
              >
                {t.tabs.logs}
              </button>
            </nav>
          </div>

          {/* Right Status & Controls */}
          <div className="flex items-center gap-3 text-xs">
            {/* Live Indicator */}
            <div className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
              <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-emerald-500" : "bg-neutral-400"}`}></span>
              <span className="text-[11px]">{isConnected ? t.header.realtimeConnected : t.header.disconnected}</span>
            </div>

            <span className="text-neutral-300 dark:text-neutral-700">|</span>

            {/* Tank Status */}
            <div className="flex items-center gap-1 text-neutral-600 dark:text-neutral-300 text-[11px]">
              <span className="text-neutral-400">{t.header.waterTank}:</span>
              <span className="font-semibold">{tankState.level_pct.toFixed(0)}%</span>
            </div>

            <span className="text-neutral-300 dark:text-neutral-700">|</span>

            {/* Alert Bell */}
            <button
              onClick={onOpenAlerts}
              className="relative p-1 text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 transition-colors"
              title={t.header.alertsTooltip}
            >
              <Bell className="w-4 h-4" />
              {activeAlertsCount > 0 && (
                <span className="absolute 0 top-0 right-0 w-1.5 h-1.5 rounded-full bg-rose-500"></span>
              )}
            </button>

            {/* Language Switcher */}
            <button
              onClick={() => setLanguage(language === "vi" ? "en" : "vi")}
              className="px-2 py-0.5 rounded border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-[11px] font-semibold transition-colors"
            >
              {language === "vi" ? "EN" : "VI"}
            </button>

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="p-1 rounded text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              title={t.header.switchTheme}
            >
              {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>

            {/* Emergency Stop */}
            <button
              onClick={onEmergencyStop}
              disabled={isStopping}
              className="px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-700 text-white font-medium text-xs transition-colors disabled:opacity-50"
            >
              {isStopping ? t.header.stopping : t.header.emergencyStop}
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        <div className="flex md:hidden border-t border-neutral-100 dark:border-neutral-800 py-1.5 gap-1">
          <button
            onClick={() => onTabChange("overview")}
            className={`flex-1 py-1 text-center rounded text-xs ${
              activeTab === "overview" ? "bg-neutral-100 dark:bg-neutral-800 font-semibold" : "text-neutral-500"
            }`}
          >
            {t.tabs.overview}
          </button>
          <button
            onClick={() => onTabChange("analytics")}
            className={`flex-1 py-1 text-center rounded text-xs ${
              activeTab === "analytics" ? "bg-neutral-100 dark:bg-neutral-800 font-semibold" : "text-neutral-500"
            }`}
          >
            {t.tabs.analytics}
          </button>
          <button
            onClick={() => onTabChange("logs")}
            className={`flex-1 py-1 text-center rounded text-xs ${
              activeTab === "logs" ? "bg-neutral-100 dark:bg-neutral-800 font-semibold" : "text-neutral-500"
            }`}
          >
            {t.tabs.logs}
          </button>
        </div>
      </div>
    </header>
  );
};
