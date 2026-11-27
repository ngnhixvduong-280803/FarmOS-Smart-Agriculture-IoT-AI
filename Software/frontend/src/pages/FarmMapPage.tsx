import { useLiveRefresh } from "../hooks/useLiveRefresh";
import React, { useState, useEffect, useCallback } from "react";
import {
  Search,
  MapPin,
  Droplets,
  Thermometer,
  Signal,
  Zap,
  RefreshCw,
  Cpu,
  X,
  ChevronRight,
  Sparkles,
  Layers,
  Sun,
  ShieldCheck,
  AlertTriangle,
  Edit3,
} from "lucide-react";
import { useI18n } from "../context/I18nContext";
import { FarmMap } from "../components/FarmMap";
import { EditNodeLocationModal } from "../components/EditNodeLocationModal";
import { IrrigateModal } from "../components/IrrigateModal";
import { fetchMapOverview, triggerManualIrrigation } from "../services/api.service";
import { getStoredMapState, updateStoredMapState } from "../services/map-state.service";
import { FarmItem, NodeDevice, Zone } from "../types";
import { useSocket } from "../hooks/useSocket";

export interface FarmMapPageProps {
  isActive?: boolean;
}

export const FarmMapPage: React.FC<FarmMapPageProps> = ({ isActive = true }) => {
  const { t } = useI18n();
  const [farms, setFarms] = useState<FarmItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<NodeDevice | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isEditLocationOpen, setIsEditLocationOpen] = useState(false);
  const [editingNode, setEditingNode] = useState<NodeDevice | null>(null);
  const [isIrrigateModalOpen, setIsIrrigateModalOpen] = useState(false);
  const [irrigateZone, setIrrigateZone] = useState<Zone | null>(null);

  const applyTelemetry = useCallback((event: any) => {
    const timestamp = new Date(event.timestamp > 10_000_000_000 ? event.timestamp : event.timestamp * 1000).toISOString();
    setFarms((current) => current.map((farm) => farm.id !== event.farmId ? farm : {
      ...farm,
      nodes: farm.nodes?.map((node) => node.id === event.nodeId ? {
        ...node,
        online: true,
        latest_telemetry: { timestamp, soil_moisture: event.soil_moisture, soil_temp: event.soil_temp, air_temp: event.air_temp, air_humidity: event.air_humidity, lux: event.lux },
      } : node),
    }));
  }, []);

  const applyGatewayStatus = useCallback((event: any) => {
    setFarms((current) => current.map((farm) => farm.id !== event.farmId ? farm : {
      ...farm,
      nodes: farm.nodes?.map((node) => node.id === event.nodeId ? { ...node, online: event.online, rssi: event.rssi ?? node.rssi } : node),
    }));
  }, []);

  const loadData = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const data = await fetchMapOverview();
      setFarms(data);

      // Restore saved node selection if navigating back to map tab
      const saved = getStoredMapState();
      if (saved.selectedNodeId) {
        let foundNode: NodeDevice | null = null;
        for (const f of data) {
          if (f.nodes) {
            const match = f.nodes.find((n) => n.id === saved.selectedNodeId);
            if (match) {
              foundNode = { ...match, farm: f };
              break;
            }
          }
        }
        if (foundNode) {
          setSelectedNode(foundNode);
          setIsPanelOpen(true);
        }
      }
    } catch (err: any) {
      console.error("Lỗi tải bản đồ:", err);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadData();
  }, []);

  // Polling and activation effect
  useEffect(() => {
    if (!isActive) return;

    // Check if a node was requested while tab was inactive (e.g. from device modal)
    const saved = getStoredMapState();
    if (saved.selectedNodeId && farms.length > 0) {
      for (const f of farms) {
        if (f.nodes) {
          const match = f.nodes.find((n) => n.id === saved.selectedNodeId);
          if (match) {
            setSelectedNode({ ...match, farm: f });
            setIsPanelOpen(true);
            break;
          }
        }
      }
    }

    // Silent background refresh on tab switch
    void loadData(true);

  }, [isActive, farms.length]);

  // Live values update local state without polling the complete map dataset.
  // A reconnect performs one authoritative reconciliation for missed events.
  useSocket({
    onTelemetry: applyTelemetry,
    onGatewayStatus: applyGatewayStatus,
    onIrrigationStatus: () => undefined,
    onNewAlert: () => undefined,
    onReconnect: () => { void loadData(true); },
  });

  useLiveRefresh(() => loadData(true), isActive);

  // Listen to cross-tab data changes (e.g. node created, location edited, or deleted in other tabs)
  useEffect(() => {
    const handleNodeUpdate = () => {
      void loadData(true);
    };
    window.addEventListener("farmos:node-updated", handleNodeUpdate);
    return () => window.removeEventListener("farmos:node-updated", handleNodeUpdate);
  }, []);

  const handleQuickIrrigate = (node: NodeDevice) => {
    if (node.zone) {
      setIrrigateZone({
        id: node.zone.id,
        name: node.zone.name,
        target_moisture_min: node.zone.target_moisture_min || 40,
        target_moisture_max: node.zone.target_moisture_max || 75,
        valve_id: node.zone.valve_id || "V01",
        crop_type: node.zone.crop_type,
      });
      setIsIrrigateModalOpen(true);
    }
  };

  const handleOpenEditLocation = (node: NodeDevice) => {
    setEditingNode(node);
    setIsEditLocationOpen(true);
  };

  // Flatten all nodes for quick device cycling
  const allNodes: NodeDevice[] = [];
  farms.forEach((f) => {
    if (f.nodes) {
      f.nodes.forEach((n) => allNodes.push({ ...n, farm: f }));
    }
  });

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#0d1b2a] font-sans">
      {/* 1. MAIN FULLSCREEN GOOGLE MAP */}
      <FarmMap
        farms={farms}
        selectedNodeId={selectedNode?.id}
        onSelectNode={(node) => {
          setSelectedNode(node);
          setIsPanelOpen(true);
          updateStoredMapState({ selectedNodeId: node.id, activeSearchPlace: null });
        }}
        onClearNodeSelection={() => {
          setSelectedNode(null);
          setIsPanelOpen(false);
          updateStoredMapState({ selectedNodeId: null });
        }}
        onQuickIrrigate={handleQuickIrrigate}
        height="100%"
        isActive={isActive}
      />

      {/* 2. TOP RIGHT FLOATING CONTROLS: Manual Telemetry Refresh */}
      <div className="absolute top-4 right-4 z-[990] flex items-center gap-2">
        <button
          onClick={() => loadData(false)}
          className="p-2.5 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-2xl transition-all shadow-lg active:scale-95"
          title={t.farmMap.refreshDataTooltip}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin text-emerald-500" : ""}`} />
        </button>
      </div>

      {/* 3. FLOATING LEFT PLACE DETAILS DRAWER (Google Maps Inspector Style) */}
      {selectedNode && isPanelOpen && (
        <div className="absolute top-20 left-4 z-[900] w-80 sm:w-96 max-w-[calc(100vw-2rem)] bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-3xl border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden transition-all animate-in slide-in-from-left duration-200">
          {/* Header Banner */}
          <div className="relative p-5 pb-4 border-b border-slate-100 dark:border-slate-800/80 bg-gradient-to-br from-emerald-50/50 via-white to-transparent dark:from-emerald-950/20 dark:via-slate-900 dark:to-transparent">
            <div className="flex items-start justify-between">
              <div>
                <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 bg-emerald-100/70 dark:bg-emerald-900/40 px-2.5 py-0.5 rounded-full mb-1.5">
                  <Sparkles className="w-3 h-3" />
                  {selectedNode.type}
                </span>
                <h3 className="font-extrabold text-slate-900 dark:text-white text-lg leading-tight">
                  {selectedNode.name || selectedNode.id}
                </h3>
                <p className="text-xs text-slate-500 font-medium mt-0.5">
                  {selectedNode.zone?.name || t.farmMap.unassignedZone} • {selectedNode.farm?.name || t.farmMap.farmDefault}
                </p>
              </div>

              <button
                onClick={() => {
                  setSelectedNode(null);
                  setIsPanelOpen(false);
                  updateStoredMapState({ selectedNodeId: null });
                }}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title={t.farmMap.closeDeviceInfo}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Status Pills */}
            <div className="flex items-center gap-2 mt-3 text-xs">
              <span
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-bold text-[11px] ${
                  selectedNode.online
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    selectedNode.online ? "bg-emerald-500" : "bg-slate-400"
                  }`}
                />
                {selectedNode.online ? t.farmMap.onlineRealtime : t.farmMap.offline}
              </span>

              {selectedNode.latest_telemetry?.soil_moisture != null && !selectedNode.is_simulation && (
                <span
                  className={`px-2.5 py-1 rounded-full font-bold text-[11px] ${
                    selectedNode.latest_telemetry.soil_moisture < 45
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                      : "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                  }`}
                >
                  {selectedNode.latest_telemetry.soil_moisture < 45 ? t.farmMap.needMoisture : t.farmMap.goodMoisture}
                </span>
              )}
            </div>
          </div>

          {/* Telemetry Metrics Grid */}
          <div className="p-5 space-y-3.5 max-h-[calc(100vh-22rem)] overflow-y-auto">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-2xl border border-slate-100 dark:border-slate-800/80 shadow-xs">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
                  <Droplets className="w-4 h-4 text-blue-500" />
                  {t.farmMap.soilMoisture}
                </div>
                <p className="text-2xl font-black text-slate-900 dark:text-white mt-1">
                  {selectedNode.latest_telemetry?.soil_moisture !== undefined
                    ? `${selectedNode.latest_telemetry.soil_moisture}%`
                    : "--"}
                </p>
                <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
                  <div
                    className="bg-blue-500 h-full rounded-full transition-all"
                    style={{ width: `${selectedNode.latest_telemetry?.soil_moisture || 0}%` }}
                  />
                </div>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-2xl border border-slate-100 dark:border-slate-800/80 shadow-xs">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
                  <Thermometer className="w-4 h-4 text-amber-500" />
                  {t.farmMap.airTemp}
                </div>
                <p className="text-2xl font-black text-slate-900 dark:text-white mt-1">
                  {selectedNode.latest_telemetry?.air_temp !== undefined
                    ? `${selectedNode.latest_telemetry.air_temp}°C`
                    : "--"}
                </p>
                <p className="text-[10px] text-slate-400 mt-2">
                  {t.farmMap.soilPrefix}{selectedNode.latest_telemetry?.soil_temp ? `${selectedNode.latest_telemetry.soil_temp}°C` : "--"}
                </p>
              </div>

              <div className="p-3 bg-slate-50 dark:bg-slate-950/60 rounded-2xl border border-slate-100 dark:border-slate-800/80 shadow-xs">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
                  <Signal className="w-4 h-4 text-purple-500" />
                  {t.farmMap.loraSignal}
                </div>
                <p className="text-xl font-bold text-slate-900 dark:text-white mt-1">
                  {selectedNode.rssi ? `${selectedNode.rssi} dBm` : "--"}
                </p>
              </div>
            </div>

            {/* GPS details with Direct Edit Action */}
            <div className="p-3.5 bg-slate-50 dark:bg-slate-950/60 rounded-2xl border border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
              <div>
                <span className="font-semibold text-slate-500 text-xs flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-emerald-500" />
                  {t.farmMap.gpsCoordinates}
                </span>
                <p className="font-bold text-slate-800 dark:text-slate-100 text-xs mt-0.5">
                  {selectedNode.latitude?.toFixed(5) || "10.85488"}, {selectedNode.longitude?.toFixed(5) || "106.78652"}
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleOpenEditLocation(selectedNode)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:hover:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 rounded-xl text-xs font-bold transition-colors border border-emerald-200/60 dark:border-emerald-800/60 shadow-2xs"
                title={t.farmMap.editLocationTooltip}
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>{t.farmMap.editLocation}</span>
              </button>
            </div>

            {/* Quick Irrigate Action Button */}
            {selectedNode.zone && (
              <button
                onClick={() => handleQuickIrrigate(selectedNode)}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white rounded-2xl text-xs font-extrabold shadow-lg shadow-emerald-600/30 transition-all"
              >
                <Zap className="w-4 h-4" />
                <span>{t.farmMap.irrigateZone}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Modals */}

      <EditNodeLocationModal
        isOpen={isEditLocationOpen}
        node={editingNode}
        farms={farms}
        onClose={() => {
          setIsEditLocationOpen(false);
          setEditingNode(null);
        }}
        onSuccess={(updatedNode) => {
          setSelectedNode(updatedNode);
          void loadData(true);
          window.dispatchEvent(new CustomEvent("farmos:node-updated"));
        }}
      />

      {irrigateZone && (
        <IrrigateModal
          isOpen={isIrrigateModalOpen}
          zone={irrigateZone}
          onClose={() => setIsIrrigateModalOpen(false)}
          onConfirm={async (zoneId, durationSec, reason) => {
            const result = await triggerManualIrrigation({
              zoneId,
              durationSec,
              reason,
            });
            if (!result.success) throw new Error(result.error || result.message);
            await loadData(true);
            window.dispatchEvent(new CustomEvent("farmos:node-updated"));
          }}
        />
      )}
    </div>
  );
};
