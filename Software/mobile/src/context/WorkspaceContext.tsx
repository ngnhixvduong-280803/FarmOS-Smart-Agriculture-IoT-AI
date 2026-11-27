import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { useDialog } from "../components/AppDialog";
import { api } from "../services/api";
import { newerTelemetry, reconcileOverview } from "../services/telemetryOrdering";
import { useFarmSocket, type AlertRealtimeEvent, type GatewayRealtimeEvent, type IrrigationRealtimeEvent, type TelemetryRealtimeEvent } from "../hooks/useFarmSocket";
import { clearPendingProfileSync, loadPendingProfileSync, saveCachedUser, savePendingProfileSync } from "../services/session";
import type { AdminDeviceInventory, AlertItem, Farm, FarmDevice, FarmOverview, IrrigationLog, UserProfile, Zone } from "../types";

type WorkspaceContextValue = {
  user: UserProfile;
  token: string;
  farms: Farm[];
  selectedFarmId: string;
  overview: FarmOverview | null;
  alerts: AlertItem[];
  users: UserProfile[];
  usersLoading: boolean;
  devices: FarmDevice[];
  adminDevices: AdminDeviceInventory[];
  currentDevices: FarmDevice[];
  farmZones: Zone[];
  latestIrrigationByZone: Map<string, IrrigationLog>;
  refreshing: boolean;
  overviewLoading: boolean;
  overviewError: string | null;
  alertsLoading: boolean;
  devicesLoading: boolean;
  devicesError: string | null;
  adminDevicesLoading: boolean;
  adminDevicesError: string | null;
  irrigationLoading: boolean;
  irrigationError: string | null;
  resolvingAlertId: string | null;
  updatingUserId: string | null;
  irrigationStatusLabel: (status: string) => string;
  selectFarm: (farmId: string) => void;
  refresh: (options?: { showError?: boolean }) => Promise<void>;
  onRefresh: () => Promise<void>;
  onDashboardRefresh: () => Promise<void>;
  irrigate: (zone: Zone) => void;
  emergencyStop: (farmId: string) => void;
  resolveAlert: (alert: AlertItem) => Promise<void>;
  changeUserRole: (member: UserProfile) => void;
  deleteUser: (member: UserProfile) => void;
  onDevicesChanged: () => Promise<void>;
  loadDevices: (showError?: boolean) => Promise<void>;
  loadAdminDevices: (showError?: boolean) => Promise<void>;
  updateProfile: (input: { name: string; avatar?: { uri: string; type?: string | null; fileName?: string | null } | null }) => Promise<void>;
  onLogout: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ user, token, onLogout, children }: { user: UserProfile; token: string; onLogout: () => Promise<void>; children: ReactNode }) {
  const { show, confirm } = useDialog();
  const [workspaceUser, setWorkspaceUser] = useState<UserProfile>(user);
  const [farms, setFarms] = useState<Farm[]>(user.farms || []);
  const [selectedFarmId, setSelectedFarmId] = useState(user.farms?.[0]?.id || "");
  const [overview, setOverview] = useState<FarmOverview | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [usersLoading, setUsersLoading] = useState(workspaceUser.role === "ADMIN");
  const [refreshing, setRefreshing] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [devices, setDevices] = useState<FarmDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [adminDevices, setAdminDevices] = useState<AdminDeviceInventory[]>([]);
  const [adminDevicesLoading, setAdminDevicesLoading] = useState(false);
  const [adminDevicesError, setAdminDevicesError] = useState<string | null>(null);
  const [irrigationLogs, setIrrigationLogs] = useState<IrrigationLog[]>([]);
  const [irrigationLoading, setIrrigationLoading] = useState(true);
  const [irrigationError, setIrrigationError] = useState<string | null>(null);
  const [resolvingAlertId, setResolvingAlertId] = useState<string | null>(null);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const devicesRef = useRef(devices);
  const adminDevicesRef = useRef(adminDevices);
  const selectedFarmRef = useRef(selectedFarmId);
  const refreshGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef<{ farmId: string; promise: Promise<void> } | null>(null);
  const devicesInFlightRef = useRef<Promise<void> | null>(null);
  const adminDevicesInFlightRef = useRef<Promise<void> | null>(null);
  const irrigationInFlightRef = useRef<Promise<void> | null>(null);
  const profileSyncInFlightRef = useRef<Promise<void> | null>(null);
  const profileSyncWriteRef = useRef<Promise<void>>(Promise.resolve());
  // Loading states belong to first-load/empty states only. Once a resource has
  // completed one request (including an empty result), pull-to-refresh keeps
  // its existing UI and uses the native RefreshControl indicator exclusively.
  const overviewLoadedRef = useRef(false);
  const alertsLoadedRef = useRef(false);
  const usersLoadedRef = useRef(false);
  const devicesLoadedRef = useRef(false);
  const adminDevicesLoadedRef = useRef(false);
  const irrigationLoadedRef = useRef(false);

  useEffect(() => {
    devicesRef.current = devices;
  }, [devices]);

  useEffect(() => {
    adminDevicesRef.current = adminDevices;
  }, [adminDevices]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshGenerationRef.current += 1;
      refreshInFlightRef.current = null;
      devicesInFlightRef.current = null;
      adminDevicesInFlightRef.current = null;
      irrigationInFlightRef.current = null;
      profileSyncInFlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    setWorkspaceUser(user);
  }, [user]);

  const refresh = useCallback((options: { showError?: boolean } = {}): Promise<void> => {
    const requestedFarmId = selectedFarmRef.current;
    const currentRequest = refreshInFlightRef.current;
    if (currentRequest?.farmId === requestedFarmId) return currentRequest.promise;

    const generation = ++refreshGenerationRef.current;
    const isCurrent = (farmId: string) => mountedRef.current && refreshGenerationRef.current === generation && selectedFarmRef.current === farmId;
    if (!overviewLoadedRef.current) setOverviewLoading(true);
    if (!alertsLoadedRef.current) setAlertsLoading(true);
    if (workspaceUser.role === "ADMIN" && !usersLoadedRef.current) setUsersLoading(true);
    setOverviewError(null);
    const promise = (async () => {
      try {
        // The selected farm is already known locally.  Load its dashboard in
        // parallel with the directory so pull-to-refresh costs one network
        // round trip rather than two sequential ones.
        const [fetchedFarms, selectedOverview, nextAlerts, nextUsers] = await Promise.all([
          api.farms(),
          requestedFarmId ? api.overview(requestedFarmId).then(value => ({ value }), error => ({ error })) : Promise.resolve({ value: null }),
          api.alerts(),
          workspaceUser.role === "ADMIN" ? api.users() : Promise.resolve<UserProfile[]>([]),
        ]);
        if (!isCurrent(requestedFarmId)) return;
        const farmId = requestedFarmId && fetchedFarms.some((farm) => farm.id === requestedFarmId) ? requestedFarmId : fetchedFarms[0]?.id || "";
        if (farmId !== selectedFarmRef.current) {
          selectedFarmRef.current = farmId;
          setSelectedFarmId(farmId);
          setOverview(null);
        }
        setFarms(fetchedFarms);
        // A deleted/revoked selected farm is rare; only then make a second
        // request for the replacement farm.
        if (farmId === requestedFarmId && "error" in selectedOverview) throw selectedOverview.error;
        const nextOverview = farmId === requestedFarmId
          ? ("value" in selectedOverview ? selectedOverview.value : null)
          : farmId ? await api.overview(farmId) : null;
        if (!isCurrent(farmId)) return;
        setOverview(current => reconcileOverview(current, nextOverview));
        setAlerts(nextAlerts);
        overviewLoadedRef.current = true;
        alertsLoadedRef.current = true;
        usersLoadedRef.current = true;
        setOverviewLoading(false);
        setAlertsLoading(false);
        setUsersLoading(false);
        setOverviewError(null);
        if (workspaceUser.role === "ADMIN") setUsers(nextUsers);
        else setUsers([]);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Lỗi kết nối";
        if (message.includes("401") || message.includes("hết hạn")) {
          onLogout().catch(() => undefined);
          return;
        }
        if (isCurrent(requestedFarmId) && options.showError === true) show({ title: "Không thể làm mới dữ liệu", message, tone: "danger" });
        if (isCurrent(requestedFarmId)) {
          setOverviewError(message);
          setOverviewLoading(false);
          setAlertsLoading(false);
          setUsersLoading(false);
        }
      }
    })().finally(() => {
      if (refreshInFlightRef.current?.promise === promise) refreshInFlightRef.current = null;
    });
    refreshInFlightRef.current = { farmId: requestedFarmId, promise };
    return promise;
  }, [workspaceUser.role, onLogout, show]);

  const loadDevices = useCallback((showError = true): Promise<void> => {
    if (devicesInFlightRef.current) return devicesInFlightRef.current;
    if (!devicesLoadedRef.current) setDevicesLoading(true);
    setDevicesError(null);
    const promise = (async () => {
      try {
        const nextDevices = await api.devices();
        if (mountedRef.current) {
          devicesLoadedRef.current = true;
          setDevices(nextDevices);
        }
      } catch (error) {
        if (!mountedRef.current) return;
        const message = error instanceof Error ? error.message : "Không thể tải danh sách thiết bị";
        setDevicesError(message);
        if (showError) show({ title: "Không thể tải thiết bị", message, tone: "danger" });
      } finally {
        if (mountedRef.current) setDevicesLoading(false);
      }
    })().finally(() => { devicesInFlightRef.current = null; });
    devicesInFlightRef.current = promise;
    return promise;
  }, [show]);

  const loadAdminDevices = useCallback((showError = true): Promise<void> => {
    // Never request the inventory endpoint for a USER, even if a stale
    // navigation action tries to render an admin screen.
    if (workspaceUser.role !== "ADMIN") {
      setAdminDevices([]);
      setAdminDevicesLoading(false);
      setAdminDevicesError(null);
      return Promise.resolve();
    }
    if (adminDevicesInFlightRef.current) return adminDevicesInFlightRef.current;
    if (!adminDevicesLoadedRef.current) setAdminDevicesLoading(true);
    setAdminDevicesError(null);
    const promise = (async () => {
      try {
        const nextDevices = await api.adminDevices();
        if (mountedRef.current) {
          adminDevicesLoadedRef.current = true;
          setAdminDevices(nextDevices);
        }
      } catch (error) {
        if (!mountedRef.current) return;
        const message = error instanceof Error ? error.message : "Không thể tải kho thiết bị";
        setAdminDevicesError(message);
        if (showError) show({ title: "Không thể tải kho thiết bị", message, tone: "danger" });
      } finally {
        if (mountedRef.current) setAdminDevicesLoading(false);
      }
    })().finally(() => { adminDevicesInFlightRef.current = null; });
    adminDevicesInFlightRef.current = promise;
    return promise;
  }, [workspaceUser.role, show]);

  const loadIrrigationLogs = useCallback((showError = false): Promise<void> => {
    if (irrigationInFlightRef.current) return irrigationInFlightRef.current;
    if (!irrigationLoadedRef.current) setIrrigationLoading(true);
    setIrrigationError(null);
    const promise = (async () => {
      try {
        const result = await api.irrigationLogs({ limit: 50 });
        if (mountedRef.current) {
          irrigationLoadedRef.current = true;
          setIrrigationLogs((current) => {
            const serverCommandIds = new Set(result.logs.map((log) => log.command_id));
            // Keep the local EXECUTING row until the server returns it (or an
            // ACK/timeout replaces it). This closes the short race where the
            // manual command is accepted but the first logs read happens
            // before the transaction is visible to the API.
            const pending = current.filter((log) => log.id.startsWith("mobile-") && log.status === "EXECUTING" && !serverCommandIds.has(log.command_id));
            return [...pending, ...result.logs];
          });
        }
      } catch (error) {
        if (!mountedRef.current) return;
        const message = error instanceof Error ? error.message : "Không thể tải trạng thái lệnh tưới";
        setIrrigationError(message);
        if (showError) show({ title: "Không thể tải trạng thái tưới", message, tone: "danger" });
      } finally {
        if (mountedRef.current) setIrrigationLoading(false);
      }
    })().finally(() => { irrigationInFlightRef.current = null; });
    irrigationInFlightRef.current = promise;
    return promise;
  }, [show]);

  useEffect(() => { refresh().catch(() => undefined); }, [refresh, selectedFarmId]);
  useEffect(() => {
    // Preload device inventories in the background at launch so the Devices tab
    // has data ready immediately without hanging spinners or delayed fetches.
    loadDevices(false).catch(() => undefined);
    if (workspaceUser.role === "ADMIN") {
      loadAdminDevices(false).catch(() => undefined);
    }
    loadIrrigationLogs(false).catch(() => undefined);
  }, [loadAdminDevices, loadDevices, loadIrrigationLogs, workspaceUser.role]);
  const applyTelemetry = useCallback((event: TelemetryRealtimeEvent) => {
    const timestamp = new Date(event.timestamp > 10_000_000_000 ? event.timestamp : event.timestamp * 1000).toISOString();
    const telemetry = {
      timestamp,
      quality: event.quality,
      soil_moisture: event.soil_moisture,
      soil_temp: event.soil_temp,
      air_temp: event.air_temp,
      air_humidity: event.air_humidity,
      lux: event.lux,
    };
    setOverview((current) => {
      if (!current || current.farm.id !== event.farmId) return current;
      const patchZones = (zones: Zone[] = []) => zones.map((zone) => zone.id === event.zoneId ? { ...zone, telemetries: [newerTelemetry(zone.telemetries?.[0], telemetry)!] } : zone);
      return { ...current, zones: patchZones(current.zones), farm: { ...current.farm, zones: patchZones(current.farm.zones) } };
    });
    setDevices((current) => current.map((device) => device.id === event.nodeId
      ? { ...device, online: true, last_seen: timestamp, latest_telemetry: newerTelemetry(device.latest_telemetry ?? undefined, telemetry) }
      : device));
  }, []);

  const applyGatewayStatus = useCallback((event: GatewayRealtimeEvent) => {
    const timestamp = new Date(event.timestamp > 10_000_000_000 ? event.timestamp : event.timestamp * 1000).toISOString();
    setDevices((current) => current.map((device) => device.id === event.nodeId
      ? { ...device, online: event.online, rssi: event.rssi ?? device.rssi, last_seen: timestamp }
      : device));
    setAdminDevices((current) => current.map((device) => device.deviceId === event.nodeId && device.node
      ? { ...device, node: { ...device.node, online: event.online, lastSeen: timestamp } }
      : device));
  }, []);

  const applyIrrigationStatus = useCallback((event: IrrigationRealtimeEvent) => {
    const timestamp = new Date(event.timestamp > 10_000_000_000 ? event.timestamp : event.timestamp * 1000).toISOString();
    setIrrigationLogs((current) => current.map((log) => log.command_id === event.commandId
      ? { ...log, status: event.status, measured_flow_liters: event.measured_flow_liters ?? log.measured_flow_liters, error_code: event.error_code ?? log.error_code, completed_at: ["COMPLETED", "FAILED", "TIMEOUT", "REJECTED"].includes(event.status) ? timestamp : log.completed_at }
      : log));
  }, []);

  const applyNewAlert = useCallback((event: AlertRealtimeEvent) => {
    setAlerts((current) => current.some((alert) => alert.id === event.id) ? current : [event, ...current]);
    setOverview((current) => !current || current.farm.id !== event.farm_id
      ? current
      : { ...current, activeAlertsCount: (current.activeAlertsCount || 0) + 1 });
  }, []);

  const reconcileAfterReconnect = useCallback(() => Promise.all([
    refresh({ showError: false }),
    loadDevices(false),
    workspaceUser.role === "ADMIN" ? loadAdminDevices(false) : Promise.resolve(),
    loadIrrigationLogs(false),
  ]).then(() => undefined), [loadAdminDevices, loadDevices, loadIrrigationLogs, refresh, workspaceUser.role]);

  const socketCallbacks = useMemo(() => ({
    onReconnect: reconcileAfterReconnect,
    onTelemetry: applyTelemetry,
    onGatewayStatus: applyGatewayStatus,
    onIrrigationStatus: applyIrrigationStatus,
    onNewAlert: applyNewAlert,
  }), [applyGatewayStatus, applyIrrigationStatus, applyNewAlert, applyTelemetry, reconcileAfterReconnect]);
  useFarmSocket(token, socketCallbacks);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([refresh({ showError: true }), loadDevices(false), loadAdminDevices(false), loadIrrigationLogs(false)]); }
    finally { setRefreshing(false); }
  }, [refresh, loadAdminDevices, loadDevices, loadIrrigationLogs]);

  const onDashboardRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // The admin home only renders farms, users, alerts and the compact
      // device list.  Do not make it wait for the factory inventory or logs.
      await Promise.all([refresh({ showError: true }), loadDevices(false)]);
    } finally {
      setRefreshing(false);
    }
  }, [loadDevices, refresh]);

  const selectFarm = useCallback((farmId: string) => {
    if (farmId === selectedFarmRef.current) return;
    selectedFarmRef.current = farmId;
    refreshGenerationRef.current += 1;
    overviewLoadedRef.current = false;
    setOverviewLoading(true);
    setAlertsLoading(true);
    setOverviewError(null);
    setSelectedFarmId(farmId);
    setOverview(null);
  }, []);

  const irrigate = useCallback((zone: Zone) => confirm({ title: "Tưới thủ công", message: `Tưới ${zone.name} trong 5 phút?`, confirmLabel: "Xác nhận", onConfirm: async () => {
      try {
        const result = await api.irrigate(zone.id, 300);
        if (result.commandId) setIrrigationLogs((current) => [{ id: `mobile-${result.commandId}`, command_id: result.commandId!, zone_id: zone.id, duration_sec: result.durationSec || 300, status: "EXECUTING", created_at: new Date().toISOString() }, ...current.filter((log) => log.command_id !== result.commandId)]);
        await Promise.all([refresh({ showError: false }), loadIrrigationLogs(false)]);
        show({ title: "Đã gửi lệnh", message: result.commandId ? `Đang chờ Gateway ACK (${result.commandId}).` : "Đang chờ Gateway ACK." });
      } catch (error) { show({ title: "Lệnh bị từ chối", message: error instanceof Error ? error.message : "Không thể tưới", tone: "danger" }); }
    } }), [confirm, loadIrrigationLogs, refresh, show]);

  const emergencyStop = useCallback((farmId: string) => confirm({ title: "DỪNG KHẨN CẤP", message: "Dừng bơm và toàn bộ van tại Farm đang chọn?", confirmLabel: "DỪNG NGAY", tone: "danger", onConfirm: async () => { try { await api.emergencyStop(farmId); show({ title: "Đã gửi dừng khẩn cấp", message: "Đang chờ Gateway xác nhận." }); } catch (error) { show({ title: "Không thể dừng", message: error instanceof Error ? error.message : "Lỗi hệ thống", tone: "danger" }); } } }), [confirm, show]);

  const resolveAlert = useCallback(async (alert: AlertItem) => {
    setResolvingAlertId(alert.id);
    try { await api.resolveAlert(alert.id); setAlerts((current) => current.filter((item) => item.id !== alert.id)); }
    catch (error) { show({ title: "Không thể xử lý cảnh báo", message: error instanceof Error ? error.message : "Lỗi kết nối", tone: "danger" }); }
    finally { setResolvingAlertId(null); }
  }, [show]);

  const changeUserRole = useCallback((member: UserProfile) => {
    const nextRole = member.role === "ADMIN" ? "USER" : "ADMIN";
    confirm({ title: "Đổi quyền người dùng", message: `Đổi ${member.email} thành ${nextRole}?`, confirmLabel: "Xác nhận", onConfirm: async () => {
        setUpdatingUserId(member.id);
        try {
          const updated = await api.updateUser(member.id, { role: nextRole });
          setUsers((current) => current.map((item) => item.id === member.id ? { ...item, ...updated } : item));
        } catch (error) {
          show({ title: "Không thể đổi quyền", message: error instanceof Error ? error.message : "Lỗi kết nối", tone: "danger" });
        } finally {
          setUpdatingUserId(null);
        }
      } });
  }, [confirm, show]);

  const deleteUser = useCallback((member: UserProfile) => {
    confirm({ title: "Xoá tài khoản", message: `Xoá vĩnh viễn tài khoản ${member.email}?`, confirmLabel: "Xoá", tone: "danger", onConfirm: async () => {
        setUpdatingUserId(member.id);
        try {
          await api.deleteUser(member.id);
          setUsers((current) => current.filter((item) => item.id !== member.id));
        } catch (error) {
          show({ title: "Không thể xoá tài khoản", message: error instanceof Error ? error.message : "Lỗi kết nối", tone: "danger" });
        } finally {
          setUpdatingUserId(null);
        }
      } });
  }, [confirm, show]);

  const flushPendingProfileSync = useCallback((): Promise<void> => {
    if (profileSyncInFlightRef.current) return profileSyncInFlightRef.current;

    const work = (async () => {
      while (mountedRef.current) {
        const pending = await loadPendingProfileSync();
        if (!pending) return;

        try {
          const updated = await api.syncProfile({ name: pending.name });
          const uploadedAvatar = pending.avatar ? await api.uploadAvatar(pending.avatar) : null;
          const currentPending = await loadPendingProfileSync();

          // A later Save replaced this item while this request was in flight.
          // Leave it queued and immediately process that newer snapshot next.
          if (currentPending?.id !== pending.id) continue;

          await clearPendingProfileSync();
          setWorkspaceUser((current) => {
            const nextUser = { ...current, ...updated, ...uploadedAvatar, farms: updated.farms || current.farms };
            saveCachedUser(nextUser).catch(() => undefined);
            return nextUser;
          });
        } catch (error) {
          if (mountedRef.current) {
            show({
              title: "Đồng bộ hồ sơ đang chờ",
              message: `${error instanceof Error ? error.message : "Không thể kết nối máy chủ"}. FarmOS sẽ tự thử lại khi ứng dụng hoạt động lại.`,
              tone: "danger",
            });
          }
          return;
        }
      }
    })();

    profileSyncInFlightRef.current = work;
    work.finally(() => {
      if (profileSyncInFlightRef.current === work) profileSyncInFlightRef.current = null;
    }).catch(() => undefined);
    return work;
  }, [show]);

  useEffect(() => {
    flushPendingProfileSync().catch(() => undefined);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") flushPendingProfileSync().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [flushPendingProfileSync]);

  const updateProfile = useCallback(({ name, avatar }: { name: string; avatar?: { uri: string; type?: string | null; fileName?: string | null } | null }): Promise<void> => {
    const normalizedName = name.trim();
    if (!normalizedName) {
      return Promise.reject(new Error("Tên hiển thị không được để trống"));
    }

    // Commit locally first so tapping Save never waits on mobile radio, image
    // upload, or server response. The durable queue below survives a restart.
    setWorkspaceUser((current) => {
      const nextUser = { ...current, name: normalizedName };
      saveCachedUser(nextUser).catch(() => undefined);
      return nextUser;
    });

    const pending = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: normalizedName,
      ...(avatar ? { avatar } : {}),
    };
    profileSyncWriteRef.current = profileSyncWriteRef.current.then(async () => {
      if (!mountedRef.current) return;
      await savePendingProfileSync(pending);
      await flushPendingProfileSync();
    }).catch((error) => {
      if (mountedRef.current) show({ title: "Không thể xếp lịch đồng bộ hồ sơ", message: error instanceof Error ? error.message : "Không thể lưu thay đổi trên thiết bị", tone: "danger" });
    });

    return Promise.resolve();
  }, [flushPendingProfileSync, show]);

  const onDevicesChanged = useCallback(async () => { await Promise.all([refresh({ showError: false }), loadDevices(false), loadAdminDevices(false), loadIrrigationLogs(false)]); }, [refresh, loadAdminDevices, loadDevices, loadIrrigationLogs]);
  // An empty selection means that the farm list is still loading (or the user
  // has no accessible farm). Never fall back to rendering every device here;
  // ADMIN can receive the global `/nodes` response and that would otherwise
  // leak another farm's devices into the empty state.
  const currentDevices = useMemo(() => selectedFarmId
    ? devices.filter((device) => device.is_activated && device.farm?.id === selectedFarmId)
    : [], [devices, selectedFarmId]);
  const farmZones = useMemo(() => (overview?.farm as (Farm & { zones?: Zone[] }) | undefined)?.zones || overview?.zones || [], [overview]);
  const latestIrrigationByZone = useMemo(() => {
    const latest = new Map<string, IrrigationLog>();
    irrigationLogs.forEach((log) => { const current = latest.get(log.zone_id); if (!current || Date.parse(log.created_at) > Date.parse(current.created_at)) latest.set(log.zone_id, log); });
    return latest;
  }, [irrigationLogs]);
  const irrigationStatusLabel = useCallback((status: string) => ({ EXECUTING: "Đang chờ Gateway ACK", COMPLETED: "Đã hoàn tất", FAILED: "Gateway báo thất bại", TIMEOUT: "Hết thời gian chờ ACK", REJECTED: "Bị từ chối" }[status] || status), []);

  const value = useMemo<WorkspaceContextValue>(() => ({ user: workspaceUser, token, farms, selectedFarmId, overview, alerts, users, usersLoading, devices, adminDevices, currentDevices, farmZones, latestIrrigationByZone, refreshing, overviewLoading, overviewError, alertsLoading, devicesLoading, devicesError, adminDevicesLoading, adminDevicesError, irrigationLoading, irrigationError, resolvingAlertId, updatingUserId, irrigationStatusLabel, selectFarm, refresh, onRefresh, onDashboardRefresh, irrigate, emergencyStop, resolveAlert, changeUserRole, deleteUser, onDevicesChanged, loadDevices, loadAdminDevices, updateProfile, onLogout }), [adminDevices, adminDevicesError, adminDevicesLoading, alerts, alertsLoading, changeUserRole, currentDevices, deleteUser, devices, devicesError, devicesLoading, emergencyStop, farmZones, farms, irrigationError, irrigationLoading, irrigationStatusLabel, latestIrrigationByZone, loadAdminDevices, loadDevices, onDashboardRefresh, onDevicesChanged, onLogout, onRefresh, overview, overviewError, overviewLoading, refresh, resolveAlert, resolvingAlertId, selectFarm, selectedFarmId, token, updatingUserId, updateProfile, workspaceUser, users, usersLoading, refreshing, irrigate]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace phải được dùng bên trong WorkspaceProvider");
  return value;
}
