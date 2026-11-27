import React, { useEffect, useState } from "react";
import {
  Activity,
  Check,
  Compass,
  Copy,
  Cpu,
  Droplets,
  Info,
  MapPin,
  QrCode,
  Radio,
  Signal,
  Sun,
  Thermometer,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { NodeDevice } from "../types";
import { useI18n } from "../context/I18nContext";
import { DevicePumpControl } from "./DevicePumpControl";
import { updateStoredMapState } from "../services/map-state.service";
import { checkFirmwareUpdate, OtaCheckResponse } from "../services/api.service";

interface DeviceDetailModalProps {
  isOpen: boolean;
  node: NodeDevice | null;
  onClose: () => void;
  onEditLocation: (node: NodeDevice) => void;
  onViewQr?: (node: NodeDevice) => void;
}

export const DeviceDetailModal: React.FC<DeviceDetailModalProps> = ({
  isOpen,
  node,
  onClose,
  onEditLocation,
  onViewQr,
}) => {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [otaInfo, setOtaInfo] = useState<OtaCheckResponse | null>(null);
  const [checkingOta, setCheckingOta] = useState(false);

  useEffect(() => {
    if (!isOpen || !node) {
      setOtaInfo(null);
      return;
    }

    let isCurrent = true;
    const currentVersion = node.firmware_version?.trim();
    if (!currentVersion || node.is_simulation) {
      setOtaInfo(null);
      setCheckingOta(false);
      return () => {
        isCurrent = false;
      };
    }

    setCheckingOta(true);
    checkFirmwareUpdate(
      node.type === "GATEWAY" ? "GATEWAY" : "SENSOR_NODE",
      currentVersion,
      node.id,
    )
      .then((response) => {
        if (isCurrent) setOtaInfo(response);
      })
      .catch(() => {
        if (isCurrent) setOtaInfo(null);
      })
      .finally(() => {
        if (isCurrent) setCheckingOta(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [isOpen, node]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen || !node) return null;

  const isGateway = node.type === "GATEWAY";
  const telemetry = node.latest_telemetry;
  const ownerName = node.owner?.name?.trim() || node.owner?.email || t.modals.unassigned;
  const hasCoordinates = node.latitude != null && node.longitude != null;
  const deploymentName = !node.is_activated
    ? t.modals.unassignedNetwork
    : isGateway
      ? t.modals.centralGateway
      : node.gateway
        ? node.gateway.name || node.gateway.id
        : t.modals.directConnection;

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    window.setTimeout(() => setCopiedField(null), 1800);
  };

  const formatTimestamp = (value?: string | null) => {
    if (!value) return t.modals.notRecorded;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(language === "vi" ? "vi-VN" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  };

  const getMoistureStatus = () => {
    if (!telemetry || telemetry.soil_moisture == null || node.is_simulation) return null;
    const minimum = node.zone?.target_moisture_min ?? 50;
    const maximum = node.zone?.target_moisture_max ?? 75;
    if (telemetry.soil_moisture < minimum) {
      return {
        label: t.modals.moistureLow,
        className:
          "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300",
      };
    }
    if (telemetry.soil_moisture > maximum) {
      return {
        label: t.modals.moistureHigh,
        className:
          "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300",
      };
    }
    return {
      label: t.modals.moistureOptimal,
      className:
        "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300",
    };
  };

  const moistureStatus = getMoistureStatus();
  const metricCards = telemetry
    ? [
        telemetry.soil_moisture != null ? {
          label: t.modals.soilMoisture,
          value: `${Number(telemetry.soil_moisture.toFixed(2))}%${node.is_simulation ? " VWC" : ""}`,
          hint: node.is_simulation ? "Độ ẩm thể tích từ mô hình đất" : node.zone
            ? t.modals.targetMoistureRange
                .replace("{min}", String(node.zone.target_moisture_min ?? 50))
                .replace("{max}", String(node.zone.target_moisture_max ?? 75))
            : t.modals.noTargetRange,
          icon: Droplets,
          accent: "text-sky-600 dark:text-sky-300",
        } : null,
        telemetry.air_temp != null
          ? {
              label: t.modals.airTemp,
              value: `${Number(telemetry.air_temp.toFixed(2))}°C`,
              hint: t.modals.airHint,
              icon: Thermometer,
              accent: "text-amber-600 dark:text-amber-300",
            }
          : null,
        telemetry.air_humidity != null
          ? {
              label: t.modals.airHumidity,
              value: `${Number(telemetry.air_humidity.toFixed(2))}%`,
              hint: t.modals.airHint,
              icon: Droplets,
              accent: "text-sky-600 dark:text-sky-300",
            }
          : null,
        telemetry.soil_temp != null
          ? {
              label: t.modals.soilTemp,
              value: `${Number(telemetry.soil_temp.toFixed(2))}°C`,
              hint: t.modals.rootZoneHint,
              icon: Thermometer,
              accent: "text-amber-600 dark:text-amber-300",
            }
          : null,
        telemetry.lux != null
          ? {
              label: t.modals.lightIntensity,
              value: `${Math.round(telemetry.lux)} Lux`,
              hint: t.modals.luminousFluxHint,
              icon: Sun,
              accent: "text-amber-600 dark:text-amber-300",
            }
          : null,
      ].filter(Boolean)
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex bg-slate-950/35 backdrop-blur-[2px] animate-fade-in"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t.modals.deviceDetailsTitle.replace("{name}", node.name || node.id)}
        className="ml-auto flex min-h-[100dvh] w-full max-w-2xl flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
      >
        <header className="border-b border-slate-200 bg-slate-50/80 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/40 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <div
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${
                  isGateway
                    ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                }`}
              >
                {isGateway ? (
                  <Radio className="h-5 w-5" />
                ) : (
                  <Cpu className="h-5 w-5" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold tracking-tight text-slate-950 dark:text-white">
                    {node.name || node.id}
                  </h2>
                  <span className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    {isGateway ? t.modals.gatewayBadge : t.modals.sensorBadge}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {node.is_simulation && <span className="rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-[10px] font-medium text-sky-700">Mô phỏng</span>}
                  <span
                    className={`inline-flex items-center rounded-md border px-2 py-1 text-[10px] font-medium ${
                      node.is_activated
                        ? "border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                        : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                    }`}
                  >
                    {node.is_activated ? t.modals.activated : t.modals.inInventory}
                  </span>
                  {node.is_activated && (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium ${
                        node.online
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                          : "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${node.online ? "bg-emerald-500" : "bg-slate-400"}`}
                      />
                      {node.online ? t.nodesPage.online : t.nodesPage.offline}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="icon-action shrink-0"
              aria-label={t.modals.closeDeviceDetailsAria}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-[11px] text-slate-500 dark:text-slate-400">
            <button
              type="button"
              onClick={() => handleCopy(node.id, "device-id")}
              className="inline-flex items-center gap-1.5 transition hover:text-slate-900 dark:hover:text-white"
              title={t.modals.copyDeviceId}
            >
              <span className="font-mono">{node.id}</span>
              {copiedField === "device-id" ? (
                <Check className="h-3 w-3 text-emerald-600" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
            {node.serial_number && (
              <button
                type="button"
                onClick={() => handleCopy(node.serial_number!, "serial-number")}
                className="inline-flex items-center gap-1.5 transition hover:text-slate-900 dark:hover:text-white"
                title={t.modals.copySerial}
              >
                <span className="font-mono">SN {node.serial_number}</span>
                {copiedField === "serial-number" ? (
                  <Check className="h-3 w-3 text-emerald-600" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {node.is_activated && !node.is_simulation && (
            <DevicePumpControl key={node.id} nodeId={node.id} />
          )}
          <div className="grid overflow-hidden rounded-xl border border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800 sm:grid-cols-2">
            <div className="bg-white px-4 py-3 dark:bg-slate-900">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                {t.modals.networkLink}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <Signal className="h-3.5 w-3.5 text-slate-400" />
                <span className="truncate">{deploymentName}</span>
              </div>
            </div>
            <div className="bg-white px-4 py-3 dark:bg-slate-900">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                {t.modals.signal}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <Activity
                  className={`h-3.5 w-3.5 ${node.rssi != null ? "text-emerald-600 dark:text-emerald-300" : "text-slate-400"}`}
                />
                {node.rssi != null ? `${node.rssi} dBm` : t.modals.notRecorded}
              </div>
            </div>
            <div className="border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                {t.modals.firmware}
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
                <span className="font-mono">
                  {node.firmware_version || t.modals.unknown}
                </span>
                {checkingOta && (
                  <span className="text-[10px] font-medium text-slate-400">
                    {t.modals.checking}
                  </span>
                )}
                {otaInfo?.updateAvailable && (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    {t.modals.hasNewUpdate}
                  </span>
                )}
              </div>
            </div>
            <div className="border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900 sm:border-l">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                {t.modals.latestData}
              </div>
              <div className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">
                {formatTimestamp(telemetry?.timestamp || node.last_seen)}
              </div>
            </div>
          </div>

          <section className="mt-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                  {t.modals.environment}
                </h3>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {t.modals.latestMetrics}
                </p>
              </div>
              {moistureStatus && (
                <span
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium ${moistureStatus.className}`}
                >
                  {moistureStatus.label}
                </span>
              )}
            </div>

            {node.is_simulation && (
              <div className="mb-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-slate-700 dark:border-sky-800 dark:bg-slate-900 dark:text-slate-200">
                <p className="font-semibold">Thiết bị mô phỏng · Dữ liệu tổng hợp</p>
                {node.simulation ? <div className="mt-2 space-y-1 break-all">
                  <p>Server đã nhận: {formatTimestamp(node.simulation.received_at)}</p>
                  <p>Thời gian mô phỏng: {formatTimestamp(node.simulation.simulated_at)}</p>
                  <p>Bản tin: {node.simulation.event_id}</p>
                  <p>Mẫu lưu: {node.simulation.sample_id}</p>
                  {isGateway ? <p>Đã chuyển tiếp từ node: {node.simulation.source_node_id}</p> : <p>Cây: {node.simulation.context.cropId} · pH: {node.simulation.context.ph ?? "—"} · EC: {node.simulation.context.eceDsM ?? "—"} dS/m</p>}
                </div> : <p className="mt-1">Chưa có bản tin được server xác nhận.</p>}
              </div>
            )}

            {telemetry ? (
              <div className="grid grid-cols-2 gap-2.5">
                {metricCards.map((metric) => {
                  if (!metric) return null;
                  const Icon = metric.icon;
                  return (
                    <div
                      key={metric.label}
                      className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/40"
                    >
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        <Icon className={`h-3.5 w-3.5 ${metric.accent}`} />
                        {metric.label}
                      </div>
                      <div className="mt-2 text-lg font-semibold tracking-tight text-slate-950 dark:text-white">
                        {metric.value}
                      </div>
                      <div className="mt-1 text-[10px] text-slate-400">
                        {metric.hint}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                <span>
                  {t.modals.noRecentTelemetry}
                </span>
              </div>
            )}
          </section>

          <section className="mt-6">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                {t.modals.assignmentAndLocation}
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-400">
                {t.modals.ownerAndZone}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800">
              <div className="grid gap-px bg-slate-200 dark:bg-slate-800 sm:grid-cols-2">
                <div className="bg-white p-3.5 dark:bg-slate-900">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    {t.modals.owner}
                  </div>
                  <div className="mt-1 truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                    {ownerName}
                  </div>
                  {node.owner?.name && (
                    <div className="mt-0.5 truncate text-[10px] text-slate-400">
                      {node.owner.email}
                    </div>
                  )}
                </div>
                <div className="bg-white p-3.5 dark:bg-slate-900">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    {t.modals.farm}
                  </div>
                  <div className="mt-1 truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                    {node.farm?.name || t.modals.unassigned}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-slate-400">
                    {node.zone?.name || t.modals.unassignedZoneDetail}
                  </div>
                </div>
                <div className="border-t border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    {t.modals.crop}
                  </div>
                  <div className="mt-1 truncate text-xs font-semibold text-slate-800 dark:text-slate-100">
                    {node.zone?.crop_type || t.modals.unregisteredCrop}
                  </div>
                </div>
                <div className="border-t border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900 sm:border-l">
                  <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    <span>{t.modals.gpsCoordinates}</span>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onEditLocation(node);
                      }}
                      className="normal-case text-emerald-700 hover:text-emerald-800 dark:text-emerald-300"
                    >
                      {hasCoordinates ? t.modals.editGpsShort : t.modals.assignGpsShort}
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-100">
                    <MapPin className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
                    {hasCoordinates
                      ? `${node.latitude!.toFixed(6)}, ${node.longitude!.toFixed(6)}`
                      : t.modals.unlocated}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <details className="mt-5 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <summary className="cursor-pointer list-none px-4 py-3 text-xs font-semibold text-slate-700 marker:hidden dark:text-slate-200">
              {t.modals.technicalInfo}
            </summary>
            <div className="border-t border-slate-200 px-4 py-3 text-[11px] dark:border-slate-800">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-slate-400">{t.modals.deploymentMethod}</div>
                  <div className="mt-0.5 font-medium text-slate-700 dark:text-slate-200">
                    {node.deployment_mode || t.modals.unknown}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">{t.modals.linkedGateway}</div>
                  <div className="mt-0.5 truncate font-medium text-slate-700 dark:text-slate-200">
                    {node.gateway?.name ||
                      node.gateway?.id ||
                      (isGateway ? t.modals.thisIsGateway : t.modals.none)}
                  </div>
                </div>
                {otaInfo?.updateAvailable && (
                  <div className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                    {isGateway
                      ? t.modals.otaAvailableGateway.replace("{version}", otaInfo.latestRelease?.version || "")
                      : t.modals.otaAvailableBle.replace("{version}", otaInfo.latestRelease?.version || "")}
                  </div>
                )}
              </div>
            </div>
          </details>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50/80 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/40 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          {onViewQr && <button type="button" onClick={() => onViewQr(node)} className="action action-light w-full sm:w-auto">
            <QrCode className="h-3.5 w-3.5" />{t.nodesPage.qrTitle}
          </button>}
          <button
            type="button"
            onClick={() => {
              updateStoredMapState({
                selectedNodeId: node.id,
                activeSearchPlace: null,
              });
              onClose();
              navigate("/map");
            }}
            className="action action-light w-full sm:w-auto"
          >
            <Compass className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
            {t.modals.viewOnMap}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onClose();
                onEditLocation(node);
              }}
              className="action action-green flex-1 sm:flex-none"
            >
              <MapPin className="h-3.5 w-3.5" />
              {hasCoordinates ? t.modals.editGps : t.modals.locateGps}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="action action-dark flex-1 sm:flex-none"
            >
              {t.modals.closeDetail}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
};
