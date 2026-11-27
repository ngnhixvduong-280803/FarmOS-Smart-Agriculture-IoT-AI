import React, { useState } from "react";
import { fontWeight } from "../theme/typography";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import "../i18n";
import Svg, { Path } from "react-native-svg";
import { Icon } from "../components/Icon";
import { beginGoogleSignIn } from "../services/supabase";

interface AuthScreenProps {
  onLogin?: (identityToken: string) => Promise<void>;
}

function GoogleMark() {
  return (
    <Svg accessibilityLabel="Google" height={24} width={24} viewBox="0 0 18 18">
      <Path fill="#EA4335" d="M17.64 9.2045c0-.638-.0573-1.2518-.1636-1.8409H9v3.4818h4.8436c-.2086 1.125-.8427 2.0782-1.796 2.7164v2.2582h2.908c1.702-1.5673 2.684-3.8741 2.684-6.6155z" />
      <Path fill="#4285F4" d="M9 18c2.43 0 4.4673-.8059 5.956-2.1773l-2.908-2.2582c-.8059.54-1.8368.8591-3.048.8591-2.3441 0-4.3286-1.5841-5.0377-3.7091H.9559v2.3327A9 9 0 009 18z" />
      <Path fill="#FBBC05" d="M3.9623 10.7145A5.4105 5.4105 0 013.68 9c0-.5945.1023-1.1727.2823-1.7145V4.9527H.9559A9 9 0 000 9c0 1.4527.3477 2.8286.9559 4.0473l3.0064-2.3328z" />
      <Path fill="#34A853" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.3455l2.5814-2.5814C13.4636.8918 11.4268 0 9 0A9 9 0 00.9559 4.9527l3.0064 2.3328C4.6714 5.1636 6.6559 3.5795 9 3.5795z" />
    </Svg>
  );
}

export function AuthScreen(_props: AuthScreenProps) {
  const { t } = useTranslation();
  const [googleBusy, setGoogleBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleGoogleSignIn = async () => {
    setErrorMessage(null);
    setGoogleBusy(true);
    try {
      await beginGoogleSignIn({
        onClose: () => {
          setGoogleBusy(false);
        },
      });
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : t("auth.googleInitError"));
      setGoogleBusy(false);
    }
  };

  return (
    <SafeAreaView edges={["top", "bottom"]} style={styles.safeArea}>
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Brand Header */}
          <View style={styles.header}>
            <View style={styles.logoBadge}>
              <Icon name="sprout" size={32} color="#16704a" />
            </View>
            <Text style={styles.brandTitle}>FarmOS</Text>
            <Text style={styles.brandSubtitle}>
              {t("auth.brandSubtitle")}
            </Text>
          </View>

          {/* Notifications */}
          {errorMessage && (
            <View style={styles.errorBox}>
              <Icon name="alertTriangle" size={18} color="#dc2626" />
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          )}

          <View style={styles.form}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("auth.continueWithGoogle")}
              disabled={googleBusy}
              onPress={handleGoogleSignIn}
              style={({ pressed }) => [
                styles.googleButton,
                pressed && styles.buttonPressed,
                googleBusy && styles.buttonDisabled,
              ]}
            >
              <View style={styles.googleMark}>
                {googleBusy ? (
                  <ActivityIndicator color="#16704a" size="small" />
                ) : (
                  <GoogleMark />
                )}
              </View>
              <Text style={styles.googleButtonText}>{googleBusy ? t("auth.openingGoogle") : t("auth.continueWithGoogleAction")}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 32,
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: 28,
  },
  logoBadge: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: "#eaf7ef",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#d1fae5",
  },
  brandTitle: {
    fontSize: 28,
    fontWeight: fontWeight.bold,
    color: "#0f172a",
    letterSpacing: -0.5,
  },
  brandSubtitle: {
    fontSize: 13,
    color: "#64748b",
    marginTop: 4,
    textAlign: "center",
    maxWidth: 280,
    lineHeight: 18,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fef2f2",
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#fee2e2",
  },
  errorText: {
    flex: 1,
    color: "#b91c1c",
    fontSize: 13,
    fontWeight: fontWeight.medium,
  },
  form: {
    gap: 16,
  },
  buttonPressed: {
    backgroundColor: "#f8fafc",
    transform: [{ scale: 0.985 }],
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  googleButton: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d8e2dc",
    borderRadius: 16,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    shadowColor: "#0f3d2e",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 2,
  },
  googleMark: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    left: 14,
    position: "absolute",
    width: 40,
  },
  googleButtonText: {
    color: "#172033",
    fontSize: 15,
    fontWeight: fontWeight.bold,
    letterSpacing: -0.1,
  },
});
