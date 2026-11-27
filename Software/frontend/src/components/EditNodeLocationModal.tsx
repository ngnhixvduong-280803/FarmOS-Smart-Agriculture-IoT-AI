import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  X,
  MapPin,
  Navigation,
  Check,
  AlertCircle,
  Loader2,
  Radio,
  Cpu,
  Save,
  Compass,
  Maximize2,
  Minimize2,
  Info,
} from "lucide-react";
import { FarmMap } from "./FarmMap";
import { updateNodeLocation, fetchMapOverview } from "../services/api.service";
import { getStoredMapState, updateStoredMapState } from "../services/map-state.service";
import { NodeDevice, FarmItem } from "../types";
import { getCurrentPositionWithFallback, getFriendlyGpsErrorMessage } from "../services/geolocation.service";
import { useI18n } from "../context/I18nContext";

interface EditNodeLocationModalProps {
  isOpen: boolean;
  node: NodeDevice | null;
  farms?: FarmItem[];
  onClose: () => void;
  onSuccess: (updatedNode: NodeDevice) => void;
}

export const EditNodeLocationModal: React.FC<EditNodeLocationModalProps> = ({
  isOpen,
  node,
  farms,
  onClose,
  onSuccess,
}) => {
  const { t } = useI18n();
  const defaultLat = 10.854886;
  const defaultLng = 106.786523;

  const [farmsList, setFarmsList] = useState<FarmItem[]>(farms || []);
  const [latitude, setLatitude] = useState<number>(defaultLat);
  const [longitude, setLongitude] = useState<number>(defaultLng);
  const [latInput, setLatInput] = useState<string>(defaultLat.toString());
  const [lngInput, setLngInput] = useState<string>(defaultLng.toString());
  const [isNewPlacement, setIsNewPlacement] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [loadingGps, setLoadingGps] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);

  // Sync or fetch full map overview (farms + all nodes) for context
  useEffect(() => {
    if (!isOpen) return;

    if (farms && farms.length > 0) {
      setFarmsList(farms);
    } else {
      let isMounted = true;
      fetchMapOverview()
        .then((data) => {
          if (isMounted && data && data.length > 0) {
            setFarmsList(data);
          }
        })
        .catch((err) => {
          console.warn("Không thể tải tổng quan trang trại cho picker:", err);
        });
      return () => {
        isMounted = false;
      };
    }
  }, [isOpen, farms]);

  // Find target farm that this node belongs to
  const targetFarm = useMemo(() => {
    if (!node) return null;
    const byId = farmsList.find((f) => f.id === node.farm_id || f.id === node.farm?.id);
    if (byId) return byId;
    if (farmsList.length > 0) return farmsList[0];
    return node.farm || null;
  }, [node, farmsList]);

  // Initialize coordinates when modal opens or node changes
  useEffect(() => {
    if (!node || !isOpen) return;

    setError(null);
    setGpsStatus(null);

    const hasCoords =
      node.latitude != null &&
      node.longitude != null &&
      !Number.isNaN(Number(node.latitude)) &&
      !Number.isNaN(Number(node.longitude)) &&
      (Number(node.latitude) !== 0 || Number(node.longitude) !== 0);

    if (hasCoords) {
      const lat = Number(node.latitude);
      const lng = Number(node.longitude);
      setLatitude(lat);
      setLongitude(lng);
      setLatInput(lat.toFixed(6));
      setLngInput(lng.toFixed(6));
      setIsNewPlacement(false);
    } else {
      setIsNewPlacement(true);
      const saved = getStoredMapState();
      let initLat = defaultLat;
      let initLng = defaultLng;

      // Smart initial centering:
      // 1. Target Farm coordinates
      // 2. Or first node with coordinates on this farm
      // 3. Or session map center
      // 4. Or user location
      // 5. Default HCMC
      const farmItem = targetFarm as FarmItem | null;
      if (targetFarm?.latitude && targetFarm?.longitude) {
        initLat = targetFarm.latitude;
        initLng = targetFarm.longitude;
      } else if (farmItem?.nodes && farmItem.nodes.length > 0) {
        const withCoords = farmItem.nodes.find((n) => n.latitude && n.longitude);
        if (withCoords?.latitude && withCoords?.longitude) {
          initLat = withCoords.latitude;
          initLng = withCoords.longitude;
        }
      } else if (saved?.center) {
        initLat = saved.center[1];
        initLng = saved.center[0];
      } else if (saved?.userLocation) {
        initLat = saved.userLocation.lat;
        initLng = saved.userLocation.lng;
      }

      setLatitude(initLat);
      setLongitude(initLng);
      setLatInput(initLat.toFixed(6));
      setLngInput(initLng.toFixed(6));

      if (targetFarm?.name) {
        setGpsStatus(t.modals.autoCenterTarget.replace("{name}", targetFarm.name));
      }
    }
  }, [node, isOpen, targetFarm, t]);

  // Handle location update from map click or drag
  const handleLocationSelect = useCallback((lat: number, lng: number) => {
    setLatitude(lat);
    setLongitude(lng);
    setLatInput(lat.toFixed(6));
    setLngInput(lng.toFixed(6));
    setError(null);
  }, []);

  // Center on Farm Center
  const handleCenterOnFarm = () => {
    if (targetFarm?.latitude && targetFarm?.longitude) {
      handleLocationSelect(targetFarm.latitude, targetFarm.longitude);
      setGpsStatus(t.modals.centeredOnFarm.replace("{name}", targetFarm.name));
    } else {
      const saved = getStoredMapState();
      if (saved.center) {
        handleLocationSelect(saved.center[1], saved.center[0]);
        setGpsStatus(t.modals.centeredOnMap);
      }
    }
  };

  // Get current device GPS via Geolocation with automatic fallback
  const handleGetCurrentGps = async () => {
    if (!navigator.geolocation) {
      setError(t.modals.browserGpsNotSupported);
      return;
    }

    setLoadingGps(true);
    setError(null);
    setGpsStatus(t.modals.gettingGps);

    try {
      const pos = await getCurrentPositionWithFallback({
        highAccuracyTimeout: 7000,
        lowAccuracyTimeout: 12000,
        maximumAge: 30000,
      });

      handleLocationSelect(pos.latitude, pos.longitude);
      setLoadingGps(false);
      setGpsStatus(
        pos.isFallbackLowAccuracy
          ? t.modals.gpsFallbackSuccess.replace("{acc}", String(Math.round(pos.accuracy)))
          : t.modals.gpsAccurateSuccess.replace("{acc}", String(Math.round(pos.accuracy)))
      );
    } catch (err: any) {
      setLoadingGps(false);
      setGpsStatus(null);
      setError(err.message || getFriendlyGpsErrorMessage(err || { code: 3 }));
    }
  };

  // Manual coordinate input handlers
  const handleLatInputChange = (val: string) => {
    setLatInput(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed >= -90 && parsed <= 90) {
      setLatitude(parsed);
    }
  };

  const handleLngInputChange = (val: string) => {
    setLngInput(val);
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed >= -180 && parsed <= 180) {
      setLongitude(parsed);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!node) return;

    try {
      setSaving(true);
      setError(null);

      const updated = await updateNodeLocation(node.id, {
        latitude,
        longitude,
      });

      // Synchronize with stored map state so switching to /map centers on this device
      updateStoredMapState({
        selectedNodeId: node.id,
        center: [longitude, latitude],
      });

      onSuccess(updated);
      onClose();
    } catch (err: any) {
      setError(err.message || t.modals.updateLocationError);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen || !node) return null;

  // Prepare farms list with fallback
  const mapFarms: FarmItem[] =
    farmsList.length > 0
      ? farmsList
      : targetFarm
      ? [{ ...targetFarm, latitude, longitude }]
      : [{ id: "F01", name: t.modals.defaultFarmText, latitude, longitude }];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-2 sm:p-4 overflow-y-auto font-sans animate-fade-in">
      <div
        className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl shadow-2xl transition-all flex flex-col ${
          isFullscreen
            ? "fixed inset-2 sm:inset-4 max-w-none w-[calc(100vw-1rem)] sm:w-[calc(100vw-2rem)] h-[calc(100vh-1rem)] sm:h-[calc(100vh-2rem)] my-0 p-5 overflow-hidden"
            : "max-w-4xl w-full p-5 sm:p-6 my-6 max-h-[94vh]"
        }`}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between pb-3.5 border-b border-slate-200 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div
              className={`w-11 h-11 rounded-2xl flex items-center justify-center shadow-xs shrink-0 ${
                node.type === "GATEWAY"
                  ? "bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400"
                  : "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {node.type === "GATEWAY" ? <Radio className="w-5 h-5" /> : <Cpu className="w-5 h-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  {t.modals.editGpsTitle}
                </h3>
                {isNewPlacement && (
                  <span className="px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 text-[10px] font-extrabold uppercase tracking-wide">
                    {t.modals.unassignedGpsBadge}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 font-medium mt-0.5 flex items-center gap-1.5 flex-wrap">
                <span className="font-bold text-slate-700 dark:text-slate-300">
                  {node.name || node.id}
                </span>
                <span>•</span>
                <span className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 rounded font-semibold text-[11px]">
                  {node.type}
                </span>
                <span>•</span>
                <span>{node.zone?.name || t.modals.unassignedZoneText}</span>
                <span>•</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                  {targetFarm?.name || node.farm?.name || t.modals.defaultFarmText}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Toggle Fullscreen button */}
            <button
              type="button"
              onClick={() => setIsFullscreen((prev) => !prev)}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={isFullscreen ? t.modals.fullscreenMinimize : t.modals.fullscreenMaximize}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t.modals.closeModal}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mt-3 p-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-2xl flex items-center gap-2.5 text-rose-700 dark:text-rose-400 text-xs font-semibold shrink-0">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0 space-y-3 mt-3">
          {/* Action Bar: GPS Button & Farm Centering Info */}
          <div className="p-3 bg-slate-50 dark:bg-slate-950/70 border border-slate-200 dark:border-slate-800/80 rounded-2xl flex flex-wrap items-center justify-between gap-2.5 shrink-0">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-emerald-100 dark:bg-emerald-950/60 rounded-xl text-emerald-600 shrink-0">
                <MapPin className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                  {t.modals.syncGpsSubtitle}
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  {t.modals.syncGpsHint}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* Center on Farm Center */}
              {targetFarm && (
                <button
                  type="button"
                  onClick={handleCenterOnFarm}
                  className="flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-95 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-bold transition-all shadow-xs"
                  title={`Đưa góc nhìn về trung tâm: ${targetFarm.name}`}
                >
                  <Compass className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <span>{t.modals.centerOnFarmBtn}</span>
                </button>
              )}

              {/* Get Device GPS */}
              <button
                type="button"
                onClick={handleGetCurrentGps}
                disabled={loadingGps}
                className="flex items-center gap-2 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-emerald-600/20 disabled:opacity-50"
              >
                {loadingGps ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Navigation className="w-4 h-4" />
                )}
                <span>{t.modals.getMyDeviceGpsBtn}</span>
              </button>
            </div>
          </div>

          {/* GPS Success Status */}
          {gpsStatus && (
            <div className="p-2 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-800/60 rounded-xl text-xs text-emerald-700 dark:text-emerald-300 font-semibold flex items-center gap-2 shrink-0">
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{gpsStatus}</span>
            </div>
          )}

          {/* Coordinates Inputs */}
          <div className="grid grid-cols-2 gap-3 shrink-0">
            <div>
              <label className="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-1">
                {t.modals.latInputLabel}
              </label>
              <input
                type="number"
                step="any"
                required
                value={latInput}
                onChange={(e) => handleLatInputChange(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-xs font-bold font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
                placeholder={t.modals.latPlaceholder}
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-1">
                {t.modals.lngInputLabel}
              </label>
              <input
                type="number"
                step="any"
                required
                value={lngInput}
                onChange={(e) => handleLngInputChange(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-xs font-bold font-mono focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
                placeholder={t.modals.lngPlaceholder}
              />
            </div>
          </div>

          {/* Interactive Satellite Picker Map - Enlarged & Spacious */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-1.5 shrink-0">
              <span className="text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <span>{t.modals.satelliteMapTitle}</span>
                <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">
                  {t.modals.syncSystemBadge}
                </span>
              </span>
              <span className="text-[11px] text-slate-400 font-medium">
                {t.modals.dragPinHint}
              </span>
            </div>

            {/* Map Container - Dynamic height or flex-1 in Fullscreen */}
            <div
              className={`w-full rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 shadow-inner relative transition-all ${
                isFullscreen ? "flex-1 min-h-[420px]" : "h-[420px] sm:h-[480px]"
              }`}
            >
              <FarmMap
                farms={mapFarms}
                pickerMode={true}
                editingNodeId={node.id}
                pickerCoords={{ lat: latitude, lng: longitude }}
                onLocationSelect={handleLocationSelect}
                height="100%"
                isActive={isOpen}
              />
            </div>
          </div>

          {/* Modal Footer Actions */}
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-800 shrink-0">
            <div className="hidden sm:flex items-center gap-1.5 text-slate-400 text-xs font-medium">
              <Info className="w-3.5 h-3.5" />
              <span>{t.modals.syncedNotice}</span>
            </div>

            <div className="flex items-center gap-3 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors"
              >
                {t.modals.cancelBtn}
              </button>

              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-bold rounded-xl shadow-lg shadow-emerald-600/30 transition-all disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>{t.modals.savingLocation}</span>
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    <span>{t.modals.saveGpsLocationBtn}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
