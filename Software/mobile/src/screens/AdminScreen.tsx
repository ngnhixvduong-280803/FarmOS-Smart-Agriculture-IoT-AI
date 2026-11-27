import React, { useMemo, useState } from "react";
import { fontWeight } from "../theme/typography";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/Icon";
import { PullRefreshStatus } from "../components/PullRefreshStatus";
import { useWorkspace } from "../context/WorkspaceContext";
import type { RootStackParamList } from "../navigation/types";
import { WorkspaceHeader } from "./WorkspaceHeader";
import type { UserProfile } from "../types";

function getInitials(name?: string | null, email?: string) {
  if (name?.trim()) {
    const parts = name.trim().split(/\s+/);
    return parts.length > 1
      ? `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
      : name.slice(0, 2).toUpperCase();
  }
  return email ? email.slice(0, 2).toUpperCase() : "FO";
}

function MemberSeparator() {
  return <View style={styles.separator} />;
}

export function AdminScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { user, users, usersLoading, refreshing, updatingUserId, onRefresh, changeUserRole, deleteUser } = useWorkspace();
  const [selectedMember, setSelectedMember] = useState<UserProfile | null>(null);
  const selectedIsSelf = selectedMember?.id === user.id;
  const selectedIsBusy = selectedMember?.id === updatingUserId;
  const selectedRoleAction = useMemo(() => {
    if (!selectedMember) return "";
    return selectedMember.role === "ADMIN" ? t("admin.demoteToMember") : t("admin.promoteToAdmin");
  }, [selectedMember, t]);

  const renderMemberItem = ({ item: member }: { item: UserProfile }) => {
    const isSelf = member.id === user.id;
    const isAdmin = member.role === "ADMIN";

    return (
      <View style={styles.memberRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{getInitials(member.name, member.email)}</Text>
        </View>
        <View style={styles.memberInfo}>
          <View style={styles.memberNameRow}>
            <Text style={styles.memberName} numberOfLines={1}>{member.name || member.email.split("@")[0]}</Text>
            {isSelf && <Text style={styles.selfLabel}>{t("admin.youBadge")}</Text>}
          </View>
          <Text style={styles.memberEmail} numberOfLines={1}>{member.email}</Text>
        </View>
        <View style={[styles.roleBadge, isAdmin ? styles.adminBadge : styles.memberBadge]}>
          <Text style={[styles.roleBadgeText, isAdmin ? styles.adminBadgeText : styles.memberBadgeText]}>
            {isAdmin ? t("admin.adminBadge") : t("admin.memberBadge")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("admin.memberOptionsA11y", { email: member.email })}
          hitSlop={6}
          onPress={() => setSelectedMember(member)}
          style={({ pressed }) => [styles.moreButton, pressed && styles.buttonPressed]}
        >
          <Icon name="dotsHorizontal" size={21} color="#64748b" />
        </Pressable>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <WorkspaceHeader title={t("admin.membersAndRoles")} onBack={() => navigation.goBack()} />

      <FlatList
        contentContainerStyle={styles.scroll}
        data={users}
        ItemSeparatorComponent={MemberSeparator}
        keyExtractor={(member) => member.id}
        refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor="#16704a" colors={["#16704a"]} />}
        ListHeaderComponent={
          <><PullRefreshStatus visible={refreshing} /><View style={styles.heading}>
            <Text style={styles.sectionTitle}>{t("admin.membersTitleWithCount", { count: users.length })}</Text>
          </View></>
        }
        ListEmptyComponent={
          usersLoading ? (
            <View style={styles.state}><ActivityIndicator color="#16704a" /><Text style={styles.muted}>{t("admin.loadingMembers")}</Text></View>
          ) : (
            <View style={styles.state}><Text style={styles.muted}>{t("admin.noMembers")}</Text></View>
          )
        }
        renderItem={renderMemberItem}
        showsVerticalScrollIndicator={false}
      />

      <Modal transparent visible={Boolean(selectedMember)} animationType="fade" onRequestClose={() => setSelectedMember(null)}>
        <Pressable style={styles.sheetOverlay} onPress={() => setSelectedMember(null)}>
          <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
            <View style={styles.dragHandle} />
            {selectedMember && (
              <>
                <View style={styles.sheetIdentity}>
                  <View style={styles.sheetAvatar}><Text style={styles.avatarText}>{getInitials(selectedMember.name, selectedMember.email)}</Text></View>
                  <View style={styles.sheetText}>
                    <Text style={styles.sheetName} numberOfLines={1}>{selectedMember.name || selectedMember.email.split("@")[0]}</Text>
                    <Text style={styles.sheetEmail} numberOfLines={1}>{selectedMember.email}</Text>
                  </View>
                </View>

                {selectedIsSelf ? (
                  <Text style={styles.selfHint}>{t("admin.selfHint")}</Text>
                ) : (
                  <View style={styles.sheetActions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={selectedRoleAction}
                      disabled={selectedIsBusy}
                      onPress={() => { changeUserRole(selectedMember); setSelectedMember(null); }}
                      style={({ pressed }) => [styles.sheetAction, pressed && styles.buttonPressed, selectedIsBusy && styles.actionDisabled]}
                    >
                      <Icon name="shield" size={19} color={selectedMember.role === "ADMIN" ? "#b45309" : "#125d3c"} />
                      <Text style={[styles.sheetActionText, selectedMember.role === "ADMIN" && styles.demoteText]}>{selectedRoleAction}</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("admin.deleteMemberA11y", { email: selectedMember.email })}
                      disabled={selectedIsBusy}
                      onPress={() => { deleteUser(selectedMember); setSelectedMember(null); }}
                      style={({ pressed }) => [styles.sheetAction, styles.deleteAction, pressed && styles.buttonPressed, selectedIsBusy && styles.actionDisabled]}
                    >
                      <Icon name="logout" size={19} color="#dc2626" />
                      <Text style={styles.deleteText}>{t("admin.deleteMember")}</Text>
                    </Pressable>
                  </View>
                )}
                <Pressable accessibilityRole="button" accessibilityLabel={t("common.close")} onPress={() => setSelectedMember(null)} style={({ pressed }) => [styles.closeButton, pressed && styles.buttonPressed]}>
                  <Text style={styles.closeText}>{t("common.close")}</Text>
                </Pressable>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#ffffff" },
  scroll: { flexGrow: 1, paddingBottom: 40 },
  heading: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 14 },
  sectionTitle: { color: "#0f172a", fontSize: 20, fontWeight: fontWeight.bold, letterSpacing: -0.35 },
  memberRow: { alignItems: "center", flexDirection: "row", gap: 10, minHeight: 72, paddingHorizontal: 18, paddingVertical: 10 },
  separator: { backgroundColor: "#f1f5f9", height: 1, marginLeft: 76 },
  avatar: { alignItems: "center", backgroundColor: "#f1f5f9", borderColor: "#e2e8f0", borderRadius: 21, borderWidth: 1, height: 42, justifyContent: "center", width: 42 },
  avatarText: { color: "#334155", fontSize: 14, fontWeight: fontWeight.bold },
  memberInfo: { flex: 1, gap: 2, minWidth: 0 },
  memberNameRow: { alignItems: "center", flexDirection: "row", gap: 6 },
  memberName: { color: "#0f172a", flexShrink: 1, fontSize: 15, fontWeight: fontWeight.bold },
  selfLabel: { backgroundColor: "#eaf7ef", borderRadius: 5, color: "#125d3c", fontSize: 10, fontWeight: fontWeight.bold, overflow: "hidden", paddingHorizontal: 5, paddingVertical: 2 },
  memberEmail: { color: "#64748b", fontSize: 12 },
  roleBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  adminBadge: { backgroundColor: "#eaf7ef" },
  memberBadge: { backgroundColor: "#f1f5f9" },
  roleBadgeText: { fontSize: 10, fontWeight: fontWeight.bold },
  adminBadgeText: { color: "#125d3c" },
  memberBadgeText: { color: "#64748b" },
  moreButton: { alignItems: "center", borderRadius: 20, height: 40, justifyContent: "center", marginRight: -8, width: 40 },
  state: { alignItems: "center", gap: 10, paddingHorizontal: 24, paddingVertical: 48 },
  muted: { color: "#64748b", fontSize: 13 },
  sheetOverlay: { backgroundColor: "rgba(15, 23, 42, 0.4)", flex: 1, justifyContent: "flex-end" },
  sheet: { backgroundColor: "#ffffff", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 34 },
  dragHandle: { alignSelf: "center", backgroundColor: "#cbd5e1", borderRadius: 2, height: 4, marginBottom: 18, width: 36 },
  sheetIdentity: { alignItems: "center", flexDirection: "row", gap: 12, marginBottom: 20 },
  sheetAvatar: { alignItems: "center", backgroundColor: "#f1f5f9", borderColor: "#e2e8f0", borderRadius: 24, borderWidth: 1, height: 48, justifyContent: "center", width: 48 },
  sheetText: { flex: 1, gap: 2 },
  sheetName: { color: "#0f172a", fontSize: 17, fontWeight: fontWeight.bold },
  sheetEmail: { color: "#64748b", fontSize: 13 },
  sheetActions: { borderColor: "#e2e8f0", borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  sheetAction: { alignItems: "center", flexDirection: "row", gap: 12, minHeight: 54, paddingHorizontal: 14 },
  sheetActionText: { color: "#125d3c", fontSize: 15, fontWeight: fontWeight.bold },
  demoteText: { color: "#b45309" },
  deleteAction: { backgroundColor: "#fffafa", borderTopColor: "#fee2e2", borderTopWidth: 1 },
  deleteText: { color: "#dc2626", fontSize: 15, fontWeight: fontWeight.bold },
  selfHint: { backgroundColor: "#f8fafc", borderRadius: 12, color: "#64748b", fontSize: 13, lineHeight: 19, padding: 14 },
  closeButton: { alignItems: "center", borderRadius: 12, height: 48, justifyContent: "center", marginTop: 12 },
  closeText: { color: "#475569", fontSize: 15, fontWeight: fontWeight.bold },
  actionDisabled: { opacity: 0.55 },
  buttonPressed: { backgroundColor: "#f8fafc", opacity: 0.85 },
});
