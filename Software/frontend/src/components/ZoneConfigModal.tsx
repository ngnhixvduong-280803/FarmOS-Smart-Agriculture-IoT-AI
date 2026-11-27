import React, { useState, useEffect } from "react";
import { Zone } from "../types";
import { useI18n } from "../context/I18nContext";
import { X, Loader2 } from "lucide-react";

interface ZoneConfigModalProps {
  zone: Zone | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (
    zoneId: string,
    data: { target_moisture_min: number; target_moisture_max: number; crop_type?: string }
  ) => Promise<void>;
}

export const ZoneConfigModal: React.FC<ZoneConfigModalProps> = ({
  zone,
  isOpen,
  onClose,
  onSave,
}) => {
  const { t } = useI18n();
  const [minMoisture, setMinMoisture] = useState<number>(40);
  const [maxMoisture, setMaxMoisture] = useState<number>(70);
  const [cropType, setCropType] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (zone) {
      setMinMoisture(zone.target_moisture_min || 40);
      setMaxMoisture(zone.target_moisture_max || 70);
      setCropType(zone.crop_type || "");
    }
  }, [zone, isOpen]);

  if (!isOpen || !zone) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      await onSave(zone.id, {
        target_moisture_min: minMoisture,
        target_moisture_max: maxMoisture,
        crop_type: cropType,
      });
      onClose();
    } catch (err) {
      console.error("Error saving zone config:", err);
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
            {t.modals.configTitle} — {zone.name}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-3.5 text-xs">
          <div>
            <label className="block font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
              {t.modals.cropTypeLabel}:
            </label>
            <input
              type="text"
              value={cropType}
              onChange={(e) => setCropType(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-900 dark:text-white placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              placeholder={t.modals.cropTypePlaceholder}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                {t.modals.minMoistureLabel}
              </label>
              <input
                type="number"
                min="10"
                max="90"
                value={minMoisture}
                onChange={(e) => setMinMoisture(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-xl bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>

            <div>
              <label className="block font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
                {t.modals.maxMoistureLabel}
              </label>
              <input
                type="number"
                min="20"
                max="95"
                value={maxMoisture}
                onChange={(e) => setMaxMoisture(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-xl bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>

          {/* Footer */}
          <div className="pt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              {t.modals.cancel}
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-50 flex items-center gap-1.5 transition-all shadow-md shadow-emerald-600/20 active:scale-95"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>{loading ? t.modals.saving : t.modals.saveConfig}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
