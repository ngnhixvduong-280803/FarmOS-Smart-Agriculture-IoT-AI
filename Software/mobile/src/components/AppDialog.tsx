import React, { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../context/PreferencesContext";
import { fontWeight } from "../theme/typography";

type DialogTone = "default" | "danger";
type DialogRequest = { title: string; message: string; confirmLabel?: string; cancelLabel?: string; tone?: DialogTone; onConfirm?: () => void | Promise<void> };
type DialogContextValue = { show: (request: Omit<DialogRequest, "onConfirm">) => void; confirm: (request: DialogRequest) => void };

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { colors } = usePreferences();
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const styles = useMemo(() => createStyles(colors), [colors]);
  const close = useCallback(() => setRequest(null), []);
  const show = useCallback((next: Omit<DialogRequest, "onConfirm">) => setRequest(next), []);
  const confirm = useCallback((next: DialogRequest) => setRequest(next), []);
  const accept = useCallback(() => {
    const action = request?.onConfirm;
    close();
    Promise.resolve(action?.()).catch(() => undefined);
  }, [close, request]);
  const value = useMemo(() => ({ show, confirm }), [confirm, show]);
  const destructive = request?.tone === "danger";

  return <DialogContext.Provider value={value}>{children}
    <Modal transparent animationType="fade" visible={request !== null} onRequestClose={close}>
      <Pressable style={styles.overlay} onPress={close}>
        <Pressable accessibilityViewIsModal onPress={(event) => event.stopPropagation()} style={styles.dialog}>
          <Text accessibilityRole="header" style={styles.title}>{request?.title}</Text>
          <Text style={styles.message}>{request?.message}</Text>
          <View style={styles.actions}>
            {request?.onConfirm && <Pressable accessibilityRole="button" onPress={close} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}><Text style={styles.cancelText}>{request.cancelLabel || t("dialog.defaultCancel")}</Text></Pressable>}
            <Pressable accessibilityRole="button" onPress={accept} style={({ pressed }) => [styles.confirm, destructive && styles.destructive, pressed && styles.pressed]}><Text style={styles.confirmText}>{request?.confirmLabel || t("dialog.defaultUnderstood")}</Text></Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  </DialogContext.Provider>;
}

export function useDialog() {
  const value = useContext(DialogContext);
  if (!value) throw new Error("useDialog must be used inside DialogProvider");
  return value;
}

/** Compatibility helper for migrating legacy Alert.alert calls without ever
 * falling back to the operating system's alert UI. */
export function useAppAlert() {
  const { t } = useTranslation();
  const { confirm, show } = useDialog();
  return useCallback((title: string, message?: string, buttons?: Array<{ text?: string; style?: "default" | "cancel" | "destructive"; onPress?: () => void }>) => {
    const action = buttons?.find((button) => button.style !== "cancel");
    if (!action) {
      show({ title, message: message || "" });
      return;
    }
    confirm({ title, message: message || "", confirmLabel: action.text || t("dialog.defaultConfirm"), cancelLabel: buttons?.find((button) => button.style === "cancel")?.text || t("dialog.defaultCancel"), tone: action.style === "destructive" ? "danger" : "default", onConfirm: action.onPress });
  }, [confirm, show, t]);
}

function createStyles(colors: ReturnType<typeof usePreferences>["colors"]) { return StyleSheet.create({
  overlay: { alignItems: "center", backgroundColor: colors.overlay, flex: 1, justifyContent: "center", padding: 24 },
  dialog: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 20, borderWidth: 1, gap: 10, maxWidth: 360, padding: 20, width: "100%" },
  title: { color: colors.text, fontSize: 17, fontWeight: fontWeight.bold, letterSpacing: -0.2 },
  message: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: "row", gap: 10, justifyContent: "flex-end", marginTop: 10 },
  cancel: { alignItems: "center", borderColor: colors.border, borderRadius: 10, borderWidth: 1, justifyContent: "center", minHeight: 42, paddingHorizontal: 14 },
  cancelText: { color: colors.text, fontSize: 14, fontWeight: fontWeight.semibold },
  confirm: { alignItems: "center", backgroundColor: colors.primary, borderRadius: 10, justifyContent: "center", minHeight: 42, paddingHorizontal: 16 },
  destructive: { backgroundColor: colors.danger },
  confirmText: { color: "#FFFFFF", fontSize: 14, fontWeight: fontWeight.bold },
  pressed: { opacity: 0.76, transform: [{ scale: 0.98 }] },
}); }
