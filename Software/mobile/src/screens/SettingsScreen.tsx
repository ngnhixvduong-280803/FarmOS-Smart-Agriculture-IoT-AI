import React, { useMemo, useState } from "react";
import { fontWeight } from "../theme/typography";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../components/Icon";
import { UserAvatar } from "../components/UserAvatar";
import { useDialog } from "../components/AppDialog";
import { usePreferences, type ThemeMode } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import type { AppLanguage } from "../i18n";
import type { RootStackParamList } from "../navigation/types";
import { WorkspaceHeader } from "./WorkspaceHeader";

type SettingsRowProps = { icon: IconName; title: string; detail?: string; onPress?: () => void; destructive?: boolean; };

function SettingsRow({ icon, title, detail, onPress, destructive = false, styles, colors }: SettingsRowProps & { styles: ReturnType<typeof createStyles>; colors: ReturnType<typeof usePreferences>["colors"] }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={!onPress} onPress={onPress} style={({ pressed }) => [styles.row, pressed && onPress && styles.rowPressed]}>
    <View style={[styles.rowIcon, destructive && styles.rowIconDestructive]}><Icon name={icon} size={19} color={destructive ? colors.danger : colors.primary} /></View>
    <View style={styles.rowText}><Text style={[styles.rowTitle, destructive && { color: colors.danger }]}>{title}</Text>{detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}</View>
    {onPress && <Icon name="chevronRight" size={18} color={colors.textMuted} />}
  </Pressable>;
}

export function SettingsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { t } = useTranslation();
  const { user, onLogout } = useWorkspace();
  const { confirm } = useDialog();
  const { colors, language, setLanguage, setThemeMode, themeMode } = usePreferences();
  const [picker, setPicker] = useState<"language" | "theme" | null>(null);
  const styles = useMemo(() => createStyles(colors), [colors]);
  const roleLabel = user.role === "ADMIN" ? t("common.admin") : t("common.member");
  const languageLabel = language === "vi" ? t("settings.vietnamese") : t("settings.english");
  const themeLabel = t(`settings.${themeMode}`);
  const selectLanguage = (nextLanguage: AppLanguage) => { setLanguage(nextLanguage).catch(() => undefined); setPicker(null); };
  const selectTheme = (nextTheme: ThemeMode) => { setThemeMode(nextTheme).catch(() => undefined); setPicker(null); };
  const confirmLogout = () => confirm({ title: t("settings.logout"), message: t("settings.logoutDetail"), confirmLabel: t("settings.logout"), cancelLabel: t("common.cancel"), tone: "danger", onConfirm: () => onLogout() });

  return <View style={styles.screen}>
    <WorkspaceHeader title={t("settings.title")} />
    <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      <Text style={styles.sectionLabel}>{t("settings.account")}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t("settings.editProfile")} onPress={() => navigation.getParent<NativeStackNavigationProp<RootStackParamList>>()?.navigate("Profile")} style={({ pressed }) => [styles.accountCard, pressed && styles.rowPressed]}>
        <UserAvatar avatarUrl={user.avatar_url} backgroundColor={colors.surface} borderColor={colors.primaryBorder} email={user.email} name={user.name} size={52} textColor={colors.primary} />
        <View style={styles.accountIdentity}><Text style={styles.accountName}>{user.name || t("profile.unnamed")}</Text><Text style={styles.accountEmail} numberOfLines={1}>{user.email}</Text><Text style={styles.roleText}>{roleLabel}</Text></View>
        <Icon name="chevronRight" size={20} color={colors.primary} />
      </Pressable>

      {user.role === "ADMIN" && <><Text style={styles.sectionLabel}>{t("settings.farm")}</Text><View style={styles.group}><SettingsRow styles={styles} colors={colors} icon="shield" title={t("settings.members")} onPress={() => navigation.getParent<NativeStackNavigationProp<RootStackParamList>>()?.navigate("Admin")} /></View></>}

      <Text style={styles.sectionLabel}>{t("settings.app")}</Text>
      <View style={styles.group}>
        <SettingsRow styles={styles} colors={colors} icon="translate" title={t("settings.language")} detail={languageLabel} onPress={() => setPicker("language")} />
        <View style={styles.divider} />
        <SettingsRow styles={styles} colors={colors} icon="palette" title={t("settings.appearance")} detail={themeLabel} onPress={() => setPicker("theme")} />
      </View>

      <Text style={styles.sectionLabel}>{t("settings.support")}</Text>
      <View style={styles.group}><SettingsRow styles={styles} colors={colors} icon="helpCircle" title={t("settings.help")} /></View>
      <View style={[styles.group, styles.logoutGroup]}><SettingsRow styles={styles} colors={colors} icon="logout" title={t("settings.logout")} onPress={confirmLogout} destructive /></View>
    </ScrollView>

    <Modal transparent visible={picker !== null} animationType="fade" onRequestClose={() => setPicker(null)}>
      <Pressable style={styles.overlay} onPress={() => setPicker(null)}><Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
        <View style={styles.handle} />
        <Text style={styles.sheetTitle}>{picker === "language" ? t("settings.selectLanguage") : t("settings.selectTheme")}</Text>
        {picker === "language" ? <>
          <PickerOption label={t("settings.vietnamese")} selected={language === "vi"} onPress={() => selectLanguage("vi")} styles={styles} colors={colors} />
          <PickerOption label={t("settings.english")} selected={language === "en"} onPress={() => selectLanguage("en")} styles={styles} colors={colors} />
        </> : <>
          {(["light", "dark", "system"] as ThemeMode[]).map((mode) => <PickerOption key={mode} label={t(`settings.${mode}`)} selected={themeMode === mode} onPress={() => selectTheme(mode)} styles={styles} colors={colors} />)}
        </>}
      </Pressable></Pressable>
    </Modal>
  </View>;
}

