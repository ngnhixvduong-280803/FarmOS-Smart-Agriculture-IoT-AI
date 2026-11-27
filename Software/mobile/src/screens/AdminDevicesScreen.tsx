import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PullRefreshStatus } from "../components/PullRefreshStatus";
import { usePreferences } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { fontWeight } from "../theme/typography";
import type { AdminDeviceInventory } from "../types";
import { WorkspaceHeader } from "./WorkspaceHeader";

type Filter = "ALL" | "INVENTORY" | "ONLINE" | "OFFLINE";

function statusOf(device: AdminDeviceInventory): "INVENTORY" | "ONLINE" | "OFFLINE" {
  // Match the web inventory semantics: a claimed identity is no longer stock,
  // even during the brief period before its runtime Node row is available.
  if (!device.node?.isActivated && !device.claimedById && !device.claimedFarmId) return "INVENTORY";
  return device.node?.online ? "ONLINE" : "OFFLINE";
}

function statusLabel(status: ReturnType<typeof statusOf>, t: (key: string) => string) {
  return status === "INVENTORY"
    ? t("adminDevices.statusInventory")
    : status === "ONLINE"
    ? t("adminDevices.statusOnline")
    : t("adminDevices.statusOffline");
}

export function AdminDevicesScreen() {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const { user, adminDevices, adminDevicesLoading, adminDevicesError, loadAdminDevices, refreshing, onRefresh } = useWorkspace();
  const [filter, setFilter] = useState<Filter>("ALL");
  const styles = useMemo(() => createStyles(colors), [colors]);
  React.useEffect(() => {
    loadAdminDevices(false).catch(() => undefined);
  }, [loadAdminDevices]);
  const inventory = adminDevices.filter((device) => statusOf(device) === "INVENTORY");
  const online = adminDevices.filter((device) => statusOf(device) === "ONLINE");
  const offline = adminDevices.filter((device) => statusOf(device) === "OFFLINE");
  const shown = filter === "INVENTORY" ? inventory : filter === "ONLINE" ? online : filter === "OFFLINE" ? offline : adminDevices;

  if (user.role !== "ADMIN") return null;

  const filters = [
    ["ALL", t("adminDevices.filterAll")],
    ["INVENTORY", t("adminDevices.filterInventory")],
    ["ONLINE", t("adminDevices.filterOnline")],
    ["OFFLINE", t("adminDevices.filterOffline")],
  ] as const;

  return (
    <View style={styles.screen}>
      <WorkspaceHeader title={t("adminDevices.allDevicesTitle", { count: adminDevices.length })} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />}
        showsVerticalScrollIndicator={false}
      >
        <PullRefreshStatus visible={refreshing} />
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{t("adminDevices.masterRegistryEyebrow")}</Text>
          <Text style={styles.title}>{t("adminDevices.title")}</Text>
          <Text style={styles.copy}>{t("adminDevices.copy")}</Text>
        </View>

        <View style={styles.metrics}>
          <Metric value={String(adminDevices.length)} label={t("adminDevices.allMetric")} styles={styles} />
          <Metric value={String(inventory.length)} label={t("adminDevices.inventoryMetric")} styles={styles} />
          <Metric value={String(online.length)} label={t("adminDevices.onlineMetric")} styles={styles} />
          <Metric value={String(offline.length)} label={t("adminDevices.offlineMetric")} attention={offline.length > 0} styles={styles} />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {filters.map(([key, label]) => (
            <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: filter === key }} onPress={() => setFilter(key)} style={[styles.filter, filter === key && styles.filterActive]}>
              <Text style={[styles.filterText, filter === key && styles.filterTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {adminDevicesLoading && adminDevices.length === 0 ? <Text style={styles.muted}>{t("adminDevices.loadingInventory")}</Text> : null}
        {adminDevicesError ? <Pressable accessibilityRole="button" onPress={() => loadAdminDevices(true).catch(() => undefined)}><Text style={styles.error}>{adminDevicesError} — {t("common.retry")}</Text></Pressable> : null}
        {shown.map((device) => <DeviceRow key={device.id} device={device} styles={styles} colors={colors} t={t} />)}
        {!adminDevicesLoading && !adminDevicesError && shown.length === 0 ? <Text style={styles.muted}>{t("adminDevices.noDevicesMatchFilter")}</Text> : null}
      </ScrollView>
    </View>
  );
}

function Metric({ value, label, attention = false, styles }: { value: string; label: string; attention?: boolean; styles: ReturnType<typeof createStyles> }) {
  return <View style={styles.metric}><Text style={[styles.metricValue, attention && styles.attention]}>{value}</Text><Text style={styles.metricLabel}>{label}</Text></View>;
}

function DeviceRow({ device, styles, colors, t }: { device: AdminDeviceInventory; styles: ReturnType<typeof createStyles>; colors: ReturnType<typeof usePreferences>["colors"]; t: any }) {
  const status = statusOf(device);
  const node = device.node;
  const location = node?.farmName || (device.claimedFarmId ? t("adminDevices.assigned") : t("adminDevices.unassignedCustomer"));
  const detail = node?.zoneId ? t("adminDevices.assignedZone", { location }) : location;
  return <View style={styles.row}>
    <View style={styles.icon}><Icon name={device.type === "GATEWAY" ? "wifi" : "cpu"} size={19} color={colors.primary} /></View>
    <View style={styles.info}>
      <Text style={styles.name} numberOfLines={1}>{node?.name || device.model || device.deviceId}</Text>
      <Text style={styles.meta} numberOfLines={1}>{device.serial || device.deviceId} · {detail}</Text>
      <Text style={styles.identity} numberOfLines={1}>{device.identityState || t("adminDevices.unassignedIdentity")}</Text>
    </View>
    <View style={styles.statusColumn}>
      <Text style={[styles.badge, status === "INVENTORY" ? styles.stock : status === "ONLINE" ? styles.online : styles.offline]}>{statusLabel(status, t)}</Text>
      {node?.firmwareVersion ? <Text style={styles.version} numberOfLines={1}>v{node.firmwareVersion}</Text> : null}
    </View>
  </View>;
}

function createStyles(c: ReturnType<typeof usePreferences>["colors"]) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.background }, scroll: { gap: 14, padding: 18, paddingBottom: 35 },
    hero: { backgroundColor: "#064e3b", borderRadius: 18, gap: 5, padding: 18 }, eyebrow: { color: "#a7f3d0", fontSize: 10, fontWeight: fontWeight.bold, letterSpacing: 1 }, title: { color: "#ffffff", fontSize: 21, fontWeight: fontWeight.bold }, copy: { color: "#d1fae5", fontSize: 12, lineHeight: 18 },
    metrics: { flexDirection: "row", justifyContent: "space-between" }, metric: { backgroundColor: c.surface, borderColor: c.border, borderRadius: 12, borderWidth: 1, padding: 10, width: "23%" }, metricValue: { color: c.text, fontSize: 17, fontWeight: fontWeight.bold }, metricLabel: { color: c.textMuted, fontSize: 10, marginTop: 3 }, attention: { color: c.danger },
    filters: { gap: 8 }, filter: { borderColor: c.border, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 }, filterActive: { backgroundColor: c.primary, borderColor: c.primary }, filterText: { color: c.textMuted, fontSize: 12, fontWeight: fontWeight.bold }, filterTextActive: { color: c.surface },
    row: { alignItems: "center", backgroundColor: c.surface, borderColor: c.border, borderRadius: 14, borderWidth: 1, flexDirection: "row", gap: 10, padding: 13 }, icon: { alignItems: "center", backgroundColor: c.primarySoft, borderRadius: 11, height: 38, justifyContent: "center", width: 38 }, info: { flex: 1, minWidth: 0 }, name: { color: c.text, fontSize: 14, fontWeight: fontWeight.bold }, meta: { color: c.textMuted, fontSize: 11, lineHeight: 16, marginTop: 3 }, identity: { color: c.textMuted, fontSize: 10, marginTop: 2 }, statusColumn: { alignItems: "flex-end", gap: 5, maxWidth: 78 },
    badge: { fontSize: 10, fontWeight: fontWeight.bold, overflow: "hidden", paddingHorizontal: 7, paddingVertical: 4, textAlign: "center" }, stock: { backgroundColor: "#fef3c7", color: "#92400e" }, online: { backgroundColor: c.primarySoft, color: c.primary }, offline: { backgroundColor: "#fee2e2", color: "#b91c1c" }, version: { color: c.textMuted, fontSize: 10 }, muted: { color: c.textMuted, fontSize: 13, paddingVertical: 18, textAlign: "center" }, error: { color: "#b91c1c", fontSize: 13, paddingVertical: 18, textAlign: "center" },
  });
}
