import AsyncStorage from "@react-native-async-storage/async-storage";
import { fontWeight } from "../theme/typography";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { sha256 } from "@noble/hashes/sha256";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { api } from "../services/api";
import {
  cancelNodeOtaFirmware,
  flashNodeOtaFirmware,
  NearbyFarmDevice,
  readIdentity,
  scanFarmDevices,
  waitForNodeFirmware,
} from "../services/deviceBle";
import { isBluetoothPermissionError, isLocationServicesDisabledError, openAndroidLocationSettings, openAppSettings, requiresAndroidLocationService } from "../services/androidSettings";
import { useAppAlert } from "./AppDialog";

interface Props {
  visible: boolean;
  onClose: () => void;
  onUpdated?: () => void;
}

const PENDING_OTA_CONFIRMATIONS_KEY = "@farmos/mobile/pending-ota-confirmations";

interface PendingOtaConfirmation {
  device: NearbyFarmDevice;
  deviceId: string;
  jobId: string;
  targetVersion: string;
  createdAt: string;
}

async function readPendingOtaConfirmations(): Promise<PendingOtaConfirmation[]> {
  const raw = await AsyncStorage.getItem(PENDING_OTA_CONFIRMATIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingOtaConfirmation => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<PendingOtaConfirmation>;
      return Boolean(candidate.device && candidate.deviceId && candidate.jobId && candidate.targetVersion);
    });
  } catch {
    return [];
  }
}

async function writePendingOtaConfirmations(items: PendingOtaConfirmation[]): Promise<void> {
  if (!items.length) {
    await AsyncStorage.removeItem(PENDING_OTA_CONFIRMATIONS_KEY);
    return;
  }
  await AsyncStorage.setItem(PENDING_OTA_CONFIRMATIONS_KEY, JSON.stringify(items));
}

async function upsertPendingOtaConfirmation(item: PendingOtaConfirmation): Promise<void> {
  const existing = await readPendingOtaConfirmations();
  const next = [...existing.filter((candidate) => candidate.jobId !== item.jobId), item];
  await writePendingOtaConfirmations(next);
}

async function removePendingOtaConfirmation(jobId: string): Promise<void> {
  const existing = await readPendingOtaConfirmations();
  await writePendingOtaConfirmations(existing.filter((candidate) => candidate.jobId !== jobId));
}

