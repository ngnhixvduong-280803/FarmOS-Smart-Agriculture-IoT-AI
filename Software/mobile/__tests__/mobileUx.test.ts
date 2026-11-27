import type { Zone } from "../src/types";
import React from "react";
import ReactTestRenderer from "react-test-renderer";

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("react-native-ble-plx", () => ({
  BleManager: jest.fn(),
  State: { PoweredOn: "PoweredOn" },
}));
jest.mock("../src/services/api", () => ({
  api: {
    reportOtaStatus: jest.fn().mockResolvedValue(undefined),
    devices: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../src/services/deviceBle", () => ({
  cancelNodeOtaFirmware: jest.fn(),
  configureNodePairing: jest.fn(),
  flashNodeOtaFirmware: jest.fn(),
  provisionCloudDevice: jest.fn(),
  readIdentity: jest.fn(),
  scanFarmDevices: jest.fn(),
  waitForNodeFirmware: jest.fn(),
}));
jest.mock("react-native-vision-camera", () => {
  const Camera = () => null;
  Camera.getCameraPermissionStatus = jest.fn(() => "not-determined");
  return {
    Camera,
    useCameraDevice: jest.fn(() => null),
    useCameraPermission: jest.fn(() => ({ hasPermission: false, requestPermission: jest.fn() })),
    useCodeScanner: jest.fn(() => ({})),
  };
});
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import { allowedModesForDevice, isZoneInFarm } from "../src/components/DeviceOnboarding";
import { cameraPermissionGranted, cameraPermissionNeedsSettings } from "../src/components/QrScanner";
import { FirmwareUpdateModal } from "../src/components/FirmwareUpdateModal";
import { DialogProvider } from "../src/components/AppDialog";
import { PreferencesProvider } from "../src/context/PreferencesContext";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { waitForNodeFirmware } from "../src/services/deviceBle";
import { isBluetoothPermissionError, isLocationServicesDisabledError } from "../src/services/androidSettings";

describe("mobile onboarding safety helpers", () => {
  const zones: Zone[] = [
    { id: "zone-a", farm_id: "farm-a", name: "A" },
    { id: "zone-b", farm_id: "farm-b", name: "B" },
  ];

  it("accepts only a Zone belonging to the selected Farm", () => {
    expect(isZoneInFarm("zone-a", "farm-a", zones)).toBe(true);
    expect(isZoneInFarm("zone-b", "farm-a", zones)).toBe(false);
    expect(isZoneInFarm("", "farm-a", zones)).toBe(false);
  });

  it("offers both transport modes only for a capable sensor Node", () => {
    expect(allowedModesForDevice({ type: "GATEWAY", capabilities: ["GATEWAY", "WIFI", "LORA"] })).toEqual(["GATEWAY"]);
    expect(allowedModesForDevice({ type: "SENSOR_NODE", capabilities: ["SENSOR_DS18B20", "WIFI", "LORA"] })).toEqual(["LEAF_NODE", "STANDALONE_NODE"]);
    expect(allowedModesForDevice({ type: "SENSOR_NODE", capabilities: ["SENSOR_DS18B20", "WIFI"] })).toEqual(["STANDALONE_NODE"]);
  });

  it("requires App Settings after camera permission is blocked", () => {
    expect(cameraPermissionNeedsSettings("denied")).toBe(true);
    expect(cameraPermissionNeedsSettings("restricted")).toBe(true);
    expect(cameraPermissionNeedsSettings("not-determined")).toBe(false);
    expect(cameraPermissionNeedsSettings("granted")).toBe(false);
    expect(cameraPermissionGranted(true)).toBe(true);
    expect(cameraPermissionGranted("granted")).toBe(true);
    expect(cameraPermissionGranted("denied")).toBe(false);
  });

  it("recognizes Android Location Services disabled BLE errors", () => {
    expect(isLocationServicesDisabledError({ errorCode: 601 })).toBe(true);
    expect(isLocationServicesDisabledError({ errorCode: "LocationServicesDisabled" })).toBe(true);
    expect(isLocationServicesDisabledError(new Error("Location services are disabled"))).toBe(true);
    expect(isLocationServicesDisabledError(new Error("Cannot start scanning operation"))).toBe(false);
  });

  it("recognizes BLE permission denial so the UI can offer App Settings", () => {
    expect(isBluetoothPermissionError({ errorCode: 102 })).toBe(true);
    expect(isBluetoothPermissionError(new Error("FarmOS cần quyền Bluetooth để tìm thiết bị ở gần"))).toBe(true);
    expect(isBluetoothPermissionError(new Error("Bluetooth chưa được bật"))).toBe(false);
  });

  it("keeps pending BOOT confirmation and shows sync status when device verification fails", async () => {
    const pending = [{
      device: { bleId: "ble-node-1", name: "Node 1", type: "SENSOR_NODE" },
      deviceId: "node-1",
      jobId: "job-1",
      targetVersion: "1.2.3",
      createdAt: "2026-09-07T00:00:00.000Z",
    }];
    const storage = AsyncStorage as unknown as {
      getItem: jest.Mock;
      setItem: jest.Mock;
      removeItem: jest.Mock;
    };
    storage.getItem.mockResolvedValue(JSON.stringify(pending));
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
    (waitForNodeFirmware as jest.Mock).mockRejectedValue(new Error("Node chưa sẵn sàng"));

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        React.createElement(PreferencesProvider, null,
          React.createElement(DialogProvider, null,
            React.createElement(FirmwareUpdateModal, { visible: true, onClose: jest.fn() }),
          ),
        ),
      );
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(storage.setItem).toHaveBeenCalledWith(
      "@farmos/mobile/pending-ota-confirmations",
      JSON.stringify(pending),
    );
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain("đang chờ đồng bộ máy chủ");
    await ReactTestRenderer.act(async () => {
      renderer!.unmount();
    });
  });
});
