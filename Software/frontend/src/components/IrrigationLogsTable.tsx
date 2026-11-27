import React from "react";
import { IrrigationLog } from "../types";
import { useI18n } from "../context/I18nContext";
import { RefreshCw } from "lucide-react";

interface IrrigationLogsTableProps {
  logs: IrrigationLog[];
  loading: boolean;
  onRefresh: () => void;
}

export const IrrigationLogsTable: React.FC<IrrigationLogsTableProps> = ({
  logs,
  loading,
  onRefresh,
}) => {
  const { t, language } = useI18n();

  const getStatusBadge = (status: string, reason?: string | null) => {
    switch (status) {
      case "COMPLETED":
        return <span className="text-emerald-600 dark:text-emerald-400 font-semibold">{t.logs.completed}</span>;
      case "EXECUTING":
        return <span className="text-cyan-600 dark:text-cyan-400 font-semibold animate-pulse">{t.logs.executing}</span>;
      case "REJECTED":
        return <span className="text-rose-600 dark:text-rose-400 font-semibold" title={reason || ""}>{t.logs.rejected}</span>;
      case "TIMEOUT":
        return <span className="text-amber-600 dark:text-amber-400 font-semibold">{t.logs.timeout}</span>;
      default:
        return <span className="text-neutral-500">{status}</span>;
    }
  };

  return (
    <div className="rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-5 transition-colors duration-150">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-4 pb-3 border-b border-neutral-100 dark:border-neutral-800">
        <div>
          <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
            {t.logs.title}
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t.logs.subtitle}
          </p>
        </div>

        <button
          onClick={onRefresh}
          className="p-1.5 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          title={t.logs.refresh}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-neutral-400 font-medium border-b border-neutral-100 dark:border-neutral-800">
            <tr>
              <th className="py-2.5 font-normal">{t.logs.commandId}</th>
              <th className="py-2.5 font-normal">{t.logs.zone}</th>
              <th className="py-2.5 font-normal">{t.logs.source}</th>
              <th className="py-2.5 font-normal">{t.logs.duration}</th>
              <th className="py-2.5 font-normal">{t.logs.flowMeasured}</th>
              <th className="py-2.5 font-normal">{t.logs.status}</th>
              <th className="py-2.5 font-normal text-right">{t.logs.timestamp}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-neutral-400">
                  {t.logs.empty}
                </td>
              </tr>
            ) : (
              logs.map((log) => {
                const date = new Date(log.created_at);
                const timeStr = date.toLocaleString(language === "vi" ? "vi-VN" : "en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                  day: "2-digit",
                  month: "2-digit",
                });

                return (
                  <tr key={log.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors">
                    <td className="py-2.5 text-neutral-900 dark:text-neutral-100 font-medium">{log.command_id}</td>
                    <td className="py-2.5 text-neutral-600 dark:text-neutral-400">{log.zone_id}</td>
                    <td className="py-2.5 text-neutral-500">{log.trigger_source}</td>
                    <td className="py-2.5 text-neutral-700 dark:text-neutral-300">{log.duration_sec}s</td>
                    <td className="py-2.5 font-semibold text-neutral-900 dark:text-neutral-100">
                      {log.measured_flow_liters !== null && log.measured_flow_liters !== undefined
                        ? `${log.measured_flow_liters.toFixed(2)} L`
                        : "--"}
                    </td>
                    <td className="py-2.5">{getStatusBadge(log.status, log.rejection_reason)}</td>
                    <td className="py-2.5 text-right text-neutral-400 text-[11px]">{timeStr}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
