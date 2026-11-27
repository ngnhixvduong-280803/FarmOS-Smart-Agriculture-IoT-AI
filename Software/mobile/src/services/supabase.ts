import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { openBrowser, closeBrowser } from "@swan-io/react-native-browser";
import { config, isSupabaseConfigured } from "../config";
import { oauthCode } from "./oauthCallback";

export { isSupabaseConfigured, closeBrowser };

export const supabase = isSupabaseConfigured
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        flowType: "pkce",
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

const MOBILE_REDIRECT_URL = "farmos://auth/callback";

export async function beginGoogleSignIn(opts?: { onClose?: () => void }): Promise<void> {
  if (!supabase) throw new Error("Thiếu cấu hình Supabase public cho mobile");
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: MOBILE_REDIRECT_URL,
      skipBrowserRedirect: true,
      // Do not silently reuse the browser's last Google account. The user must
      // always get Google's account chooser before FarmOS receives a callback.
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data.url) throw new Error(error?.message || "Không thể khởi tạo đăng nhập Google");
  await openBrowser(data.url, {
    dismissButtonStyle: "cancel",
    barTintColor: "#16704a",
    controlTintColor: "#ffffff",
    onClose: opts?.onClose,
  });
}

export async function finishGoogleSignIn(callbackUrl: string): Promise<string> {
  if (!supabase || !callbackUrl.startsWith(MOBILE_REDIRECT_URL)) throw new Error("Đường dẫn đăng nhập Google không hợp lệ");
  const { data, error } = await supabase.auth.exchangeCodeForSession(oauthCode(callbackUrl));
  if (error || !data.session?.access_token) throw new Error(error?.message || "Google không trả về phiên đăng nhập");
  return data.session.access_token;
}

export async function signInWithEmail(email: string, password: string): Promise<string> {
  if (!supabase) throw new Error("Chưa cấu hình dịch vụ xác thực Supabase");
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error || !data.session?.access_token) {
    const msg = error?.message || "Email hoặc mật khẩu không chính xác";
    if (msg.includes("Invalid login credentials")) {
      throw new Error("Email hoặc mật khẩu không chính xác");
    }
    throw new Error(msg);
  }
  return data.session.access_token;
}

export async function signUpWithEmail(
  email: string,
  password: string,
  name?: string,
): Promise<{ accessToken: string | null; needsEmailConfirmation?: boolean }> {
  if (!supabase) throw new Error("Chưa cấu hình dịch vụ xác thực Supabase");
  const { data, error } = await supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: {
        full_name: name?.trim() || email.split("@")[0],
      },
    },
  });
  if (error) {
    throw new Error(error.message || "Không thể tạo tài khoản mới");
  }
  if (data.session?.access_token) {
    return { accessToken: data.session.access_token, needsEmailConfirmation: false };
  }
  return { accessToken: null, needsEmailConfirmation: true };
}

export async function resetPassword(email: string): Promise<void> {
  if (!supabase) throw new Error("Chưa cấu hình dịch vụ xác thực Supabase");
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
  if (error) throw new Error(error.message || "Không thể gửi email đặt lại mật khẩu");
}

/**
 * Retrieves a fresh Supabase identity token.
 * Automatically checks whether the token is missing, expired, or close to expiry (< 120s),
 * and transparently refreshes it via Supabase's stored refresh token in AsyncStorage.
 */
export async function getFreshIdentityToken(): Promise<string | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      // Attempt manual refresh
      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
      if (refreshError || !refreshData.session?.access_token) return null;
      return refreshData.session.access_token;
    }

    const expiresAt = data.session.expires_at; // in seconds
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt && expiresAt - now < 120) {
      const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
      if (!refreshError && refreshData.session?.access_token) {
        return refreshData.session.access_token;
      }
    }

    return data.session.access_token;
  } catch {
    return null;
  }
}
