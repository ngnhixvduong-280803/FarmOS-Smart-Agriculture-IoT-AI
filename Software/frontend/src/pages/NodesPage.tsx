import { useLiveRefresh } from "../hooks/useLiveRefresh";
import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  RefreshCw,
  Trash2,
  MapPin,
  ChevronDown,
  ChevronRight,
  Radio,
  Cpu,
  Droplets,
  Thermometer,
  Copy,
  Check,
  Eye,
  LayoutGrid,
  List,
  GitFork,
  X,
  RotateCcw,
  Package,
  Activity,
  QrCode,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useI18n } from "../context/I18nContext";
import {
  fetchNodes,
  deleteNode,
  unbindNode,
  getCurrentUser,
} from "../services/api.service";
import { EditNodeLocationModal } from "../components/EditNodeLocationModal";
import { DeviceDetailModal } from "../components/DeviceDetailModal";
import { DeviceQrModal } from "../components/DeviceQrModal";
import { NodeDevice } from "../types";

type ViewMode = "table" | "grid" | "grouped";
type FilterCategory =
  | "all"
  | "inventory"
  | "active"
  | "gateways"
  | "sensors"
  | "online"
  | "offline";

export interface NodesPageProps {
  isActive?: boolean;
}

export const NodesPage: React.FC<NodesPageProps> = ({ isActive = true }) => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUser = getCurrentUser();
  const isAdmin = currentUser?.role === "ADMIN";

  const [nodes, setNodes] = useState<NodeDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState<FilterCategory>(() => {
    const tab = searchParams.get("tab") || searchParams.get("filter");
    if (tab === "inventory") return "inventory";
    return "all";
  });
  const [selectedFarmFilter, setSelectedFarmFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (
      (localStorage.getItem("farmos_nodes_view_mode") as ViewMode) || "table"
    );
  });

  const [isEditLocationOpen, setIsEditLocationOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<NodeDevice | null>(null);
  const [qrNode, setQrNode] = useState<NodeDevice | null>(null);
  const [expandedGateways, setExpandedGateways] = useState<
    Record<string, boolean>
  >({});
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [releaseInProgress, setReleaseInProgress] = useState<string | null>(null);
  const [releaseNotice, setReleaseNotice] = useState("");

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(id);
    setTimeout(() => setCopiedField(null), 1800);
  };

  const handleViewModeChange = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("farmos_nodes_view_mode", mode);
  };

  useEffect(() => {
    if (!isDetailModalOpen) return;
    const timer = window.setInterval(() => { void loadNodes(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [isDetailModalOpen]);

  const openDeviceDetail = (node: NodeDevice) => {
    setSelectedNode(node);
    setIsDetailModalOpen(true);
  };

  const loadNodes = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const data = await fetchNodes();
      setNodes(data);
      setSelectedNode(current => current ? data.find(n => n.id === current.id) ?? current : null);

      const initialExpanded: Record<string, boolean> = { unassigned: true };
      data.forEach((n) => {
        if (n.type === "GATEWAY") {
          initialExpanded[n.id] = true;
        }
      });
      setExpandedGateways((prev) => ({ ...initialExpanded, ...prev }));
    } catch (err: any) {
      console.error("Lỗi tải danh sách Nodes:", err);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    loadNodes();
  }, []);

  useEffect(() => {
    if (isActive) {
      void loadNodes(true);
    }
  }, [isActive]);

  useEffect(() => {
    const handleSync = () => {
      void loadNodes(true);
    };
    window.addEventListener("farmos:node-updated", handleSync);
    return () => window.removeEventListener("farmos:node-updated", handleSync);
  }, []);

  useLiveRefresh(() => loadNodes(true), isActive);

  // Handle URL search params switch
  useEffect(() => {
    const tab = searchParams.get("tab") || searchParams.get("filter");
    if (tab === "inventory") {
      setFilterCategory("inventory");
    }
  }, [searchParams]);

  const handleDelete = async (id: string, name?: string | null) => {
    const displayName = name || id;
    if (
      window.confirm(
        t.nodesPage.deletePermanentConfirm.replace("{{name}}", displayName),
      )
    ) {
      try {
        await deleteNode(id);
        setNodes((prev) => prev.filter((n) => n.id !== id));
        window.dispatchEvent(new CustomEvent("farmos:node-updated"));
      } catch (err: any) {
        alert(t.nodesPage.deleteError + err.message);
      }
    }
  };

  const handleUnbind = async (node: NodeDevice) => {
    const message = node.type === "GATEWAY" ? t.nodesPage.unbindGatewayConfirm : t.nodesPage.unbindNodeConfirm;
    if (!window.confirm(message.replace("{{name}}", node.name || node.id))) return;
    setReleaseInProgress(node.id);
    setReleaseNotice("");
    try {
      await unbindNode(node.id);
      setNodes((current) => current.filter((item) => item.id !== node.id));
      setReleaseNotice(t.nodesPage.releaseDone);
      window.dispatchEvent(new CustomEvent("farmos:node-updated"));
    } catch (error) {
      setReleaseNotice(t.nodesPage.unbindError + (error instanceof Error ? error.message : ""));
      void loadNodes(true);
    } finally {
      setReleaseInProgress(null);
    }
  };

  const renderUnbind = (node: NodeDevice) => {
    if (!node.can_unbind) return null;
    const label = releaseInProgress === node.id ? t.nodesPage.releaseWaiting : t.nodesPage.unbindAction;
    return (
      <button
        type="button"
        disabled={releaseInProgress !== null}
        onClick={(event) => {
          event.stopPropagation();
          void handleUnbind(node);
        }}
        className="inline-flex min-h-10 items-center gap-1 rounded px-2 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60 dark:text-amber-300 dark:hover:bg-amber-950/40"
        title={label}
        aria-label={`${label} · ${node.name || node.id}`}
      >
        <RotateCcw className="w-3.5 h-3.5" />
        <span>{label}</span>
      </button>
    );
  };

  const toggleGateway = (gatewayId: string) => {
    setExpandedGateways((prev) => ({
      ...prev,
      [gatewayId]: !prev[gatewayId],
    }));
  };

  // Unique farms list for Admin filtering
  const availableFarms = useMemo(() => {
    const farmMap = new Map<string, string>();
    nodes.forEach((n) => {
      if (n.is_activated && n.farm) {
        farmMap.set(n.farm.id, n.farm.name);
      }
    });
    return Array.from(farmMap.entries()).map(([id, name]) => ({ id, name }));
  }, [nodes]);

  // Overall KPI metrics
  const stats = useMemo(() => {
    const gateways = nodes.filter((n) => n.type === "GATEWAY");
    const sensors = nodes.filter((n) => n.type !== "GATEWAY");
    const inventory = nodes.filter((n) => !n.is_activated);
    const active = nodes.filter((n) => n.is_activated !== false);
    const online = nodes.filter((n) => n.online);
    const offline = nodes.filter((n) => !n.online);
    const onlinePct =
      nodes.length > 0 ? Math.round((online.length / nodes.length) * 100) : 0;

    return {
      total: nodes.length,
      gateways: gateways.length,
      sensors: sensors.length,
      inventory: inventory.length,
      active: active.length,
      online: online.length,
      offline: offline.length,
      onlinePct,
    };
  }, [nodes]);

  // Filtered nodes list based on category, farm, and search
  const filteredNodes = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();

    return nodes.filter((node) => {
      // Category filter
      if (filterCategory === "inventory" && node.is_activated !== false)
        return false;
      if (filterCategory === "active" && !node.is_activated) return false;
      if (filterCategory === "gateways" && node.type !== "GATEWAY")
        return false;
      if (filterCategory === "sensors" && node.type === "GATEWAY") return false;
      if (filterCategory === "online" && !node.online) return false;
      if (filterCategory === "offline" && node.online) return false;

      // Farm filter
      if (selectedFarmFilter !== "all" && node.farm_id !== selectedFarmFilter)
        return false;

      // Search query
      if (q) {
        const matches =
          node.id.toLowerCase().includes(q) ||
          (node.name || "").toLowerCase().includes(q) ||
          (node.serial_number || "").toLowerCase().includes(q) ||
          (node.owner?.name || "").toLowerCase().includes(q) ||
          (node.owner?.email || "").toLowerCase().includes(q) ||
          (node.farm?.name || "").toLowerCase().includes(q) ||
          (node.zone?.name || "").toLowerCase().includes(q);
        if (!matches) return false;
      }

      return true;
    });
  }, [nodes, filterCategory, selectedFarmFilter, searchQuery]);

  // Grouped data structure for 'grouped' view
  const groupedData = useMemo(() => {
    const gateways = filteredNodes.filter((n) => n.type === "GATEWAY");
    const sensors = filteredNodes.filter((n) => n.type !== "GATEWAY");

    const gatewayMap = new Map<
      string,
      { gateway: NodeDevice; nodes: NodeDevice[] }
    >();
    gateways.forEach((gw) => {
      gatewayMap.set(gw.id, { gateway: gw, nodes: [] });
    });

    const unassigned: NodeDevice[] = [];
    sensors.forEach((s) => {
      if (s.gateway_id && gatewayMap.has(s.gateway_id)) {
        gatewayMap.get(s.gateway_id)!.nodes.push(s);
      } else {
        unassigned.push(s);
      }
    });

    return {
      groups: Array.from(gatewayMap.values()),
      unassigned,
    };
  }, [filteredNodes]);

  // Helper render signal strength indicator
  const renderSignalBars = (rssi?: number | null) => {
    if (rssi === null || rssi === undefined) {
      return <span className="text-slate-400 text-xs">--</span>;
    }
    const bars = rssi > -65 ? 4 : rssi > -75 ? 3 : rssi > -85 ? 2 : 1;
    return (
      <div
        className="flex items-end gap-0.5 h-3"
        title={t.nodesPage.signalTitle.replace("{{rssi}}", String(rssi))}
      >
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`w-1 rounded-xs transition-all ${
              i <= bars
                ? "bg-slate-700 dark:bg-slate-300"
                : "bg-slate-200 dark:bg-slate-700"
            }`}
            style={{ height: `${i * 25}%` }}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6 font-sans pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">
              {isAdmin ? t.nodesPage.masterTitle : t.nodesPage.title}
            </h1>
            {isAdmin && (
              <span className="px-2 py-0.5 text-xs font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 rounded-md border border-blue-200 dark:border-blue-800">
                Master Registry
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {isAdmin
              ? t.nodesPage.masterSubtitle
              : t.nodesPage.userSubtitle}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={() => loadNodes(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition shadow-2xs"
            title={t.nodesPage.refresh}
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
            />
            <span>{t.nodesPage.refresh}</span>
          </button>

          <button
            onClick={() => navigate("/flasher")}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-emerald-600 dark:hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition shadow-xs"
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>{t.nodesPage.flashDevice}</span>
          </button>
        </div>
      </div>

      {/* Compact operational summary. Detailed counts stay available through filters. */}
      <div className="grid overflow-hidden rounded-xl border border-slate-200 bg-slate-200 shadow-xs dark:border-slate-800 dark:bg-slate-800 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => setFilterCategory("all")}
          className={`flex items-center gap-3 bg-white px-4 py-3.5 text-left transition hover:bg-emerald-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600 dark:bg-slate-900 dark:hover:bg-emerald-950/20 ${
            filterCategory === "all"
              ? "bg-emerald-50/70 dark:bg-emerald-950/25"
              : ""
          }`}
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <Cpu className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              {t.nodesPage.totalDevices}
            </div>
            <div className="mt-0.5 text-xl font-semibold tracking-tight text-slate-950 dark:text-white">
              {stats.total}
            </div>
            <div className="text-[11px] text-slate-400">
              {t.nodesPage.gatewaysAndSensors.replace("{{gateways}}", String(stats.gateways)).replace("{{sensors}}", String(stats.sensors))}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setFilterCategory("inventory")}
          className={`flex items-center gap-3 bg-white px-4 py-3.5 text-left transition hover:bg-amber-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500 dark:bg-slate-900 dark:hover:bg-amber-950/20 ${
            filterCategory === "inventory"
              ? "bg-amber-50/70 dark:bg-amber-950/25"
              : ""
          }`}
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300">
            <Package className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              {t.nodesPage.readyToDeploy}
            </div>
            <div className="mt-0.5 text-xl font-semibold tracking-tight text-slate-950 dark:text-white">
              {stats.inventory}
            </div>
            <div className="text-[11px] text-slate-400">
              {t.nodesPage.unassignedOwner}
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setFilterCategory("online")}
          className={`flex items-center gap-3 bg-white px-4 py-3.5 text-left transition hover:bg-emerald-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600 dark:bg-slate-900 dark:hover:bg-emerald-950/20 ${
            filterCategory === "online"
              ? "bg-emerald-50/70 dark:bg-emerald-950/25"
              : ""
          }`}
        >
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              {t.nodesPage.connecting}
            </div>
            <div className="mt-0.5 text-xl font-semibold tracking-tight text-slate-950 dark:text-white">
              {stats.online}{" "}
              <span className="text-xs font-medium text-slate-400">
                / {stats.total}
              </span>
            </div>
            <div className="text-[11px] text-slate-400">
              {t.nodesPage.offlineCount.replace("{{count}}", String(stats.offline)).replace("{{pct}}", String(stats.onlinePct))}
            </div>
          </div>
        </button>
      </div>

      {/* Filter, Search & View Mode Toolbar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 shadow-xs space-y-3 lg:space-y-0 lg:flex lg:items-center lg:justify-between lg:gap-4">
        {/* Left: Search Bar & Farm Selector */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 flex-1 max-w-xl">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder={
                isAdmin
                  ? t.nodesPage.adminSearchPlaceholder
                  : t.nodesPage.searchPlaceholder
              }
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-8 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs focus:outline-none focus:border-slate-400 dark:text-white transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          {isAdmin && availableFarms.length > 1 && (
            <select
              value={selectedFarmFilter}
              onChange={(e) => setSelectedFarmFilter(e.target.value)}
              className="px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:border-slate-400 shrink-0"
            >
              <option value="all">
                {t.nodesPage.allFarms.replace("{{count}}", String(availableFarms.length))}
              </option>
              {availableFarms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Right: Lifecycle Filter Tabs & View Mode Switcher */}
        <div className="flex items-center justify-between sm:justify-end gap-2.5 flex-wrap">
          {/* Status Tabs */}
          <div className="flex items-center bg-slate-100 dark:bg-slate-950 p-0.5 rounded-lg text-xs font-medium overflow-x-auto">
            <button
              onClick={() => setFilterCategory("all")}
              className={`px-2.5 py-1 rounded-md transition-colors text-xs shrink-0 ${
                filterCategory === "all"
                  ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-2xs font-semibold"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
            >
              {t.nodesPage.filterAll} ({stats.total})
            </button>
            <button
              onClick={() => setFilterCategory("inventory")}
              className={`px-2.5 py-1 rounded-md transition-colors text-xs shrink-0 ${
                filterCategory === "inventory"
                  ? "bg-white dark:bg-slate-800 text-amber-700 dark:text-amber-300 shadow-2xs font-semibold"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
            >
              {t.nodesPage.filterInventory} ({stats.inventory})
            </button>
            <button
              onClick={() => setFilterCategory("active")}
              className={`px-2.5 py-1 rounded-md transition-colors text-xs shrink-0 ${
                filterCategory === "active"
                  ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-2xs font-semibold"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
            >
              {t.nodesPage.filterActive} ({stats.active})
            </button>
            <button
              onClick={() => setFilterCategory("online")}
              className={`px-2.5 py-1 rounded-md transition-colors text-xs shrink-0 ${
                filterCategory === "online"
                  ? "bg-white dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 shadow-2xs font-semibold"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
            >
              {t.nodesPage.filterOnline} ({stats.online})
            </button>
            <button
              onClick={() => setFilterCategory("offline")}
              className={`px-2.5 py-1 rounded-md transition-colors text-xs shrink-0 ${
                filterCategory === "offline"
                  ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-2xs font-semibold"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
            >
              {t.nodesPage.filterOffline} ({stats.offline})
            </button>
          </div>

          {/* View Mode Switcher */}
          <div className="flex items-center bg-slate-100 dark:bg-slate-950 p-0.5 rounded-lg text-xs font-medium">
            <button
              onClick={() => handleViewModeChange("table")}
              className={`p-1.5 rounded-md transition-colors flex items-center gap-1 text-xs ${
                viewMode === "table"
                  ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-2xs font-semibold"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
              title={t.nodesPage.viewTableTitle}
            >
              <List className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{t.nodesPage.viewTable}</span>
            </button>

            <button
              onClick={() => handleViewModeChange("grid")}
              className={`p-1.5 rounded-md transition-colors flex items-center gap-1 text-xs ${
                viewMode === "grid"
                  ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-2xs font-semibold"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
              title={t.nodesPage.viewGridTitle}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{t.nodesPage.viewGrid}</span>
            </button>

            <button
              onClick={() => handleViewModeChange("grouped")}
              className={`p-1.5 rounded-md transition-colors flex items-center gap-1 text-xs ${
                viewMode === "grouped"
                  ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-2xs font-semibold"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              }`}
              title={t.nodesPage.viewGroupedTitle}
            >
              <GitFork className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{t.nodesPage.viewGrouped}</span>
            </button>
          </div>
        </div>
      </div>

      {releaseNotice && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          {releaseNotice}
        </div>
      )}

      {/* Main Content Area */}
      {loading && nodes.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-16 text-center text-slate-500 shadow-xs">
          <RefreshCw className="w-7 h-7 animate-spin mx-auto mb-3 text-emerald-500" />
          <div className="font-semibold text-slate-800 dark:text-slate-200">
            {t.nodesPage.loadingNodes}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {t.nodesPage.syncingNodes}
          </p>
        </div>
      ) : filteredNodes.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-16 text-center shadow-xs">
          <Cpu className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
          <h3 className="font-bold text-slate-800 dark:text-slate-200 text-base">
            {t.nodesPage.noDevicesFound}
          </h3>
          <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
            {searchQuery ||
            filterCategory !== "all" ||
            selectedFarmFilter !== "all"
              ? t.nodesPage.noDevicesFilteredHint
              : t.nodesPage.noDevicesEmptyHint}
          </p>
          {(searchQuery ||
            filterCategory !== "all" ||
            selectedFarmFilter !== "all") && (
            <button
              onClick={() => {
                setSearchQuery("");
                setFilterCategory("all");
                setSelectedFarmFilter("all");
              }}
              className="mt-4 px-3.5 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 rounded-lg hover:bg-emerald-100 transition"
            >
              {t.nodesPage.clearAllFilters}
            </button>
          )}
        </div>
      ) : viewMode === "table" ? (
        /* ================= 1. COMPACT MASTER TABLE VIEW ================= */
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-sm">
              <thead className="bg-slate-50/80 dark:bg-slate-950/60 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 text-[10px] uppercase tracking-[0.08em] font-semibold">
                <tr>
                  <th className="pl-5 pr-4 py-3">{t.nodesPage.tableColDevice}</th>
                  <th className="px-4 py-3">{t.nodesPage.tableColAssignment}</th>
                  <th className="px-4 py-3">{t.nodesPage.tableColStatus}</th>
                  <th className="px-4 py-3">{t.nodesPage.tableColLastMeasurement}</th>
                  <th className="pr-5 pl-4 py-3 text-right">{t.nodesPage.tableColActions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {filteredNodes.map((node) => {
                  const isGw = node.type === "GATEWAY";
                  const tel = node.latest_telemetry;

                  return (
                    <tr
                      key={node.id}
                      onClick={() => openDeviceDetail(node)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openDeviceDetail(node);
                        }
                      }}
                      tabIndex={0}
                      className="cursor-pointer transition-colors hover:bg-emerald-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600 dark:hover:bg-emerald-950/10"
                    >
                      <td className="pl-5 pr-4 py-3">
                        <div className="flex min-w-[220px] items-center gap-2.5">
                          <div
                            className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                              isGw
                                ? "bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800"
                                : "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800"
                            }`}
                          >
                            {isGw ? (
                              <Radio className="w-3.5 h-3.5" />
                            ) : (
                              <Cpu className="w-3.5 h-3.5" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-semibold text-xs text-slate-900 dark:text-slate-100">
                                {node.name || node.id}
                              </span>
                              <span
                                className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold ${
                                  isGw
                                    ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                                    : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                }`}
                              >
                                {isGw ? "GATEWAY" : t.nodesPage.sensorRole.toUpperCase()}
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center gap-1 text-[11px] font-mono text-slate-400">
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleCopy(node.id, `tbl-${node.id}`);
                                }}
                                className="hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-1"
                                title={t.nodesPage.copyId}
                              >
                                <span>{node.id}</span>
                                {copiedField === `tbl-${node.id}` ? (
                                  <Check className="w-2.5 h-2.5 text-emerald-500" />
                                ) : (
                                  <Copy className="w-2.5 h-2.5 text-slate-400" />
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-3 text-xs">
                        {!node.is_activated ? (
                          <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                            {t.nodesPage.unassigned}
                          </span>
                        ) : (
                          <div className="min-w-[190px]">
                            <div className="truncate font-medium text-slate-800 dark:text-slate-200">
                              {node.farm?.name || t.nodesPage.unassignedFarm}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-slate-400">
                              {node.zone
                                ? `${node.zone.name}${node.zone.crop_type ? ` · ${node.zone.crop_type}` : ""}`
                                : isAdmin && node.owner
                                  ? node.owner.name?.trim() || node.owner.email
                                  : t.nodesPage.unassignedZone}
                            </div>
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 text-xs">
                        <div className="flex min-w-[135px] flex-wrap gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium ${
                              node.is_activated
                                ? "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                            }`}
                          >
                            {node.is_activated ? t.nodesPage.filterActive : t.nodesPage.inInventory}
                          </span>
                          {node.is_activated && (
                            <span
                              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium ${
                                node.online
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                                  : "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${node.online ? "bg-emerald-500" : "bg-slate-400"}`}
                              />
                              {node.online ? t.nodesPage.online : t.nodesPage.offline}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-4 py-3 text-xs">
                        <div className="flex min-w-[150px] items-center gap-2 text-slate-600 dark:text-slate-300">
                          {node.is_activated && tel ? (
                            <>
                              <div
                                className="flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-1 text-[11px] dark:bg-slate-800"
                                title={t.nodesPage.soilMoisture}
                              >
                                <Droplets className="w-3 h-3 text-blue-500" />
                                <span className="font-semibold">
                                  {tel.soil_moisture != null ? `${Number(tel.soil_moisture.toFixed(2))}%${node.is_simulation ? " VWC" : ""}` : "—"}
                                </span>
                              </div>
                              {tel.air_temp != null && (
                                <div
                                  className="flex items-center gap-1 text-[11px]"
                                  title={t.nodesPage.airTemp}
                                >
                                  <Thermometer className="w-3 h-3 text-amber-500" />
                                  <span>{Number(tel.air_temp.toFixed(2))}°C</span>
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-[11px] text-slate-400">
                              {isGw ? t.nodesPage.centralGateway : t.nodesPage.noData}
                            </span>
                          )}

                          {node.is_activated && renderSignalBars(node.rssi)}
                        </div>
                      </td>

                      <td className="pr-5 pl-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              openDeviceDetail(node);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-emerald-700 transition hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                            title={t.nodesPage.deviceDetails}
                          >
                            <Eye className="h-3.5 w-3.5" />
                            <span>{t.nodesPage.viewAction}</span>
                          </button>

                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setQrNode(node);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                            title={t.nodesPage.qrTitle}
                          >
                            <QrCode className="h-3.5 w-3.5" />
                            <span>QR</span>
                          </button>

                          {renderUnbind(node)}

                          {isAdmin && (
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                handleDelete(node.id, node.name);
                              }}
                              className="p-1 text-slate-400 hover:text-rose-600 rounded hover:bg-rose-50 dark:hover:bg-rose-950/40 transition"
                              title={t.nodesPage.deletePermanentAction}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : viewMode === "grid" ? (
        /* ================= 2. FLAT CARD GRID VIEW ================= */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3.5 sm:gap-4">
          {filteredNodes.map((node) => {
            const isGw = node.type === "GATEWAY";
            const tel = node.latest_telemetry;

            return (
              <div
                key={node.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs hover:border-slate-300 dark:hover:border-slate-700 transition flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                          isGw
                            ? "bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400"
                            : "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {isGw ? (
                          <Radio className="w-4 h-4" />
                        ) : (
                          <Cpu className="w-4 h-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 dark:text-slate-100 text-xs sm:text-sm truncate">
                          {node.name || node.id}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono mt-0.5">
                          <button
                            onClick={() =>
                              handleCopy(node.id, `crd-${node.id}`)
                            }
                            className="hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-1"
                          >
                            <span>{node.id}</span>
                            {copiedField === `crd-${node.id}` ? (
                              <Check className="w-2.5 h-2.5 text-emerald-500" />
                            ) : (
                              <Copy className="w-2.5 h-2.5" />
                            )}
                          </button>
                          {node.serial_number && (
                            <span>• {node.serial_number}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 text-[11px] font-medium shrink-0">
                      {!node.is_activated ? (
                        <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                          {t.nodesPage.inInventory}
                        </span>
                      ) : (
                        <>
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              node.online ? "bg-emerald-500" : "bg-slate-400"
                            }`}
                          />
                          <span
                            className={
                              node.online
                                ? "text-emerald-600 font-semibold"
                                : "text-slate-400"
                            }
                          >
                            {node.online ? t.nodesPage.online : t.nodesPage.offline}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Badges line */}
                  <div className="flex items-center gap-1.5 flex-wrap mb-3 text-xs">
                    <span
                      className={`px-1.5 py-0.2 rounded text-[10px] font-semibold ${
                        isGw
                          ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                          : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      {isGw ? "GATEWAY" : t.nodesPage.sensorRole.toUpperCase()}
                    </span>

                    {node.is_activated && node.zone && (
                      <span className="px-1.5 py-0.2 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                        {node.zone.name}
                      </span>
                    )}

                    {isAdmin && node.owner && (
                      <div className="text-right ml-auto min-w-0 max-w-[150px]">
                        <div
                          className="text-[11px] font-medium text-slate-700 dark:text-slate-300 truncate"
                          title={node.owner.name || node.owner.email}
                        >
                          {node.owner.name?.trim() ||
                            node.owner.email.split("@")[0]}
                        </div>
                        <div
                          className="text-[10px] text-slate-400 truncate"
                          title={node.owner.email}
                        >
                          {node.owner.email}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Telemetry Display Box */}
                  <div className="bg-slate-50 dark:bg-slate-950/50 rounded-lg p-2.5 border border-slate-200/60 dark:border-slate-800 space-y-2 mb-3">
                    {!node.is_activated ? (
                      <div className="text-xs text-slate-400 text-center py-2 italic">
                        {t.nodesPage.inventoryUnactivated}
                      </div>
                    ) : tel ? (
                      <>
                        <div>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1">
                              <Droplets className="w-3 h-3 text-blue-500" />
                              {t.nodesPage.soilMoisture}
                            </span>
                            <span className="font-semibold text-slate-900 dark:text-white">
                              {tel.soil_moisture != null ? `${Number(tel.soil_moisture.toFixed(2))}%${node.is_simulation ? " VWC" : ""}` : "—"}
                            </span>
                          </div>
                          <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1 overflow-hidden">
                            <div
                              className="bg-emerald-500 h-full rounded-full transition-all"
                              style={{
                                width: `${Math.min(tel.soil_moisture ?? 0, 100)}%`,
                              }}
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-xs pt-1.5 border-t border-slate-200/50 dark:border-slate-800 text-slate-500">
                          <div className="flex items-center gap-1">
                            <Thermometer className="w-3 h-3 text-amber-500" />
                            <span>
                              {tel.air_temp != null
                                ? `${Number(tel.air_temp.toFixed(2))}°C`
                                : "--"}
                            </span>
                          </div>
                          <div className="flex items-center gap-1"></div>
                          <div className="flex items-center gap-1">
                            {renderSignalBars(node.rssi)}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-slate-400 text-center py-1">
                        {t.nodesPage.noRecentTelemetry}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer Actions */}
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                  {node.latitude && node.longitude ? (
                    <button
                      onClick={() => {
                        setSelectedNode(node);
                        setIsEditLocationOpen(true);
                      }}
                      className="flex items-center gap-1 text-[11px] text-slate-500 font-mono hover:text-slate-800"
                    >
                      <MapPin className="w-3 h-3 text-slate-400" />
                      <span>
                        {node.latitude.toFixed(3)}, {node.longitude.toFixed(3)}
                      </span>
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setSelectedNode(node);
                        setIsEditLocationOpen(true);
                      }}
                      className="text-[11px] text-amber-600 font-medium"
                    >
                      {t.nodesPage.assignGps}
                    </button>
                  )}

                  <div className="flex items-center gap-1 ml-auto">
                    <button
                      onClick={() => {
                        setSelectedNode(node);
                        setIsDetailModalOpen(true);
                      }}
                      className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100"
                      title={t.nodesPage.deviceDetails}
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                    {renderUnbind(node)}
                    {isAdmin && (
                      <button
                        onClick={() => handleDelete(node.id, node.name)}
                        className="p-1 text-slate-400 hover:text-rose-600 rounded hover:bg-rose-50"
                        title={t.nodesPage.deletePermanentAction}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ================= 3. GROUPED / TOPOLOGY VIEW ================= */
        <div className="space-y-4">
          {groupedData.groups.map(({ gateway, nodes: childNodes }) => {
            const isExpanded = expandedGateways[gateway.id] ?? true;
            return (
              <div
                key={gateway.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs"
              >
                {/* Gateway Slim Header */}
                <div
                  onClick={() => toggleGateway(gateway.id)}
                  className="p-3.5 bg-slate-50/70 dark:bg-slate-950/40 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 cursor-pointer hover:bg-slate-100/60 select-none transition"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <button
                      type="button"
                      className="p-0.5 text-slate-400 hover:text-slate-600"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </button>

                    <div className="w-6 h-6 rounded-md bg-blue-50 dark:bg-blue-950/60 text-blue-600 flex items-center justify-center shrink-0">
                      <Radio className="w-3.5 h-3.5" />
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-slate-900 dark:text-white truncate">
                          {gateway.name || gateway.id}
                        </span>
                        <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                          GATEWAY
                        </span>
                        <span className="text-xs text-slate-500">
                          {t.nodesPage.childNodesCount.replace("{{count}}", String(childNodes.length))}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>ID: {gateway.id}</span>
                        {gateway.is_activated && gateway.farm && (
                          <span className="font-sans">
                            • {gateway.farm.name}
                          </span>
                        )}
                        {isAdmin && gateway.owner && (
                          <span className="font-sans text-slate-500 dark:text-slate-400">
                            • {t.nodesPage.customer}:{" "}
                            <b className="font-medium text-slate-700 dark:text-slate-200">
                              {gateway.owner.name?.trim() ||
                                gateway.owner.email.split("@")[0]}
                            </b>{" "}
                            ({gateway.owner.email})
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div
                    className="flex items-center gap-2 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center gap-1 text-[11px] font-medium">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          gateway.online ? "bg-emerald-500" : "bg-slate-400"
                        }`}
                      />
                      <span
                        className={
                          gateway.online ? "text-emerald-600" : "text-slate-400"
                        }
                      >
                        {gateway.online ? t.nodesPage.online : t.nodesPage.offline}
                      </span>
                    </div>

                    {renderUnbind(gateway)}
                    <button
                      onClick={() => {
                        setSelectedNode(gateway);
                        setIsDetailModalOpen(true);
                      }}
                      className="p-1 text-slate-400 hover:text-slate-700"
                      title={t.nodesPage.deviceDetails}
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Child Nodes inside Gateway */}
                {isExpanded && (
                  <div className="p-4 bg-white dark:bg-slate-900">
                    {childNodes.length === 0 ? (
                      <div className="text-xs text-slate-400 py-1 italic text-center">
                        {t.nodesPage.noSensorNodesConnected}
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {childNodes.map((cn) => (
                          <div
                            key={cn.id}
                            className="p-3 bg-slate-50/60 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800 rounded-lg flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <div className="font-semibold text-xs text-slate-900 dark:text-slate-100 truncate">
                                {cn.name || cn.id}
                              </div>
                              <div className="text-[11px] text-slate-400 font-mono">
                                {cn.id}
                              </div>
                              {cn.zone && (
                                <div className="text-[10px] text-slate-500 mt-1">
                                  {t.nodesPage.zonePrefix}{cn.zone.name}
                                </div>
                              )}
                            </div>

                            <div className="text-right shrink-0">
                              <div className="flex items-center gap-1 text-xs font-semibold text-slate-800 dark:text-slate-200">
                                <Droplets className="w-3 h-3 text-blue-500" />
                                <span>
                                  {cn.latest_telemetry?.soil_moisture ?? "--"}%
                                </span>
                              </div>
                              {renderUnbind(cn)}
                              <button
                                onClick={() => {
                                  setSelectedNode(cn);
                                  setIsDetailModalOpen(true);
                                }}
                                className="mt-1 text-[11px] text-emerald-600 hover:underline"
                              >
                                {t.nodesPage.viewMeasurements}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Standalone Nodes */}
          {groupedData.unassigned.length > 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-xs">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-emerald-600" />
                <span>
                  {t.nodesPage.directConnectedNodes.replace("{{count}}", String(groupedData.unassigned.length))}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {groupedData.unassigned.map((node) => (
                  <div
                    key={node.id}
                    className="p-3 bg-slate-50/60 dark:bg-slate-950/40 border border-slate-200/80 dark:border-slate-800 rounded-lg flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-xs text-slate-900 dark:text-slate-100 truncate">
                        {node.name || node.id}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono">
                        {node.id}
                      </div>
                      {node.is_activated && node.farm && (
                        <div className="text-[10px] text-slate-500 mt-1">
                          {t.nodesPage.farmPrefix}{node.farm.name}
                        </div>
                      )}
                    </div>

                    <div className="text-right shrink-0">
                      <div className="flex items-center gap-1 text-xs font-semibold text-slate-800 dark:text-slate-200">
                        <Droplets className="w-3 h-3 text-blue-500" />
                        <span>
                          {node.latest_telemetry?.soil_moisture ?? "--"}%
                        </span>
                      </div>
                      {renderUnbind(node)}
                      <button
                        onClick={() => {
                          setSelectedNode(node);
                          setIsDetailModalOpen(true);
                        }}
                        className="mt-1 text-[11px] text-emerald-600 hover:underline"
                      >
                        {t.nodesPage.viewAction}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <EditNodeLocationModal
        isOpen={isEditLocationOpen}
        node={selectedNode}
        onClose={() => {
          setIsEditLocationOpen(false);
          setSelectedNode(null);
        }}
        onSuccess={() => {
          void loadNodes(true);
          window.dispatchEvent(new CustomEvent("farmos:node-updated"));
        }}
      />

      <DeviceDetailModal
        isOpen={isDetailModalOpen}
        node={selectedNode}
        onClose={() => {
          setIsDetailModalOpen(false);
          setSelectedNode(null);
        }}
        onEditLocation={(node) => {
          setSelectedNode(node);
          setIsEditLocationOpen(true);
        }}
        onViewQr={(node) => setQrNode(node)}
      />
      <DeviceQrModal node={qrNode} onClose={() => setQrNode(null)} />
    </div>
  );
};
