import { useEffect, useRef } from "react";
import { useSocket } from "./useSocket";

// Coalesce bursts, serialize requests, and reconcile server-derived offline
// status even when there is no telemetry event for an offline device.
export function useLiveRefresh(refresh: () => Promise<void>, active = true) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let running = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      timer = undefined;
      if (disposed || document.hidden) return;
      if (running) { pending = true; return; }
      running = true;
      try { await refreshRef.current(); }
      catch (error) { console.error("Live refresh failed", error); }
      finally {
        running = false;
        if (pending && !disposed) { pending = false; schedule(); }
      }
    };
    const schedule = () => {
      if (!disposed && timer === undefined) timer = setTimeout(() => { void run(); }, 250);
    };
    scheduleRef.current = schedule;
    const onVisible = () => { if (!document.hidden) schedule(); };
    const interval = setInterval(schedule, 15000);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", schedule);
    return () => {
      disposed = true;
      scheduleRef.current = () => {};
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", schedule);
    };
  }, [active]);

  const schedule = () => scheduleRef.current();
  useSocket({
    onTelemetry: schedule,
    onGatewayStatus: schedule,
    onIrrigationStatus: schedule,
    onReconnect: schedule,
  });
}
