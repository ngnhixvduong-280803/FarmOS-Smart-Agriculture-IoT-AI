import React from "react";
import { WaterSummary } from "../types";
import { useI18n } from "../context/I18nContext";

interface WaterUsageCardProps {
  summaries: WaterSummary[];
}

export const WaterUsageCard: React.FC<WaterUsageCardProps> = ({ summaries }) => {
  const { t } = useI18n();

  const totalLiters = summaries.reduce((acc, curr) => acc + (curr.totalLiters || 0), 0);
  const totalSeconds = summaries.reduce((acc, curr) => acc + (curr.totalDurationSec || 0), 0);
  const totalSessions = summaries.reduce((acc, curr) => acc + (curr.totalIrrigationSessions || 0), 0);

  return (
    <div className="rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-5 transition-colors duration-150 flex flex-col justify-between">
      <div>
        {/* Header */}
        <div className="mb-5 pb-3 border-b border-neutral-100 dark:border-neutral-800">
          <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
            {t.water.title}
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t.water.subtitle}
          </p>
        </div>

        {/* Big Numbers */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
            <div className="text-[11px] text-neutral-400 uppercase">
              {t.water.totalVolume}
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-2xl font-extrabold text-neutral-900 dark:text-neutral-100">
                {totalLiters.toFixed(1)}
              </span>
              <span className="text-xs text-neutral-400">L</span>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
            <div className="text-[11px] text-neutral-400 uppercase">
              {t.water.pumpRuntime}
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-2xl font-extrabold text-neutral-900 dark:text-neutral-100">
                {(totalSeconds / 60).toFixed(1)}
              </span>
              <span className="text-xs text-neutral-400">m</span>
            </div>
          </div>
        </div>

        {/* Breakdown */}
        <div className="space-y-3">
          <div className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
            {t.water.zoneBreakdown}:
          </div>
          {["Z01", "Z02", "Z03"].map((zId) => {
            const item = summaries.find((s) => s.zoneId === zId);
            const liters = item?.totalLiters || 0;
            const pct = totalLiters > 0 ? (liters / totalLiters) * 100 : 0;

            return (
              <div key={zId} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-neutral-600 dark:text-neutral-400">Zone {zId}</span>
                  <span className="text-neutral-900 dark:text-neutral-100 font-semibold">
                    {liters.toFixed(1)} L <span className="text-neutral-400 font-normal">({pct.toFixed(0)}%)</span>
                  </span>
                </div>
                <div className="h-1 rounded-full bg-neutral-100 dark:bg-neutral-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-neutral-900 dark:bg-neutral-100 transition-all duration-300"
                    style={{ width: `${Math.max(2, pct)}%` }}
                  ></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-5 pt-3 border-t border-neutral-100 dark:border-neutral-800 text-xs text-neutral-400 flex justify-between">
        <span>{t.water.totalSessions}:</span>
        <span className="font-semibold text-neutral-900 dark:text-neutral-100">{totalSessions}</span>
      </div>
    </div>
  );
};
