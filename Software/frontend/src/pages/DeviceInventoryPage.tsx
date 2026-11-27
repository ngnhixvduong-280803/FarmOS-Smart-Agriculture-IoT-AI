import { useLiveRefresh } from "../hooks/useLiveRefresh";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  ExternalLink,
  Radio,
  RefreshCw,
  Search,
  ShieldAlert,
  Wifi,
  WifiOff,
} from "lucide-react";
import { fetchInventoryNodes } from "../services/api.service";

type InventoryStatus = "all" | "unactivated" | "activated";
type InventoryType = "all" | "SENSOR_NODE" | "GATEWAY";

interface InventoryDevice {
  id: string;
  serial_number: string | null;
  name: string | null;
  type: string;
  farm_id: string | null;
  gateway_id: string | null;
  is_activated: boolean;
  online: boolean;
  rssi: number | null;
  firmware_version: string | null;
  created_at: string;
  gateway?: { id: string; name: string | null; serial_number: string | null } | null;
  owner?: { id: string; name: string | null; email: string } | null;
  farm?: { id: string; name: string } | null;
}

import { useI18n } from "../context/I18nContext";

export interface DeviceInventoryPageProps {
  isActive?: boolean;
}

export const DeviceInventoryPage: React.FC<DeviceInventoryPageProps> = ({ isActive = true }) => {
  const { t, language } = useI18n();

  const typeLabel = (type: string) => {
    return type === "GATEWAY" ? t.inventoryPage.gateway : t.inventoryPage.sensorNode;
  };

  const formatDate = (value?: string | null) => {
    if (!value) return t.inventoryPage.unrecorded;
    return new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  };

  const statusLabel = (device: InventoryDevice) => {
    if (!device.is_activated) return t.inventoryPage.inStock;
    return device.online ? t.inventoryPage.activeStatus : t.inventoryPage.disconnectedStatus;
  };
  const [devices, setDevices] = useState<InventoryDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<InventoryStatus>("all");
  const [filterType, setFilterType] = useState<InventoryType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  const loadInventory = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      // Identity creation belongs to the secure Web Serial enrollment flow,
      // not this read-only consumer of the inventory API.
      const data = await fetchInventoryNodes("all");
      setDevices(data as InventoryDevice[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.inventoryPage.loadError);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadInventory();
  }, [loadInventory]);

  useEffect(() => {
    if (isActive) void loadInventory(true);
  }, [isActive, loadInventory]);

  useEffect(() => {
    const handleSync = () => void loadInventory(true);
    window.addEventListener("farmos:node-updated", handleSync);
    return () => window.removeEventListener("farmos:node-updated", handleSync);
  }, [loadInventory]);

  useLiveRefresh(() => loadInventory(true), isActive);

  const copyValue = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(key);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Clipboard permission is optional; the value remains visible in the row.
    }
  };

  const filteredDevices = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return devices.filter((device) => {
      if (filterStatus === "unactivated" && device.is_activated) return false;
      if (filterStatus === "activated" && !device.is_activated) return false;
      if (filterType !== "all" && device.type !== filterType) return false;
      if (!query) return true;
      return [
        device.id,
        device.serial_number,
        device.name,
        device.owner?.email,
        device.owner?.name,
        device.farm?.name,
      ].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }, [devices, filterStatus, filterType, searchQuery]);

  const countInStock = devices.filter((device) => !device.is_activated).length;
  const countActivated = devices.filter((device) => device.is_activated).length;
  const countOnline = devices.filter((device) => device.is_activated && device.online).length;

  return (
    <div className="admin-page space-y-6 pb-12">
      <header className="admin-page__header">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow">{t.inventoryPage.eyebrow}</p>
            <span className="status-chip status-chip--neutral">{t.inventoryPage.readOnly}</span>
          </div>
          <h1 className="admin-page__title">{t.inventoryPage.title}</h1>
          <p className="admin-page__intro">{t.inventoryPage.intro}</p>
        </div>
        <button type="button" onClick={() => void loadInventory()} className="action action-light" disabled={loading}>
          <RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
          {t.inventoryPage.refresh}
        </button>
      </header>

      <section className="inventory-summary" aria-label={t.inventoryPage.summaryAria}>
        <button type="button" className={`inventory-summary__item ${filterStatus === "all" ? "is-selected" : ""}`} onClick={() => setFilterStatus("all")}>
          <span>{t.inventoryPage.totalDevices}</span><strong>{devices.length}</strong><small>{t.inventoryPage.totalSubtitle}</small>
        </button>
        <button type="button" className={`inventory-summary__item ${filterStatus === "unactivated" ? "is-selected" : ""}`} onClick={() => setFilterStatus("unactivated")}>
          <span>{t.inventoryPage.inStock}</span><strong>{countInStock}</strong><small>{t.inventoryPage.inStockSubtitle}</small>
        </button>
        <button type="button" className={`inventory-summary__item ${filterStatus === "activated" ? "is-selected" : ""}`} onClick={() => setFilterStatus("activated")}>
          <span>{t.inventoryPage.activated}</span><strong>{countActivated}</strong><small>{countOnline} {t.inventoryPage.devicesConnecting}</small>
        </button>
      </section>

      <section className="admin-panel overflow-hidden">
        <div className="admin-panel__toolbar">
          <label className="relative min-w-0 flex-1 sm:max-w-md">
            <span className="sr-only">{t.inventoryPage.searchDevicesSr}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t.inventoryPage.searchPlaceholder} className="field pl-9" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <select value={filterType} onChange={(event) => setFilterType(event.target.value as InventoryType)} className="field w-auto min-w-[150px]">
              <option value="all">{t.inventoryPage.allTypes}</option>
              <option value="GATEWAY">{t.inventoryPage.gateway}</option>
              <option value="SENSOR_NODE">{t.inventoryPage.sensorNode}</option>
            </select>
            <span className="text-xs tabular-nums text-slate-500">{filteredDevices.length}/{devices.length}</span>
          </div>
        </div>

        {error && <div className="mx-4 mt-4 admin-alert admin-alert--error" role="alert"><ShieldAlert className="h-4 w-4 shrink-0" /><span>{error}</span><button type="button" className="ml-auto underline" onClick={() => void loadInventory()}>{t.inventoryPage.retry}</button></div>}

        <div className="overflow-x-auto">
          <table className="data-table min-w-[760px]">
            <caption className="sr-only">{t.inventoryPage.tableCaption}</caption>
            <thead><tr><th>{t.inventoryPage.colDevice}</th><th>{t.inventoryPage.colType}</th><th>{t.inventoryPage.colStatus}</th><th>{t.inventoryPage.colFirmware}</th><th>{t.inventoryPage.colFarmUser}</th><th><span className="sr-only">{t.inventoryPage.colDetailsSr}</span></th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={6} className="data-table__empty"><RefreshCw className="mx-auto mb-2 h-5 w-5 animate-spin" />{t.inventoryPage.loadingList}</td></tr> : filteredDevices.length === 0 ? <tr><td colSpan={6} className="data-table__empty">{t.inventoryPage.empty}</td></tr> : filteredDevices.map((device) => {
                const isGateway = device.type === "GATEWAY";
                const isSelected = selectedDeviceId === device.id;
                return <React.Fragment key={device.id}>
                  <tr className={isSelected ? "is-selected" : ""}>
                    <td>
                      <div className="flex items-start gap-2">
                        <span className="mt-0.5 text-emerald-700 dark:text-emerald-400">{isGateway ? <Radio className="h-4 w-4" /> : <Cpu className="h-4 w-4" />}</span>
                        <div className="min-w-0"><button type="button" className="font-mono text-xs font-semibold hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => setSelectedDeviceId(isSelected ? null : device.id)}>{device.id}</button><button type="button" className="ml-1.5 inline-flex align-middle text-slate-400 hover:text-emerald-700" onClick={() => void copyValue(device.id, device.id)} aria-label={t.inventoryPage.copyDeviceAria.replace("{{id}}", device.id)}>{copiedId === device.id ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}</button><span className="mt-1 block font-mono text-[10px] text-slate-500">{device.serial_number || t.inventoryPage.noSerial}</span></div>
                      </div>
                    </td>
                    <td><span className="text-xs font-medium">{typeLabel(device.type)}</span><span className="mt-1 block text-[10px] text-slate-400">{device.gateway_id ? t.inventoryPage.viaGateway.replace("{{gatewayId}}", device.gateway_id) : t.inventoryPage.standalone}</span></td>
                    <td><span className={`status-chip ${!device.is_activated ? "status-chip--neutral" : device.online ? "status-chip--success" : "status-chip--warning"}`}>{device.is_activated && (device.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />)}{statusLabel(device)}</span><span className="mt-1 block text-[10px] text-slate-400">{formatDate(device.created_at)}</span></td>
                    <td><span className="font-mono text-xs">{device.firmware_version || t.inventoryPage.notRead}</span></td>
                    <td><span className="block max-w-[180px] truncate text-xs font-medium">{device.farm?.name || (device.is_activated ? t.inventoryPage.activatedFarm : t.inventoryPage.notActivatedFarm)}</span><span className="mt-1 block max-w-[180px] truncate text-[10px] text-slate-500">{device.owner?.name || device.owner?.email || t.inventoryPage.readyToFlash}</span></td>
                    <td className="text-right"><button type="button" className="icon-action" onClick={() => setSelectedDeviceId(isSelected ? null : device.id)} aria-expanded={isSelected} aria-label={t.inventoryPage.viewDetailAria.replace("{{id}}", device.id)}><ExternalLink className="h-4 w-4" /></button></td>
                  </tr>
                  {isSelected && <tr className="data-table__detail"><td colSpan={6}><div className="inventory-detail"><div><span className="eyebrow">{t.inventoryPage.identity}</span><p className="mt-1 font-mono text-xs">{device.id}</p><p className="mt-1 text-[11px] text-slate-500">{t.inventoryPage.serial}: {device.serial_number || t.inventoryPage.noSerialDetail}</p></div><div><span className="eyebrow">{t.inventoryPage.connection}</span><p className="mt-1 text-xs">{device.online ? t.inventoryPage.connecting : t.inventoryPage.notConnected}{device.rssi === null ? "" : ` · RSSI ${device.rssi} dBm`}</p><p className="mt-1 text-[11px] text-slate-500">Gateway: {device.gateway?.name || device.gateway_id || t.inventoryPage.noGateway}</p></div><div className="flex items-end justify-end"><Link to="/flasher" className="action action-dark"><RefreshCw className="h-3.5 w-3.5" /> {t.inventoryPage.openReflash}</Link></div></div></td></tr>}
                </React.Fragment>;
              })}
            </tbody>
          </table>
        </div>
        <footer className="admin-panel__footer"><span>{t.inventoryPage.footerNote}</span><span className="hidden sm:inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> {t.inventoryPage.footerAttestation}</span></footer>
      </section>
    </div>
  );
};
