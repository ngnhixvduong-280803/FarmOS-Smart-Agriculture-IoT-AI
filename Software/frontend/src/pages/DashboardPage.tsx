import { useLiveRefresh } from "../hooks/useLiveRefresh";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Users,
  Sprout,
  Cpu,
  TriangleAlert,
  RefreshCw,
  CheckCircle2,
  ChevronRight,
  ArrowRight,
  WifiOff,
  Check,
  Droplets,
} from "lucide-react";
import { useI18n } from "../context/I18nContext";
import {
  getCurrentUser,
  fetchUsers,
  fetchFarms,
  fetchNodes,
  fetchInventoryNodes,
  fetchAlerts,
  fetchZones,
  fetchFarmOverview,
  resolveAlert,
} from "../services/api.service";
import { updateStoredMapState } from "../services/map-state.service";
import { UserProfile, FarmItem, NodeDevice, AlertItem, Zone, WaterTankState } from "../types";
import { useSocket } from "../hooks/useSocket";

export interface DashboardPageProps {
  isActive?: boolean;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ isActive = true }) => {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const currentUser = getCurrentUser();
  const isAdmin = currentUser?.role === "ADMIN";

  // Data states
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [farms, setFarms] = useState<FarmItem[]>([]);
  const [devices, setDevices] = useState<NodeDevice[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [resolvingAlertId, setResolvingAlertId] = useState<string | null>(null);

  // Non-admin user farm overview states
  const [userZones, setUserZones] = useState<Zone[]>([]);
  const [userTank, setUserTank] = useState<WaterTankState | null>(null);

  // Load data from Backend APIs
  const loadDashboardData = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) {
      setRefreshing(true);
    }
    setError(null);

    try {
      if (isAdmin) {
        // Fetch Admin system overview data in parallel
        const [usersData, farmsData, devicesData, alertsData] = await Promise.all([
          fetchUsers(),
          fetchFarms(),
          // `/nodes` only contains legacy operational rows. The Admin
          // inventory is the canonical source because it merges current
          // device identities with their runtime Node when one exists.
          // This keeps the overview aligned with the Device Inventory page.
          fetchInventoryNodes("all"),
          fetchAlerts(false),
        ]);

        setUsers(usersData);
        setFarms(farmsData);
        setDevices(devicesData as NodeDevice[]);
        setAlerts(alertsData);
      } else {
        // Regular user: load their farm overview & zones
        const [farmsData, zonesData, nodesData] = await Promise.all([
          fetchFarms().catch(() => [] as FarmItem[]),
          fetchZones().catch(() => [] as Zone[]),
          fetchNodes().catch(() => [] as NodeDevice[]),
        ]);
        setFarms(farmsData);
        setUserZones(zonesData);
        setDevices(nodesData);
        const overviewData = farmsData[0] ? await fetchFarmOverview(farmsData[0].id).catch(() => null) : null;
        setUserTank(overviewData?.tankState ?? null);
        if (overviewData?.tankState) {
          setUserTank(overviewData.tankState);
        }
      }
      setLastUpdated(new Date());
    } catch (err: any) {
      setError(err?.message || t.adminOverview.errorLoading);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAdmin, t.adminOverview.errorLoading]);

  // Initial load
  useEffect(() => {
    if (isActive) {
      loadDashboardData();
    }
  }, [isActive, loadDashboardData]);

  // Real-time WebSocket Listeners
  const handleGatewayStatus = useCallback((event: any) => {
    if (!event?.nodeId) return;
    setDevices((current) =>
      current.map((dev) =>
        dev.id === event.nodeId
          ? { ...dev, online: Boolean(event.online), rssi: event.rssi ?? dev.rssi }
          : dev
      )
    );
  }, []);

  const handleTelemetry = useCallback((event: any) => {
    if (!event?.nodeId) return;
    setDevices((current) =>
      current.map((dev) =>
        dev.id === event.nodeId
          ? {
              ...dev,
              online: true,
              latest_telemetry: {
                timestamp: new Date().toISOString(),
                soil_moisture: event.soil_moisture,
                soil_temp: event.soil_temp,
                air_temp: event.air_temp,
                air_humidity: event.air_humidity,
                lux: event.lux,
              },
            }
          : dev
      )
    );
  }, []);

  const handleNewAlert = useCallback((newAlert: AlertItem) => {
    setAlerts((current) => {
      if (current.some((a) => a.id === newAlert.id)) return current;
      return [newAlert, ...current];
    });
  }, []);

  useSocket({
    onGatewayStatus: handleGatewayStatus,
    onTelemetry: handleTelemetry,
    onNewAlert: handleNewAlert,
    onReconnect: () => {
      loadDashboardData();
    },
  });

  useLiveRefresh(() => loadDashboardData(), isActive);

  // Derived metrics matching mobile AdminSystemOverviewScreen
  const customers = useMemo(
    () => users.filter((u) => u.role === "USER"),
    [users]
  );
  const onlineDevices = useMemo(
    () => devices.filter((d) => d.online).length,
    [devices]
  );
  const offlineDevices = useMemo(
    () => devices.filter((d) => !d.online).length,
    [devices]
  );

  // Farms needing attention: farms that have active alerts OR offline devices
  const attentionFarms = useMemo(() => {
    return farms
      .filter((farm) => {
        const hasAlert = alerts.some(
          (alert) => alert.farm_id === farm.id || alert.zone?.name === farm.name
        );
        const hasOfflineDevice = devices.some(
          (device) =>
            (device.farm?.id === farm.id || device.farm_id === farm.id) && !device.online
        );
        return hasAlert || hasOfflineDevice;
      })
      .slice(0, 6);
  }, [farms, alerts, devices]);

  // Navigate to farm location on Map
  const handleOpenFarmOnMap = (farm: FarmItem) => {
    if (farm.latitude != null && farm.longitude != null) {
      updateStoredMapState({
        center: [farm.longitude, farm.latitude],
        zoom: 17,
      });
    }
    navigate("/map");
  };

  // Handle resolving an alert
  const handleResolveAlert = async (alertId: string) => {
    if (resolvingAlertId) return;
    setResolvingAlertId(alertId);
    try {
      await resolveAlert(alertId);
      setAlerts((current) => current.filter((a) => a.id !== alertId));
    } catch (err) {
      console.error("Failed to resolve alert:", err);
    } finally {
      setResolvingAlertId(null);
    }
  };

  // Skeleton loading state
  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-28 rounded-3xl bg-slate-200 dark:bg-slate-800" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-32 rounded-2xl bg-slate-200 dark:bg-slate-800" />
          ))}
        </div>
        <div className="h-44 rounded-2xl bg-slate-200 dark:bg-slate-800" />
        <div className="h-64 rounded-2xl bg-slate-200 dark:bg-slate-800" />
      </div>
    );
  }

  // If user is regular USER (non-admin), show farm overview
  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
              {t.dashboardPage.title}
            </h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
              {t.dashboardPage.subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadDashboardData(true)}
            disabled={refreshing}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all active:scale-95 shadow-2xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-emerald-600" : ""}`} />
            <span>{refreshing ? t.adminOverview.refreshing : t.adminOverview.refresh}</span>
          </button>
        </div>

        {/* User Farm Hero / Tank Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <Droplets className="w-6 h-6 text-blue-600 dark:text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                  {t.dashboardPage.tankLevel}
                </p>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white">
                  {userTank?.level_pct != null ? `${Math.round(userTank.level_pct)}%` : "—"}
                </h3>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <Cpu className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                  {t.dashboardPage.activeDevices}
                </p>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white">
                  {devices.filter((d) => d.online).length} / {devices.length}
                </h3>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                <TriangleAlert className="w-6 h-6 text-amber-600 dark:text-amber-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                  {t.dashboardPage.systemAlerts}
                </p>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white">
                  {alerts.length}
                </h3>
              </div>
            </div>
          </div>
        </div>

        {/* Cultivation Zones */}
        <h2 className="text-lg font-bold text-slate-900 dark:text-white mt-8 mb-4">
          {t.dashboardPage.zoneStatus}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {userZones.map((zone) => {
            const telemetry = zone.latest_telemetry;
            const moisture = telemetry?.soil_moisture;
            const isSimulation = zone.farm_id?.startsWith("SIM_");
            const isWarning = moisture != null && moisture < zone.target_moisture_min;
            return (
              <div
                key={zone.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs hover:shadow-md transition-all"
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-semibold text-slate-900 dark:text-white">{zone.name}</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {zone.crop_type || t.zones.crop}
                    </p>
                  </div>
                  <span
                    className={`px-3 py-1 text-xs font-semibold rounded-full ${
                      isWarning
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                        : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                    }`}
                  >
                    {isSimulation ? (language === "vi" ? "Mô phỏng" : "Simulation") : moisture == null ? (language === "vi" ? "Chưa có dữ liệu" : "No data") : isWarning ? t.zones.lowMoisture : t.zones.optimal}
                  </span>
                </div>
                {isSimulation ? <p className="mb-6 text-sm text-slate-600 dark:text-slate-300">
                  {language === "vi" ? "Dữ liệu mô phỏng và đề xuất tưới có tại mục Xem vườn." : "Simulation readings and irrigation advice are available in Garden view."}
                </p> : <>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-slate-500 dark:text-slate-400">{t.dashboardPage.soilMoisture}</span>
                  <span className="font-bold text-slate-900 dark:text-white">{moisture != null ? `${moisture}%` : "—"}</span>
                </div>
                <div className="w-full bg-slate-100 dark:bg-slate-800 rounded-full h-2.5 mb-2 relative overflow-hidden">
                  <div
                    className={`h-2.5 rounded-full transition-all duration-300 ${
                      isWarning ? "bg-amber-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${moisture ?? 0}%` }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-slate-400 dark:bg-slate-500"
                    style={{ left: `${zone.target_moisture_min}%` }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-slate-400 dark:bg-slate-500"
                    style={{ left: `${zone.target_moisture_max}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-slate-500 mb-6">
                  <span>0%</span>
                  <span>
                    {t.dashboardPage.target}: {zone.target_moisture_min}-{zone.target_moisture_max}%
                  </span>
                  <span>100%</span>
                </div>
                </>}
                <button
                  type="button"
                  onClick={() => navigate(isSimulation ? "/farm-assistant" : "/map")}
                  className="w-full py-2.5 bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-semibold rounded-xl transition-all"
                >
                  {t.dashboardPage.details}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ==========================================
  // ADMIN SYSTEM OVERVIEW (Matches Mobile App)
  // ==========================================
  return (
    <div className="space-y-6">
      {/* Top Header / Actions Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            {t.adminOverview.systemOverview}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-0.5">
            {t.adminOverview.systemOverviewDesc}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Live Indicator */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50 text-emerald-700 dark:text-emerald-400 text-xs font-semibold">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span>{t.adminOverview.liveUpdated}</span>
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={() => loadDashboardData(true)}
            disabled={refreshing}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all active:scale-95 shadow-2xs disabled:opacity-50"
            title={`${t.adminOverview.lastUpdated} ${lastUpdated.toLocaleTimeString()}`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-emerald-600" : ""}`} />
            <span className="hidden sm:inline">
              {refreshing ? t.adminOverview.refreshing : t.adminOverview.refresh}
            </span>
          </button>
        </div>
      </div>

      {/* Error Alert Banner if any */}
      {error && (
        <div className="p-4 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 flex items-center justify-between text-rose-700 dark:text-rose-300 text-sm">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => loadDashboardData(true)}
            className="text-xs font-bold underline hover:no-underline ml-4"
          >
            {t.adminOverview.retry}
          </button>
        </div>
      )}

      {/* 4 KEY METRIC CARDS (KPI Grid) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {/* Metric 1: Khách hàng */}
        <button
          type="button"
          onClick={() => navigate("/users")}
          className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-2xs hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-800 transition-all group"
        >
          <div className="flex items-center justify-between">
            <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/50 dark:border-emerald-800/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 group-hover:scale-105 transition-transform">
              <Users className="w-5 h-5" />
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-600 transition-colors" />
          </div>
          <div className="mt-4">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
              {customers.length}
            </h3>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-1">
              {t.adminOverview.customers}
            </p>
          </div>
        </button>

        {/* Metric 2: Trang trại */}
        <button
          type="button"
          onClick={() => navigate("/map")}
          className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-2xs hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-800 transition-all group"
        >
          <div className="flex items-center justify-between">
            <div className="w-11 h-11 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/50 dark:border-emerald-800/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 group-hover:scale-105 transition-transform">
              <Sprout className="w-5 h-5" />
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-600 transition-colors" />
          </div>
          <div className="mt-4">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
              {farms.length}
            </h3>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-1">
              {t.adminOverview.farms}
            </p>
          </div>
        </button>

        {/* Metric 3: Node online */}
        <button
          type="button"
          onClick={() => navigate("/nodes")}
          className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 shadow-2xs hover:shadow-md hover:border-blue-300 dark:hover:border-blue-800 transition-all group"
        >
          <div className="flex items-center justify-between">
            <div className="w-11 h-11 rounded-xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200/50 dark:border-blue-800/40 flex items-center justify-center text-blue-600 dark:text-blue-400 group-hover:scale-105 transition-transform">
              <Cpu className="w-5 h-5" />
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-blue-600 transition-colors" />
          </div>
          <div className="mt-4">
            <h3 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
              {onlineDevices} / {devices.length}
            </h3>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-1">
              {t.adminOverview.nodesOnline}
            </p>
            {offlineDevices > 0 && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{offlineDevices} · {t.adminOverview.needsCheck}</p>}
          </div>
        </button>

        {/* Metric 4: Cảnh báo mở */}
        <div
          className={`bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-2xs transition-all border ${
            alerts.length > 0
              ? "border-rose-200 dark:border-rose-900/50 bg-rose-50/30 dark:bg-rose-950/10"
              : "border-slate-200 dark:border-slate-800"
          }`}
        >
          <div className="flex items-center justify-between">
            <div
              className={`w-11 h-11 rounded-xl border flex items-center justify-center ${
                alerts.length > 0
                  ? "bg-rose-100 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800/50 text-rose-600 dark:text-rose-400"
                  : "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200/50 dark:border-emerald-800/40 text-emerald-600 dark:text-emerald-400"
              }`}
            >
              <TriangleAlert className="w-5 h-5" />
            </div>
            {alerts.length > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300">
                {t.adminOverview.needsCheck}
              </span>
            )}
          </div>
          <div className="mt-4">
            <h3
              className={`text-2xl sm:text-3xl font-extrabold tracking-tight ${
                alerts.length > 0
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-slate-900 dark:text-white"
              }`}
            >
              {alerts.length}
            </h3>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mt-1">
              {t.adminOverview.openAlerts}
            </p>
          </div>
        </div>
      </div>

      {/* SECTION 2: TRANG TRẠI CẦN CHÚ Ý (Farms Needing Attention) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs">
        <div className="flex items-center justify-between pb-5 border-b border-slate-100 dark:border-slate-800/80">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              {t.adminOverview.farmsNeedingAttention}
            </h2>
            {attentionFarms.length > 0 && (
              <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
                {attentionFarms.length}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => navigate("/map")}
            className="text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 flex items-center gap-1 transition-colors"
          >
            <span>{t.adminOverview.viewAll}</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="mt-4">
          {attentionFarms.length > 0 ? (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {attentionFarms.map((farm) => {
                const farmOffline = devices.filter(
                  (device) =>
                    (device.farm?.id === farm.id || device.farm_id === farm.id) && !device.online
                ).length;
                const farmAlerts = alerts.filter(
                  (alert) =>
                    alert.farm_id === farm.id || alert.zone?.name === farm.name
                ).length;

                return (
                  <div
                    key={farm.id}
                    onClick={() => handleOpenFarmOnMap(farm)}
                    className="py-3.5 flex items-center justify-between gap-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 px-3 -mx-3 rounded-xl transition-all group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/50 dark:border-emerald-800/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                        <Sprout className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="font-bold text-sm text-slate-900 dark:text-white truncate">
                            {farm.name}
                          </h4>
                          {farm.location && (
                            <span className="text-[11px] text-slate-400 dark:text-slate-500 hidden sm:inline truncate">
                              • {farm.location}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {farmAlerts > 0 ? (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 dark:text-rose-400">
                              <TriangleAlert className="w-3.5 h-3.5" />
                              <span>{t.adminOverview.alertCount.replace("{{count}}", String(farmAlerts))}</span>
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400 dark:text-slate-500">
                              {t.adminOverview.noAlerts}
                            </span>
                          )}

                          {farmOffline > 0 && (
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 dark:text-amber-400">
                              <WifiOff className="w-3.5 h-3.5" />
                              <span>{t.adminOverview.offlineNodes.replace("{{count}}", String(farmOffline))}</span>
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="hidden sm:inline text-xs font-semibold text-slate-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                        {t.adminOverview.viewOnMap}
                      </span>
                      <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 group-hover:translate-x-0.5 transition-all" />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-8 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/50 dark:border-emerald-800/40 flex items-center justify-center text-emerald-600 dark:text-emerald-400 mx-auto mb-3">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h4 className="text-sm font-bold text-slate-900 dark:text-white">
                {t.adminOverview.allFarmsOperatingNormally}
              </h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
                {t.adminOverview.noAttentionDesc}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ACTIVE ALERTS TABLE IF ANY (Direct action for Admin) */}
      {alerts.length > 0 && (
        <div className="bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-900/40 rounded-2xl p-6 shadow-xs">
          <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <TriangleAlert className="w-5 h-5 text-rose-600 dark:text-rose-400" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                {t.adminOverview.openAlerts} ({alerts.length})
              </h2>
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 mt-2">
            {alerts.slice(0, 5).map((alert) => (
              <div
                key={alert.id}
                className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`px-2 py-0.5 text-[10px] font-bold rounded-full uppercase ${
                        alert.level === "CRITICAL"
                          ? "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300"
                          : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                      }`}
                    >
                      {alert.level}
                    </span>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      {alert.farm_id || (alert.zone?.name ? `Zone: ${alert.zone.name}` : "Hệ thống")}
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500">
                      {new Date(alert.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 font-medium">
                    {alert.message}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => handleResolveAlert(alert.id)}
                  disabled={resolvingAlertId === alert.id}
                  className="self-start sm:self-center px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 text-xs font-semibold border border-emerald-200 dark:border-emerald-800 transition-colors flex items-center gap-1.5 active:scale-95 disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>Giải quyết</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}


    </div>
  );
};
