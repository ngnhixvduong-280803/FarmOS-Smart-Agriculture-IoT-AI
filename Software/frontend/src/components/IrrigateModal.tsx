import React, { useState } from "react";
import { Zone } from "../types";
import { useI18n } from "../context/I18nContext";
import { X, Loader2 } from "lucide-react";

interface IrrigateModalProps {
  zone: Zone | null;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (zoneId: string, durationSec: number, reason?: string) => Promise<void>;
}

export const IrrigateModal: React.FC<IrrigateModalProps> = ({
  zone,
  isOpen,
  onClose,
  onConfirm,
}) => {
  const { t } = useI18n();
  const [duration, setDuration] = useState<number>(10);
  const [reason, setReason] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !zone) return null;

  const presets = [10, 30, 60, 120, 300];

  const handleSubmitting = async () => {
    try {
      setLoading(true);
      setError(null);
      await onConfirm(
        zone.id,
        duration,
        reason.trim() || `${t.zones.irrigateBtn} - ${zone.name}`
      );
      onClose();
    } catch (e: any) {
      setError(e.message || "Error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-fade-in">
      <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-2xl overflow-hidden animate-fade-in-scale">
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
          <h3 className="font-bold text-sm text-neutral-900 dark:text-neutral-100">
            {t.modals.irrigateTitle} — {zone.name}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 text-xs">
              {error}
            </div>
          )}

          {/* Presets */}
          <div>
            <div className="flex justify-between font-medium text-neutral-600 dark:text-neutral-400 mb-2">
              <span>{t.modals.selectDuration}:</span>
              <span className="font-bold text-neutral-900 dark:text-neutral-100">{duration}s</span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDuration(p)}
                  className={`py-1.5 rounded-xl text-xs transition-all border active:scale-95 ${
                    duration === p
                      ? "bg-emerald-600 text-white border-transparent font-bold shadow-xs"
                      : "bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-200 dark:border-neutral-700 hover:border-emerald-500/40"
                  }`}
                >
                  {p}s
                </button>
              ))}
            </div>
          </div>

          {/* Slider */}
          <div>
            <input
              type="range"
              min="5"
              max="600"
              step="5"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full accent-emerald-600 cursor-pointer h-1.5 bg-neutral-200 dark:bg-neutral-700 rounded-full"
            />
          </div>

          {/* Reason */}
          <div>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-900 dark:text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              placeholder={t.modals.reasonPlaceholder}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            {t.modals.cancel}
          </button>
          <button
            type="button"
            onClick={handleSubmitting}
            disabled={loading}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-50 flex items-center gap-1.5 transition-all shadow-md shadow-emerald-600/20 active:scale-95"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>{loading ? t.modals.processing : `${t.modals.confirmIrrigate} (${duration}s)`}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