function PickerOption({ label, selected, onPress, styles, colors }: { label: string; selected: boolean; onPress: () => void; styles: ReturnType<typeof createStyles>; colors: ReturnType<typeof usePreferences>["colors"] }) {
  return <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => [styles.option, pressed && styles.rowPressed]}><Text style={styles.optionText}>{label}</Text>{selected && <Icon name="check" size={20} color={colors.primary} />}</Pressable>;
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, scroll: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 40, gap: 10 },
  sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: fontWeight.bold, letterSpacing: 0.5, marginTop: 10, textTransform: "uppercase" },
  accountCard: { alignItems: "center", backgroundColor: colors.primarySoft, borderColor: colors.primaryBorder, borderRadius: 18, borderWidth: 1, flexDirection: "row", gap: 12, padding: 16 },
  accountIdentity: { flex: 1, gap: 2 }, accountName: { color: colors.text, fontSize: 16, fontWeight: fontWeight.bold }, accountEmail: { color: colors.textMuted, fontSize: 13 }, roleText: { color: colors.primary, fontSize: 12, fontWeight: fontWeight.bold, marginTop: 2 },
  group: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderWidth: 1, overflow: "hidden" }, logoutGroup: { marginTop: 10 }, row: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 68, paddingHorizontal: 14, paddingVertical: 10 }, rowPressed: { opacity: 0.78 }, rowIcon: { alignItems: "center", backgroundColor: colors.primarySoft, borderRadius: 10, height: 38, justifyContent: "center", width: 38 }, rowIconDestructive: { backgroundColor: colors.dangerSoft }, rowText: { flex: 1, gap: 2 }, rowTitle: { color: colors.text, fontSize: 14, fontWeight: fontWeight.bold }, rowDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 17 }, divider: { backgroundColor: colors.border, height: 1, marginLeft: 64 },
  overlay: { backgroundColor: colors.overlay, flex: 1, justifyContent: "flex-end" }, sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 36 }, handle: { alignSelf: "center", backgroundColor: colors.border, borderRadius: 2, height: 4, marginBottom: 18, width: 36 }, sheetTitle: { color: colors.text, fontSize: 17, fontWeight: fontWeight.bold, marginBottom: 10 }, option: { alignItems: "center", borderRadius: 12, flexDirection: "row", height: 52, justifyContent: "space-between", paddingHorizontal: 12 }, optionText: { color: colors.text, fontSize: 15, fontWeight: fontWeight.semibold },
}); }
