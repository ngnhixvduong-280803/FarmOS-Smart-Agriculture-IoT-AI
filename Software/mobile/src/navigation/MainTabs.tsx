import React, { useMemo } from "react";
import { fontWeight } from "../theme/typography";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { usePreferences } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { DevicesScreen } from "../screens/DevicesScreen";
import { OverviewScreen } from "../screens/OverviewScreen";
import { AdminSystemOverviewScreen } from "../screens/AdminSystemOverviewScreen";
import { AdminDevicesScreen } from "../screens/AdminDevicesScreen";
import { AdminFarmsScreen } from "../screens/AdminFarmsScreen";
import { FarmMapScreen } from "../screens/FarmMapScreen";
import { FarmAssistantScreen } from "../screens/FarmAssistantScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import type { MainTabParamList } from "./types";

const Tab = createBottomTabNavigator<MainTabParamList>();

const renderOverviewIcon = ({ color }: { color: string }) => (
  <Icon name="home" size={22} color={color} />
);

const renderDevicesIcon = ({ color }: { color: string }) => (
  <Icon name="cpu" size={22} color={color} />
);

const renderFarmsIcon = ({ color }: { color: string }) => (
  <Icon name="sprout" size={22} color={color} />
);

const renderMapIcon = ({ color }: { color: string }) => (
  <Icon name="map" size={22} color={color} />
);

const renderAssistantIcon = ({ color }: { color: string }) => <Icon name="sprout" size={22} color={color} />;

const renderSettingsIcon = ({ color }: { color: string }) => (
  <Icon name="cog" size={22} color={color} />
);

export function MainTabs() {
  const { user } = useWorkspace();
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const insets = useSafeAreaInsets();

  const overviewOptions = useMemo(
    () => ({
      tabBarLabel: user.role === "ADMIN" ? t("tabs.system") : t("tabs.myFarm"),
      tabBarIcon: renderOverviewIcon,
    }),
    [t, user.role],
  );

  const devicesOptions = useMemo(
    () => ({
      tabBarLabel: t("tabs.devices"),
      tabBarIcon: renderDevicesIcon,
    }),
    [t],
  );

  const farmsOptions = useMemo(
    () => ({
      tabBarLabel: t("tabs.farms"),
      tabBarIcon: renderFarmsIcon,
    }),
    [t],
  );

  const mapOptions = useMemo(
    () => ({
      tabBarLabel: t("tabs.map"),
      tabBarIcon: renderMapIcon,
    }),
    [t],
  );

  const settingsOptions = useMemo(
    () => ({
      tabBarLabel: t("tabs.settings"),
      tabBarIcon: renderSettingsIcon,
    }),
    [t],
  );

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: styles.tabLabel,
        tabBarActiveBackgroundColor: colors.primarySoft,
        tabBarItemStyle: { borderRadius: 12, marginHorizontal: 2 },
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 60 + Math.max(8, insets.bottom),
          paddingBottom: Math.max(8, insets.bottom),
          paddingTop: 6,
          shadowColor: colors.text,
          shadowOffset: { width: 0, height: -3 },
          shadowOpacity: 0.05,
          shadowRadius: 6,
          elevation: 10,
        },
      }}
    >
      <Tab.Screen name="Overview" component={user.role === "ADMIN" ? AdminSystemOverviewScreen : OverviewScreen} options={overviewOptions} />
      {user.role === "ADMIN" && (
        <Tab.Screen name="Farms" component={AdminFarmsScreen} options={farmsOptions} />
      )}
      <Tab.Screen name="Map" component={FarmMapScreen} options={mapOptions} />
      <Tab.Screen name="Devices" component={user.role === "ADMIN" ? AdminDevicesScreen : DevicesScreen} options={devicesOptions} />
      <Tab.Screen name="Assistant" component={FarmAssistantScreen} options={{ tabBarLabel: t("tabs.farmStatus", { defaultValue: "Xem vườn" }), tabBarIcon: renderAssistantIcon }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={settingsOptions} />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabLabel: {
    fontWeight: fontWeight.medium,
    fontSize: 10,
    marginTop: 1,
  },
});
