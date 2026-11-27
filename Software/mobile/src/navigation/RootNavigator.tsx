import React from "react";
import { createNativeStackNavigator, type NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { ActivityIndicator, Image, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SafeAreaView } from "react-native-safe-area-context";
import { WorkspaceProvider } from "../context/WorkspaceContext";
import { DialogProvider } from "../components/AppDialog";
import { usePreferences } from "../context/PreferencesContext";
import type { UserProfile } from "../types";
import { AuthScreen } from "../screens/AuthScreen";
import { AdminScreen } from "../screens/AdminScreen";
import { OnboardingScreen } from "../screens/OnboardingScreen";
import { ProfileScreen } from "../screens/ProfileScreen";
import { FarmOperationsScreen } from "../screens/FarmOperationsScreen";
import { AlertsScreen } from "../screens/AlertsScreen";
import { MainTabs } from "./MainTabs";
import type { RootStackParamList } from "./types";

const Stack = createNativeStackNavigator<RootStackParamList>();
const hiddenHeader: NativeStackNavigationOptions = { headerShown: false };
export const ONBOARDING_SCREEN_OPTIONS: NativeStackNavigationOptions = {
  presentation: "fullScreenModal",
  animation: "slide_from_right",
};

export function RootNavigator({
  loading,
  user,
  token,
  onLogout,
  onLogin,
}: {
  loading: boolean;
  user: UserProfile | null;
  token: string | null;
  onLogout: () => Promise<void>;
  onLogin?: (identityToken: string) => Promise<void>;
}) {
  if (loading) {
    return <StartupSplash />;
  }

  if (!user || !token) {
    return (
      <Stack.Navigator screenOptions={hiddenHeader}>
        <Stack.Screen name="Auth">
          {() => <AuthScreen onLogin={onLogin} />}
        </Stack.Screen>
      </Stack.Navigator>
    );
  }

  return (
    <DialogProvider>
      <WorkspaceProvider user={user} token={token} onLogout={onLogout}>
        <Stack.Navigator screenOptions={hiddenHeader}>
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen name="Admin" component={AdminScreen} />
        <Stack.Screen name="FarmOperations" component={FarmOperationsScreen} />
        <Stack.Screen name="Alerts" component={AlertsScreen} />
        <Stack.Screen name="Profile" component={ProfileScreen} />
        <Stack.Screen name="Onboarding" component={OnboardingScreen} options={ONBOARDING_SCREEN_OPTIONS} />
        </Stack.Navigator>
      </WorkspaceProvider>
    </DialogProvider>
  );
}

function StartupSplash() {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  return <SafeAreaView accessibilityLabel={t("common.openingApp")} edges={["top", "bottom"]} style={styles.loading}>
    <View style={styles.logoStage}>
      <Image accessibilityIgnoresInvertColors source={require("../assets/farmos-logo.png")} resizeMode="contain" style={styles.logo} />
    </View>
    <ActivityIndicator accessibilityLabel={t("common.loading")} size="small" color={colors.primary} style={styles.indicator} />
  </SafeAreaView>;
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) {
  return StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  },
  logoStage: {
    alignItems: "center",
    backgroundColor: colors.primarySoft,
    borderColor: colors.primaryBorder,
    borderRadius: 36,
    borderWidth: 1,
    height: 144,
    justifyContent: "center",
    width: 144,
  },
  logo: { height: 112, width: 112 },
  indicator: { marginTop: 24 },
  });
}
