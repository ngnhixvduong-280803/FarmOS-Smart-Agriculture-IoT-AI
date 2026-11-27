import { Pressable, StyleSheet, Text, View } from "react-native";
import { fontWeight } from "../theme/typography";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { DeviceOnboarding } from "../components/DeviceOnboarding";
import { DialogProvider } from "../components/AppDialog";
import { useWorkspace } from "../context/WorkspaceContext";
import type { RootStackParamList } from "../navigation/types";

export function OnboardingScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { selectedFarmId, farmZones, onDevicesChanged } = useWorkspace();
  // A full-screen native modal needs insets from its own presentation.
  return <SafeAreaProvider style={styles.screen}>
    <SafeAreaView style={styles.screen} edges={["top", "bottom", "left", "right"]}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("onboarding.backA11y")} accessibilityHint={t("onboarding.backA11yHint")} style={styles.backButton} onPress={() => navigation.goBack()}>
        <Text style={styles.back}>{t("onboarding.backToMain")}</Text>
      </Pressable>
      <Text accessibilityRole="header" style={styles.headerTitle}>{t("onboarding.setupDeviceTitle")}</Text>
      <View style={styles.headerSpacer} />
    </View>
    {/* Present alerts above this native full-screen screen on iOS. */}
    <DialogProvider>
      <DeviceOnboarding farmId={selectedFarmId} zones={farmZones} onChanged={onDevicesChanged} />
    </DialogProvider>
    </SafeAreaView>
  </SafeAreaProvider>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#ffffff" },
  header: { minHeight: 52, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  back: { color: "#19764b", fontSize: 14, fontWeight: fontWeight.bold },
  backButton: { minHeight: 48, minWidth: 72, justifyContent: "center" },
  headerTitle: { color: "#1c2922", fontSize: 16, fontWeight: fontWeight.bold },
  headerSpacer: { width: 72 },
});
