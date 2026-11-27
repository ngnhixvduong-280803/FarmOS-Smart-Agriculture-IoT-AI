import React, { useEffect, useMemo } from "react";
import { fontWeight } from "../theme/typography";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PullRefreshStatus } from "../components/PullRefreshStatus";
import { usePreferences } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import type { RootStackParamList } from "../navigation/types";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function FarmOperationsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const route = useRoute<RouteProp<RootStackParamList, "FarmOperations">>();
  const { colors } = usePreferences();
  const { farms, selectFarm, overview, currentDevices, farmZones, alerts, refreshing, overviewLoading, overviewError, onRefresh, latestIrrigationByZone, irrigationStatusLabel } = useWorkspace();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const farm = farms.find((item) => item.id === route.params.farmId);
  useEffect(() => { selectFarm(route.params.farmId); }, [route.params.farmId, selectFarm]);
  const isCurrentFarm = overview?.farm.id === route.params.farmId;
  const owners = farm?.user_farms?.map((membership) => membership.user).filter((owner): owner is NonNullable<typeof owner> => owner?.role === "USER") || [];
  const farmAlerts = alerts.filter((alert) => alert.farm_id === route.params.farmId || alert.farm?.id === route.params.farmId);
  const onlineDevices = currentDevices.filter((device) => device.online).length;
  const gateways = currentDevices.filter((device) => device.type === "GATEWAY");
  const farmIrrigation = farmZones.map((zone) => latestIrrigationByZone.get(zone.id)).filter((log): log is NonNullable<typeof log> => Boolean(log));

  return <View style={styles.screen}>
    <WorkspaceHeader title={t("operations.farmProfile")} onBack={() => navigation.goBack()} />
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />}
      showsVerticalScrollIndicator={false}
    >
      <PullRefreshStatus visible={refreshing} />
      <View style={styles.hero}>
        <View style={styles.icon}><Icon name="sprout" size={26} color={colors.primary} /></View>
        <View style={styles.heroCopy}>
          <Text style={styles.eyebrow}>{t("operations.clientFarmEyebrow")}</Text>
          <Text style={styles.title}>{farm?.name || t("operations.defaultFarm")}</Text>
          <Text style={styles.location}>{farm?.address || farm?.location || t("operations.noAddress")}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("operations.clientInCharge")}</Text>
        {owners.length ? owners.map((owner) => <View key={owner.id} style={styles.customerRow}>
          <View style={styles.customerAvatar}><Text style={styles.customerAvatarText}>{(owner.name || owner.email).slice(0, 2).toUpperCase()}</Text></View>
          <View style={styles.customerCopy}><Text style={styles.customerName}>{owner.name || t("common.unnamed")}</Text><Text style={styles.customerEmail}>{owner.email}</Text></View>
          <Text style={styles.roleBadge}>{t("operations.customerBadge")}</Text>
        </View>) : <Text style={styles.muted}>{t("operations.noClientAssigned")}</Text>}
      </View>

      {!isCurrentFarm || overviewLoading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={styles.muted}>{t("operations.loadingProfile")}</Text></View> : overviewError ? <View style={styles.error}><Text style={styles.errorTitle}>{t("operations.loadFailed")}</Text><Text style={styles.muted}>{overviewError}</Text><Pressable accessibilityRole="button" onPress={() => onRefresh().catch(() => undefined)} style={styles.retry}><Text style={styles.retryText}>{t("operations.retry")}</Text></Pressable></View> : <>
        <View style={styles.stats}>
          <Stat label={t("operations.zonesStat")} value={String(farmZones.length)} icon="sprout" colors={colors} />
          <Stat label={t("operations.nodesOnlineStat")} value={`${onlineDevices}/${currentDevices.length}`} icon="cpu" colors={colors} />
          <Stat label={t("operations.openAlertsStat")} value={String(farmAlerts.length)} icon="bell" colors={colors} attention={farmAlerts.length > 0} />
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>{t("operations.farmDevicesSection")}</Text><Text style={styles.count}>{t("operations.deviceCount", { count: currentDevices.length })}</Text></View>
          {currentDevices.length ? currentDevices.map((device) => <View key={device.id} style={styles.deviceRow}>
            <View style={[styles.deviceIcon, device.online ? styles.deviceIconOnline : styles.deviceIconOffline]}><Icon name={device.type === "GATEWAY" ? "wifi" : "cpu"} size={18} color={device.online ? colors.primary : colors.textMuted} /></View>
            <View style={styles.deviceCopy}><Text style={styles.deviceName}>{device.name}</Text><Text style={styles.deviceMeta}>{device.type === "GATEWAY" ? t("operations.gatewayType") : device.zone?.name || t("operations.unassignedZoneNode")}{device.last_seen ? ` • ${new Date(device.last_seen).toLocaleString()}` : ""}</Text></View>
            <View style={[styles.status, device.online ? styles.statusOnline : styles.statusOffline]}><Text style={[styles.statusText, device.online ? styles.statusTextOnline : styles.statusTextOffline]}>{device.online ? t("common.online") : t("common.offline")}</Text></View>
          </View>) : <Text style={styles.muted}>{t("operations.noDevicesInFarm")}</Text>}
          {gateways.length === 0 && currentDevices.length > 0 ? <Text style={styles.warning}>{t("operations.noGatewayWarning")}</Text> : null}
        </View>

        <View style={styles.section}>
          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>{t("operations.operationsReportSection")}</Text><Text style={styles.count}>{t("operations.liveUpdated")}</Text></View>
          <ReportRow label={t("operations.lastIrrigationCommand")} value={farmIrrigation.length ? irrigationStatusLabel(farmIrrigation.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0].status) : t("operations.noData")} />
          <ReportRow label={t("operations.pendingAlertsReport")} value={farmAlerts.length ? t("operations.neededAction", { count: farmAlerts.length }) : t("operations.none")} attention={farmAlerts.length > 0} />
          <ReportRow label={t("operations.waterTankStatus")} value={overview?.tankState?.safe === false ? t("operations.needsCheck") : t("operations.safe")} attention={overview?.tankState?.safe === false} />
        </View>
      </>}
    </ScrollView>
  </View>;
}

