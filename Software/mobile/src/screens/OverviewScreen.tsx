import React from "react";
import { fontWeight } from "../theme/typography";
import { useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  Alert,
  TextInput,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { api } from "../services/api";
import { Icon } from "../components/Icon";
import { PullRefreshStatus } from "../components/PullRefreshStatus";
import { isTelemetryStale } from "../components/DeviceDetailsPanel";
import { useWorkspace } from "../context/WorkspaceContext";
import { usePreferences } from "../context/PreferencesContext";
import { WorkspaceHeader } from "./WorkspaceHeader";
import type { Zone } from "../types";
import type { RootStackParamList } from "../navigation/types";

export function OverviewScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors, language } = usePreferences();
  const themedStyles = React.useMemo(() => createStyles(colors), [colors]);
  const {
    user,
    farms,
    selectedFarmId,
    selectFarm,
    overview,
    alerts,
    currentDevices,
    farmZones,
    latestIrrigationByZone,
    irrigationLoading,
    irrigationError,
    overviewLoading,
    overviewError,
    refreshing,
    refresh,
    onRefresh,
    irrigate,
    emergencyStop,
    irrigationStatusLabel,
  } = useWorkspace();

  const selectedFarm = farms.find((f) => f.id === selectedFarmId);
  const tankLastUpdated = Date.parse(overview?.tankState?.last_updated || "");
  const tankUnknown = !Number.isFinite(tankLastUpdated) || tankLastUpdated <= 0;
  const [farmName, setFarmName] = React.useState("");
  const [addingFarm, setAddingFarm] = React.useState(false);
  const [savingFarm, setSavingFarm] = React.useState(false);
  const manageFarm = async (operation: () => Promise<unknown>, created = false) => {
    if (savingFarm) return;
    setSavingFarm(true);
    try {
      await operation();
      if (created) {
        setFarmName("");
        setAddingFarm(false);
      }
      await refresh({ showError: true });
    } catch (error) {
      Alert.alert(t("common.error"), error instanceof Error ? error.message : undefined);
    } finally {
      setSavingFarm(false);
    }
  };

  const activeAlertsCount = overview?.activeAlertsCount ?? alerts.length;
  const onlineDevicesCount = currentDevices.filter((d) => d.online).length;
  const totalDevicesCount = currentDevices.length;

  const renderMoistureStatus = (zone: Zone, soilMoisture?: number | null) => {
    const min = zone.target_moisture_min ?? 40;
    const max = zone.target_moisture_max ?? 75;

    if (soilMoisture == null) {
      return (
        <View style={themedStyles.moistureContainer}>
          <Text style={themedStyles.moistureRangeText}>
            {language === "en" ? "No soil moisture reading received" : "Chưa nhận số đo độ ẩm đất"}
          </Text>
        </View>
      );
    }

    const isLow = soilMoisture < min;
    const isOptimal = soilMoisture >= min && soilMoisture <= max;

    return (
      <View style={themedStyles.moistureContainer}>
        <View style={themedStyles.moistureHeaderRow}>
          <Text style={themedStyles.moistureRangeText}>
            {t("overview.moistureThreshold", { min, max })}
          </Text>
          <View
            style={[
              themedStyles.moistureBadge,
              isOptimal
                ? themedStyles.badgeOptimal
                : isLow
                ? themedStyles.badgeLow
                : themedStyles.badgeHigh,
            ]}
          >
            <Text
              style={[
                themedStyles.moistureBadgeText,
                isOptimal
                  ? themedStyles.textOptimal
                  : isLow
                  ? themedStyles.textLow
                  : themedStyles.textHigh,
              ]}
            >
              {isOptimal ? t("overview.optimalMoisture") : isLow ? t("overview.lowMoisture") : t("overview.highMoisture")}
            </Text>
          </View>
        </View>

        {/* Visual progress track */}
        <View style={themedStyles.progressTrack}>
          <View
            style={[
              themedStyles.progressBar,
              isOptimal
                ? themedStyles.barOptimal
                : isLow
                ? themedStyles.barLow
                : themedStyles.barHigh,
              { width: `${Math.min(100, Math.max(0, soilMoisture))}%` },
            ]}
          />
        </View>
      </View>
    );
  };

  return (
    <View style={themedStyles.screen}>
      <WorkspaceHeader title={t("overview.greeting", { name: user.name || user.email.split("@")[0] })} />

      <ScrollView
        contentContainerStyle={themedStyles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <PullRefreshStatus visible={refreshing} />
        {(
          <View style={themedStyles.sectionHeader}>
            <View style={themedStyles.farmTitleRow}>
              <Text style={themedStyles.sectionTitle}>{t("overview.farmingFarms")}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t("overview.openFarmMap")} onPress={() => navigation.getParent<NativeStackNavigationProp<RootStackParamList>>()?.navigate("Main", { screen: "Map" })} style={themedStyles.mapButton}>
                <Icon name="map" size={15} color={colors.primary} />
                <Text style={[themedStyles.mapButtonText, { color: colors.primary }]}>{t("overview.map")}</Text>
              </Pressable>
            </View>
            <View style={themedStyles.farmSelectorList}>
              <Pressable accessibilityRole="button" disabled={savingFarm} onPress={() => setAddingFarm(value => !value)}>
                <Text style={{ color: colors.primary }}>Thêm vườn</Text>
              </Pressable>
              {selectedFarm && <Pressable accessibilityRole="button" disabled={savingFarm} onPress={() =>
                Alert.alert("Xóa vườn", `Xóa “${selectedFarm.name}” và các khu vực cùng lịch sử của vườn?`, [
                  { text: "Hủy", style: "cancel" },
                  { text: "Xóa", style: "destructive", onPress: () => void manageFarm(() => api.deleteFarm(selectedFarm.id)) },
                ])
              }><Text style={{ color: "#dc2626" }}>Xóa vườn đang chọn</Text></Pressable>}
            </View>
            {addingFarm && <View>
              <TextInput accessibilityLabel="Tên vườn" placeholder="Tên vườn" value={farmName} maxLength={100}
                onChangeText={setFarmName} editable={!savingFarm} style={[themedStyles.farmCard, themedStyles.farmCardText]} />
              <Pressable accessibilityRole="button" disabled={savingFarm || !farmName.trim()}
                onPress={() => void manageFarm(() => api.createFarm(farmName.trim()), true)}>
                <Text style={{ color: colors.primary }}>Lưu vườn</Text>
              </Pressable>
            </View>}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={themedStyles.farmSelectorList}>
              {farms.map((farm) => {
                const active = selectedFarmId === farm.id;
                return <Pressable key={farm.id} accessibilityRole="radio" accessibilityState={{ selected: active }} accessibilityLabel={t("overview.selectFarm", { name: farm.name })} onPress={() => selectFarm(farm.id)} style={[themedStyles.farmCard, active && themedStyles.farmCardActive]}>
                  <Icon name="sprout" size={16} color={active ? colors.surface : colors.primary} />
                  <Text style={[themedStyles.farmCardText, active && themedStyles.farmCardTextActive]} numberOfLines={1}>{farm.name}</Text>
                </Pressable>;
              })}
            </ScrollView>
          </View>
        )}

        {/* Quick Stats Grid */}
        <View style={themedStyles.statsRow}>
          <View style={themedStyles.statCard}>
            <View style={[themedStyles.statIconBadge, themedStyles.statIconBadgeGreen]}>
              <Icon name="sprout" size={18} color={colors.primary} />
            </View>
            <Text style={themedStyles.statValue}>{farmZones.length}</Text>
            <Text style={themedStyles.statLabel}>{t("overview.cultivationZones")}</Text>
          </View>

          <View style={themedStyles.statCard}>
            <View style={[themedStyles.statIconBadge, themedStyles.statIconBadgeBlue]}>
              <Icon name="cpu" size={18} color="#2563eb" />
            </View>
            <Text style={themedStyles.statValue}>
              {onlineDevicesCount}/{totalDevicesCount}
            </Text>
            <Text style={themedStyles.statLabel}>{t("overview.devicesOnline")}</Text>
          </View>

          <View style={themedStyles.statCard}>
            <View
              style={[
                themedStyles.statIconBadge,
                activeAlertsCount > 0
                  ? themedStyles.statIconBadgeRed
                  : themedStyles.statIconBadgeGray,
              ]}
            >
              <Icon
                name="bell"
                size={18}
                color={activeAlertsCount > 0 ? "#ef4444" : colors.textMuted}
              />
            </View>
            <Text
              style={[
                themedStyles.statValue,
                activeAlertsCount > 0 && themedStyles.statValueAlert,
              ]}
            >
              {activeAlertsCount}
            </Text>
            <Text style={themedStyles.statLabel}>{t("overview.alerts")}</Text>
          </View>
        </View>

        {/* Cultivation Zones List */}
        <View style={themedStyles.heroCard}>
          <View style={themedStyles.heroHeader}>
            <View style={themedStyles.heroStatusRow}>
              <View style={[themedStyles.statusBeacon, overviewError ? themedStyles.beaconError : overview?.tankState?.safe === false ? themedStyles.beaconWarning : themedStyles.beaconOnline]} />
            </View>
            <Text style={themedStyles.heroFarmName}>{selectedFarm?.name || t("overview.defaultFarmName")}</Text>
          </View>
          {overviewLoading ? (
            <View style={themedStyles.heroLoading}>
              <ActivityIndicator color="#9ed9b5" />
              <Text style={themedStyles.heroMuted}>{t("overview.syncingRealtime")}</Text>
            </View>
          ) : overviewError ? (
            <View style={themedStyles.heroErrorBox}>
              <Text style={themedStyles.heroErrorTitle}>{t("overview.cloudNotConnected")}</Text>
              <Text style={themedStyles.heroErrorSubtitle}>{overviewError}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("overview.retryConnection")}
                onPress={() => {
                  refresh({ showError: true }).catch(() => undefined);
                }}
                style={themedStyles.retryHeroButton}
              >
                <Icon name="refresh" size={14} color={colors.surface} />
                <Text style={themedStyles.retryHeroText}>{t("overview.retryConnectionAction")}</Text>
              </Pressable>
            </View>
          ) : (
            <View style={themedStyles.heroBody}>
              <View style={themedStyles.heroStatusContent}>
                <Text style={themedStyles.heroTitle}>
                  {tankUnknown
                    ? (language === "en" ? "No water tank data" : "Chưa có dữ liệu bể nước")
                    : overview?.tankState?.safe === false
                    ? t("overview.checkWaterTank")
                    : t("overview.systemReady")}
                </Text>
              </View>

            </View>
          )}
        </View>

        {selectedFarmId && <View style={themedStyles.heroCard}>
              {/* Emergency Stop Action */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("overview.emergencyStopA11y")}
                disabled={!selectedFarmId}
                onPress={() => {
                  if (selectedFarmId) emergencyStop(selectedFarmId);
                }}
                style={({ pressed }) => [
                  themedStyles.emergencyButton,
                  pressed && themedStyles.buttonPressed,
                ]}
              >
                <Icon name="power" size={16} color={colors.danger} />
                <Text style={themedStyles.emergencyText}>{t("overview.emergencyStop")}</Text>
              </Pressable>
        </View>}
        <View style={themedStyles.zonesSection}>
          <View style={themedStyles.zonesHeader}>
            <Text style={themedStyles.sectionTitle}>{t("overview.zonesWithCount", { count: farmZones.length })}</Text>
          </View>

          {farmZones.length ? (
            farmZones.map((zone) => {
              const telemetry = zone.telemetries?.[0];
              const isStale = isTelemetryStale(telemetry?.timestamp);
              const irrigation = latestIrrigationByZone.get(zone.id);

              return (
                <View key={zone.id} style={themedStyles.zoneCard}>
                  {/* Zone Card Header */}
                  <View style={themedStyles.zoneHeader}>
                    <View style={themedStyles.zoneTitleCol}>
                      <Text style={themedStyles.zoneName}>{zone.name}</Text>
                      <View style={themedStyles.cropBadge}>
                        <Icon name="sprout" size={12} color="#125d3c" />
                        <Text style={themedStyles.cropText}>
                          {zone.crop_type || t("overview.generalCrop")}
                        </Text>
                      </View>
                    </View>

                    {/* Irrigation Quick Action Button */}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("overview.irrigate5MinA11y", { name: zone.name })}
                      onPress={() => irrigate(zone)}
                      style={({ pressed }) => [
                        themedStyles.irrigateButton,
                        pressed && themedStyles.buttonPressed,
                      ]}
                    >
                      <Icon name="droplet" size={15} color={colors.surface} />
                      <Text style={themedStyles.irrigateButtonText}>{t("overview.irrigate5Min")}</Text>
                    </Pressable>
                  </View>

                  {telemetry?.quality !== 1 && renderMoistureStatus(zone, telemetry?.soil_moisture)}

                  {telemetry ? (
                    <View style={themedStyles.metricsRow}>
                      {([
                        { label: "soilMoisture", value: telemetry.soil_moisture, unit: "%", icon: "droplet", color: "#0284c7" },
                        { label: "soilTemp", value: telemetry.soil_temp, unit: "°C", icon: "thermometer", color: "#ea580c" },
                        { label: "airTemp", value: telemetry.air_temp, unit: "°C", icon: "thermometer", color: "#ea580c" },
                        { label: "airHumidity", value: telemetry.air_humidity, unit: "%", icon: "wind", color: "#0d9488" },
                      ] as const).map(({ label, value, unit, icon, color }) => (
                        <View key={label} style={themedStyles.metricChip}>
                          <View style={themedStyles.metricLabelRow}>
                            <Icon name={icon} size={14} color={color} />
                            <Text style={themedStyles.metricChipText}>{t(`deviceDetails.${label}`)}</Text>
                          </View>
                          <Text style={themedStyles.metricValueBold}>{value == null ? "–" : `${value}${unit}`}</Text>
                        </View>
                      ))}
                    </View>
                  ) : (
                    <View style={themedStyles.noTelemetryBox}>
                      <Text style={themedStyles.mutedText}>{t("overview.noTelemetry")}</Text>
                    </View>
                  )}

                  {/* Zone Footer: Telemetry freshness & Irrigation Log */}
                  <View style={themedStyles.zoneFooter}>
                    {telemetry ? (
                      <View style={themedStyles.freshnessRow}>
                        <View
                          style={[
                            themedStyles.freshnessDot,
                            isStale ? themedStyles.dotStale : themedStyles.dotOnline,
                          ]}
                        />
                        <Text style={themedStyles.freshnessText}>
                          {isStale ? t("overview.dataStale") : t("overview.dataFresh")}
                        </Text>
                      </View>
                    ) : (
                      <View />
                    )}

                    {irrigation && (
                      <View style={themedStyles.irrigationLogBadge}>
                        <Text style={themedStyles.irrigationLogText}>
                          {t("overview.commandStatus", { status: irrigationStatusLabel(irrigation.status) })}
                          {irrigation.measured_flow_liters != null
                            ? ` • ${irrigation.measured_flow_liters} L`
                            : ""}
                        </Text>
                      </View>
                    )}
                  </View>

                  {irrigationLoading && !irrigation && (
                    <Text style={themedStyles.inlineMutedText}>{t("overview.loadingIrrigation")}</Text>
                  )}
                  {irrigationError && (
                    <Text style={themedStyles.inlineErrorText}>{irrigationError}</Text>
                  )}
                </View>
              );
            })
          ) : (
            <View style={themedStyles.emptyCard}>
              <Icon name="sprout" size={32} color="#94a3b8" />
              <Text style={themedStyles.emptyTitle}>{t("overview.noZones")}</Text>
              <Text style={themedStyles.mutedText}>
                {t("overview.noZonesDesc")}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) {
  const isDark = colors.background === "#0B0B0C";
  const heroBackground = colors.surface;
  const heroText = colors.text;
  const heroMuted = colors.textMuted;
  return StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  scroll: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 40,
    gap: 18,
  },
  sectionHeader: {
    gap: 10,
  },
  farmTitleRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  mapButton: { alignItems: "center", backgroundColor: colors.primarySoft, borderColor: colors.primaryBorder, borderRadius: 10, borderWidth: 1, flexDirection: "row", gap: 5, paddingHorizontal: 10, paddingVertical: 7 },
  mapButtonText: { fontSize: 12, fontWeight: fontWeight.bold },
  sectionTitle: {
    fontSize: 16,
    fontWeight: fontWeight.bold,
    color: colors.text,
    letterSpacing: -0.3,
  },
  farmSelectorList: {
    flexDirection: "row",
    gap: 8,
  },
  farmCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 99,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  farmCardActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  farmCardText: {
    fontSize: 13,
    fontWeight: fontWeight.bold,
    color: colors.textMuted,
  },
  farmCardTextActive: {
    color: colors.surface,
    fontWeight: fontWeight.bold,
  },
  heroCard: {
    backgroundColor: heroBackground,
    borderRadius: 20,
    padding: 20,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 4,
    gap: 14,
  },
  heroHeader: {
    gap: 4,
  },
  heroStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusBeacon: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  beaconOnline: {
    backgroundColor: colors.primary,
  },
  beaconWarning: {
    backgroundColor: "#fbbf24",
  },
  beaconError: {
    backgroundColor: "#f87171",
  },
  heroEyebrow: {
    color: heroMuted,
    fontSize: 11,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
  },
  heroFarmName: {
    color: heroText,
    fontSize: 19,
    fontWeight: fontWeight.bold,
  },
  heroLoading: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  heroMuted: {
    color: heroMuted,
    fontSize: 13,
  },
  heroErrorBox: {
    backgroundColor: "rgba(0, 0, 0, 0.2)",
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  heroErrorTitle: {
    color: heroText,
    fontSize: 14,
    fontWeight: fontWeight.bold,
  },
  heroErrorSubtitle: {
    color: "#fca5a5",
    fontSize: 12,
    lineHeight: 16,
  },
  retryHeroButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    borderWidth: 1,
    borderColor: isDark ? colors.border : colors.surface,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 6,
  },
  retryHeroText: {
    color: heroText,
    fontSize: 12,
    fontWeight: fontWeight.bold,
  },
  heroBody: {
    gap: 14,
  },
  heroStatusContent: {
    gap: 4,
  },
  heroTitle: {
    color: heroText,
    fontSize: 17,
    fontWeight: fontWeight.bold,
  },
  heroSubtitle: {
    color: heroMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  emergencyButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1.5,
    borderColor: "#f87171",
    borderRadius: 12,
    paddingVertical: 12,
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
  emergencyText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: fontWeight.bold,
    letterSpacing: 0.8,
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.surfaceMuted,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 2,
    gap: 4,
  },
  statIconBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  statValue: {
    fontSize: 17,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  statLabel: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: fontWeight.semibold,
    textAlign: "center",
  },
  zonesSection: {
    gap: 12,
  },
  zonesHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  zoneCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
    gap: 12,
  },
  zoneHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  zoneTitleCol: {
    flex: 1,
    gap: 4,
  },
  zoneName: {
    fontSize: 15,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  cropBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    backgroundColor: colors.primarySoft,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  cropText: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    color: colors.primary,
  },
  irrigateButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
  },
  irrigateButtonText: {
    color: isDark ? "#18181B" : colors.surface,
    fontSize: 13,
    fontWeight: fontWeight.bold,
  },
  moistureContainer: {
    gap: 6,
    backgroundColor: colors.background,
    borderRadius: 10,
    padding: 10,
  },
  moistureHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  moistureRangeText: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: fontWeight.semibold,
  },
  moistureBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeOptimal: {
    backgroundColor: colors.primarySoft,
  },
  badgeLow: {
    backgroundColor: "#fef3c7",
  },
  badgeHigh: {
    backgroundColor: "#e0f2fe",
  },
  moistureBadgeText: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
  },
  textOptimal: {
    color: colors.primary,
  },
  textLow: {
    color: "#b45309",
  },
  textHigh: {
    color: "#0369a1",
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: "hidden",
  },
  progressBar: {
    height: "100%",
    borderRadius: 3,
  },
  metricsRow: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
  },
  metricChip: {
    flexBasis: "46%",
    flexGrow: 1,
    gap: 4,
    backgroundColor: colors.surfaceMuted,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  metricLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metricChipText: {
    flexShrink: 1,
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: fontWeight.medium,
  },
  metricValueBold: {
    color: colors.text,
    fontSize: 15,
    fontWeight: fontWeight.bold,
  },
  noTelemetryBox: {
    paddingVertical: 6,
  },
  zoneFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.surfaceMuted,
    paddingTop: 8,
  },
  freshnessRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  freshnessDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  freshnessText: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: fontWeight.medium,
  },
  irrigationLogBadge: {
    backgroundColor: colors.primarySoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  irrigationLogText: {
    fontSize: 11,
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  inlineMutedText: {
    fontSize: 12,
    color: colors.textMuted,
    fontStyle: "italic",
  },
  inlineErrorText: {
    fontSize: 12,
    color: "#dc2626",
    fontWeight: fontWeight.semibold,
  },
  emptyCard: {
    backgroundColor: colors.surface,
    padding: 32,
    borderRadius: 16,
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  mutedText: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  barOptimal: {
    backgroundColor: colors.primary,
  },
  barLow: {
    backgroundColor: "#f59e0b",
  },
  barHigh: {
    backgroundColor: "#0284c7",
  },
  statIconBadgeGreen: {
    backgroundColor: colors.primarySoft,
  },
  statIconBadgeBlue: {
    backgroundColor: "#eff6ff",
  },
  statIconBadgeRed: {
    backgroundColor: "#fef2f2",
  },
  statIconBadgeGray: {
    backgroundColor: colors.background,
  },
  statValueAlert: {
    color: "#dc2626",
  },
  dotOnline: {
    backgroundColor: colors.primary,
  },
  dotStale: {
    backgroundColor: "#f59e0b",
  },
}); }
