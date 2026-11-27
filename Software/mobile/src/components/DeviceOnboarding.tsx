import { useCallback, useEffect, useMemo, useRef, useState, type ElementRef } from "react";
import { fontWeight } from "../theme/typography";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Pressable, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { config } from "../config";
import { api } from "../services/api";
import { attestClaimSession, attestExistingDeviceSession, BleProvisioningSecurityError, configureAttestedExistingNode, configureAttestedNode, configureNodePairing, ExistingDeviceIdentityExpectation, NearbyFarmDevice, provisionAttestedCloudDevice, provisionAttestedExistingDevice, provisionCloudDevice, scanFarmDevices } from "../services/deviceBle";
import { parseDeviceQr, type ParsedDeviceQr } from "../services/qr";
import type { DeploymentMode, FarmDevice, ResolvedDeviceQr, ResolvedDeviceQrV3, Zone } from "../types";
import { CLOUD_PROVISIONING_TIMEOUT_MS, isAbortLikeError, isRetryableOnboardingError, LEAF_PAIRING_TIMEOUT_MS, OnboardingStatusFailedError, OnboardingStatusTimeoutError, pollOnboardingStatus } from "../services/onboardingStatus";
import { QrScanner } from "./QrScanner";
import { isBluetoothPermissionError, isLocationServicesDisabledError, openAndroidLocationSettings, openAppSettings, requiresAndroidLocationService } from "../services/androidSettings";
import { SetupLocationPicker, type SetupLocation } from "./SetupLocationPicker";
import { useAppAlert } from "./AppDialog";

export function isZoneInFarm(zoneId: string, farmId: string, zones: Zone[]): boolean {
  return Boolean(zoneId) && zones.some((zone) => zone.id === zoneId && zone.farm_id === farmId);
}

type ResolvedOnboardingQr = ResolvedDeviceQr | ResolvedDeviceQrV3;

function isResolvedV3(value: ResolvedOnboardingQr): value is ResolvedDeviceQrV3 {
  return "identity" in value;
}

export function allowedModesForDevice(device: Pick<FarmDevice, "type" | "capabilities">): DeploymentMode[] {
  const capabilities = device.capabilities?.length
    ? device.capabilities
    : device.type === "GATEWAY" ? ["GATEWAY"] : ["WIFI", "LORA", "SENSOR_DS18B20"];
  if (device.type === "GATEWAY") return capabilities.includes("GATEWAY") ? ["GATEWAY"] : [];
  return [
    ...(capabilities.includes("LORA") && capabilities.some((item) => item.startsWith("SENSOR_")) ? ["LEAF_NODE" as const] : []),
    ...(capabilities.includes("WIFI") && capabilities.some((item) => item.startsWith("SENSOR_")) ? ["STANDALONE_NODE" as const] : []),
  ];
}

function resolvedSummary(value: ResolvedOnboardingQr) {
  if (isResolvedV3(value)) {
    const capabilities = value.identity.capabilities || [];
    const allowedModes = allowedModesForDevice({ type: value.identity.type, capabilities });
    return {
      deviceId: value.identity.deviceId,
      serialNumber: value.identity.serial,
      model: value.identity.model,
      capabilities,
      hardwareType: value.identity.type,
      allowedModes,
    };
  }
  return value;
}