function Stat({ label, value, icon, colors, attention = false }: { label: string; value: string; icon: "sprout" | "cpu" | "bell"; colors: ReturnType<typeof usePreferences>["colors"]; attention?: boolean }) { const styles = createStatStyles(colors); return <View style={styles.card}><Icon name={icon} size={18} color={attention ? "#dc2626" : colors.primary} /><Text style={[styles.value, attention && styles.valueAttention]}>{value}</Text><Text style={styles.label}>{label}</Text></View>; }
function ReportRow({ label, value, attention = false }: { label: string; value: string; attention?: boolean }) { return <View style={reportStyles.row}><Text style={reportStyles.label}>{label}</Text><Text style={[reportStyles.value, attention && reportStyles.attention]}>{value}</Text></View>; }
function createStatStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({ card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 14, borderWidth: 1, flex: 1, gap: 5, padding: 13 }, value: { color: colors.text, fontSize: 17, fontWeight: fontWeight.bold }, valueAttention: { color: "#dc2626" }, label: { color: colors.textMuted, fontSize: 11, fontWeight: fontWeight.medium } }); }
const reportStyles = StyleSheet.create({ row: { alignItems: "center", borderTopColor: "#e2e8f0", borderTopWidth: 1, flexDirection: "row", justifyContent: "space-between", paddingVertical: 12 }, label: { color: "#475569", fontSize: 13 }, value: { color: "#16704a", fontSize: 13, fontWeight: fontWeight.bold, maxWidth: "50%", textAlign: "right" }, attention: { color: "#dc2626" } });
function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background }, content: { gap: 16, padding: 18, paddingBottom: 36 }, hero: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 18, borderWidth: 1, flexDirection: "row", gap: 14, padding: 16 }, icon: { alignItems: "center", backgroundColor: colors.primarySoft, borderRadius: 16, height: 56, justifyContent: "center", width: 56 }, heroCopy: { flex: 1 }, eyebrow: { color: colors.primary, fontSize: 10, fontWeight: fontWeight.bold, letterSpacing: 0.7 }, title: { color: colors.text, fontSize: 20, fontWeight: fontWeight.bold, marginTop: 3 }, location: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 4 }, section: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 18, borderWidth: 1, gap: 10, padding: 16 }, sectionHeading: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" }, sectionTitle: { color: colors.text, fontSize: 16, fontWeight: fontWeight.bold }, count: { color: colors.textMuted, fontSize: 12, fontWeight: fontWeight.medium }, customerRow: { alignItems: "center", borderTopColor: colors.border, borderTopWidth: 1, flexDirection: "row", gap: 10, paddingTop: 12 }, customerAvatar: { alignItems: "center", backgroundColor: colors.primarySoft, borderRadius: 14, height: 34, justifyContent: "center", width: 34 }, customerAvatarText: { color: colors.primary, fontSize: 11, fontWeight: fontWeight.bold }, customerCopy: { flex: 1 }, customerName: { color: colors.text, fontSize: 14, fontWeight: fontWeight.bold }, customerEmail: { color: colors.textMuted, fontSize: 12, marginTop: 2 }, roleBadge: { backgroundColor: colors.primarySoft, color: colors.primary, fontSize: 11, fontWeight: fontWeight.bold, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 5 }, stats: { flexDirection: "row", gap: 8 }, loading: { alignItems: "center", backgroundColor: colors.surface, borderRadius: 18, gap: 10, padding: 28 }, error: { backgroundColor: colors.surface, borderColor: "#fecaca", borderRadius: 18, borderWidth: 1, gap: 8, padding: 16 }, errorTitle: { color: "#b91c1c", fontSize: 15, fontWeight: fontWeight.bold }, retry: { alignSelf: "flex-start", backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 }, retryText: { color: colors.surface, fontSize: 13, fontWeight: fontWeight.bold }, deviceRow: { alignItems: "center", borderTopColor: colors.border, borderTopWidth: 1, flexDirection: "row", gap: 10, paddingTop: 12 }, deviceIcon: { alignItems: "center", borderRadius: 12, height: 38, justifyContent: "center", width: 38 }, deviceIconOnline: { backgroundColor: colors.primarySoft }, deviceIconOffline: { backgroundColor: colors.surfaceMuted }, deviceCopy: { flex: 1 }, deviceName: { color: colors.text, fontSize: 14, fontWeight: fontWeight.bold }, deviceMeta: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 2 }, status: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4 }, statusOnline: { backgroundColor: colors.primarySoft }, statusOffline: { backgroundColor: "#fef2f2" }, statusText: { fontSize: 11, fontWeight: fontWeight.bold }, statusTextOnline: { color: colors.primary }, statusTextOffline: { color: "#b91c1c" }, warning: { color: "#b45309", fontSize: 12, lineHeight: 18 }, muted: { color: colors.textMuted, fontSize: 13, lineHeight: 19 } }); }