async function reportBootConfirmedWithRetry(item: PendingOtaConfirmation): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await api.reportOtaStatus({
        deviceId: item.deviceId,
        jobId: item.jobId,
        deviceType: "SENSOR_NODE",
        targetVersion: item.targetVersion,
        status: "BOOT_CONFIRMED",
        progress: 100,
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Không thể đồng bộ trạng thái OTA với máy chủ");
}

export function FirmwareUpdateModal({ visible, onClose, onUpdated }: Props) {
  const { t } = useTranslation();
  const appAlert = useAppAlert();
  const [scanning, setScanning] = useState(false);
  const [nearbyNodes, setNearbyNodes] = useState<NearbyFarmDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<NearbyFarmDevice | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    deviceId: string;
    currentVersion: string;
    updateAvailable: boolean;
    jobId?: string;
    latestVersion?: string;
    changelog?: string;
    sizeBytes?: number;
    downloadUrl?: string;
    sha256?: string;
  } | null>(null);
  const [flashing, setFlashing] = useState(false);
  const [flashProgress, setFlashProgress] = useState<number>(0);
  const [flashStatusText, setFlashStatusText] = useState<string>("");
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [bleFlashing, setBleFlashing] = useState(false);
  const [locationServicesDisabled, setLocationServicesDisabled] = useState(false);
  const scanCleanupRef = useRef<(() => void) | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const cancelRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  const otaAbortControllerRef = useRef<AbortController | null>(null);

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

  const stopScan = useCallback(() => {
    scanGenerationRef.current += 1;
    scanCleanupRef.current?.();
    scanCleanupRef.current = null;
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    scanTimerRef.current = null;
    setScanning(false);
  }, []);

  const resetFlow = useCallback(() => {
    selectionGenerationRef.current += 1;
    stopScan();
    setNearbyNodes([]);
    setSelectedDevice(null);
    setChecking(false);
    setUpdateInfo(null);
    setFlashProgress(0);
    setFlashStatusText("");
    setPendingSyncCount(0);
    setBleFlashing(false);
    setLocationServicesDisabled(false);
  }, [stopScan]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scanGenerationRef.current += 1;
      scanCleanupRef.current?.();
      if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      otaAbortControllerRef.current?.abort();
      cancelNodeOtaFirmware();
    };
  }, []);

  useEffect(() => {
    if (visible || flashing) return;
    resetFlow();
  }, [flashing, resetFlow, visible]);

  useEffect(() => {
    if (!visible || flashing) return;
    let cancelled = false;

    const reconcilePending = async () => {
      const pending = await readPendingOtaConfirmations().catch(() => []);
      if (cancelled || !pending.length) return;
      if (!mountedRef.current) return;
      setPendingSyncCount(pending.length);
      const remaining: PendingOtaConfirmation[] = [];
      for (const item of pending) {
        if (cancelled) return;
        try {
          if (cancelled || !mountedRef.current) return;
          setFlashStatusText(`Đang đồng bộ firmware ${item.deviceId}…`);
          await waitForNodeFirmware(item.device, item.targetVersion, 3);
          await reportBootConfirmedWithRetry(item);
          await removePendingOtaConfirmation(item.jobId);
          if (!cancelled && mountedRef.current) onUpdated?.();
        } catch {
          remaining.push(item);
        }
      }
      if (cancelled || !mountedRef.current) return;
      await writePendingOtaConfirmations(remaining).catch(() => undefined);
      setPendingSyncCount(remaining.length);
      if (remaining.length) {
        setFlashStatusText("Thiết bị đã cập nhật, đang chờ đồng bộ với máy chủ.");
      } else {
        setFlashStatusText("");
      }
    };

    reconcilePending().catch(() => undefined);
    return () => { cancelled = true; };
  }, [flashing, onUpdated, visible]);

  const startScan = async () => {
    stopScan();
    const generation = scanGenerationRef.current;
    setNearbyNodes([]);
    setScanning(true);
    setLocationServicesDisabled(false);
    try {
      const cleanup = await scanFarmDevices(
        "SENSOR_NODE",
        (found) => {
          if (mountedRef.current && generation === scanGenerationRef.current) {
            setNearbyNodes((prev) => [
              ...prev.filter((item) => item.bleId !== found.bleId),
              found,
            ]);
          }
        },
        10_000,
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
        setScanning(false);
      }, 10_000);
    } catch (err: any) {
      if (!mountedRef.current || generation !== scanGenerationRef.current) return;
      const locationDisabled = requiresAndroidLocationService() && isLocationServicesDisabledError(err);
      setLocationServicesDisabled(locationDisabled);
      setScanning(false);
      if (!locationDisabled) showScanError(err instanceof Error ? err : new Error(err?.message || "Không thể tìm kiếm Node"));
    }
  };

  const openLocationSettings = async () => {
    await openAndroidLocationSettings();
  };

  const handleSelectNode = async (device: NearbyFarmDevice) => {
    stopScan();
    const generation = ++selectionGenerationRef.current;
    setSelectedDevice(device);
    setChecking(true);
    setUpdateInfo(null);
    try {
      const { device: connection, identity } = await readIdentity(device);
      await connection.cancelConnection().catch(() => undefined);
      if (!mountedRef.current || generation !== selectionGenerationRef.current) return;
      if (!identity.firmwareVersion) throw new Error("Firmware hiện tại không công bố version; không thể chọn bản OTA an toàn.");
      const currentVer = identity.firmwareVersion;
      const checkResult = await api.checkFirmwareUpdate("SENSOR_NODE", currentVer, identity.id);
      if (!mountedRef.current || generation !== selectionGenerationRef.current) return;

      setUpdateInfo({
        deviceId: identity.id,
        currentVersion: currentVer,
        updateAvailable: checkResult.updateAvailable,
        jobId: checkResult.jobId,
        latestVersion: checkResult.latestRelease?.version,
        changelog: checkResult.latestRelease?.changelog,
        sizeBytes: checkResult.latestRelease?.sizeBytes,
        downloadUrl: checkResult.downloadUrl,
        sha256: checkResult.latestRelease?.sha256,
      });
    } catch (err: any) {
      if (!mountedRef.current || generation !== selectionGenerationRef.current) return;
      appAlert(t("firmware.readNodeInfoError"), err?.message || "Không thể đọc dữ liệu BLE");
      setSelectedDevice(null);
    } finally {
      if (mountedRef.current && generation === selectionGenerationRef.current) setChecking(false);
    }
  };

  const handleStartFlashing = async () => {
    if (!selectedDevice || !updateInfo?.jobId || !updateInfo.downloadUrl || !updateInfo.latestVersion || !updateInfo.sha256) return;

    setFlashing(true);
    cancelRequestedRef.current = false;
    setFlashProgress(0);
    setFlashStatusText(t("firmware.downloadingBinary"));
    let bootVerified = false;

    try {
      // 1. Download binary
      const binaryBytes = await api.downloadFirmwareBinary(updateInfo.downloadUrl);
      const actualSha256 = Array.from(sha256(binaryBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actualSha256 !== updateInfo.sha256.toLowerCase()) {
        throw new Error(t("firmware.checksumMismatch"));
      }
      if (!mountedRef.current) return;
      setFlashProgress(5);
      setFlashStatusText(t("firmware.downloadedStartingBle", { kb: (binaryBytes.byteLength / 1024).toFixed(0) }));

      // 2. Report status DOWNLOADING
      await api.reportOtaStatus({
        deviceId: updateInfo.deviceId,
        jobId: updateInfo.jobId,
        deviceType: "SENSOR_NODE",
        targetVersion: updateInfo.latestVersion,
        status: "DOWNLOADING",
        progress: 10,
      });

      // 3. Flash over BLE
      await api.reportOtaStatus({
        deviceId: updateInfo.deviceId,
        jobId: updateInfo.jobId,
        deviceType: "SENSOR_NODE",
        targetVersion: updateInfo.latestVersion,
        status: "FLASHING",
        progress: 15,
      });
      if (!mountedRef.current) return;
      setBleFlashing(true);
      const otaAbortController = new AbortController();
      otaAbortControllerRef.current = otaAbortController;
      await flashNodeOtaFirmware(
        selectedDevice,
        binaryBytes,
        updateInfo.latestVersion,
        updateInfo.sha256,
        (percent, written, total) => {
          if (!mountedRef.current) return;
          setFlashProgress(percent);
          setFlashStatusText(
            t("firmware.writingFlash", {
              percent,
              written: (written / 1024).toFixed(0),
              total: (total / 1024).toFixed(0),
            })
          );
        },
        { signal: otaAbortController.signal },
      );
      otaAbortControllerRef.current = null;
      if (mountedRef.current) setBleFlashing(false);

      const pendingConfirmation: PendingOtaConfirmation = {
        device: selectedDevice,
        deviceId: updateInfo.deviceId,
        jobId: updateInfo.jobId,
        targetVersion: updateInfo.latestVersion,
        createdAt: new Date().toISOString(),
      };
      // Persist after the Node has accepted and verified the image. If the app
      // is killed while it reboots, the next modal open can reconcile the job.
      await upsertPendingOtaConfirmation(pendingConfirmation).catch(() => undefined);

      let flashedReportError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await api.reportOtaStatus({
            deviceId: updateInfo.deviceId,
            jobId: updateInfo.jobId,
            deviceType: "SENSOR_NODE",
            targetVersion: updateInfo.latestVersion,
            status: "FLASHED",
            progress: 100,
          });
          flashedReportError = undefined;
          break;
        } catch (error) {
          flashedReportError = error;
          await new Promise<void>((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }

      if (!mountedRef.current) return;
      setFlashStatusText(
        flashedReportError
          ? t("firmware.waitingNodeReboot")
          : t("firmware.waitingNodeReboot")
      );
      await waitForNodeFirmware(selectedDevice, updateInfo.latestVersion);
      bootVerified = true;

      // Only a version read from the rebooted Node is reported as confirmed.
      await reportBootConfirmedWithRetry(pendingConfirmation);
      await removePendingOtaConfirmation(pendingConfirmation.jobId).catch(() => undefined);

      if (!mountedRef.current) return;
      setFlashStatusText(t("firmware.rebootConfirmedSuccess"));
      appAlert(
        t("firmware.syncSuccessTitle"),
        t("firmware.syncSuccessMessage", { deviceId: updateInfo.deviceId, version: updateInfo.latestVersion })
      );

      Promise.resolve(onUpdated?.()).catch(() => undefined);
      closeTimerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setFlashing(false);
        resetFlow();
        onClose();
      }, 2000);
    } catch (err: any) {
      if (mountedRef.current) {
        setBleFlashing(false);
        setFlashing(false);
        setFlashStatusText(cancelRequestedRef.current ? t("firmware.cancelDoneMessage") : bootVerified ? t("firmware.needSyncMessage") : t("firmware.failedTitle"));
      }
      if (!bootVerified) {
        await api.reportOtaStatus({
          deviceId: updateInfo.deviceId,
          jobId: updateInfo.jobId,
          deviceType: "SENSOR_NODE",
          targetVersion: updateInfo.latestVersion,
          status: "FAILED",
          error: err?.message || "Lỗi nạp BLE FOTA",
        }).catch(() => undefined);
      }
      if (mountedRef.current) {
        const wasCancelled = cancelRequestedRef.current;
        appAlert(
          wasCancelled ? t("firmware.cancelledTitle") : bootVerified ? t("firmware.needSyncTitle") : t("firmware.failedTitle"),
          wasCancelled
            ? t("firmware.cancelledMessage")
            : bootVerified
              ? t("firmware.needSyncMessage")
              : err?.message || t("firmware.failedTitle")
        );
      }
      cancelRequestedRef.current = false;
      otaAbortControllerRef.current = null;
    }
  };

  const handleCancelOta = useCallback(() => {
    if (!flashing || !bleFlashing) return;
    appAlert(
      t("firmware.cancelConfirmTitle"),
      t("firmware.cancelConfirmMessage"),
      [
        { text: t("firmware.continueOta"), style: "cancel" },
        {
          text: t("firmware.cancelOtaAction"),
          style: "destructive",
          onPress: () => {
            cancelRequestedRef.current = true;
            setFlashStatusText(t("firmware.cancelDoneMessage"));
            otaAbortControllerRef.current?.abort();
            cancelNodeOtaFirmware();
          },
        },
      ],
    );
  }, [appAlert, bleFlashing, flashing, t]);

  const requestClose = useCallback(() => {
    if (flashing) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    resetFlow();
    onClose();
  }, [flashing, onClose, resetFlow]);

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={requestClose}>
      <SafeAreaProvider>
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>{t("firmware.controllerEyebrow")}</Text>
            <Text style={styles.title}>{t("firmware.title")}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={t("firmware.closeA11y")} hitSlop={10} onPress={requestClose} disabled={flashing}>
            <Text style={styles.closeText}>{t("firmware.close")}</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Section 1: Scan BLE Nodes */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t("firmware.step1Title")}</Text>
            <Text style={styles.muted}>
              {t("firmware.step1Desc")}
            </Text>
            {requiresAndroidLocationService() && <Text style={styles.platformHint}>{t("onboarding.androidLocationHint")}</Text>}
            {locationServicesDisabled && <View style={styles.locationCard}><Text style={styles.locationTitle}>{t("onboarding.locationServiceNeeded")}</Text><Text style={styles.muted}>{t("onboarding.locationServiceNeededDesc")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("onboarding.openLocationSettingsA11y")} accessibilityHint={t("onboarding.openLocationSettingsHint")} hitSlop={6} style={styles.locationButton} onPress={openLocationSettings}><Text style={styles.locationButtonText}>{t("onboarding.openLocationSettings")}</Text></Pressable></View>}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("firmware.scanButtonA11y")}
              accessibilityHint={t("firmware.scanButtonHint")}
              hitSlop={6}
              style={[styles.primaryButton, (scanning || flashing) && styles.disabled]}
              onPress={startScan}
              disabled={scanning || flashing}
            >
              <Text style={styles.primaryText}>
                {scanning ? t("firmware.scanning") : t("firmware.scanNodes")}
              </Text>
            </Pressable>

            {nearbyNodes.map((item) => (
              <Pressable
                key={item.bleId}
                accessibilityRole="button"
                accessibilityLabel={t("firmware.selectNodeA11y", { name: item.name })}
                accessibilityHint={t("firmware.selectNodeHint")}
                hitSlop={4}
                style={[
                  styles.deviceItem,
                  selectedDevice?.bleId === item.bleId && styles.deviceItemSelected,
                ]}
                onPress={() => handleSelectNode(item)}
                disabled={flashing}
              >
                <View>
                  <Text style={styles.deviceName}>{item.name}</Text>
                  <Text style={styles.muted}>{t("onboarding.rssiLabel", { val: item.rssi ?? "–" })}</Text>
                </View>
                {selectedDevice?.bleId === item.bleId && checking && (
                  <ActivityIndicator color="#19764b" />
                )}
              </Pressable>
            ))}
          </View>

          {/* Section 2: Firmware info & check */}
          {updateInfo && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{t("firmware.step2Title")}</Text>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>{t("firmware.deviceLabel")}</Text>
                <Text style={styles.infoValue}>{updateInfo.deviceId}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>{t("firmware.currentVersionLabel")}</Text>
                <Text style={styles.infoValue}>v{updateInfo.currentVersion}</Text>
              </View>

              {updateInfo.updateAvailable ? (
                <>
                  <View style={styles.badgeNew}>
                    <Text style={styles.badgeNewText}>
                      {t("firmware.newVersionBadge", { version: updateInfo.latestVersion })}
                    </Text>
                  </View>
                  {updateInfo.changelog && (
                    <View style={styles.changelogBox}>
                      <Text style={styles.changelogTitle}>{t("firmware.changelogTitle")}</Text>
                      <Text style={styles.changelogText}>{updateInfo.changelog}</Text>
                    </View>
                  )}

                  {!flashing ? (
                    <Pressable accessibilityRole="button" accessibilityLabel={t("firmware.flashBleButtonA11y", { version: updateInfo.latestVersion })} accessibilityHint={t("firmware.flashBleButtonHint")} hitSlop={6} style={styles.upgradeButton} onPress={handleStartFlashing}>
                      <Text style={styles.upgradeButtonText}>
                        {t("firmware.flashBleButton", { version: updateInfo.latestVersion })}
                      </Text>
                    </Pressable>
                  ) : (
                    <View style={styles.progressContainer}>
                      <View style={styles.progressBarBg}>
                        <View style={[styles.progressBarFill, { width: `${flashProgress}%` }]} />
                      </View>
                      <Text style={styles.progressText}>{flashProgress}%</Text>
                      <Text style={styles.statusText}>{flashStatusText}</Text>
                      {bleFlashing && <Pressable accessibilityRole="button" accessibilityLabel={t("firmware.cancelOtaA11y")} hitSlop={10} style={styles.cancelOtaButton} onPress={handleCancelOta}><Text style={styles.cancelOtaText}>{t("firmware.cancelOta")}</Text></Pressable>}
                    </View>
                  )}
                </>
              ) : (
                <View style={styles.badgeOk}>
                  <Text style={styles.badgeOkText}>
                    {t("firmware.latestVersionBadge", { version: updateInfo.currentVersion })}
                  </Text>
                </View>
              )}
            </View>
          )}
          {pendingSyncCount > 0 && !updateInfo && <View style={styles.pendingSyncCard}><Text style={styles.pendingSyncText}>{t("firmware.pendingSyncCountMessage", { count: pendingSyncCount })}</Text></View>}
        </ScrollView>
      </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#ffffff" },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  eyebrow: { color: "#19764b", fontWeight: fontWeight.bold, fontSize: 11, letterSpacing: 1 },
  title: { color: "#1c2922", fontSize: 20, fontWeight: fontWeight.bold, marginTop: 2 },
  closeText: { color: "#19764b", fontWeight: fontWeight.bold, fontSize: 15 },
  scroll: { padding: 20, gap: 16 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    borderColor: "#e3e8df",
  },
  cardTitle: { color: "#1c2922", fontSize: 16, fontWeight: fontWeight.bold },
  muted: { color: "#68766e", fontSize: 13, lineHeight: 18 },
  platformHint: { color: "#7a5b16", fontSize: 12, lineHeight: 18, fontWeight: fontWeight.bold },
  locationCard: { backgroundColor: "#fff8e1", borderRadius: 12, padding: 12, gap: 8, borderWidth: 1, borderColor: "#f0d58a" },
  locationTitle: { color: "#7a5b16", fontWeight: fontWeight.bold, fontSize: 14 },
  locationButton: { alignSelf: "flex-start", backgroundColor: "#7a5b16", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  locationButtonText: { color: "#fff", fontWeight: fontWeight.bold, fontSize: 12 },
  primaryButton: {
    backgroundColor: "#19764b",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
  },
  disabled: { opacity: 0.6 },
  primaryText: { color: "#fff", fontWeight: fontWeight.bold, fontSize: 15 },
  deviceItem: {
    borderWidth: 1,
    borderColor: "#dde4da",
    borderRadius: 12,
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  deviceItemSelected: { borderColor: "#19764b", backgroundColor: "#edf7ef" },
  deviceName: { color: "#1c2922", fontSize: 15, fontWeight: fontWeight.bold },
  infoRow: { flexDirection: "row", justifyContent: "space-between" },
  infoLabel: { color: "#68766e", fontSize: 14 },
  infoValue: { color: "#1c2922", fontWeight: fontWeight.bold, fontSize: 14 },
  badgeNew: {
    backgroundColor: "#e6f4ea",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#a8dab5",
  },
  badgeNewText: { color: "#137333", fontWeight: fontWeight.bold, fontSize: 13 },
  badgeOk: {
    backgroundColor: "#f1f3f4",
    padding: 10,
    borderRadius: 8,
  },
  badgeOkText: { color: "#5f6368", fontWeight: fontWeight.bold, fontSize: 13 },
  changelogBox: {
    backgroundColor: "#f8f9fa",
    padding: 12,
    borderRadius: 8,
    gap: 4,
  },
  changelogTitle: { color: "#1c2922", fontWeight: fontWeight.bold, fontSize: 13 },
  changelogText: { color: "#555", fontSize: 13, lineHeight: 18 },
  upgradeButton: {
    backgroundColor: "#19764b",
    borderRadius: 12,
    padding: 14,
    alignItems: "center",
    marginTop: 6,
  },
  upgradeButtonText: { color: "#fff", fontWeight: fontWeight.bold, fontSize: 15 },
  progressContainer: { gap: 8, marginTop: 8 },
  progressBarBg: {
    height: 12,
    backgroundColor: "#e0e0e0",
    borderRadius: 6,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "#19764b",
    borderRadius: 6,
  },
  progressText: { textAlign: "right", color: "#19764b", fontWeight: fontWeight.bold, fontSize: 13 },
  statusText: { textAlign: "center", color: "#68766e", fontSize: 13 },
  cancelOtaButton: { alignSelf: "center", borderWidth: 1, borderColor: "#b83c32", borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  cancelOtaText: { color: "#b83c32", fontWeight: fontWeight.bold, fontSize: 13 },
  pendingSyncCard: { backgroundColor: "#fff8e1", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "#f0d58a" },
  pendingSyncText: { color: "#7a5b16", fontSize: 13, lineHeight: 19, fontWeight: fontWeight.bold },
});
