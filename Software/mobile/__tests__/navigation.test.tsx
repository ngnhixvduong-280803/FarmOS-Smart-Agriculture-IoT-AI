import React from "react";
import ReactTestRenderer from "react-test-renderer";
import { Modal, StyleSheet } from "react-native";
import { createNavigationContainerRef, NavigationContainer } from "@react-navigation/native";
import { RootNavigator, ONBOARDING_SCREEN_OPTIONS } from "../src/navigation/RootNavigator";
import type { RootStackParamList } from "../src/navigation/types";
import { PreferencesProvider } from "../src/context/PreferencesContext";
import { api } from "../src/services/api";

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);
jest.mock("@swan-io/react-native-browser", () => ({
  openBrowser: jest.fn().mockResolvedValue(undefined),
  closeBrowser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("react-native-ble-plx", () => ({
  BleManager: jest.fn(),
  State: { PoweredOn: "PoweredOn" },
}));
jest.mock("react-native-vision-camera", () => ({
  Camera: () => null,
  useCameraDevice: () => null,
  useCameraPermission: () => ({ hasPermission: false, requestPermission: jest.fn() }),
  useCodeScanner: () => ({}),
}));
jest.mock("../src/hooks/useFarmSocket", () => ({ useFarmSocket: jest.fn() }));
jest.mock("../src/services/api", () => ({
  api: {
    farms: jest.fn().mockResolvedValue([{ id: "farm-1", name: "Vườn 1" }]),
    overview: jest.fn().mockResolvedValue({ farm: { id: "farm-1", name: "Vườn 1" }, zones: [] }),
    alerts: jest.fn().mockResolvedValue([]),
    users: jest.fn().mockResolvedValue([]),
    devices: jest.fn().mockResolvedValue([]),
    unbindDevice: jest.fn(),
    adminDevices: jest.fn().mockResolvedValue([]),
    mapOverview: jest.fn().mockResolvedValue([]),
    irrigationLogs: jest.fn().mockResolvedValue({ logs: [] }),
    resolveAlert: jest.fn().mockResolvedValue(undefined),
    irrigate: jest.fn().mockResolvedValue({}),
    emergencyStop: jest.fn().mockResolvedValue(undefined),
  },
}));

const user = { id: "user-1", email: "grower@example.com", name: "Grower", role: "USER" as const, farms: [{ id: "farm-1", name: "Vườn 1" }] };

describe("root navigation", () => {
  it("gives an ADMIN a system overview rather than a customer-device dashboard", async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <PreferencesProvider>
          <NavigationContainer>
            <RootNavigator
              loading={false}
              user={{ ...user, role: "ADMIN" }}
              token="mobile-token"
              onLogout={jest.fn().mockResolvedValue(undefined)}
            />
          </NavigationContainer>
        </PreferencesProvider>,
      );
    });

    const textNodes = renderer!.root.findAllByType("Text" as any);
    expect(textNodes.some((node) => node.props.children === "Trang trại")).toBe(true);
    expect(textNodes.some((node) => node.props.children === "Bản đồ")).toBe(true);
    expect(textNodes.some((node) => node.props.children === "Tổng quan hệ thống")).toBe(true);
    expect(textNodes.some((node) => node.props.children === "Trang trại canh tác")).toBe(false);
  });

  it("shows all four home sensor readings without the soil estimate note", async () => {
    const overview = jest.mocked(api.overview);
    const original = overview.getMockImplementation()!;
    overview.mockResolvedValue({
      farm: user.farms[0],
      zones: [{
        id: "zone-1", farm_id: "farm-1", name: "Khu vực 1",
        telemetries: [{
          timestamp: new Date().toISOString(), quality: 1,
          soil_moisture: 0, soil_temp: 28.19, air_temp: 28.49, air_humidity: 65.01,
        }],
      }],
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <PreferencesProvider><NavigationContainer><RootNavigator loading={false} user={user} token="mobile-token" onLogout={jest.fn()} /></NavigationContainer></PreferencesProvider>,
        );
      });
      const text = renderer!.root.findAllByType("Text" as any).map(node => node.props.children);
      expect(text).toEqual(expect.arrayContaining([
        "Độ ẩm đất", "Nhiệt độ đất", "Nhiệt độ không khí", "Độ ẩm không khí",
        "0%", "28.19°C", "28.49°C", "65.01%",
      ]));
      expect(text).not.toContain("Độ ẩm đất là giá trị thử nghiệm, chưa hiệu chuẩn.");
      expect(text).not.toContain("Cường độ sáng");
    } finally {
      overview.mockImplementation(original);
      await ReactTestRenderer.act(async () => { renderer?.unmount(); });
    }
  });

  it("declares onboarding as a full-screen stack route and supports back navigation", async () => {
    expect(ONBOARDING_SCREEN_OPTIONS.presentation).toBe("fullScreenModal");

    const navigationRef = createNavigationContainerRef<RootStackParamList>();
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <NavigationContainer ref={navigationRef}>
          <PreferencesProvider>
            <RootNavigator loading={false} user={user} token="mobile-token" onLogout={jest.fn().mockResolvedValue(undefined)} />
          </PreferencesProvider>
        </NavigationContainer>,
      );
    });

    expect(navigationRef.getCurrentRoute()?.name).toBe("Overview");
    await ReactTestRenderer.act(async () => { navigationRef.navigate("Onboarding"); });
    expect(navigationRef.getCurrentRoute()?.name).toBe("Onboarding");
    await ReactTestRenderer.act(async () => { navigationRef.goBack(); });
    expect(navigationRef.getCurrentRoute()?.name).toBe("Overview");
  });

  it("removes an online board on the setup screen after the server confirms account release", async () => {
    const navigationRef = createNavigationContainerRef<RootStackParamList>();
    const listDevices = jest.mocked(api.devices);
    const unbindDevice = jest.mocked(api.unbindDevice);
    listDevices.mockResolvedValue([{
      id: "NODE_TEST", name: "Node test", type: "SENSOR_NODE", online: true,
      is_activated: true, can_unbind: true, farm: user.farms[0],
    } as Awaited<ReturnType<typeof api.devices>>[number]]);
    unbindDevice.mockImplementation(async () => {
      listDevices.mockResolvedValue([]);
      return { status: "APPLIED" };
    });
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    try {
      await ReactTestRenderer.act(async () => {
        renderer = ReactTestRenderer.create(
          <PreferencesProvider><NavigationContainer ref={navigationRef}><RootNavigator loading={false} user={user} token="mobile-token" onLogout={jest.fn()} /></NavigationContainer></PreferencesProvider>,
        );
      });
      await ReactTestRenderer.act(async () => { navigationRef.navigate("Main", { screen: "Devices" }); });
      expect(navigationRef.getCurrentRoute()?.name).toBe("Devices");
      const setup = renderer!.root.findAll((button) => button.props.accessibilityLabel === "Mở cài đặt thiết bị" && typeof button.props.onPress === "function")[0];
      expect(setup).toBeDefined();
      await ReactTestRenderer.act(async () => { setup!.props.onPress(); });
      expect(navigationRef.getCurrentRoute()?.name).toBe("Onboarding");
      const releaseLabel = "Gỡ khỏi tài khoản Node test";
      const release = renderer!.root.findAll((button) => button.props.accessibilityLabel === releaseLabel && typeof button.props.style === "function")[0];
      expect(release).toBeDefined();
      expect(StyleSheet.flatten(release!.props.style({ pressed: false })).minHeight).toBe(48);
      await ReactTestRenderer.act(async () => { release!.props.onPress(); });
      expect(navigationRef.getCurrentRoute()?.name).toBe("Onboarding");
      const visibleDialog = renderer!.root.findAllByType(Modal).find((dialog) => dialog.props.visible);
      expect(visibleDialog?.findAllByType("Text" as any).some((element) => element.props.children === "Gỡ thiết bị khỏi tài khoản")).toBe(true);
      expect(unbindDevice).not.toHaveBeenCalled();
      const confirm = visibleDialog?.findAll((button) =>
        typeof button.props.onPress === "function" && button.props.children?.props?.children === "Gỡ khỏi tài khoản",
      )[0];
      expect(confirm).toBeDefined();
      await ReactTestRenderer.act(async () => { confirm!.props.onPress(); });
      expect(unbindDevice).toHaveBeenCalledWith("NODE_TEST");
      expect(renderer!.root.findAll((element) => element.props.accessibilityLabel === releaseLabel)).toHaveLength(0);
      const successDialog = renderer!.root.findAllByType(Modal).find((dialog) => dialog.props.visible);
      expect(successDialog?.findAllByType("Text" as any).some((element) => element.props.children === "Đã gỡ thiết bị")).toBe(true);
    } finally {
      listDevices.mockResolvedValue([]);
      unbindDevice.mockReset();
      await ReactTestRenderer.act(async () => { renderer?.unmount(); });
    }
  });

  it("does not render ADMIN-only tabs for a USER", async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <PreferencesProvider><NavigationContainer><RootNavigator loading={false} user={user} token="mobile-token" onLogout={jest.fn().mockResolvedValue(undefined)} /></NavigationContainer></PreferencesProvider>,
      );
    });
    const textNodes = renderer!.root.findAllByType("Text" as any);
    expect(textNodes.some((node) => node.props.children === "Vận hành hệ thống")).toBe(false);
    expect(textNodes.some((node) => node.props.children === "Trang trại")).toBe(false);
    expect(textNodes.some((node) => node.props.children === "Bản đồ")).toBe(true);
  });

  it("opens alerts from the global header instead of a bottom tab", async () => {
    const navigationRef = createNavigationContainerRef<RootStackParamList>();
    let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <NavigationContainer ref={navigationRef}><PreferencesProvider><RootNavigator loading={false} user={user} token="mobile-token" onLogout={jest.fn().mockResolvedValue(undefined)} /></PreferencesProvider></NavigationContainer>,
      );
    });

    const alertButton = renderer!.root.find((node) => node.props.accessibilityLabel === "Cảnh báo: không có cảnh báo mở");
    await ReactTestRenderer.act(async () => { alertButton.props.onPress(); });
    expect(navigationRef.getCurrentRoute()?.name).toBe("Alerts");
  });

  it("uses a visual splash without technical loading copy", async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <PreferencesProvider>
          <RootNavigator
            loading={true}
            user={null}
            token={null}
            onLogout={jest.fn().mockResolvedValue(undefined)}
          />
        </PreferencesProvider>,
      );
    });

    const splash = renderer!.root.find((node) => node.props.accessibilityLabel === "Đang mở FarmOS");
    expect(splash).toBeTruthy();
    expect(renderer!.root.findAllByType("Text" as any)).toHaveLength(0);
  });

  it("preloads admin devices and devices in the background at launch", async () => {
    const { api } = require("../src/services/api");
    api.adminDevices.mockClear();
    api.devices.mockClear();

    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <PreferencesProvider>
          <NavigationContainer>
            <RootNavigator
              loading={false}
              user={{ ...user, role: "ADMIN" }}
              token="mobile-token"
              onLogout={jest.fn().mockResolvedValue(undefined)}
            />
          </NavigationContainer>
        </PreferencesProvider>,
      );
    });

    expect(api.devices).toHaveBeenCalled();
    expect(api.adminDevices).toHaveBeenCalled();
  });
});
