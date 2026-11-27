import { NativeEventEmitter, NativeModules } from "react-native";

type NativeHeading = { heading: number; accuracy: number; usable: boolean; source: "true" | "magnetic" };
type HeadingListener = (heading: NativeHeading) => void;

const nativeHeading = NativeModules.FarmOSHeading as { start: () => void; stop: () => void } | undefined;
const emitter = nativeHeading ? new NativeEventEmitter(nativeHeading as never) : null;

export function subscribeToCalibratedHeading(listener: HeadingListener): () => void {
  if (!nativeHeading || !emitter) return () => undefined;
  const subscription = emitter.addListener("farmosHeading", (reading: unknown) => {
    if (!reading || typeof reading !== "object") return;
    const value = reading as NativeHeading;
    if (Number.isFinite(value.heading)) listener(value);
  });
  nativeHeading.start();
  return () => {
    subscription.remove();
    nativeHeading.stop();
  };
}

export function smoothHeading(previous: number | null, next: number, factor = 0.2): number {
  if (previous === null) return next;
  const delta = ((next - previous + 540) % 360) - 180;
  return (previous + delta * factor + 360) % 360;
}
