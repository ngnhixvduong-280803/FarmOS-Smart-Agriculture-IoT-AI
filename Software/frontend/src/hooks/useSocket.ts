import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { AlertItem } from "../types";

let socketInstance: Socket | null = null;

export function useSocket(callbacks?: {
  onTelemetry?: (data: any) => void;
  onGatewayStatus?: (data: any) => void;
  onIrrigationStatus?: (data: any) => void;
  onNewAlert?: (data: AlertItem) => void;
  onReconnect?: () => void;
}) {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const callbacksRef = useRef(callbacks);

  useEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  useEffect(() => {
    if (!socketInstance) {
      socketInstance = io("/", {
        transports: ["polling", "websocket"],
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });
    }

    const socket = socketInstance;

    const handleConnect = () => {
      console.log("🟢 [WebSocket] Đã kết nối tới FarmOS Backend");
      setIsConnected(true);
      // Reconcile even the first connection: HTTP loading may precede room join.
      callbacksRef.current?.onReconnect?.();
    };

    const handleDisconnect = () => {
      console.log("🔴 [WebSocket] Mất kết nối tới FarmOS Backend");
      setIsConnected(false);
    };

    const handleTelemetry = (data: any) => {
      callbacksRef.current?.onTelemetry?.(data);
    };

    const handleGatewayStatus = (data: any) => {
      callbacksRef.current?.onGatewayStatus?.(data);
    };

    const handleIrrigationStatus = (data: any) => {
      callbacksRef.current?.onIrrigationStatus?.(data);
    };

    const handleNewAlert = (data: any) => {
      callbacksRef.current?.onNewAlert?.(data);
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("telemetry:update", handleTelemetry);
    socket.on("gateway:status", handleGatewayStatus);
    socket.on("irrigation:status", handleIrrigationStatus);
    socket.on("alert:new", handleNewAlert);

    setIsConnected(socket.connected);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("telemetry:update", handleTelemetry);
      socket.off("gateway:status", handleGatewayStatus);
      socket.off("irrigation:status", handleIrrigationStatus);
      socket.off("alert:new", handleNewAlert);
    };
  }, []);

  return { isConnected, socket: socketInstance };
}