export function DeviceOnboarding({ farmId, zones, onChanged }: { farmId: string; zones: Zone[]; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const appAlert = useAppAlert();
  const [devices, setDevices] = useState<FarmDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesLoadFailed, setDevicesLoadFailed] = useState(false);
  const [refreshingDevices, setRefreshingDevices] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [deviceQr, setDeviceQr] = useState<ParsedDeviceQr | null>(null);
  const [resolved, setResolved] = useState<ResolvedOnboardingQr | null>(null);
  const [selectedMode, setSelectedMode] = useState<DeploymentMode | null>(null);
  const [switchDevice, setSwitchDevice] = useState<FarmDevice | null>(null);
  const [wifiReconfigure, setWifiReconfigure] = useState(false);
  const [switchMode, setSwitchMode] = useState<DeploymentMode | null>(null);
  const [switchGatewayId, setSwitchGatewayId] = useState("");
  const [switchZoneId, setSwitchZoneId] = useState(zones[0]?.id || "");
  const [ssid, setSsid] = useState(""); const [wifiPassword, setWifiPassword] = useState("");
  const [nearbyDevices, setNearbyDevices] = useState<NearbyFarmDevice[]>([]);
  const [gatewayId, setGatewayId] = useState(""); const [zoneId, setZoneId] = useState(zones[0]?.id || "");
  const [setupLocation, setSetupLocation] = useState<SetupLocation | null>(null);
  const [locationPickerVisible, setLocationPickerVisible] = useState(false);
  const wifiPasswordRef = useRef<ElementRef<typeof TextInput>>(null);
  const scrollRef = useRef<ElementRef<typeof ScrollView>>(null);
  const devicesRequestRef = useRef(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<string | null>(null);
  const [locationServicesDisabled, setLocationServicesDisabled] = useState(false);
  const scanCleanupRef = useRef<(() => void) | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanGenerationRef = useRef(0);
  const statusAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const previousFarmIdRef = useRef(farmId);
  const farmDevices = useMemo(() => devices.filter((device) => device.is_activated && device.farm?.id === farmId), [devices, farmId]);
  const gateways = useMemo(() => devices.filter((device) => device.is_activated && device.type === "GATEWAY" && device.farm?.id === farmId), [devices, farmId]);

  const cancelOnboardingWait = useCallback(() => {
    statusAbortRef.current?.abort();
    statusAbortRef.current = null;
  }, []);

  const beginOnboardingWait = useCallback((message: string): AbortController => {
    cancelOnboardingWait();
    const controller = new AbortController();
    statusAbortRef.current = controller;
    if (mountedRef.current) setOnboardingStatus(message);
    return controller;
  }, [cancelOnboardingWait]);

  const showScanError = useCallback((error: Error) => {
    if (isBluetoothPermissionError(error)) {
      appAlert(t("onboarding.bluetoothPermissionNeeded"), error.message, [
        { text: t("common.close"), style: "cancel" },
        { text: t("onboarding.openSettings"), onPress: () => { openAppSettings().catch(() => undefined); } },
      ]);
      return;
    }
    appAlert(t("onboarding.cannotScanBluetooth"), error.message);
  }, [appAlert, t]);

  const load = useCallback(async () => {
    const requestId = ++devicesRequestRef.current;
    const isCurrent = () => mountedRef.current && requestId === devicesRequestRef.current;
    try {
      const nextDevices = await api.devices();
      if (isCurrent()) {
        setDevices(nextDevices);
        setDevicesLoadFailed(false);
      }
    } catch (error) {
      if (isCurrent()) setDevicesLoadFailed(true);
      throw error;
    } finally {
      if (isCurrent()) setDevicesLoading(false);
    }
  }, []);
  useEffect(() => { load().catch(() => undefined); }, [load]);

  const refreshDevices = async () => {
    setRefreshingDevices(true);
    try {
      await load();
    } catch (error) {
      if (mountedRef.current) appAlert(t("common.error"), error instanceof Error ? error.message : t("common.error"));
    } finally {
      if (mountedRef.current) setRefreshingDevices(false);
    }
  };

  const stopScan = useCallback(() => {
    cancelOnboardingWait();
    scanGenerationRef.current += 1;
    scanCleanupRef.current?.();
    scanCleanupRef.current = null;
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = null;
    setBusy((current) => current === "scan-device" ? null : current);
  }, [cancelOnboardingWait]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
    mountedRef.current = false;
    cancelOnboardingWait();
    scanGenerationRef.current += 1;
    scanCleanupRef.current?.();
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    };
  }, [cancelOnboardingWait]);

  useEffect(() => {
    if (previousFarmIdRef.current !== farmId) {
      stopScan();
      setScanner(false);
      setDeviceQr(null);
      setResolved(null);
      setSelectedMode(null);
      setSwitchDevice(null);
      setWifiReconfigure(false);
      setSwitchMode(null);
      setSwitchGatewayId("");
      setGatewayId("");
      setNearbyDevices([]);
      setLocationServicesDisabled(false);
      previousFarmIdRef.current = farmId;
    }
  }, [farmId, stopScan]);

  useEffect(() => {
    setZoneId((currentZoneId) => {
      if (isZoneInFarm(currentZoneId, farmId, zones)) return currentZoneId;
      return zones.find((zone) => zone.farm_id === farmId)?.id || "";
    });
  }, [farmId, zones]);

  useEffect(() => {
    setSwitchZoneId((currentZoneId) => isZoneInFarm(currentZoneId, farmId, zones)
      ? currentZoneId
      : zones.find((zone) => zone.farm_id === farmId)?.id || "");
  }, [farmId, zones]);

  const scan = async (type: "GATEWAY" | "SENSOR_NODE") => {
    stopScan();
    const generation = scanGenerationRef.current;
    setNearbyDevices([]); setBusy("scan-device"); setLocationServicesDisabled(false);
    try {
      const cleanup = await scanFarmDevices(
        type,
        (found) => {
          if (mountedRef.current && generation === scanGenerationRef.current) {
            setNearbyDevices((current) => [...current.filter((item) => item.bleId !== found.bleId), found]);
          }
        },
        12_000,
        (error) => {
          if (!mountedRef.current || generation !== scanGenerationRef.current) return;
          const locationDisabled = requiresAndroidLocationService() && isLocationServicesDisabledError(error);
          setLocationServicesDisabled(locationDisabled);
          stopScan();
          if (!locationDisabled) showScanError(error);
        },
      );
      if (!mountedRef.current || generation !== scanGenerationRef.current) {
        cleanup();
        return;
      }
      scanCleanupRef.current = cleanup;
      scanTimerRef.current = setTimeout(() => {
        if (!mountedRef.current || generation !== scanGenerationRef.current) return;
        cleanup();
        scanCleanupRef.current = null;
        scanTimerRef.current = null;
        setBusy((current) => current === "scan-device" ? null : current);
      }, 12_100);
    } catch (error) {
      if (!mountedRef.current || generation !== scanGenerationRef.current) return;
      const locationDisabled = requiresAndroidLocationService() && isLocationServicesDisabledError(error);
      setLocationServicesDisabled(locationDisabled);
      setBusy(null);
      if (!locationDisabled) showScanError(error instanceof Error ? error : new Error("Lỗi BLE"));
    }
  };

  const openLocationSettings = async () => {
    await openAndroidLocationSettings();
  };

  const acceptQr = async (value: string) => {
    setScanner(false); setBusy("resolve-qr");
    try {
      const qr = parseDeviceQr(value);
      const result = qr.version === 3
        ? await api.resolveQrV3(qr.payload)
        : await api.resolveDeviceQr({ deviceId: qr.legacy.deviceId, claimCode: qr.legacy.claim });
      const summary = resolvedSummary(result);
      if (qr.version === 3) {
        if (!isResolvedV3(result) || !result.claimable) {
          throw new Error(`Thiết bị đang ở trạng thái ${isResolvedV3(result) ? result.identity.state : "không xác định"}; chỉ thiết bị READY_TO_SHIP mới được claim`);
        }
      }
      if (!mountedRef.current) return;
      setDeviceQr(qr); setResolved(result); setSelectedMode(summary.allowedModes.length === 1 ? summary.allowedModes[0] : null);
      await scan(summary.hardwareType);
    } catch (error) {
      if (!mountedRef.current) return;
      appAlert(t("onboarding.invalidQrTitle"), error instanceof Error ? error.message : t("onboarding.cannotReadQr")); setBusy(null);
    }
  };

  const [cloudSetupError, setCloudSetupError] = useState<string | null>(null);

  const completeSetup = async (message: string) => {
    await load().catch(() => undefined);
    if (!mountedRef.current) return;
    setDeviceQr(null);
    setResolved(null);
    setSelectedMode(null);
    setSsid("");
    setWifiPassword("");
    setNearbyDevices([]);
    setOnboardingStatus(null);
    setBusy(null);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
    appAlert(t("onboarding.deviceAddedTitle"), message);
    void onChanged().catch(() => undefined);
  };

  const finishCloudDevice = async (nearby: NearbyFarmDevice) => {
    if (!deviceQr || !resolved || !selectedMode || selectedMode === "LEAF_NODE" || !ssid.trim()) return appAlert(t("onboarding.missingInfoTitle"), t("onboarding.missingCloudModeOrWifi"));
    if (!isZoneInFarm(zoneId, farmId, zones)) return appAlert(t("onboarding.missingZoneTitle"), t("onboarding.missingZoneDesc"));
    setCloudSetupError(null);
    Keyboard.dismiss();
    stopScan();
    setBusy(`device:${nearby.bleId}`);
    let step = t("onboarding.step03");
    let statusController: AbortController | null = null;
    try {
      const summary = resolvedSummary(resolved);
      const deviceId = summary.deviceId;
      if (deviceQr.version === 3) {
        // v3 claim order is intentional: QR resolve -> claim challenge ->
        // physical BLE attestation -> API attest/finalize -> provisioning.
        const claimSession = await api.createQrClaimSession({
          payload: deviceQr.payload,
          farmId,
          zoneId,
          deploymentMode: selectedMode,
        });
        step = t("onboarding.selectBleLabel");
        const proof = await attestClaimSession(nearby, deviceQr.payload, claimSession);
        step = "FarmOS";
        await api.attestQrClaimSession(claimSession.sessionId, {
          signature: proof.signature,
          nonce: proof.nonce || claimSession.nonce || "",
          provisioningToken: claimSession.provisioningToken || claimSession.challenge,
        });
        const finalized = await api.finalizeQrClaimSession(claimSession.sessionId, { name: summary.model || deviceId, ...(setupLocation || {}) });
        const provisioningSession = finalized.provisioning;
        if (!provisioningSession?.sessionId) throw new Error("Server không trả provisioning session cho thiết bị cloud");
        step = "Wi-Fi / BLE";
        await provisionAttestedCloudDevice(nearby, deviceQr.payload, {
          deploymentMode: selectedMode,
          ssid: ssid.trim(),
          password: wifiPassword,
          apiBaseUrl: config.apiBaseUrl,
          sessionId: claimSession.sessionId,
          provisioningToken: provisioningSession.provisioningToken || claimSession.provisioningToken || claimSession.challenge,
          signature: proof.signature,
          nonce: proof.nonce,
        });
        step = "Wi-Fi / FarmOS";
        if (!mountedRef.current) return;
        statusController = beginOnboardingWait(t("onboarding.bleConfigWrittenWaitingCloud"));
        await pollOnboardingStatus(
          (signal, timeoutMs) => api.cloudDeviceSessionStatus(provisioningSession.sessionId, { signal, timeoutMs }),
          {
            timeoutMs: CLOUD_PROVISIONING_TIMEOUT_MS,
            signal: statusController.signal,
            retryOnError: isRetryableOnboardingError,
            onStateChange: (state) => {
              if (!mountedRef.current) return;
              if (state === "RETRYING") setOnboardingStatus(t("onboarding.tempDisconnectRetryingStatus"));
              if (state === "PENDING") setOnboardingStatus(t("onboarding.bleConfigWrittenWaitingCloud"));
            },
          },
          (result) => result.status === "REDEEMED",
          ["EXPIRED", "CANCELLED"],
        );
        if (!mountedRef.current) return;
        await completeSetup(t("onboarding.cloudDeviceAddedMessage", { deviceId }));
        return;
      }

      const session = await api.createCloudDeviceSession({ deviceId, claimCode: deviceQr.legacy.claim, farmId, zoneId, deploymentMode: selectedMode });
      await provisionCloudDevice(nearby, deviceId, { deploymentMode: selectedMode, ssid: ssid.trim(), password: wifiPassword, apiBaseUrl: config.apiBaseUrl, sessionId: session.sessionId, provisioningToken: session.provisioningToken });
      if (!mountedRef.current) return;
      setWifiPassword("");
      statusController = beginOnboardingWait(t("onboarding.bleConfigWrittenWaitingCloud"));
      await pollOnboardingStatus(
        (signal, timeoutMs) => api.cloudDeviceSessionStatus(session.sessionId, { signal, timeoutMs }),
        {
          timeoutMs: CLOUD_PROVISIONING_TIMEOUT_MS,
          signal: statusController.signal,
          retryOnError: isRetryableOnboardingError,
          onStateChange: (state) => {
            if (!mountedRef.current) return;
            if (state === "RETRYING") setOnboardingStatus(t("onboarding.tempDisconnectRetryingStatus"));
            if (state === "PENDING") setOnboardingStatus(t("onboarding.bleConfigWrittenWaitingCloud"));
          },
        },
        (result) => result.status === "REDEEMED",
        ["EXPIRED", "CANCELLED"],
      );
      if (!mountedRef.current) return;
      await completeSetup(selectedMode === "GATEWAY" ? t("onboarding.gatewayConnectedMessage") : t("onboarding.standaloneConnectedMessage"));
    } catch (error) {
      if (!mountedRef.current || isAbortLikeError(error)) return;
      setCloudSetupError(`${step} — ${error instanceof Error ? error.message : t("onboarding.setupFailed")}`);
      if (error instanceof BleProvisioningSecurityError) {
        appAlert(t("onboarding.blePairingNeeded"), error.message);
      } else if (error instanceof OnboardingStatusTimeoutError) {
        appAlert(t("onboarding.deviceNotConfirmedTitle"), t("onboarding.timeoutNotConfirmed"));
      } else if (error instanceof OnboardingStatusFailedError) {
        appAlert(t("onboarding.provisioningIncompleteTitle"), t("onboarding.provisioningIncomplete", { message: error.message }));
      } else {
        appAlert(t("onboarding.setupFailed"), error instanceof Error ? error.message : "Lỗi provisioning");
      }
    }
    finally {
      if (statusController && statusAbortRef.current === statusController) statusAbortRef.current = null;
      if (mountedRef.current) {
        setOnboardingStatus(null);
        setBusy(null);
      }
    }
  };

  const finishLeafNode = async (nearby: NearbyFarmDevice) => {
    if (!deviceQr || !gatewayId || !isZoneInFarm(zoneId, farmId, zones)) return appAlert(t("onboarding.missingInfoTitle"), t("onboarding.missingGatewayAndZoneForNode"));
    stopScan();
    setBusy("pair-node");
    let statusController: AbortController | null = null;
    try {
      const summary = resolved ? resolvedSummary(resolved) : null;
      const deviceId = summary?.deviceId || (deviceQr.version === 3 ? deviceQr.payload.deviceId : deviceQr.legacy.deviceId);
      if (deviceQr.version === 3) {
        const claimSession = await api.createQrClaimSession({
          payload: deviceQr.payload,
          farmId,
          zoneId,
          deploymentMode: "LEAF_NODE",
        });
        const proof = await attestClaimSession(nearby, deviceQr.payload, claimSession);
        await api.attestQrClaimSession(claimSession.sessionId, {
          signature: proof.signature,
          nonce: proof.nonce || claimSession.nonce || "",
          provisioningToken: claimSession.provisioningToken || claimSession.challenge,
        });
        const finalized = await api.finalizeQrClaimSession(claimSession.sessionId, { name: summary?.model || deviceId, gatewayId, ...(setupLocation || {}) });
        if (!finalized.pairing) throw new Error("Server không trả pairing session cho LEAF_NODE");
        await configureAttestedNode(nearby, deviceQr.payload, {
          gatewayId,
          pairingId: finalized.pairing.pairingId,
          radioToken: finalized.pairing.radioToken,
          sessionId: claimSession.sessionId,
          provisioningToken: claimSession.provisioningToken || claimSession.challenge,
          signature: proof.signature,
          nonce: proof.nonce,
          expiresAt: finalized.pairing.expiresAt,
        });
        if (!mountedRef.current) return;
        statusController = beginOnboardingWait(t("onboarding.bleConfigWrittenWaitingGateway"));
        await pollOnboardingStatus(
          (signal, timeoutMs) => api.pairingStatus(finalized.pairing!.pairingId, { signal, timeoutMs }),
          {
            timeoutMs: LEAF_PAIRING_TIMEOUT_MS,
            signal: statusController.signal,
            retryOnError: isRetryableOnboardingError,
            onStateChange: (state) => {
              if (!mountedRef.current) return;
              if (state === "RETRYING") setOnboardingStatus(t("onboarding.retryingStatusGateway"));
              if (state === "PENDING") setOnboardingStatus(t("onboarding.bleConfigWrittenWaitingGateway"));
            },
          },
          (result) => result.status === "ACTIVE",
          ["FAILED", "EXPIRED", "CANCELLED"],
        );
        if (!mountedRef.current) return;
        await completeSetup(t("onboarding.leafAddedGatewayMessage", { deviceId }));
        return;
      }

      const session = await api.createNodePairingSession({ nodeId: deviceId, possessionCode: deviceQr.legacy.claim, gatewayId, farmId, zoneId });
      await configureNodePairing(nearby, deviceId, { pairingId: session.pairingId, gatewayId, radioToken: session.radioToken, expiresAt: session.expiresAt });
      if (!mountedRef.current) return;
      statusController = beginOnboardingWait(t("onboarding.bleConfigWrittenWaitingGateway"));
      await pollOnboardingStatus(
        (signal, timeoutMs) => api.pairingStatus(session.pairingId, { signal, timeoutMs }),
        {
          timeoutMs: LEAF_PAIRING_TIMEOUT_MS,
          signal: statusController.signal,
          retryOnError: isRetryableOnboardingError,
          onStateChange: (state) => {
            if (!mountedRef.current) return;
            if (state === "RETRYING") setOnboardingStatus(t("onboarding.retryingStatusGateway"));
            if (state === "PENDING") setOnboardingStatus(t("onboarding.bleConfigWrittenWaitingGateway"));
          },
        },
        (result) => result.status === "ACTIVE",
        ["FAILED", "EXPIRED", "CANCELLED"],
      );
      if (!mountedRef.current) return;
      await completeSetup(t("onboarding.leafAddedSignalMessage", { deviceId }));
    } catch (error) {
      if (!mountedRef.current || isAbortLikeError(error)) return;
      if (error instanceof BleProvisioningSecurityError) {
        appAlert(t("onboarding.blePairingNeeded"), error.message);
      } else if (error instanceof OnboardingStatusTimeoutError) {
        appAlert(t("onboarding.timeoutGatewayConfirm"), t("onboarding.timeoutGatewayDesc"));
      } else if (error instanceof OnboardingStatusFailedError) {
        appAlert(t("onboarding.pairingIncomplete"), `${error.message}. Hãy kiểm tra khoảng cách LoRa và thử lại.`);
      } else {
        appAlert(t("onboarding.nodePairingFailed"), error instanceof Error ? error.message : "Lỗi pairing");
      }
    }
    finally {
      if (statusController && statusAbortRef.current === statusController) statusAbortRef.current = null;
      if (mountedRef.current) {
        setOnboardingStatus(null);
        setBusy(null);
      }
    }
  };

  const openModeSwitch = (device: FarmDevice, reconfigureWifi = false) => {
    const modes = allowedModesForDevice(device);
    const currentMode = device.deployment_mode;
    if (reconfigureWifi
      ? !device.can_reconfigure_wifi || (currentMode !== "GATEWAY" && currentMode !== "STANDALONE_NODE")
      : device.type === "GATEWAY" || modes.length < 2) return;
    stopScan();
    setDeviceQr(null);
    setResolved(null);
    setSelectedMode(null);
    setSwitchDevice(device);
    setWifiReconfigure(reconfigureWifi);
    setSwitchMode(reconfigureWifi ? currentMode ?? null : null);
    setSsid("");
    setWifiPassword("");
    setSwitchGatewayId(device.gateway_id || gateways[0]?.id || "");
    setSwitchZoneId(device.zone?.id || zoneId);
    setNearbyDevices([]);
    scan(device.type).catch(() => undefined);
  };

  const finishModeSwitch = async (nearby: NearbyFarmDevice) => {
    const device = switchDevice;
    const mode = switchMode;
    if (!device || !mode) return;
    if (mode === "LEAF_NODE" && (!switchGatewayId || !isZoneInFarm(switchZoneId, farmId, zones))) {
      appAlert(t("onboarding.missingInfoTitle"), t("onboarding.missingGatewayAndZoneForLora"));
      return;
    }
    if (!wifiReconfigure && mode === "STANDALONE_NODE" && !isZoneInFarm(switchZoneId, farmId, zones)) {
      appAlert(t("onboarding.missingZoneTitle"), t("onboarding.missingZoneForWifiNode"));
      return;
    }
    if (mode !== "LEAF_NODE" && !ssid.trim()) {
      appAlert(t("onboarding.missingInfoTitle"), t("onboarding.missingWifiForStandalone"));
      return;
    }
    stopScan();
    setBusy(`switch:${nearby.bleId}`);
    let statusController: AbortController | null = null;
    try {
      const session = await api.createDeviceModeSession({
        deviceId: device.id,
        farmId,
        zoneId: mode === "GATEWAY" ? undefined : switchZoneId,
        gatewayId: mode === "LEAF_NODE" ? switchGatewayId : undefined,
        deploymentMode: mode,
        wifiReconfigure,
      });
      const expected: ExistingDeviceIdentityExpectation = {
        deviceId: session.identity.deviceId,
        type: session.identity.type,
        serialNumber: session.identity.serial,
        hardwareRevision: session.identity.hardwareRevision,
      };
      const proof = await attestExistingDeviceSession(nearby, expected, session);
      await api.attestQrClaimSession(session.sessionId, {
        signature: proof.signature,
        nonce: proof.nonce || session.nonce || "",
        provisioningToken: session.provisioningToken || session.challenge,
      });
      const finalized = await api.finalizeQrClaimSession(session.sessionId, {
        name: device.name || device.id,
        gatewayId: mode === "LEAF_NODE" ? switchGatewayId : undefined,
        ...(setupLocation || {}),
      });
      if (mode === "LEAF_NODE") {
        if (!finalized.pairing) throw new Error("Server không trả pairing session cho mode LoRa");
        await configureAttestedExistingNode(nearby, expected, {
          gatewayId: switchGatewayId,
          pairingId: finalized.pairing.pairingId,
          radioToken: finalized.pairing.radioToken,
          sessionId: session.sessionId,
          provisioningToken: session.provisioningToken || session.challenge,
          signature: proof.signature,
          nonce: proof.nonce,
          expiresAt: finalized.pairing.expiresAt,
        });
        statusController = beginOnboardingWait(t("onboarding.bleLoraWrittenWaitingGateway"));
        await pollOnboardingStatus(
          (signal, timeoutMs) => api.pairingStatus(finalized.pairing!.pairingId, { signal, timeoutMs }),
          {
            timeoutMs: LEAF_PAIRING_TIMEOUT_MS,
            signal: statusController.signal,
            retryOnError: isRetryableOnboardingError,
            onStateChange: (state) => {
              if (!mountedRef.current) return;
              if (state === "RETRYING") setOnboardingStatus(t("onboarding.retryingStatusGateway"));
              if (state === "PENDING") setOnboardingStatus(t("onboarding.bleLoraWrittenWaitingGateway"));
            },
          },
          (result) => result.status === "ACTIVE",
          ["FAILED", "EXPIRED", "CANCELLED"],
        );
      } else {
        await provisionAttestedExistingDevice(nearby, expected, {
          deploymentMode: mode,
          ssid: ssid.trim(),
          password: wifiPassword,
          apiBaseUrl: config.apiBaseUrl,
          sessionId: session.sessionId,
          provisioningToken: finalized.provisioning?.provisioningToken || session.provisioningToken || session.challenge,
          signature: proof.signature,
          nonce: proof.nonce,
        });
        const provisioningSession = finalized.provisioning;
        if (!provisioningSession?.sessionId) throw new Error("Server không trả provisioning session cho mode Wi‑Fi");
        statusController = beginOnboardingWait(t("onboarding.bleWifiWrittenWaitingDevice"));
        await pollOnboardingStatus(
          (signal, timeoutMs) => api.cloudDeviceSessionStatus(provisioningSession.sessionId, { signal, timeoutMs }),
          {
            timeoutMs: CLOUD_PROVISIONING_TIMEOUT_MS,
            signal: statusController.signal,
            retryOnError: isRetryableOnboardingError,
            onStateChange: (state) => {
              if (!mountedRef.current) return;
              if (state === "RETRYING") setOnboardingStatus(t("onboarding.tempDisconnectRetryingStatus"));
              if (state === "PENDING") setOnboardingStatus(t("onboarding.bleWifiWrittenWaitingDevice"));
            },
          },
          (result) => result.status === "REDEEMED",
          ["EXPIRED", "CANCELLED"],
        );
      }
      if (!mountedRef.current) return;
      if (wifiReconfigure) {
        appAlert(t("onboarding.wifiChangedTitle"), t("onboarding.wifiChangedMessage"));
      } else {
        appAlert(t("onboarding.modeSwitchedTitle"), mode === "LEAF_NODE" ? t("onboarding.modeSwitchedLeafMessage") : t("onboarding.modeSwitchedStandaloneMessage"));
      }
      setSwitchDevice(null); setWifiReconfigure(false); setSwitchMode(null); setSwitchGatewayId(""); setNearbyDevices([]); setWifiPassword(""); setSsid("");
      await load(); await onChanged();
    } catch (error) {
      if (!mountedRef.current || isAbortLikeError(error)) return;
      if (error instanceof BleProvisioningSecurityError) {
        appAlert(t("onboarding.blePairingNeeded"), error.message);
      } else if (wifiReconfigure) {
        appAlert(t("onboarding.wifiChangeFailed"), error instanceof Error ? error.message : t("onboarding.wifiChangeFailed"));
      } else if (error instanceof OnboardingStatusTimeoutError) {
        appAlert(t("onboarding.modeSwitchNotConfirmed"), t("onboarding.modeSwitchNotConfirmed"));
      } else if (error instanceof OnboardingStatusFailedError) {
        appAlert(t("onboarding.modeSwitchFailed"), t("onboarding.modeSwitchIncomplete", { message: error.message }));
      } else {
        appAlert(t("onboarding.modeSwitchFailed"), error instanceof Error ? error.message : "Lỗi mode transition");
      }
    } finally {
      if (statusController && statusAbortRef.current === statusController) statusAbortRef.current = null;
      if (mountedRef.current) {
        setOnboardingStatus(null);
        setBusy(null);
      }
    }
  };

  const unbindDevice = (device: FarmDevice) => {
    appAlert(
      t("onboarding.unbindTitle"),
      t(device.type === "GATEWAY" ? "onboarding.unbindGatewayConfirmMessage" : "onboarding.unbindConfirmMessage"),
      [
        { text: t("onboarding.unbindCancel"), style: "cancel" },
        {
          text: t("onboarding.unbind"),
          style: "destructive",
          onPress: async () => {
            try {
              setBusy(`unbind:${device.id}`);
              const result = await api.unbindDevice(device.id);
              if (result.status !== "APPLIED") throw new Error(t("onboarding.cannotUnbind"));
              if (!mountedRef.current) return;
              setDevices((current) => current.filter((item) => item.id !== device.id));
              await load().catch(() => undefined);
              if (!mountedRef.current) return;
              appAlert(t("onboarding.unbindSuccessTitle"), t("onboarding.unbindSuccessMessage"));
              void onChanged().catch(() => undefined);
            } catch (error) {
              if (!mountedRef.current || isAbortLikeError(error)) return;
              const message = error instanceof Error ? error.message : t("onboarding.cannotUnbind");
              appAlert(t("common.error"), message);
              await load().catch(() => undefined);
            } finally {
              if (mountedRef.current) setBusy(null);
            }
          },
        },
      ]
    );
  };

  const resolvedDetails = resolved ? resolvedSummary(resolved) : null;

  if (scanner) return <QrScanner onCode={acceptQr} onClose={() => setScanner(false)} />;

  return <KeyboardAvoidingView style={styles.keyboardAvoidingView} behavior={Platform.OS === "ios" ? "padding" : "height"}>
  <ScrollView
    ref={scrollRef}
    contentContainerStyle={styles.page}
    keyboardShouldPersistTaps="handled"
    refreshControl={<RefreshControl refreshing={refreshingDevices} onRefresh={() => void refreshDevices()} />}
    keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
  >
    <View><Text style={styles.eyebrow}>{t("onboarding.devicesHeader", { farmId })}</Text><Text style={styles.title}>{t("onboarding.autoSetupTitle")}</Text><Text style={styles.muted}>{t("onboarding.autoSetupDesc")}</Text>{requiresAndroidLocationService() && <Text style={styles.platformHint}>{t("onboarding.androidLocationHint")}</Text>}</View>
    <View style={styles.card}><Text style={styles.step}>{t("onboarding.step01")}</Text><Text style={styles.cardTitle}>{t("onboarding.scanDeviceQr")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("onboarding.scanQrButtonA11y")} accessibilityHint={t("onboarding.scanQrButtonHint")} hitSlop={6} style={styles.primary} onPress={() => { Keyboard.dismiss(); setScanner(true); }}><Text style={styles.primaryText}>{t("onboarding.scanQrButton")}</Text></Pressable>{busy === "resolve-qr" && <ActivityIndicator color="#19764b" />}</View>
    {locationServicesDisabled && <View style={styles.locationCard}><Text style={styles.locationTitle}>{t("onboarding.locationServiceNeeded")}</Text><Text style={styles.muted}>{t("onboarding.locationServiceNeededDesc")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("onboarding.openLocationSettingsA11y")} accessibilityHint={t("onboarding.openLocationSettingsHint")} hitSlop={6} style={styles.locationButton} onPress={openLocationSettings}><Text style={styles.locationButtonText}>{t("onboarding.openLocationSettings")}</Text></Pressable></View>}
    {resolved && deviceQr && resolvedDetails && <View style={styles.card}><Text style={styles.step}>{t("onboarding.step02")}</Text><Text style={styles.cardTitle}>{resolvedDetails.model || resolvedDetails.deviceId}</Text><Text style={styles.muted}>{resolvedDetails.serialNumber} • {resolvedDetails.capabilities.join(" • ")}{deviceQr.version === 3 ? ` • ${t("onboarding.qrV3ServerVerified")}` : ` • ${t("onboarding.qrV2Legacy")}`}</Text><Text style={styles.label}>{t("onboarding.allowedModesTitle")}</Text>{resolvedDetails.allowedModes.map((mode) => <Pressable key={mode} accessibilityRole="radio" accessibilityState={{ checked: selectedMode === mode }} accessibilityLabel={mode === "GATEWAY" ? t("onboarding.modeGateway") : mode === "STANDALONE_NODE" ? t("onboarding.modeStandalone") : t("onboarding.modeLeaf")} style={[styles.option, selectedMode === mode && styles.selected]} onPress={() => { setSelectedMode(mode); if (mode === "LEAF_NODE" && !gatewayId && gateways[0]) setGatewayId(gateways[0].id); }}><View><Text style={styles.optionTitle}>{mode === "GATEWAY" ? t("onboarding.modeGateway") : mode === "STANDALONE_NODE" ? t("onboarding.modeStandalone") : t("onboarding.modeLeaf")}</Text><Text style={styles.muted}>{mode === "LEAF_NODE" ? t("onboarding.modeLeafDesc") : t("onboarding.modeCloudDesc")}</Text></View></Pressable>)}</View>}
    {resolved && selectedMode && resolvedDetails && <View style={styles.card}><Text style={styles.step}>{t("onboarding.step03")}</Text><Text style={styles.cardTitle}>{t("onboarding.configTitle", { deviceId: resolvedDetails.deviceId })}</Text><Text style={styles.label}>{t("onboarding.installLocationLabel")}</Text><Text style={styles.muted}>{t("onboarding.installLocationDesc")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("onboarding.selectLocationA11y")} style={styles.locationSelect} onPress={() => { Keyboard.dismiss(); setLocationPickerVisible(true); }}><Text style={styles.locationSelectTitle}>{setupLocation ? t("onboarding.pinnedLocation") : t("onboarding.selectOnMap")}</Text><Text style={styles.locationSelectText}>{setupLocation ? `${setupLocation.latitude.toFixed(6)}, ${setupLocation.longitude.toFixed(6)}` : t("onboarding.canSkipLocation")}</Text></Pressable>{selectedMode === "LEAF_NODE" ? <><Text style={styles.label}>{t("onboarding.gatewayLabel")}</Text>{gateways.map((gateway) => <Pressable key={gateway.id} accessibilityRole="radio" accessibilityState={{ checked: gatewayId === gateway.id }} accessibilityLabel={`Gateway ${gateway.name}`} style={[styles.option, gatewayId === gateway.id && styles.selected]} onPress={() => setGatewayId(gateway.id)}><Text style={styles.optionTitle}>{gateway.name}</Text><Text style={gateway.online ? styles.online : styles.offline}>{gateway.online ? t("common.online") : t("common.offline")}</Text></Pressable>)}</> : <><TextInput style={styles.input} placeholder={t("onboarding.wifiSsidPlaceholder")} value={ssid} onChangeText={setSsid} autoCapitalize="none" autoCorrect={false} returnKeyType="next" onSubmitEditing={() => wifiPasswordRef.current?.focus()} accessibilityLabel={t("onboarding.wifiSsidA11y")} /><TextInput ref={wifiPasswordRef} style={styles.input} placeholder={t("onboarding.wifiPasswordPlaceholder")} value={wifiPassword} onChangeText={setWifiPassword} autoCapitalize="none" autoCorrect={false} secureTextEntry returnKeyType="done" onSubmitEditing={() => Keyboard.dismiss()} accessibilityLabel={t("onboarding.wifiPasswordA11y")} /></>}<Text style={styles.label}>{t("onboarding.sensorZoneLabel")}</Text>{zones.map((zone) => <Pressable key={zone.id} accessibilityRole="radio" accessibilityState={{ checked: zoneId === zone.id }} accessibilityLabel={`Zone ${zone.name}`} style={[styles.option, zoneId === zone.id && styles.selected]} onPress={() => { Keyboard.dismiss(); setZoneId(zone.id); }}><Text style={styles.optionTitle}>{zone.name}</Text></Pressable>)}<Text style={styles.label}>{t("onboarding.selectBleLabel")}</Text>{cloudSetupError && <Text accessibilityRole="alert" style={styles.muted}>{cloudSetupError}</Text>}{nearbyDevices.map((item) => <Pressable key={item.bleId} accessibilityRole="button" accessibilityLabel={`Thiết bị ${item.name}`} style={styles.option} onPress={() => selectedMode === "LEAF_NODE" ? finishLeafNode(item) : finishCloudDevice(item)} disabled={Boolean(busy) && busy !== "scan-device"}><View><Text style={styles.optionTitle}>{item.name}</Text><Text style={styles.muted}>{t("onboarding.rssiLabel", { val: item.rssi ?? "–" })}</Text></View>{busy === `device:${item.bleId}` && <ActivityIndicator color="#19764b" />}</Pressable>)}{busy === "scan-device" ? (
      <ActivityIndicator color="#19764b" accessibilityLabel={t("onboarding.scanBluetoothAgain")} />
    ) : (
      <Pressable
        accessibilityRole="button"
        disabled={Boolean(busy)}
        style={styles.secondary}
        onPress={() => {
          setCloudSetupError(null);
          void scan(resolvedDetails.hardwareType);
        }}
      >
        <Text style={styles.secondaryText}>{t("onboarding.scanBluetoothAgain")}</Text>
      </Pressable>
    )}</View>}
    {switchDevice && <View style={styles.card}><Text style={styles.step}>{t(wifiReconfigure ? "onboarding.changeWifi" : "onboarding.switchModeStep")}</Text><Text style={styles.cardTitle}>{switchDevice.name || switchDevice.id}</Text><Text style={styles.muted}>{t(wifiReconfigure ? "onboarding.changeWifiDesc" : "onboarding.switchModeDesc")}</Text>{!wifiReconfigure && <><Text style={styles.label}>{t("onboarding.selectNewModeLabel")}</Text>{allowedModesForDevice(switchDevice).filter((mode) => mode !== switchDevice.deployment_mode).map((mode) => <Pressable key={mode} accessibilityRole="radio" accessibilityState={{ checked: switchMode === mode }} accessibilityLabel={mode === "STANDALONE_NODE" ? t("onboarding.switchStandaloneA11y") : t("onboarding.switchLeafA11y")} style={[styles.option, switchMode === mode && styles.selected]} onPress={() => { setSwitchMode(mode); if (mode === "LEAF_NODE" && !switchGatewayId && gateways[0]) setSwitchGatewayId(gateways[0].id); }}><View><Text style={styles.optionTitle}>{mode === "STANDALONE_NODE" ? t("onboarding.modeStandalone") : t("onboarding.modeLeaf")}</Text><Text style={styles.muted}>{mode === "LEAF_NODE" ? t("onboarding.switchLeafDesc") : t("onboarding.switchStandaloneDesc")}</Text></View></Pressable>)}</>}{switchMode === "LEAF_NODE" ? <><Text style={styles.label}>{t("onboarding.newGatewayLabel")}</Text>{gateways.map((gateway) => <Pressable key={gateway.id} accessibilityRole="radio" accessibilityState={{ checked: switchGatewayId === gateway.id }} accessibilityLabel={`Gateway ${gateway.name}`} style={[styles.option, switchGatewayId === gateway.id && styles.selected]} onPress={() => setSwitchGatewayId(gateway.id)}><Text style={styles.optionTitle}>{gateway.name}</Text><Text style={gateway.online ? styles.online : styles.offline}>{gateway.online ? t("common.online") : t("common.offline")}</Text></Pressable>)}</> : switchMode && <><TextInput style={styles.input} placeholder={t("onboarding.newWifiSsidPlaceholder")} value={ssid} onChangeText={setSsid} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t("onboarding.newWifiSsidA11y")} /><TextInput ref={wifiPasswordRef} style={styles.input} placeholder={t("onboarding.newWifiPasswordPlaceholder")} value={wifiPassword} onChangeText={setWifiPassword} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel={t("onboarding.newWifiPasswordA11y")} /></>} {switchMode && !wifiReconfigure && <><Text style={styles.label}>Zone</Text>{zones.map((zone) => <Pressable key={zone.id} accessibilityRole="radio" accessibilityState={{ checked: switchZoneId === zone.id }} accessibilityLabel={`Zone ${zone.name}`} style={[styles.option, switchZoneId === zone.id && styles.selected]} onPress={() => setSwitchZoneId(zone.id)}><Text style={styles.optionTitle}>{zone.name}</Text></Pressable>)}</>}<Text style={styles.label}>{t("onboarding.selectBleConfirmLabel")}</Text>{nearbyDevices.map((item) => <Pressable key={item.bleId} accessibilityRole="button" accessibilityLabel={t("onboarding.switchDeviceA11y", { name: item.name })} style={styles.option} onPress={() => finishModeSwitch(item)} disabled={Boolean(busy) && busy !== "scan-device"}><View><Text style={styles.optionTitle}>{item.name}</Text><Text style={styles.muted}>{t("onboarding.rssiLabel", { val: item.rssi ?? "–" })}</Text></View>{busy === `switch:${item.bleId}` && <ActivityIndicator color="#19764b" />}</Pressable>)}{busy === "scan-device" ? <ActivityIndicator color="#19764b" /> : (
      <Pressable accessibilityRole="button" disabled={Boolean(busy)} style={styles.secondary} onPress={() => { void scan(switchDevice.type); }}>
        <Text style={styles.secondaryText}>{t("onboarding.scanBluetoothAgain")}</Text>
      </Pressable>
    )}<Pressable accessibilityRole="button" accessibilityLabel={t("onboarding.cancelSwitchModeA11y")} style={styles.secondary} onPress={() => { stopScan(); setSwitchDevice(null); setWifiReconfigure(false); setSwitchMode(null); setNearbyDevices([]); setWifiPassword(""); setSsid(""); }}><Text style={styles.secondaryText}>{t("onboarding.cancelSwitchMode")}</Text></Pressable></View>}
    {onboardingStatus && <View style={styles.statusCard} accessibilityRole="progressbar" accessibilityLabel={t("onboarding.statusProgressA11y")}><ActivityIndicator color="#19764b" /><Text style={styles.statusText}>{onboardingStatus}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("onboarding.cancelWaitA11y")} accessibilityHint={t("onboarding.cancelWaitHint")} hitSlop={8} style={styles.cancelWait} onPress={cancelOnboardingWait}><Text style={styles.cancelWaitText}>{t("onboarding.cancelWait")}</Text></Pressable></View>}
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t("onboarding.farmDevicesTitle")}</Text>
      {devicesLoading && <Text style={styles.muted}>{t("devices.loadingDevices")}</Text>}
      {devicesLoadFailed && <Pressable accessibilityRole="button" disabled={refreshingDevices} style={styles.secondary} onPress={() => void refreshDevices()}>
        <Text style={styles.secondaryText}>{t("onboarding.retryDeviceList")}</Text>
      </Pressable>}
      {farmDevices.length ? farmDevices.map((device) => {
        const actionBusy = Boolean(busy) && busy !== "scan-device";
        const releaseLabel = t("onboarding.unbind");
        return <View key={device.id} style={styles.row}>
          <View style={styles.rowContent}>
            <Text style={styles.optionTitle}>{device.name}</Text>
            <Text style={styles.muted}>{device.id} • {device.deployment_mode || device.type}</Text>
            <Text style={device.online ? styles.online : styles.offline}>{device.online ? t("common.online") : t("common.offline")}</Text>
          </View>
          <View style={styles.rowActions}>
            {device.can_reconfigure_wifi && !device.release_pending && <Pressable accessibilityRole="button" style={styles.deviceAction} disabled={actionBusy} onPress={() => openModeSwitch(device, true)}>
              <Text style={styles.switchMode}>{t("onboarding.changeWifi")}</Text>
            </Pressable>}
            {device.can_unbind && !device.release_pending && allowedModesForDevice(device).length > 1 && <Pressable accessibilityRole="button" accessibilityLabel={t("onboarding.changeModeA11y", { name: device.name || device.id })} style={styles.deviceAction} disabled={actionBusy} onPress={() => openModeSwitch(device)}>
              <Text style={styles.switchMode}>{t("onboarding.changeMode")}</Text>
            </Pressable>}
          </View>
          {device.can_unbind && <Pressable accessibilityRole="button" accessibilityLabel={`${releaseLabel} ${device.name || device.id}`} disabled={actionBusy} style={({ pressed }) => [styles.deviceAction, styles.releaseAction, (pressed || actionBusy) && styles.inactiveAction]} onPress={() => unbindDevice(device)}>
            <Text style={styles.unbind}>{busy === `unbind:${device.id}` ? t("onboarding.releaseWaiting") : releaseLabel}</Text>
          </Pressable>}
        </View>;
      }) : !devicesLoading && !devicesLoadFailed && <Text style={styles.muted}>{t("onboarding.noActivatedDevices")}</Text>}
    </View>
  </ScrollView>
  <SetupLocationPicker visible={locationPickerVisible} value={setupLocation} onClose={() => setLocationPickerVisible(false)} onSave={(location) => { setSetupLocation(location); setLocationPickerVisible(false); }} />
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  keyboardAvoidingView: { flex: 1 },
  page: { padding: 20, paddingBottom: 110, gap: 14, backgroundColor: "#ffffff" }, eyebrow: { color: "#19764b", fontSize: 11, fontWeight: fontWeight.bold, letterSpacing: 1 }, title: { color: "#1c2922", fontSize: 27, fontWeight: fontWeight.bold, marginTop: 4 }, muted: { color: "#68766e", fontSize: 13, lineHeight: 19 },
  card: { backgroundColor: "white", borderRadius: 18, padding: 17, gap: 11, borderWidth: 1, borderColor: "#e3e8df" }, statusCard: { backgroundColor: "#edf7ef", borderRadius: 14, padding: 14, gap: 10, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: "#b9ddc2" }, statusText: { flex: 1, color: "#245c3d", fontSize: 13, lineHeight: 19, fontWeight: fontWeight.bold }, cancelWait: { borderWidth: 1, borderColor: "#9bc6a7", borderRadius: 9, paddingHorizontal: 9, paddingVertical: 7 }, cancelWaitText: { color: "#245c3d", fontSize: 12, fontWeight: fontWeight.bold }, step: { color: "#19764b", fontSize: 11, fontWeight: fontWeight.bold, letterSpacing: 1 }, cardTitle: { color: "#1c2922", fontSize: 18, fontWeight: fontWeight.bold }, platformHint: { color: "#7a5b16", fontSize: 12, fontWeight: fontWeight.bold, marginTop: 8 }, locationCard: { backgroundColor: "#fff8e1", borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: "#f0d58a" }, locationTitle: { color: "#7a5b16", fontSize: 15, fontWeight: fontWeight.bold }, locationButton: { alignSelf: "flex-start", backgroundColor: "#7a5b16", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 }, locationButtonText: { color: "#fff", fontWeight: fontWeight.bold },
  primary: { backgroundColor: "#19764b", borderRadius: 12, minHeight: 48, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 }, primaryText: { color: "white", fontWeight: fontWeight.bold }, secondary: { backgroundColor: "#e5f1e8", borderRadius: 12, padding: 14, alignItems: "center" }, secondaryText: { color: "#19764b", fontWeight: fontWeight.bold },
  locationSelect: { backgroundColor: "#edf7ef", borderColor: "#a9d9b8", borderRadius: 12, borderWidth: 1, padding: 13 }, locationSelectTitle: { color: "#19764b", fontSize: 14, fontWeight: fontWeight.bold }, locationSelectText: { color: "#587062", fontSize: 12, marginTop: 4 },
  input: { backgroundColor: "#f7f9f5", borderWidth: 1, borderColor: "#dce4da", borderRadius: 12, padding: 13, color: "#1c2922" }, label: { color: "#435148", fontWeight: fontWeight.bold, fontSize: 12, marginTop: 3 }, option: { minHeight: 55, borderWidth: 1, borderColor: "#dde4da", borderRadius: 12, padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, selected: { borderColor: "#19764b", backgroundColor: "#edf7ef" }, optionTitle: { color: "#1c2922", fontSize: 14, fontWeight: fontWeight.bold },
  row: { borderTopWidth: 1, borderTopColor: "#eef1ec", paddingTop: 12, gap: 8 },
  rowContent: { gap: 3 },
  rowActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  deviceAction: { minHeight: 48, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#edf7ef" },
  releaseAction: { borderColor: "#edc9c4", borderWidth: 1, backgroundColor: "#fff5f3" },
  inactiveAction: { opacity: 0.65 },
  switchMode: { color: "#19764b", fontSize: 14, fontWeight: fontWeight.bold },
  unbind: { color: "#a33028", fontSize: 14, fontWeight: fontWeight.bold }, online: { color: "#19764b", fontWeight: fontWeight.bold, fontSize: 12 }, offline: { color: "#9a5b45", fontWeight: fontWeight.bold, fontSize: 12 },
});
