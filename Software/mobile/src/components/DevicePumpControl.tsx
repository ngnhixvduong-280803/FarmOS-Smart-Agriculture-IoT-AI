import React, { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { usePreferences } from "../context/PreferencesContext";
import { api } from "../services/api";
import type { PumpControlStatus } from "../types";

function commandId() {
  const { crypto } = globalThis as typeof globalThis & { crypto: { getRandomValues(buffer: Uint8Array): Uint8Array } };
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function errorCode(cause: unknown) {
  return cause instanceof Error && /^[A-Z_]+$/.test(cause.message) ? cause.message : "NETWORK_ERROR";
}

export function DevicePumpControl({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation();
  const { colors, language } = usePreferences();
  const [data, setData] = useState<PumpControlStatus | null>(null);
  const [tracked, setTracked] = useState<string>();
  const [sending, setSending] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const submitting = useRef(false);
  const command = data?.command;
  const pending = command?.status === "PENDING" || command?.status === "DELIVERED";
  const disabled = sending || !data || Boolean(data.reason || statusError);

  useEffect(() => {
    if (sending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api.pumpStatus(nodeId, controller.signal, tracked);
        if (!controller.signal.aborted) {
          setData(next);
          setStatusError(null);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setStatusError(errorCode(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, pending ? 1500 : 12_000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [nodeId, pending, sending, tracked]);

  async function submit(on: boolean) {
    if (submitting.current) return;
    submitting.current = true;
    setSending(true);
    setSendError(null);
    try {
      const next = await api.sendPumpCommand(nodeId, on, commandId());
      setTracked(next.id);
      setData(current => current && { ...current, command: next });
    } catch (cause) {
      setTracked(undefined);
      setSendError(errorCode(cause));
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  const commandError = command?.status === "FAILED" ? command.error ?? "OUTPUT_ERROR" :
    command?.status === "TIMEOUT" || command?.status === "CANCELLED" ? command.status : null;
  const explain = (code: string) => t(`pump.errors.${code}`, { defaultValue: t("pump.errors.NETWORK_ERROR") });
  const startDisabled = disabled || pending;
  const stopDisabled = disabled || (pending && command.on === false);
  return (
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Text style={[styles.title, { color: colors.text }]}>{t("pump.title")}</Text>
      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          disabled={startDisabled}
          onPress={() => void submit(true)}
          style={[styles.button, { borderColor: colors.primaryBorder, backgroundColor: colors.primarySoft, opacity: startDisabled ? 0.45 : 1 }]}
        >
          <Text style={[styles.title, { color: colors.primary }]}>
            {data ? t("pump.startTimed", { count: data.runSeconds }) : t("pump.start")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={stopDisabled}
          onPress={() => void submit(false)}
          style={[styles.button, { borderColor: colors.border, opacity: stopDisabled ? 0.45 : 1 }]}
        >
          <Text style={[styles.title, { color: colors.danger }]}>{t("pump.stop")}</Text>
        </Pressable>
      </View>
      <View accessibilityLiveRegion="polite" style={styles.status}>
        {!data && !statusError && <Text style={{ color: colors.textMuted }}>{t("pump.checking")}</Text>}
        {data?.reason && <Text style={{ color: colors.textMuted }}>{explain(data.reason)}</Text>}
        {(sending || pending) && <Text style={{ color: colors.text }}>{t("pump.waiting")}</Text>}
        {command?.status === "CONFIRMED" && (
          <Text style={{ color: colors.primary }}>
            {t(command.feedbackOn ? "pump.onConfirmed" : "pump.offConfirmed")}
            {command.confirmedAt && ` · ${new Date(command.confirmedAt).toLocaleString(language === "vi" ? "vi-VN" : "en-US")}`}
            {command.feedbackOn && ` · ${t("pump.cutoff", { count: data?.runSeconds })}`}
          </Text>
        )}
        {[statusError, sendError, commandError].filter((code): code is string => Boolean(code)).map((code, index) => (
          <Text key={`${code}-${index}`} style={{ color: colors.danger }}>{explain(code)}</Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 },
  title: { fontWeight: "700" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { borderWidth: 1, borderRadius: 8, minHeight: 44, justifyContent: "center", paddingHorizontal: 12 },
  status: { gap: 4 },
});
