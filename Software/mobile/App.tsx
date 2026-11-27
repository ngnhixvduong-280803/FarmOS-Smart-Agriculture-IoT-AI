import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, StatusBar } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nextProvider } from "react-i18next";
import { RootNavigator } from "./src/navigation/RootNavigator";
import i18n from "./src/i18n";
import { PreferencesProvider, usePreferences } from "./src/context/PreferencesContext";
import { api, exchangeSupabaseToken, setAccessToken } from "./src/services/api";
import {
  clearMobileToken,
  loadCachedUser,
  loadMobileToken,
  onTokenChanged,
  saveCachedUser,
  saveMobileToken,
} from "./src/services/session";
import { closeBrowser, finishGoogleSignIn, getFreshIdentityToken, supabase } from "./src/services/supabase";
import type { UserProfile } from "./src/types";

/**
 * Application bootstrap only.
 *
 * Session restoration and the OAuth deep-link bridge live here because they
 * must outlive individual screens. Authenticated application state is owned by
 * WorkspaceProvider and the navigation tree under RootNavigator.
 */
function AppContent() {
  const { isDark } = usePreferences();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [authProcessing, setAuthProcessing] = useState(false);

  // Sync token state if silently refreshed in the background
  useEffect(() => {
    return onTokenChanged((newToken) => {
      if (newToken) {
        setToken(newToken);
      }
    });
  }, []);

  const finishLogin = useCallback(async (identityToken: string) => {
    const mobileToken = await exchangeSupabaseToken(identityToken);
    setAccessToken(mobileToken);
    await saveMobileToken(mobileToken);
    setToken(mobileToken);
    const profile = await api.me();
    setUser(profile);
    await saveCachedUser(profile);
  }, []);

  const restoreSession = useCallback(async () => {
    try {
      // 1. Immediate restore from local cache so the user sees the app without flash
      const cached = await loadCachedUser();
      const saved = await loadMobileToken();
      if (cached) {
        setUser(cached);
      }
      if (saved) {
        setAccessToken(saved);
        setToken(saved);
      }

      // Cached identity + device-protected token are sufficient to paint the
      // last known workspace immediately. Network validation continues below;
      // a revoked/expired token still clears the session as soon as /me says
      // so, but slow cellular DNS must not keep returning users on a splash.
      if (cached && saved) {
        setLoading(false);
      }

      // 2. If we have a saved token, verify and refresh user profile
      if (saved) {
        try {
          const freshUser = await api.me();
          setUser(freshUser);
          await saveCachedUser(freshUser);
          return;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "";
          const isAuthError =
            message.includes("401") ||
            message.includes("Unauthorized") ||
            message.includes("invalid or expired") ||
            message.includes("hết hạn");

          // If offline/network glitch and we already have cached user, keep user logged in!
          if (!isAuthError && cached) {
            return;
          }
        }
      }

      // 3. If token missing or expired, attempt restore from Supabase session in AsyncStorage
      const freshIdentity = await getFreshIdentityToken();
      if (freshIdentity) {
        try {
          await finishLogin(freshIdentity);
          return;
        } catch {
          // If server temporarily unreachable but user is cached, keep user logged in
          if (cached) return;
        }
      }

      // 4. If neither token nor Supabase session exists and no cached user, clear credentials
      if (!cached) {
        setAccessToken(null);
        setToken(null);
        setUser(null);
        await clearMobileToken();
      }
    } catch {
      const cached = await loadCachedUser();
      if (!cached) {
        setAccessToken(null);
        setToken(null);
        setUser(null);
        await clearMobileToken();
      }
    } finally {
      setLoading(false);
    }
  }, [finishLogin]);

  useEffect(() => {
    restoreSession().catch(() => setLoading(false));
  }, [restoreSession]);

  useEffect(() => {
    let isActive = true;
    const completeGoogleLogin = (url: string) => {
      if (!url.startsWith("farmos://auth/callback")) return;
      setAuthProcessing(true);
      closeBrowser();
      finishGoogleSignIn(url)
        .then((identityToken) => (isActive ? finishLogin(identityToken) : undefined))
        .catch((error) => {
          if (isActive)
            Alert.alert(
              "Đăng nhập Google không thành công",
              error instanceof Error ? error.message : "Vui lòng thử lại",
            );
        })
        .finally(() => {
          if (isActive) {
            setAuthProcessing(false);
          }
        });
    };

    const subscription = Linking.addEventListener("url", ({ url }) =>
      completeGoogleLogin(url),
    );
    Linking.getInitialURL()
      .then((url) => {
        if (url) completeGoogleLogin(url);
      })
      .catch(() => undefined);
    return () => {
      isActive = false;
      subscription.remove();
    };
  }, [finishLogin]);

  const logout = useCallback(async () => {
    setAccessToken(null);
    setToken(null);
    setUser(null);
    await clearMobileToken();
    await supabase?.auth.signOut();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDark ? "light-content" : "dark-content"} />
      <NavigationContainer>
        <RootNavigator
          loading={loading || authProcessing}
          user={user}
          token={token}
          onLogout={logout}
          onLogin={finishLogin}
        />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <PreferencesProvider>
        <AppContent />
      </PreferencesProvider>
    </I18nextProvider>
  );
}

export default App;
