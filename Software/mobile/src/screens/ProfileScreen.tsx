import React, { useEffect, useMemo, useState } from "react";
import { fontWeight } from "../theme/typography";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { launchImageLibrary, type Asset } from "react-native-image-picker";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { UserAvatar } from "../components/UserAvatar";
import { useDialog } from "../components/AppDialog";
import { usePreferences } from "../context/PreferencesContext";
import { useWorkspace } from "../context/WorkspaceContext";
import type { RootStackParamList } from "../navigation/types";
import { WorkspaceHeader } from "./WorkspaceHeader";

export function ProfileScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const { user, updateProfile } = useWorkspace();
  const { show } = useDialog();
  const [name, setName] = useState(user.name || "");
  const [avatar, setAvatar] = useState<Asset | null>(null);
  const [saving, setSaving] = useState(false);
  const styles = useMemo(() => createStyles(colors), [colors]);
  useEffect(() => setName(user.name || ""), [user.name]);
  const changed = name.trim() !== (user.name || "").trim() || avatar !== null;
  const chooseAvatar = async () => {
    const result = await launchImageLibrary({ mediaType: "photo", quality: 0.8, maxWidth: 1200, maxHeight: 1200, selectionLimit: 1 });
    if (result.didCancel) return;
    const selected = result.assets?.[0];
    if (!selected?.uri) {
      show({ title: t("profile.title"), message: result.errorMessage || t("profile.cannotPickImage"), tone: "danger" });
      return;
    }
    if (selected.fileSize && selected.fileSize > 5 * 1024 * 1024) {
      show({ title: t("profile.title"), message: t("profile.maxImageSize"), tone: "danger" });
      return;
    }
    setAvatar(selected);
  };
  const save = () => {
    if (!name.trim()) {
      show({ title: t("profile.title"), message: t("profile.displayNameRequired"), tone: "danger" });
      return;
    }
    setSaving(true);
    // The workspace commits locally and queues server work durably. Leave this
    // screen immediately instead of making the user wait for an image upload.
    updateProfile({ name, avatar: avatar ? { uri: avatar.uri!, type: avatar.type, fileName: avatar.fileName } : null }).catch(() => undefined);
    navigation.goBack();
  };

  return <View style={styles.screen}>
    <WorkspaceHeader title={t("profile.title")} onBack={() => navigation.goBack()} />
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <View style={styles.avatarSection}>
          <UserAvatar allowLocalUri avatarUrl={avatar?.uri || user.avatar_url} backgroundColor={colors.primarySoft} borderColor={colors.primaryBorder} email={user.email} name={user.name} size={88} textColor={colors.primary} borderWidth={1.5} />
          <Pressable accessibilityRole="button" accessibilityLabel={t("profile.changeAvatarA11y")} disabled={saving} onPress={() => { chooseAvatar().catch(() => undefined); }} style={({ pressed }) => [styles.changeAvatar, pressed && styles.pressed, saving && styles.disabled]}><Icon name="plus" size={16} color={colors.surface} /><Text style={styles.changeAvatarText}>{t("profile.changeAvatar")}</Text></Pressable>
        </View>
        <Text style={styles.email}>{user.email}</Text>
        <Text style={styles.label}>{t("profile.displayName")}</Text>
        <TextInput accessibilityLabel={t("profile.displayName")} autoCapitalize="words" maxLength={80} onChangeText={setName} placeholder={t("profile.displayName")} placeholderTextColor={colors.textMuted} style={styles.input} value={name} />
        <Text style={styles.hint}>{t("profile.displayNameHint")}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !changed || saving, busy: saving }} disabled={!changed || saving} onPress={save} style={({ pressed }) => [styles.save, (!changed || saving) && styles.disabled, pressed && styles.pressed]}>
        <Icon name="check" size={18} color={colors.surface} /><Text style={styles.saveText}>{saving ? t("common.loading") : t("profile.save")}</Text>
      </Pressable>
    </ScrollView>
  </View>;
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.background }, scroll: { padding: 18, gap: 16 }, card: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 18, borderWidth: 1, gap: 10, padding: 16 }, avatarSection: { alignItems: "center", gap: 8, marginBottom: 8 }, changeAvatar: { alignItems: "center", backgroundColor: colors.primary, borderRadius: 18, flexDirection: "row", gap: 5, minHeight: 34, paddingHorizontal: 12 }, changeAvatarText: { color: colors.surface, fontSize: 12, fontWeight: fontWeight.bold }, email: { color: colors.textMuted, fontSize: 13, marginBottom: 8 }, label: { color: colors.text, fontSize: 13, fontWeight: fontWeight.bold }, input: { backgroundColor: colors.surfaceMuted, borderColor: colors.border, borderRadius: 12, borderWidth: 1, color: colors.text, fontSize: 16, height: 48, paddingHorizontal: 13 }, hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 }, save: { alignItems: "center", backgroundColor: colors.primary, borderRadius: 12, flexDirection: "row", gap: 8, height: 50, justifyContent: "center" }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.8 }, saveText: { color: colors.surface, fontSize: 15, fontWeight: fontWeight.bold } }); }
