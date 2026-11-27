import React, { useMemo } from "react";
import { fontWeight } from "../theme/typography";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon } from "../components/Icon";
import { UserAvatar } from "../components/UserAvatar";
import { usePreferences } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import type { RootStackParamList } from "../navigation/types";

export function WorkspaceHeader({ title, onBack, showAlerts = true }: { title: string; onBack?: () => void; showAlerts?: boolean }) {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user, alerts } = useWorkspace();
  const { colors } = usePreferences();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const roleLabel = user.role === "ADMIN" ? t("common.admin") : t("common.member");
  const rootNavigation = navigation.getParent<NativeStackNavigationProp<RootStackParamList>>() || navigation;
  const alertLabel = alerts.length ? t("header.openAlerts", { count: alerts.length }) : t("header.noOpenAlerts");

  return <SafeAreaView edges={["top"]} style={styles.safeContainer}><View style={styles.header}>
    {onBack ? <><Pressable accessibilityRole="button" accessibilityLabel={t("common.back")} hitSlop={8} onPress={onBack} style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}><Icon name="chevronLeft" size={22} color={colors.text} /></Pressable><Text style={styles.backTitle} numberOfLines={1}>{title}</Text></> : <View style={styles.identity}><View style={styles.avatarWrap}><UserAvatar avatarUrl={user.avatar_url} backgroundColor={colors.primarySoft} borderColor={colors.primaryBorder} email={user.email} name={user.name} size={34} textColor={colors.primary} borderWidth={1.5} /></View><View style={styles.textContainer}><View style={styles.roleRow}><Text style={styles.roleText}>{roleLabel}</Text></View><Text style={styles.userName} numberOfLines={1}>{title}</Text></View></View>}
    {showAlerts && <Pressable accessibilityRole="button" accessibilityLabel={alertLabel} accessibilityState={{ disabled: false }} onPress={() => rootNavigation.navigate("Alerts")} style={({ pressed }) => [styles.alertButton, pressed && styles.pressed]}>
      <Icon name="bell" size={21} color={colors.primary} />
      {alerts.length > 0 && <View style={styles.alertBadge}><Text style={styles.alertBadgeText}>{alerts.length > 99 ? "99+" : alerts.length}</Text></View>}
    </Pressable>}
  </View></SafeAreaView>;
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({
  safeContainer: { backgroundColor: colors.surface, borderBottomColor: colors.border, borderBottomWidth: 1 }, header: { alignItems: "center", backgroundColor: colors.surface, flexDirection: "row", justifyContent: "space-between", minHeight: 64, paddingHorizontal: 18, paddingVertical: 10 }, identity: { alignItems: "center", flex: 1, flexDirection: "row", marginRight: 10 }, avatarWrap: { marginRight: 10 }, textContainer: { flex: 1 }, roleRow: { alignItems: "center", flexDirection: "row", gap: 7 }, roleText: { color: colors.primary, fontSize: 11, fontWeight: fontWeight.bold }, userName: { color: colors.text, fontSize: 19, fontWeight: fontWeight.bold, letterSpacing: -0.4, marginTop: 2 }, alertButton: { alignItems: "center", backgroundColor: colors.primarySoft, borderRadius: 20, height: 40, justifyContent: "center", position: "relative", width: 40 }, alertBadge: { alignItems: "center", backgroundColor: colors.danger, borderColor: colors.surface, borderRadius: 10, borderWidth: 2, height: 20, justifyContent: "center", minWidth: 20, paddingHorizontal: 3, position: "absolute", right: -5, top: -5 }, alertBadgeText: { color: "#ffffff", fontSize: 10, fontWeight: fontWeight.bold }, backButton: { alignItems: "center", borderRadius: 22, height: 44, justifyContent: "center", marginLeft: -8, marginRight: 4, width: 44 }, backTitle: { color: colors.text, flex: 1, fontSize: 16, fontWeight: fontWeight.bold }, pressed: { opacity: 0.72 },
}); }
