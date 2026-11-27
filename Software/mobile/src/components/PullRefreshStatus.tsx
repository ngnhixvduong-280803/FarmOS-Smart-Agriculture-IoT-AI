import React, { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../context/PreferencesContext";

/** The only visible progress treatment for pull-to-refresh content. */
export function PullRefreshStatus({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (!visible) return null;

  return <View accessibilityRole="progressbar" accessibilityLabel={t("common.refreshing")} style={styles.container}>
    <ActivityIndicator color={colors.primary} size="small" />
    <Text style={styles.label}>{t("common.refreshing")}</Text>
  </View>;
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) {
  return StyleSheet.create({
    container: { alignItems: "center", flexDirection: "row", gap: 9, justifyContent: "center", minHeight: 52 },
    label: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  });
}
