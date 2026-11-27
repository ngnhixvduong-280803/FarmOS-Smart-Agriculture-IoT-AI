import React, { useMemo, useState } from "react";
import { fontWeight } from "../theme/typography";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PullRefreshStatus } from "../components/PullRefreshStatus";
import { usePreferences } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import type { RootStackParamList } from "../navigation/types";
import type { Farm } from "../types";
import { WorkspaceHeader } from "./WorkspaceHeader";

function getCustomerNames(farm: Farm, fallback: string) {
  return farm.user_farms
    ?.map((membership) => membership.user?.name || membership.user?.email)
    .filter((name): name is string => Boolean(name))
    .join(", ") || fallback;
}

export function AdminFarmsScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { farms, refreshing, onRefresh, user } = useWorkspace();
  const { colors } = usePreferences();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const fallbackCustomer = t("adminFarms.unassignedCustomer");
  const visibleFarms = useMemo(() => farms.filter((farm) => {
    if (!normalizedQuery) return true;
    return [farm.name, farm.location, farm.address, getCustomerNames(farm, fallbackCustomer)]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
  }), [farms, normalizedQuery, fallbackCustomer]);

  if (user.role !== "ADMIN") return null;

  return (
    <View style={styles.screen}>
      <WorkspaceHeader title={t("adminFarms.manageFarms")} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />}
      >
        <PullRefreshStatus visible={refreshing} />
        <Text style={styles.title}>{t("adminFarms.title")}</Text>

        <View style={styles.searchBox}>
          <Icon name="search" size={20} color={colors.textMuted} />
          <TextInput
            accessibilityLabel={t("adminFarms.searchA11y")}
            value={query}
            onChangeText={setQuery}
            placeholder={t("adminFarms.searchPlaceholder")}
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable accessibilityRole="button" accessibilityLabel={t("adminFarms.clearSearchA11y")} onPress={() => setQuery("")} hitSlop={10}>
              <Text style={styles.clear}>{t("adminFarms.clearSearch")}</Text>
            </Pressable>
          )}
        </View>

        <Text style={styles.resultCount}>{t("adminFarms.farmCount", { count: visibleFarms.length })}</Text>
        {visibleFarms.map((farm) => (
          <Pressable
            key={farm.id}
            accessibilityRole="button"
            accessibilityLabel={t("adminFarms.openFarmProfileA11y", { name: farm.name })}
            onPress={() => navigation.navigate("FarmOperations", { farmId: farm.id })}
            style={({ pressed }) => [styles.farmCard, pressed && styles.pressed]}
          >
            <View style={styles.farmIcon}><Icon name="sprout" size={21} color={colors.primary} /></View>
            <View style={styles.farmInfo}>
              <Text style={styles.farmName} numberOfLines={1}>{farm.name}</Text>
              <Text style={styles.customer} numberOfLines={1}>{getCustomerNames(farm, fallbackCustomer)}</Text>
              {(farm.address || farm.location) ? <Text style={styles.location} numberOfLines={1}>{farm.address || farm.location}</Text> : null}
            </View>
            <Icon name="chevronRight" size={20} color={colors.textMuted} />
          </Pressable>
        ))}

        {visibleFarms.length === 0 && (
          <View style={styles.empty}>
            <Icon name="sprout" size={30} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>{t("adminFarms.noFarmsFound")}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingBottom: 32 },
  title: { color: colors.text, fontSize: 22, fontWeight: fontWeight.bold, letterSpacing: -0.3 },
  searchBox: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 14, borderWidth: 1, flexDirection: "row", gap: 10, marginTop: 20, minHeight: 52, paddingHorizontal: 14 },
  searchInput: { color: colors.text, flex: 1, fontSize: 15, fontWeight: fontWeight.medium, paddingVertical: 0 },
  clear: { color: colors.primary, fontSize: 13, fontWeight: fontWeight.bold },
  resultCount: { color: colors.textMuted, fontSize: 13, fontWeight: fontWeight.bold, marginBottom: 10, marginTop: 18 },
  farmCard: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderWidth: 1, flexDirection: "row", gap: 12, marginBottom: 10, minHeight: 92, padding: 14, shadowColor: "#000000", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.10, shadowRadius: 8 },
  pressed: { opacity: 0.88, transform: [{ scale: 0.99 }] },
  farmIcon: { alignItems: "center", backgroundColor: colors.primarySoft, borderRadius: 12, height: 44, justifyContent: "center", width: 44 },
  farmInfo: { flex: 1, gap: 3 },
  farmName: { color: colors.text, fontSize: 15, fontWeight: fontWeight.bold },
  customer: { color: colors.primary, fontSize: 13, fontWeight: fontWeight.bold },
  location: { color: colors.textMuted, fontSize: 12, fontWeight: fontWeight.medium },
  empty: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderStyle: "dashed", borderWidth: 1, marginTop: 10, padding: 30 },
  emptyTitle: { color: colors.text, fontSize: 15, fontWeight: fontWeight.bold, marginTop: 10 },
}); }
