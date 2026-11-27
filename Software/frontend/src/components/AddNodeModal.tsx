import React, { useState, useEffect } from "react";
import { X, MapPin, Navigation, Cpu, Check, AlertCircle, Loader2 } from "lucide-react";
import { FarmMap } from "./FarmMap";
import { claimNode, fetchZones, fetchMe, fetchNodes, fetchMapOverview } from "../services/api.service";
import { Zone, FarmItem, NodeDevice } from "../types";
import { getCurrentPositionWithFallback, getFriendlyGpsErrorMessage } from "../services/geolocation.service";
import { useI18n } from "../context/I18nContext";

interface AddNodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (node: NodeDevice) => void;
}

export const AddNodeModal: React.FC<AddNodeModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const { t } = useI18n();
  const [nodeId, setNodeId] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("SENSOR_NODE");
  const [farmId, setFarmId] = useState("F01");
  const [zoneId, setZoneId] = useState("");
  const [gatewayId, setGatewayId] = useState("");
  const [latitude, setLatitude] = useState<number>(10.854886);
  const [longitude, setLongitude] = useState<number>(106.786523);

  const [zones, setZones] = useState<Zone[]>([]);
  const [farms, setFarms] = useState<FarmItem[]>([]);
  const [availableGateways, setAvailableGateways] = useState<NodeDevice[]>([]);
  const [loadingGps, setLoadingGps] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gpsStatus, setGpsStatus] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadInitialData();
    }
  }, [isOpen]);

  const loadInitialData = async () => {
    try {
      const [zonesData, userData, allNodes, mapFarms] = await Promise.all([
        fetchZones().catch(() => []),
        fetchMe().catch(() => null),
        fetchNodes().catch(() => []),
        fetchMapOverview().catch(() => []),
      ]);
      setZones(zonesData);
      if (zonesData.length > 0) {
        setZoneId(zonesData[0].id);
      }
      const gws = allNodes.filter((n) => n.type === "GATEWAY");
      setAvailableGateways(gws);
      if (gws.length > 0) {
        setGatewayId(gws[0].id);
      }
      if (mapFarms && mapFarms.length > 0) {
        setFarms(mapFarms);
        setFarmId(mapFarms[0].id);
        if (mapFarms[0].latitude && mapFarms[0].longitude) {
          setLatitude(mapFarms[0].latitude);
          setLongitude(mapFarms[0].longitude);
        }
      } else if (userData?.farms && userData.farms.length > 0) {
        setFarms(userData.farms);
        setFarmId(userData.farms[0].id);
        if (userData.farms[0].latitude && userData.farms[0].longitude) {
          setLatitude(userData.farms[0].latitude);
          setLongitude(userData.farms[0].longitude);
        }
      }
    } catch (err: any) {
      console.error("Lỗi tải dữ liệu ban đầu:", err);
    }
  };

  // Lấy tọa độ GPS thiết bị người dùng qua Geolocation API với fallback tự động
  const handleGetCurrentGps = async () => {
    if (!navigator.geolocation) {
      setError("Trình duyệt của bạn không hỗ trợ định vị GPS Geolocation.");
      return;
    }

    setLoadingGps(true);
    setError(null);
    setGpsStatus("Đang định vị vệ tinh GPS...");

    try {
      const pos = await getCurrentPositionWithFallback({
        highAccuracyTimeout: 7000,
        lowAccuracyTimeout: 12000,
        maximumAge: 30000,
      });

      setLatitude(pos.latitude);
      setLongitude(pos.longitude);
      setLoadingGps(false);
      setGpsStatus(
        pos.isFallbackLowAccuracy
          ? `✅ Đã lấy tọa độ vị trí (Ước tính qua mạng: ±${Math.round(pos.accuracy)}m)`
          : `✅ Đã lấy tọa độ GPS chính xác (Sai số: ±${Math.round(pos.accuracy)}m)`
      );
    } catch (err: any) {
      setLoadingGps(false);
      setGpsStatus(null);
      setError(err.message || getFriendlyGpsErrorMessage(err || { code: 3 }));
    }
  };

  const handleLocationSelect = (lat: number, lng: number) => {
    setLatitude(lat);
    setLongitude(lng);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nodeId.trim()) {
      setError("Vui lòng nhập Mã Node hoặc Số Serial của thiết bị");
      return;
    }
    if (!claimCode.trim()) {
      setError("Vui lòng nhập mã sở hữu trên QR thiết bị");
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      const created = await claimNode({
        nodeId: nodeId.trim(),
        serialNumber: nodeId.trim(),
        claimCode: claimCode.trim(),
        name: name.trim() || nodeId.trim(),
        farmId,
        zoneId: zoneId || undefined,
        gatewayId: type === "SENSOR_NODE" ? (gatewayId || undefined) : undefined,
        type,
        latitude,
        longitude,
      });

      onSuccess(created);
      onClose();
    } catch (err: any) {
      setError(err.message || "Lỗi khi kích hoạt thiết bị");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto font-sans animate-fade-in">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-2xl w-full p-5 sm:p-6 shadow-xl my-8 animate-fade-in-scale">
        <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 flex items-center justify-center shrink-0">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">{t.modals.addNodeTitle}</h3>
              <p className="text-xs text-slate-500">{t.modals.addNodeSubtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-xl flex items-center gap-2 text-rose-700 dark:text-rose-400 text-sm">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t.modals.nodeIdLabel}
              </label>
              <input
                type="text"
                value={nodeId}
                onChange={(e) => setNodeId(e.target.value)}
                placeholder={t.modals.nodeIdPlaceholder}
                required
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                {t.modals.nodeIdHint}
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t.modals.claimCodeLabel}
              </label>
              <input
                type="password"
                value={claimCode}
                onChange={(e) => setClaimCode(e.target.value)}
                placeholder={t.modals.claimCodePlaceholder}
                required
                autoComplete="off"
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
              />
              <p className="text-[10px] text-slate-500 mt-1">
                {t.modals.claimCodeHint}
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t.modals.friendlyNameLabel}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.modals.friendlyNamePlaceholder}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t.modals.deviceTypeSelectLabel}
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
              >
                <option value="SENSOR_NODE">{t.modals.sensorNodeOption}</option>
                <option value="GATEWAY">{t.modals.gatewayOption}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t.modals.assignFarmLabel}
              </label>
              <select
                value={farmId}
                onChange={(e) => setFarmId(e.target.value)}
                required
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
              >
                {farms.length > 0 ? (
                  farms.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({f.location || f.address || f.id})
                    </option>
                  ))
                ) : (
                  <option value={farmId}>{t.modals.mainFarmOption.replace("{{id}}", farmId)}</option>
                )}
              </select>
            </div>

            {type === "SENSOR_NODE" && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {t.modals.assignGatewayLabel}
                </label>
                <select
                  value={gatewayId}
                  onChange={(e) => setGatewayId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
                >
                  <option value="">{t.modals.autoAssignGateway}</option>
                  {availableGateways
                    .filter((g) => g.farm_id === farmId || !g.farm_id)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name || g.id} ({g.id})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t.modals.assignZoneLabel}
              </label>
              <select
                value={zoneId}
                onChange={(e) => setZoneId(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-none dark:text-white"
              >
                <option value="">{t.modals.unassignedZone}</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} ({z.crop_type || "Cây trồng"})
                  </option>
                ))}
              </select>
            </div>
          </div>


          {/* GPS Location Section */}
          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800 dark:text-slate-200">
                <MapPin className="w-4 h-4 text-emerald-500" />
                {t.modals.nodeGpsSectionTitle}
              </div>

              <button
                type="button"
                onClick={handleGetCurrentGps}
                disabled={loadingGps}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 dark:text-emerald-300 rounded-lg text-xs font-semibold transition-colors shadow-sm disabled:opacity-50"
              >
                {loadingGps ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                {t.modals.getCurrentGpsBtn}
              </button>
            </div>

            {gpsStatus && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 mb-2 font-medium">{gpsStatus}</p>
            )}

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-[11px] text-slate-500 mb-0.5">{t.modals.latitudeLabel}</label>
                <input
                  type="number"
                  step="any"
                  value={latitude}
                  onChange={(e) => setLatitude(parseFloat(e.target.value) || 0)}
                  className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-xs dark:text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-500 mb-0.5">{t.modals.longitudeLabel}</label>
                <input
                  type="number"
                  step="any"
                  value={longitude}
                  onChange={(e) => setLongitude(parseFloat(e.target.value) || 0)}
                  className="w-full px-2.5 py-1.5 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg text-xs dark:text-white"
                />
              </div>
            </div>

            {/* Mini Map Picker */}
            <p className="text-[11px] text-slate-500 mb-1">
              {t.modals.mapPinHint}
            </p>
            <div className="h-72 w-full rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 shadow-inner">
              <FarmMap
                farms={farms.length > 0 ? farms : [{ id: farmId, name: "Farm", latitude, longitude }]}
                pickerMode={true}
                pickerCoords={{ lat: latitude, lng: longitude }}
                onLocationSelect={handleLocationSelect}
                height="100%"
                isActive={isOpen}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            >
              {t.modals.cancel}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-slate-900 hover:bg-slate-800 dark:bg-emerald-600 dark:hover:bg-emerald-700 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t.modals.activating}</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>{t.modals.activateAndSave}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
