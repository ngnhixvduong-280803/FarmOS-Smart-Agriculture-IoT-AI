import React, { useMemo } from "react";
import { fontWeight } from "../theme/typography";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Icon } from "../components/Icon";
import { PullRefreshStatus } from "../components/PullRefreshStatus";
import { usePreferences } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import type { RootStackParamList } from "../navigation/types";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function AdminSystemOverviewScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors, language } = usePreferences();
  const { farms, users, devices, alerts, refreshing, onDashboardRefresh } = useWorkspace();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const customers = users.filter((member) => member.role === "USER");
  const online = devices.filter((device) => device.online).length;
  const offline = devices.filter((device) => !device.online).length;
  const attentionFarms = farms.filter((farm) => alerts.some((alert) => alert.farm_id === farm.id || alert.farm?.id === farm.id) || devices.some((device) => device.farm?.id === farm.id && !device.online)).slice(0, 4);

  return <View style={styles.screen}>
    <WorkspaceHeader title={t("adminOverview.systemOverview")} />
    <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={false} onRefresh={onDashboardRefresh} tintColor={colors.primary} colors={[colors.primary]} />} showsVerticalScrollIndicator={false}>
      <PullRefreshStatus visible={refreshing} />
      <View style={styles.section}><View style={styles.heading}><Text style={styles.sectionTitle}>{t("adminOverview.connectionStatus")}</Text><Text style={styles.live}>{t("adminOverview.liveUpdated")}</Text></View><View style={styles.connectionRow}><View><Text style={styles.connectionValue}>{online}</Text><Text style={styles.connectionLabel}>{t("adminOverview.devicesOnline")}</Text></View><View style={styles.divider} /><View><Text style={[styles.connectionValue, offline > 0 && styles.danger]}>{offline}</Text><Text style={styles.connectionLabel}>{t("adminOverview.needsCheck")}</Text></View><View style={styles.divider} /><View><Text style={styles.connectionValue}>{alerts.length}</Text><Text style={styles.connectionLabel}>{t("adminOverview.openAlerts")}</Text></View></View></View>
      <View style={styles.section}><View style={styles.heading}><Text style={styles.sectionTitle}>{t("adminOverview.farmsNeedingAttention")}</Text><Pressable accessibilityRole="button" accessibilityLabel={t("adminOverview.openCustomersAndFarms")} onPress={() => navigation.navigate("Main", { screen: "Farms" })}><Text style={styles.link}>{t("common.viewAll")}</Text></Pressable></View>{attentionFarms.length ? attentionFarms.map((farm) => { const farmOffline = devices.filter((device) => device.farm?.id === farm.id && !device.online).length; const farmAlerts = alerts.filter((alert) => alert.farm_id === farm.id || alert.farm?.id === farm.id).length; return <Pressable key={farm.id} accessibilityRole="button" accessibilityLabel={t("adminOverview.openFarmProfile", { name: farm.name })} onPress={() => navigation.navigate("FarmOperations", { farmId: farm.id })} style={({ pressed }) => [styles.farmRow, pressed && styles.pressed]}><View style={styles.farmIcon}><Icon name="sprout" size={18} color={colors.primary} /></View><View style={styles.farmCopy}><Text style={styles.farmName}>{farm.name}</Text><Text style={styles.farmMeta}>{farmAlerts ? t("adminOverview.alertCount", { count: farmAlerts }) : t("adminOverview.noAlerts")}{farmOffline ? t("adminOverview.offlineNodes", { count: farmOffline }) : ""}</Text></View><Icon name="chevronRight" size={18} color={colors.textMuted} /></Pressable>; }) : <View style={styles.empty}><Icon name="check" size={20} color={colors.primary} /><Text style={styles.emptyText}>{t("adminOverview.noFarmsNeedingAttention")}</Text></View>}</View>
      <Text style={styles.sectionTitle}>{language === "en" ? "Customers and farms" : "Khách hàng và trang trại"}</Text>
      <View style={styles.grid}>
        <Metric icon="user" value={String(customers.length)} label={t("adminOverview.customers")} colors={colors} />
        <Metric icon="sprout" value={String(farms.length)} label={t("adminOverview.farms")} colors={colors} />
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={t("adminOverview.manageCustomersAndFarms")} onPress={() => navigation.navigate("Main", { screen: "Farms" })} style={({ pressed }) => [styles.manage, pressed && styles.pressed]}><View><Text style={styles.manageTitle}>{t("adminOverview.customersAndFarms")}</Text><Text style={styles.manageText}>{t("adminOverview.manageCustomersAndFarmsDesc")}</Text></View><Icon name="chevronRight" size={20} color={colors.surface} /></Pressable>
    </ScrollView>
  </View>;
}

function Metric({ icon, value, label, colors, attention = false }: { icon: "user" | "sprout" | "cpu" | "alertTriangle"; value: string; label: string; colors: ReturnType<typeof usePreferences>["colors"]; attention?: boolean }) { const styles = createMetricStyles(colors); return <View style={styles.card}><Icon name={icon} size={17} color={attention ? "#dc2626" : colors.primary} /><Text style={[styles.value, attention && styles.valueAttention]}>{value}</Text><Text style={styles.label}>{label}</Text></View>; }
function createMetricStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({ card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 15, borderWidth: 1, gap: 5, padding: 13, width: "48.5%" }, value: { color: colors.text, fontSize: 20, fontWeight: fontWeight.bold }, valueAttention: { color: "#dc2626" }, label: { color: colors.textMuted, fontSize: 12, fontWeight: fontWeight.medium } }); }
function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background }, scroll: { gap: 16, padding: 18, paddingBottom: 36 }, grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "space-between" }, section: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 18, borderWidth: 1, gap: 12, padding: 16 }, heading: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" }, sectionTitle: { color: colors.text, fontSize: 16, fontWeight: fontWeight.bold }, live: { color: colors.primary, fontSize: 9, fontWeight: fontWeight.bold, letterSpacing: 0.6 }, link: { color: colors.primary, fontSize: 12, fontWeight: fontWeight.bold }, connectionRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 }, connectionValue: { color: colors.text, fontSize: 21, fontWeight: fontWeight.bold }, connectionLabel: { color: colors.textMuted, fontSize: 11, marginTop: 2 }, divider: { backgroundColor: colors.border, height: 33, width: 1 }, danger: { color: "#dc2626" }, farmRow: { alignItems: "center", borderTopColor: colors.border, borderTopWidth: 1, flexDirection: "row", gap: 10, paddingTop: 12 }, farmIcon: { alignItems: "center", backgroundColor: colors.primarySoft, borderRadius: 12, height: 38, justifyContent: "center", width: 38 }, farmCopy: { flex: 1 }, farmName: { color: colors.text, fontSize: 14, fontWeight: fontWeight.bold }, farmMeta: { color: colors.textMuted, fontSize: 12, marginTop: 3 }, empty: { alignItems: "center", flexDirection: "row", gap: 8, paddingVertical: 8 }, emptyText: { color: colors.textMuted, fontSize: 13 }, manage: { alignItems: "center", backgroundColor: colors.primary, borderRadius: 16, flexDirection: "row", justifyContent: "space-between", padding: 17 }, manageTitle: { color: colors.surface, fontSize: 15, fontWeight: fontWeight.bold }, manageText: { color: "#d1fae5", fontSize: 12, lineHeight: 18, marginTop: 3, maxWidth: "90%" }, pressed: { opacity: 0.78 } }); }
