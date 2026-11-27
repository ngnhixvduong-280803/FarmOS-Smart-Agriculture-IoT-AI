import React from "react";
import { fontWeight } from "../theme/typography";
import { useNavigation } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Icon } from "../components/Icon";
import { PullRefreshStatus } from "../components/PullRefreshStatus";
import { usePreferences } from "../context/PreferencesContext";
import { DeviceDetailsPanel } from "../components/DeviceDetailsPanel";
import { useWorkspace } from "../context/WorkspaceContext";
import type { RootStackParamList } from "../navigation/types";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function DevicesScreen() {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const {
    currentDevices,
    devicesLoading,
    devicesError,
    loadDevices,
    refreshing,
    onRefresh,
  } = useWorkspace();

  React.useEffect(() => {
    loadDevices(false).catch(() => undefined);
  }, [loadDevices]);

  return (
    <View style={styles.screen}>
      <WorkspaceHeader title={t("devices.devicesTitleWithCount", { count: currentDevices.length })} />

      <ScrollView
        contentContainerStyle={styles.scroll}
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("devices.openDeviceSetup")}
          onPress={() => navigation.navigate("Onboarding")}
          style={({ pressed }) => [styles.actionCard, pressed && styles.buttonPressed]}
        >
          <View style={styles.actionIconContainer}>
            <Icon name="qrCode" size={24} color={colors.primary} />
          </View>
          <View style={styles.actionTextCol}>
            <Text style={styles.actionTitle}>{t("devices.addDevice")}</Text>
          </View>
          <View style={styles.primaryButton}>
            <Icon name="plus" size={16} color="#ffffff" />
            <Text style={styles.primaryButtonText}>{t("devices.scanQr")}</Text>
          </View>
        </Pressable>

        {/* Device List & Details */}
        <DeviceDetailsPanel
          devices={currentDevices}
          loading={devicesLoading}
          error={devicesError}
          onRetry={() => {
            loadDevices(true).catch(() => undefined);
          }}
        />
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 40,
    gap: 16,
  },
  actionCard: {
    backgroundColor: colors.primarySoft,
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  actionIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  actionTextCol: {
    flex: 1,
    gap: 2,
  },
  actionTitle: {
    fontSize: 15,
    fontWeight: fontWeight.bold,
    color: colors.primary,
  },
  primaryButton: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontWeight: fontWeight.bold,
    fontSize: 13,
  },
  buttonPressed: {
    opacity: 0.85,
  },
}); }
