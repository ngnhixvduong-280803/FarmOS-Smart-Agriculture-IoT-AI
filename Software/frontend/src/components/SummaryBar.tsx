import React from "react";
import { WaterTankState, WaterSummary, Zone } from "../types";
import { useI18n } from "../context/I18nContext";

interface SummaryBarProps {
  zones: Zone[];
  tankState: WaterTankState;
  waterSummaries: WaterSummary[];
}

export const SummaryBar: React.FC<SummaryBarProps> = ({
  zones,
  tankState,
  waterSummaries,
}) => {
  const { t } = useI18n();

  const onlineNodesCount = zones.reduce((count, z) => {
    const isOnline = z.nodes?.some((n) => n.online);
    return isOnline ? count + 1 : count;
  }, 0);

  const totalLiters = waterSummaries.reduce((sum, item) => sum + (item.totalLiters || 0), 0);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {/* Metric 1 */}
      <div className="p-3.5 rounded-lg bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
        <div className="text-[11px] uppercase tracking-wider text-neutral-400">
          {t.summary.onlineNodes}
        </div>
        <div className="mt-1 text-lg font-bold text-neutral-900 dark:text-neutral-100">
          {onlineNodesCount}/{zones.length || 3}
        </div>
      </div>

      {/* Metric 2 */}
      <div className="p-3.5 rounded-lg bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
        <div className="text-[11px] uppercase tracking-wider text-neutral-400">
          {t.summary.tankLevel}
        </div>
        <div className="mt-1 text-lg font-bold text-neutral-900 dark:text-neutral-100">
          {tankState.level_pct.toFixed(0)}%
        </div>
      </div>

      {/* Metric 3 */}
      <div className="p-3.5 rounded-lg bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
        <div className="text-[11px] uppercase tracking-wider text-neutral-400">
          {t.summary.todayWater}
        </div>
        <div className="mt-1 text-lg font-bold text-neutral-900 dark:text-neutral-100">
          {totalLiters.toFixed(1)} L
        </div>
      </div>

      {/* Metric 4 */}
      <div className="p-3.5 rounded-lg bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
        <div className="text-[11px] uppercase tracking-wider text-neutral-400">
          {t.summary.activeStatus}
        </div>
        <div className="mt-1 text-lg font-bold text-emerald-600 dark:text-emerald-400">
          {t.summary.normal}
        </div>
      </div>
    </div>
  );
};
