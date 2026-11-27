import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { config } from "../config";

export const SOCKET_REFRESH_DEBOUNCE_MS = 300;

export type TelemetryRealtimeEvent = {
  farmId: string;
  zoneId: string;
  nodeId: string;
  soil_moisture?: number | null;
  soil_temp?: number | null;
  air_temp?: number | null;
  air_humidity?: number | null;
  lux?: number | null;
  quality?: number;
  timestamp: number;
};

export type GatewayRealtimeEvent = {
  farmId: string;
  nodeId: string;
  online: boolean;
  rssi?: number;
  timestamp: number;
};

export type IrrigationRealtimeEvent = {
  farmId: string;
  commandId: string;
  zoneId: string;
  status: string;
  measured_flow_liters?: number | null;
  error_code?: number;
  timestamp: number;
};

export type AlertRealtimeEvent = {
  farm_id: string;
  id: string;
  zone_id?: string | null;
  level: string;
  type: string;
  message: string;
  created_at: string;
};

export type FarmSocketCallbacks = {
  onReconnect: () => void | Promise<void>;
  onTelemetry: (event: TelemetryRealtimeEvent) => void;
  onGatewayStatus: (event: GatewayRealtimeEvent) => void;
  onIrrigationStatus: (event: IrrigationRealtimeEvent) => void;
  onNewAlert: (event: AlertRealtimeEvent) => void;
};

type LegacyRefreshCallback = () => void | Promise<void>;

// Kept temporarily so existing callers can migrate without a behavior break.
// New code must use FarmSocketCallbacks and receive deltas directly.
function normalizeCallbacks(callbacks: FarmSocketCallbacks | LegacyRefreshCallback): FarmSocketCallbacks {
  if (typeof callbacks !== "function") return callbacks;
  return {
    onReconnect: callbacks,
    onTelemetry: callbacks,
    onGatewayStatus: callbacks,
    onIrrigationStatus: callbacks,
    onNewAlert: callbacks,
  };
}

export function useFarmSocket(token: string | null, callbacks: FarmSocketCallbacks | LegacyRefreshCallback) {
  const callbacksRef = useRef(normalizeCallbacks(callbacks));
  const legacyRef = useRef(typeof callbacks === "function");

  useEffect(() => {
    callbacksRef.current = normalizeCallbacks(callbacks);
    legacyRef.current = typeof callbacks === "function";
  }, [callbacks]);

  useEffect(() => {
    if (!token) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hasConnected = false;
    let reconcileRunning = false;

    const reconcileAfterReconnect = () => {
      if (disposed || timer || reconcileRunning) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed) return;
        reconcileRunning = true;
        Promise.resolve(callbacksRef.current.onReconnect())
          .catch(() => undefined)
          .finally(() => {
            reconcileRunning = false;
          });
      }, SOCKET_REFRESH_DEBOUNCE_MS);
    };

    const socket: Socket = io(config.apiBaseUrl, {
      transports: ["websocket"],
      auth: { token },
    });

    // Reconcile after a reconnect because Socket.IO cannot replay farm events
    // emitted while the mobile client was offline.
    socket.on("connect", () => {
      // The initial REST snapshot is already in flight; only reconnects need
      // a reconciliation fetch because Socket.IO cannot replay missed events.
      if (hasConnected) reconcileAfterReconnect();
      hasConnected = true;
    });
    socket.on("telemetry:update", (event: TelemetryRealtimeEvent) => legacyRef.current ? reconcileAfterReconnect() : callbacksRef.current.onTelemetry(event));
    socket.on("gateway:status", (event: GatewayRealtimeEvent) => legacyRef.current ? reconcileAfterReconnect() : callbacksRef.current.onGatewayStatus(event));
    socket.on("irrigation:status", (event: IrrigationRealtimeEvent) => legacyRef.current ? reconcileAfterReconnect() : callbacksRef.current.onIrrigationStatus(event));
    socket.on("alert:new", (event: AlertRealtimeEvent) => legacyRef.current ? reconcileAfterReconnect() : callbacksRef.current.onNewAlert(event));

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      socket.disconnect();
    };
  }, [token]);
}
