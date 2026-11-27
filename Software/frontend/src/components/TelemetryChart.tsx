import React, { useState, useEffect, useCallback } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { fetchTelemetryHistory } from "../services/api.service";
import { TelemetryPoint } from "../types";
import { useI18n } from "../context/I18nContext";
import { useTheme } from "../context/ThemeContext";
import { RefreshCw } from "lucide-react";
import { useSocket } from "../hooks/useSocket";

interface TelemetryChartProps {
  activeZoneId: string;
  onZoneChange: (zoneId: string) => void;
}

export const TelemetryChart: React.FC<TelemetryChartProps> = ({
  activeZoneId,
  onZoneChange,
}) => {
  const { t, language } = useI18n();
  const { theme } = useTheme();
  const [range, setRange] = useState<string>("1h");
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const loadHistory = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchTelemetryHistory(activeZoneId, range);
      const formatted = res.points.map((p: TelemetryPoint) => {
        const d = new Date(p.timestamp);
        const timeStr = d.toLocaleTimeString(language === "vi" ? "vi-VN" : "en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        return {
          time: timeStr,
          rawTime: d.getTime(),
          soil_moisture: p.soil_moisture,
          air_temp: p.air_temp,
          air_humidity: p.air_humidity,
          soil_temp: p.soil_temp,
        };
      });
      setData(formatted);
    } catch (e) {
      console.error("Error loading telemetry:", e);
    } finally {
      setLoading(false);
    }
  }, [activeZoneId, language, range]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const applyTelemetry = useCallback((event: any) => {
    if (event.zoneId !== activeZoneId) return;
    const rawTime = event.timestamp > 10_000_000_000 ? event.timestamp : event.timestamp * 1000;
    const time = new Date(rawTime).toLocaleTimeString(language === "vi" ? "vi-VN" : "en-US", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    setData((current) => {
      const next = [...current.filter((point) => point.rawTime !== rawTime), {
        time,
        rawTime,
        soil_moisture: event.soil_moisture,
        air_temp: event.air_temp,
        air_humidity: event.air_humidity,
        soil_temp: event.soil_temp,
      }];
      return next.sort((a, b) => a.rawTime - b.rawTime).slice(-500);
    });
  }, [activeZoneId, language]);

  useSocket({ onTelemetry: applyTelemetry, onReconnect: () => { void loadHistory(); } });

  const isDark = theme === "dark";

  return (
    <div className="rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-5 transition-colors duration-150">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5 pb-3 border-b border-neutral-100 dark:border-neutral-800">
        <div>
          <h3 className="font-semibold text-sm text-neutral-900 dark:text-neutral-100">
            {t.chart.title}
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t.chart.subtitle}
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Zone Selector */}
          <div className="flex rounded-md bg-neutral-100 dark:bg-neutral-800 p-0.5 text-xs">
            {["Z01", "Z02", "Z03"].map((z) => (
              <button
                key={z}
                onClick={() => onZoneChange(z)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  activeZoneId === z
                    ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white font-bold shadow-xs"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                {z}
              </button>
            ))}
          </div>

          {/* Range Selector */}
          <div className="flex rounded-md bg-neutral-100 dark:bg-neutral-800 p-0.5 text-xs">
            {["1h", "6h", "24h", "7d"].map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-2 py-1 rounded transition-colors ${
                  range === r
                    ? "bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white font-bold shadow-xs"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          <button
            onClick={loadHistory}
            className="p-1.5 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title={t.chart.refresh}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Chart Canvas */}
      <div className="h-64 sm:h-72 w-full">
        {data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-neutral-400 text-xs">
            {loading ? t.chart.loading : t.chart.noData}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <defs>
                <linearGradient id="colorMoisture" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0.0} />
                </linearGradient>
                <linearGradient id="colorTemp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="2 2"
                stroke={isDark ? "#262626" : "#f1f5f9"}
                vertical={false}
              />
              <XAxis
                dataKey="time"
                stroke={isDark ? "#737373" : "#94a3b8"}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                stroke={isDark ? "#737373" : "#94a3b8"}
                tick={{ fontSize: 11 }}
                domain={[10, 100]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? "#171717" : "#ffffff",
                  borderColor: isDark ? "#262626" : "#e5e5e5",
                  borderRadius: "0.375rem",
                  fontSize: "12px",
                  color: isDark ? "#fafafa" : "#171717",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
              <Area
                type="monotone"
                name={t.chart.soilMoisture}
                dataKey="soil_moisture"
                stroke="#0ea5e9"
                strokeWidth={1.5}
                fillOpacity={1}
                fill="url(#colorMoisture)"
              />
              <Area
                type="monotone"
                name={t.chart.airTemp}
                dataKey="air_temp"
                stroke="#f59e0b"
                strokeWidth={1.5}
                fillOpacity={1}
                fill="url(#colorTemp)"
              />
              <Area
                type="monotone"
                name={t.chart.soilTemp}
                dataKey="soil_temp"
                stroke="#10b981"
                strokeWidth={1.2}
                strokeDasharray="3 3"
                fill="none"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};
