import React from "react";
import { Zone, TelemetryPoint } from "../types";
import { useI18n } from "../context/I18nContext";
import { Sliders, Loader2 } from "lucide-react";

interface ZoneCardProps {
  zone: Zone;
  telemetry?: TelemetryPoint | null;
  isIrrigating: boolean;
  onIrrigateClick: (zone: Zone) => void;
  onConfigClick: (zone: Zone) => void;
}

export const ZoneCard: React.FC<ZoneCardProps> = ({
  zone,
  telemetry,
  isIrrigating,
  onIrrigateClick,
  onConfigClick,
}) => {
  const { t } = useI18n();

  const moisture = telemetry?.soil_moisture ?? 0;
  const targetMin = zone.target_moisture_min;
  const targetMax = zone.target_moisture_max;

  let statusText = t.zones.optimal;
  let statusColor = "text-emerald-600 dark:text-emerald-400";
  let barColor = "bg-emerald-500";

  if (moisture < targetMin) {
    statusText = t.zones.lowMoisture;
    statusColor = "text-amber-600 dark:text-amber-400";
    barColor = "bg-amber-500";
  } else if (moisture > targetMax) {
    statusText = t.zones.highMoisture;
    statusColor = "text-sky-600 dark:text-sky-400";
    barColor = "bg-sky-500";
  }

  const node = zone.nodes?.[0];

  return (
    <div
      className={`rounded-xl bg-white dark:bg-neutral-900 border p-5 transition-colors duration-150 flex flex-col justify-between ${
        isIrrigating
          ? "border-emerald-500 ring-1 ring-emerald-500"
          : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700"
      }`}
    >
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-2 pb-3 border-b border-neutral-100 dark:border-neutral-800">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-neutral-400">
                {zone.id}
              </span>
              <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
                {zone.name}
              </h3>
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              {zone.crop_type || t.zones.notConfigured} • Van {zone.valve_id || "V01"}
            </p>
          </div>

          <button
            onClick={() => onConfigClick(zone)}
            className="p-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title={t.zones.configTooltip}
          >
            <Sliders className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Moisture Primary Metric */}
        <div className="py-4">
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-extrabold text-neutral-900 dark:text-neutral-100 tracking-tight">
                {moisture.toFixed(1)}
              </span>
              <span className="text-xs text-neutral-400">%</span>
            </div>

            <div className="text-right">
              <span className={`text-xs font-semibold ${statusColor}`}>
                {statusText}
              </span>
            </div>
          </div>

          {/* Slim Bar */}
          <div className="mt-2">
            <div className="h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                style={{ width: `${Math.min(100, Math.max(3, moisture))}%` }}
              ></div>
            </div>
            <div className="text-[11px] text-neutral-400 mt-1">
              <span>Target: {targetMin}%–{targetMax}%</span>
            </div>
          </div>
        </div>

        {/* Clean Data Strip (No nested boxes) */}
        <div className="pt-3 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between text-xs text-neutral-600 dark:text-neutral-400">
          <div>
            <span className="text-neutral-400 text-[10px] uppercase block">Soil Temp</span>
            <span className="font-semibold text-neutral-800 dark:text-neutral-200">{telemetry?.soil_temp ? `${telemetry.soil_temp.toFixed(1)}°C` : "--"}</span>
          </div>

          <div>
            <span className="text-neutral-400 text-[10px] uppercase block">Air</span>
            <span className="font-semibold text-neutral-800 dark:text-neutral-200">{telemetry?.air_temp ? `${telemetry.air_temp.toFixed(0)}°C` : "--"}/{telemetry?.air_humidity ? `${telemetry.air_humidity.toFixed(0)}%` : "--"}</span>
          </div>

          <div>
            <span className="text-neutral-400 text-[10px] uppercase block">Light</span>
            <span className="font-semibold text-neutral-800 dark:text-neutral-200">{telemetry?.lux ? `${(telemetry.lux / 1000).toFixed(1)}k` : "--"} lx</span>
          </div>
        </div>
      </div>

      {/* Button */}
      <div className="mt-5">
        {isIrrigating ? (
          <div className="w-full py-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 text-xs font-semibold flex items-center justify-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>{t.zones.irrigatingState}</span>
          </div>
        ) : (
          <button
            onClick={() => onIrrigateClick(zone)}
            className="w-full py-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 dark:bg-neutral-100 dark:hover:bg-white text-white dark:text-neutral-900 text-xs font-semibold transition-colors"
          >
            {t.zones.irrigateBtn}
          </button>
        )}
      </div>
    </div>
  );
};
