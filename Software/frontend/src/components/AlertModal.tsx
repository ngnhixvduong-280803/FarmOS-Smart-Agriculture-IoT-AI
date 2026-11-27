import React from "react";
import { AlertItem } from "../types";
import { useI18n } from "../context/I18nContext";
import { X, CheckCircle2 } from "lucide-react";

interface AlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  alerts: AlertItem[];
  onResolve: (alertId: string) => Promise<void>;
}

export const AlertModal: React.FC<AlertModalProps> = ({
  isOpen,
  onClose,
  alerts,
  onResolve,
}) => {
  const { t, language } = useI18n();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-fade-in">
      <div className="w-full max-w-md rounded-3xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-2xl overflow-hidden flex flex-col max-h-[80vh] animate-fade-in-scale">
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
          <div>
            <h3 className="font-bold text-sm text-neutral-900 dark:text-neutral-100">
              {t.modals.alertsTitle}
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t.modals.alertsSubtitle}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-3 flex-1 text-xs">
          {alerts.length === 0 ? (
            <div className="py-12 text-center text-neutral-500 dark:text-neutral-400 flex flex-col items-center gap-2">
              <CheckCircle2 className="w-6 h-6 text-emerald-500" />
              <span className="font-medium">{t.modals.noAlerts}</span>
            </div>
          ) : (
            alerts.map((a) => {
              const date = new Date(a.created_at);
              const timeStr = date.toLocaleString(language === "vi" ? "vi-VN" : "en-US", {
                hour: "2-digit",
                minute: "2-digit",
                day: "2-digit",
                month: "2-digit",
              });

              return (
                <div
                  key={a.id}
                  className="p-3.5 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-850/60 flex items-start justify-between gap-3 shadow-2xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={`font-bold px-1.5 py-0.5 rounded-md ${
                          a.level === "CRITICAL"
                            ? "bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400"
                            : "bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400"
                        }`}
                      >
                        [{a.level}]
                      </span>
                      <span className="text-neutral-400">{timeStr}</span>
                    </div>
                    <p className="text-neutral-800 dark:text-neutral-200 font-medium">{a.message}</p>
                  </div>

                  {!a.resolved && (
                    <button
                      onClick={() => onResolve(a.id)}
                      className="px-3 py-1.5 rounded-xl bg-white dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-200 font-semibold border border-neutral-200 dark:border-neutral-700 shrink-0 transition-all active:scale-95 shadow-2xs"
                    >
                      {t.modals.resolveBtn}
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-neutral-100 dark:border-neutral-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs font-semibold bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-200 transition-colors"
          >
            {t.modals.close}
          </button>
        </div>
      </div>
    </div>
  );
};
