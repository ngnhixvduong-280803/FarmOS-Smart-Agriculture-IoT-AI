import React from "react";
import { fontWeight } from "../theme/typography";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PullRefreshStatus } from "../components/PullRefreshStatus";
import { usePreferences } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { WorkspaceHeader } from "./WorkspaceHeader";
import type { AlertItem } from "../types";
import type { RootStackParamList } from "../navigation/types";

export function AlertsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { colors } = usePreferences();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  const {
    alerts,
    alertsLoading,
    resolvingAlertId,
    resolveAlert,
    refreshing,
    onRefresh,
  } = useWorkspace();

  const renderAlertItem = ({ item }: { item: AlertItem }) => {
    const isBusy = resolvingAlertId === item.id;
    const isCritical = item.level === "CRITICAL";
    const isWarning = item.level === "WARNING";

    return (
      <View
        style={[
          styles.alertCard,
          isCritical && styles.alertCardCritical,
          isWarning && styles.alertCardWarning,
        ]}
      >
        <View style={styles.cardHeaderRow}>
          <View
            style={[
              styles.levelBadge,
              isCritical
                ? styles.levelBadgeCritical
                : isWarning
                ? styles.levelBadgeWarning
                : styles.levelBadgeInfo,
            ]}
          >
            <Icon
              name="alertTriangle"
              size={14}
              color={isCritical ? "#dc2626" : isWarning ? "#d97706" : "#2563eb"}
            />
            <Text
              style={[
                styles.levelBadgeText,
                isCritical
                  ? styles.levelTextCritical
                  : isWarning
                  ? styles.levelTextWarning
                  : styles.levelTextInfo,
              ]}
            >
              {item.level}
            </Text>
          </View>
          <Text style={styles.timestampText}>
            {new Date(item.created_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            • {new Date(item.created_at).toLocaleDateString()}
          </Text>
        </View>

        <Text style={styles.alertMessage}>{item.message}</Text>

        <View style={styles.locationRow}>
          <Text style={styles.locationText}>
            {item.farm?.name || t("alerts.defaultFarmName")}
            {item.zone?.name ? ` • ${item.zone.name}` : ""}
          </Text>
        </View>

        <View style={styles.actionRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("alerts.markResolvedA11y", { message: item.message })}
            accessibilityState={{ busy: isBusy, disabled: isBusy }}
            disabled={isBusy}
            onPress={() => {
              resolveAlert(item).catch(() => undefined);
            }}
            style={({ pressed }) => [
              styles.resolveButton,
              pressed && styles.buttonPressed,
              isBusy && styles.disabled,
            ]}
          >
            {isBusy ? (
              <ActivityIndicator color={colors.primary} size="small" />
            ) : (
              <>
                <Icon name="check" size={15} color={colors.primary} />
                <Text style={styles.resolveButtonText}>{t("alerts.markResolved")}</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <WorkspaceHeader title={t("alerts.alertsTitleWithCount", { count: alerts.length })} onBack={() => navigation.goBack()} showAlerts={false} />

      <FlatList
        contentContainerStyle={styles.scroll}
        data={alerts}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListHeaderComponent={
          <><PullRefreshStatus visible={refreshing} /><View style={styles.headerSection}>
            <Text style={styles.sectionTitle}>
              {alerts.length > 0
                ? t("alerts.pendingAlertsWithCount", { count: alerts.length })
                : t("alerts.systemAlerts")}
            </Text>
          </View></>
        }
        ListEmptyComponent={
          alertsLoading ? (
            <View style={styles.state}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.muted}>{t("alerts.checkingAlerts")}</Text>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <View style={styles.emptyIconBadge}>
                <Icon name="check" size={28} color={colors.primary} />
              </View>
              <Text style={styles.emptyTitle}>{t("alerts.systemSafe")}</Text>
              <Text style={styles.emptySubtitle}>{t("alerts.systemSafeDesc")}</Text>
            </View>
          )
        }
        renderItem={renderAlertItem}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) {
  const isDark = colors.background === "#0B0B0C";
  return StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 40,
    gap: 14,
    flexGrow: 1,
  },
  headerSection: {
    gap: 4,
    marginBottom: 4,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.3,
  },
  sectionSubtitle: {
    color: "#64748b",
    fontSize: 13,
  },
  alertCard: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 2,
  },
  alertCardCritical: {
    borderColor: isDark ? "#7F3034" : "#FECACA",
    backgroundColor: isDark ? "#221416" : "#FFFAFA",
  },
  alertCardWarning: {
    borderColor: isDark ? "#6B5222" : "#FED7AA",
    backgroundColor: isDark ? "#211D12" : "#FFFDF9",
  },
  cardHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  levelBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  levelBadgeCritical: {
    backgroundColor: "#fee2e2",
  },
  levelBadgeWarning: {
    backgroundColor: "#fef3c7",
  },
  levelBadgeInfo: {
    backgroundColor: "#eff6ff",
  },
  levelBadgeText: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
  },
  levelTextCritical: {
    color: "#dc2626",
  },
  levelTextWarning: {
    color: "#d97706",
  },
  levelTextInfo: {
    color: "#2563eb",
  },
  timestampText: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: fontWeight.medium,
  },
  alertMessage: {
    color: colors.text,
    fontWeight: fontWeight.bold,
    fontSize: 14,
    lineHeight: 20,
  },
  locationRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  locationText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: fontWeight.medium,
  },
  actionRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 4,
  },
  resolveButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.primarySoft,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  resolveButtonText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: fontWeight.bold,
  },
  buttonPressed: {
    opacity: 0.8,
  },
  disabled: {
    opacity: 0.5,
  },
  state: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    gap: 8,
  },
  muted: {
    color: colors.textMuted,
    fontSize: 13,
  },
  emptyState: {
    backgroundColor: colors.surface,
    padding: 32,
    borderRadius: 18,
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 20,
  },
  emptyIconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  emptySubtitle: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 18,
    maxWidth: 280,
  },
}); }
