import React, { useMemo, useState } from "react";
import { fontWeight } from "../theme/typography";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { DevicePumpControl } from "./DevicePumpControl";
import { Icon } from "./Icon";
import { usePreferences } from "../context/PreferencesContext";
import type { FarmDevice, TelemetryPoint } from "../types";

export const TELEMETRY_STALE_AFTER_MS = 5 * 60 * 1000;

type Props = {
  devices: FarmDevice[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
};

function formatValue(value: number | null | undefined, suffix = "") {
  return value === null || value === undefined ? "–" : `${value}${suffix}`;
}

export function isTelemetryStale(timestamp: string | undefined, now = Date.now()) {
  if (!timestamp) return true;
  const time = Date.parse(timestamp);
  return !Number.isFinite(time) || now - time > TELEMETRY_STALE_AFTER_MS;
}

function telemetrySummary(telemetry?: TelemetryPoint | null, t?: (key: string, options?: any) => string) {
  if (!telemetry) return t ? t("deviceDetails.noSensorData") : "Chưa có dữ liệu cảm biến";
  if (!t) return `Ẩm đất ${formatValue(telemetry.soil_moisture, "%")} • Nhiệt độ ${formatValue(telemetry.air_temp, "°C")}`;
  return `${t("deviceDetails.soilMoistureSummary", { val: formatValue(telemetry.soil_moisture, "%") })} • ${t("deviceDetails.airTempSummary", { val: formatValue(telemetry.air_temp, "°C") })}`;
}

function DeviceCard({ device, onPress }: { device: FarmDevice; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const stale = isTelemetryStale(device.latest_telemetry?.timestamp);
  const isGateway = device.type === "GATEWAY";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("deviceDetails.viewDeviceDetails", { name: device.name || device.id })}
      onPress={onPress}
      style={({ pressed }) => [styles.deviceCard, pressed && styles.cardPressed]}
    >
      <View style={styles.deviceCardIcon}>
        <Icon
          name={isGateway ? "wifi" : "cpu"}
          size={20}
          color={device.online ? colors.primary : colors.textMuted}
        />
      </View>

      <View style={styles.cardMain}>
        <View style={styles.cardHeaderRow}>
          <Text style={styles.deviceName} numberOfLines={1}>
            {device.name || device.id}
          </Text>
          <View
            style={[
              styles.statusBadge,
              device.online ? styles.statusBadgeOnline : styles.statusBadgeOffline,
            ]}
          >
            <View
              style={[
                styles.statusDot,
                device.online ? styles.statusDotOnline : styles.statusDotOffline,
              ]}
            />
            <Text
              style={[
                styles.statusBadgeText,
                device.online ? styles.statusTextOnline : styles.statusTextOffline,
              ]}
            >
              {device.online ? "Online" : "Offline"}
            </Text>
          </View>
        </View>

        <Text style={styles.deviceMeta}>
          {device.type} • {device.deployment_mode || t("deviceDetails.unassignedMode")}
        </Text>

        <Text style={styles.telemetryText}>{telemetrySummary(device.latest_telemetry, t)}</Text>

        {device.latest_telemetry?.timestamp && (
          <Text style={stale ? styles.staleText : styles.freshText}>
            {stale ? t("deviceDetails.dataStale") : t("deviceDetails.dataFresh")} •{" "}
            {new Date(device.latest_telemetry.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const { colors } = usePreferences();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function DeviceDetails({ device }: { device: FarmDevice }) {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const telemetry = device.latest_telemetry;
  const stale = isTelemetryStale(telemetry?.timestamp);

  return (
    <View style={styles.detailCard}>
      <View style={styles.detailHeader}>
        <Text style={styles.detailTitle}>{device.name || device.id}</Text>
        <Text style={styles.detailId}>
          {device.id}
          {device.serial_number ? ` • SN ${device.serial_number}` : ""}
        </Text>
      </View>

      {device.is_activated && !device.is_simulation && <DevicePumpControl key={device.id} nodeId={device.id} />}

      <View style={styles.infoTable}>
        <DetailRow label={t("deviceDetails.connectionStatus")} value={device.online ? "Online" : "Offline"} />
        <DetailRow label={t("deviceDetails.deviceType")} value={device.type} />
        <DetailRow label={t("deviceDetails.deploymentMode")} value={device.deployment_mode || t("deviceDetails.unknownMode")} />
        <DetailRow label={t("deviceDetails.firmwareVersion")} value={device.firmware_version || t("deviceDetails.unrecorded")} />
        <DetailRow label={t("deviceDetails.farmLabel")} value={device.farm?.name || t("deviceDetails.unassigned")} />
        <DetailRow label={t("deviceDetails.zoneLabel")} value={device.zone?.name || t("deviceDetails.unassigned")} />
        <DetailRow
          label={t("deviceDetails.gatewayLabel")}
          value={
            device.gateway?.name ||
            device.gateway_id ||
            (device.type === "GATEWAY" ? t("deviceDetails.gatewayDevice") : t("deviceDetails.unassigned"))
          }
        />
        <DetailRow
          label={t("deviceDetails.rssiSignal")}
          value={device.rssi == null ? "–" : `${device.rssi} dBm`}
        />
        <DetailRow
          label={t("deviceDetails.lastSeen")}
          value={
            device.last_seen
              ? new Date(device.last_seen).toLocaleString()
              : t("deviceDetails.unrecorded")
          }
        />
      </View>

      <Text style={styles.subheading}>{t("deviceDetails.latestTelemetryHeading")}</Text>
      {telemetry ? (
        <>
          <View style={styles.metricGrid}>
            <Metric label={t("deviceDetails.soilMoisture")} value={formatValue(telemetry.soil_moisture, "%")} />
            <Metric label={t("deviceDetails.airTemp")} value={formatValue(telemetry.air_temp, "°C")} />
            <Metric label={t("deviceDetails.soilTemp")} value={formatValue(telemetry.soil_temp, "°C")} />
            <Metric label={t("deviceDetails.airHumidity")} value={formatValue(telemetry.air_humidity, "%")} />
          </View>
          {device.type === "SENSOR_NODE" && telemetry.soil_moisture == null && (
            <Text style={styles.muted}>{t("deviceDetails.noSoilMoisture")}</Text>
          )}
          <Text style={stale ? styles.staleTextModal : styles.freshTextModal}>
            {stale ? t("deviceDetails.staleModal") : t("deviceDetails.freshModal")} •{" "}
            {new Date(telemetry.timestamp).toLocaleString()}
          </Text>
        </>
      ) : (
        <View style={styles.noTelemetryBox}>
          <Text style={styles.muted}>{t("deviceDetails.noTelemetryModal")}</Text>
        </View>
      )}
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const { colors } = usePreferences();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

export function DeviceDetailsPanel({ devices, loading, error, onRetry }: Props) {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const selected = useMemo(
    () => devices.find((device) => device.id === selectedId) || null,
    [devices, selectedId],
  );

  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <View>
          <Text style={styles.eyebrow}>{t("deviceDetails.deviceListEyebrow")}</Text>
          <Text style={styles.panelTitle}>{t("deviceDetails.devicesAndSensors")}</Text>
        </View>
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>{t("deviceDetails.deviceCount", { count: devices.length })}</Text>
        </View>
      </View>

      {loading && devices.length === 0 ? (
        <View style={styles.state}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.muted}>{t("deviceDetails.loadingDevices")}</Text>
        </View>
      ) : error && devices.length === 0 ? (
        <View style={styles.state}>
          <Text style={styles.error}>{error}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("deviceDetails.retryLoadingA11y")}
            onPress={onRetry}
            style={styles.retry}
          >
            <Icon name="refresh" size={14} color="#ffffff" />
            <Text style={styles.retryText}>{t("deviceDetails.retry")}</Text>
          </Pressable>
        </View>
      ) : devices.length === 0 ? (
        <View style={styles.emptyState}>
          <Icon name="cpu" size={28} color={colors.textMuted} />
          <Text style={styles.emptyText}>{t("deviceDetails.noActiveDevices")}</Text>
        </View>
      ) : (
        <>
          {error && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("deviceDetails.retryLoadingA11y")}
              onPress={onRetry}
              style={[styles.retry, { alignSelf: "center", marginBottom: 10 }]}
            >
              <Icon name="refresh" size={14} color="#ffffff" />
              <Text style={styles.retryText}>{error} — {t("deviceDetails.retry")}</Text>
            </Pressable>
          )}
          <FlatList
            data={showAll ? devices : devices.slice(0, 3)}
            keyExtractor={(device) => device.id}
            renderItem={({ item }) => (
              <DeviceCard device={item} onPress={() => setSelectedId(item.id)} />
            )}
            scrollEnabled={showAll}
            showsVerticalScrollIndicator={showAll}
            style={showAll ? styles.expandedList : undefined}
          />
          {devices.length > 3 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={showAll ? t("deviceDetails.collapse") : t("deviceDetails.viewAllDevices", { count: devices.length })}
              onPress={() => setShowAll((current) => !current)}
              style={styles.showAll}
            >
              <Text style={styles.showAllText}>
                {showAll ? t("deviceDetails.collapse") : t("deviceDetails.viewAllDevices", { count: devices.length })}
              </Text>
            </Pressable>
          )}
        </>
      )}

      {/* Device Details Modal */}
      <Modal
        visible={Boolean(selected)}
        animationType="slide"
        onRequestClose={() => setSelectedId(null)}
      >
        <SafeAreaProvider style={styles.modalRoot}>
          <SafeAreaView style={styles.modalRoot} edges={["top", "bottom", "left", "right"]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("deviceDetails.deviceInfoModal")}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("deviceDetails.closeDetailsA11y")}
                onPress={() => setSelectedId(null)}
                style={styles.closeBtn}
              >
                <Text style={styles.closeText}>{t("deviceDetails.close")}</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalContent}>
              {selected && <DeviceDetails device={selected} />}
            </ScrollView>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  panelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  eyebrow: {
    color: colors.primary,
    fontSize: 10,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
  },
  panelTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: fontWeight.bold,
    marginTop: 2,
  },
  countBadge: {
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
  },
  countBadgeText: {
    fontSize: 12,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
  },
  deviceCard: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 12,
    marginTop: 8,
    flexDirection: "row",
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
  },
  cardPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  deviceCardIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardMain: {
    flex: 1,
    gap: 3,
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  deviceName: {
    color: colors.text,
    fontWeight: fontWeight.bold,
    fontSize: 14,
    flex: 1,
    marginRight: 8,
  },
  deviceMeta: {
    color: colors.textMuted,
    fontSize: 12,
  },
  telemetryText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: fontWeight.semibold,
    marginTop: 2,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  statusBadgeOnline: {
    backgroundColor: colors.primarySoft,
  },
  statusBadgeOffline: {
    backgroundColor: colors.surfaceMuted,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDotOnline: {
    backgroundColor: colors.primary,
  },
  statusDotOffline: {
    backgroundColor: colors.textMuted,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
  },
  statusTextOnline: {
    color: colors.primary,
  },
  statusTextOffline: {
    color: colors.textMuted,
  },
  freshText: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: fontWeight.semibold,
    marginTop: 2,
  },
  staleText: {
    color: "#d97706",
    fontSize: 11,
    fontWeight: fontWeight.semibold,
    marginTop: 2,
  },
  state: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 20,
    gap: 8,
  },
  error: {
    color: "#dc2626",
    textAlign: "center",
    fontSize: 12,
    fontWeight: fontWeight.medium,
  },
  retry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  retryText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: fontWeight.bold,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 20,
    gap: 6,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  showAll: {
    alignItems: "center",
    paddingVertical: 10,
    marginTop: 4,
  },
  showAllText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: fontWeight.bold,
  },
  expandedList: {
    maxHeight: 340,
  },
  modalRoot: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  modalTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: fontWeight.bold,
  },
  closeBtn: {
    padding: 6,
  },
  closeText: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
    fontSize: 14,
  },
  modalContent: {
    padding: 20,
    paddingBottom: 40,
  },
  detailCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    gap: 14,
  },
  detailHeader: {
    gap: 4,
  },
  detailTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: fontWeight.bold,
  },
  detailId: {
    color: colors.textMuted,
    fontSize: 13,
  },
  infoTable: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 12,
    padding: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  detailLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: fontWeight.medium,
  },
  detailValue: {
    color: colors.text,
    fontSize: 12,
    fontWeight: fontWeight.bold,
    textAlign: "right",
  },
  subheading: {
    color: colors.text,
    fontWeight: fontWeight.bold,
    fontSize: 15,
    marginTop: 6,
  },
  metricGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  metric: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 10,
    padding: 10,
    minWidth: "46%",
    flexGrow: 1,
    borderWidth: 1,
    borderColor: colors.border,
  },
  metricLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: fontWeight.medium,
  },
  metricValue: {
    color: colors.text,
    fontSize: 15,
    fontWeight: fontWeight.bold,
    marginTop: 3,
  },
  freshTextModal: {
    color: colors.primary,
    fontSize: 11,
    fontWeight: fontWeight.semibold,
  },
  staleTextModal: {
    color: "#d97706",
    fontSize: 11,
    fontWeight: fontWeight.semibold,
  },
  noTelemetryBox: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
  },
  muted: {
    color: colors.textMuted,
    fontSize: 13,
  },
}); }
