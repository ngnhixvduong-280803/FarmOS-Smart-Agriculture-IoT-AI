import { createClient } from "@supabase/supabase-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSessionRestorer } from "./session";

export type DesktopAccount = { id: string; email: string; name: string | null; avatarUrl: string | null; role: string };

const url = import.meta.env.VITE_SUPABASE_URL || "";
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const configured = Boolean(url && anonKey);
const storageKey = configured ? `sb-${new URL(url).hostname.split(".")[0]}-auth-token` : "sb-farmos-auth-token";
const supabase = configured ? createClient(url, anonKey, {
  auth: {
    flowType: "pkce",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey,
    storage: {
      getItem: (key) => invoke<string | null>("auth_storage_get", { key }),
      setItem: (key, value) => invoke<void>("auth_storage_set", { key, value }),
      removeItem: (key) => invoke<void>("auth_storage_remove", { key }),
    },
  },
}) : null;
const callbackOrigin = "farmos://auth/callback";
const developmentCallbackOrigin = "http://127.0.0.1:17846/auth/callback";

type OAuthCallback =
  | { kind: "code"; code: string }
  | { kind: "tokens"; accessToken: string; refreshToken: string };

function callbackResult(value: string): OAuthCallback | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "farmos:" || parsed.hostname !== "auth" || parsed.pathname !== "/callback") return null;
    const code = parsed.searchParams.get("code") || "";
    if (code) return { kind: "code", code };
    const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const accessToken = params.get("access_token") || "";
    const refreshToken = params.get("refresh_token") || "";
    return accessToken && refreshToken ? { kind: "tokens", accessToken, refreshToken } : null;
  } catch { return null; }
}

let activeOAuthCancel: (() => void) | null = null;

export async function cancelDesktopSignIn(): Promise<void> {
  if (activeOAuthCancel) {
    activeOAuthCancel();
    activeOAuthCancel = null;
  }
  try {
    await invoke("cancel_oauth_callback");
  } catch {}
}

async function waitForDeepLinkCallback(onCancel?: (fn: () => void) => void): Promise<OAuthCallback> {
  const initial = (await getCurrent())?.map(callbackResult).find(Boolean);
  if (initial) return initial;
  return new Promise(async (resolve, reject) => {
    let unlisten: (() => void) | undefined;
    let settled = false;
    const cleanup = () => {
      settled = true;
      window.clearTimeout(timeout);
      unlisten?.();
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error("Đăng nhập Google quá thời gian chờ (60s)."));
    }, 60_000);
    const resolveOnce = (result: OAuthCallback) => {
      if (settled) return;
      cleanup();
      resolve(result);
    };
    onCancel?.(() => {
      if (settled) return;
      cleanup();
      reject(new Error("Đã hủy đăng nhập."));
    });
    unlisten = await onOpenUrl((urls) => {
      const result = urls.map(callbackResult).find(Boolean);
      if (result) resolveOnce(result);
    });
  });
}

export const isDesktopGoogleConfigured = () => configured;

// The API validates the saved/refreshed token and current role before restoring
// native authorization. StrictMode remounts share this in-flight operation.
export const restoreDesktopSession = createSessionRestorer(supabase?.auth ?? null,
  (accessToken) => invoke<DesktopAccount>("create_mobile_session", { accessToken }));

export async function signInDesktopWithGoogle(lang?: string): Promise<DesktopAccount> {
  if (!configured || !supabase) throw new Error("Thiếu VITE_SUPABASE_URL hoặc VITE_SUPABASE_ANON_KEY.");
  const activeLang = lang || (typeof localStorage !== "undefined" ? localStorage.getItem("farmos_lang") : null) || "vi";
  const redirectTo = import.meta.env.DEV ? developmentCallbackOrigin : callbackOrigin;
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo, skipBrowserRedirect: true } });
  if (error || !data.url) throw new Error(error?.message || "Không tạo được URL đăng nhập Google.");

  const authorizationUrl = new URL(data.url);
  const acceptedRedirect = authorizationUrl.searchParams.get("redirect_to");
  if (acceptedRedirect && acceptedRedirect !== redirectTo) {
    throw new Error(`Supabase chưa cho phép callback ${redirectTo}. Hãy thêm URL này vào Authentication > URL Configuration > Redirect URLs.`);
  }

  let cancelReject: ((err: Error) => void) | null = null;
  const cancelPromise = new Promise<never>((_, reject) => {
    cancelReject = reject;
  });
  activeOAuthCancel = () => {
    cancelReject?.(new Error(activeLang === "vi" ? "Đã hủy đăng nhập." : "Sign-in cancelled."));
  };

  const callback: Promise<OAuthCallback> = import.meta.env.DEV
    ? invoke<string>("wait_for_oauth_callback", { lang: activeLang }).then((code) => ({ kind: "code", code }))
    : waitForDeepLinkCallback((registerCancel) => {
        const prev = activeOAuthCancel;
        activeOAuthCancel = () => {
          prev?.();
          registerCancel();
        };
      });

  try {
    if (import.meta.env.DEV) await new Promise((resolve) => window.setTimeout(resolve, 150));
    await openUrl(data.url);
    const result = await Promise.race([callback, cancelPromise]);
    try {
      await getCurrentWindow().setFocus();
    } catch {}
    const { data: session, error: sessionError } = result.kind === "code"
      ? await supabase.auth.exchangeCodeForSession(result.code)
      : await supabase.auth.setSession({ access_token: result.accessToken, refresh_token: result.refreshToken });
    if (sessionError || !session.session?.access_token) throw new Error(sessionError?.message || "Google callback không tạo được Supabase session.");
    const account = await invoke<DesktopAccount>("create_mobile_session", { accessToken: session.session.access_token });
    if (account.role !== "ADMIN") {
      await invoke("clear_mobile_session");
      await supabase.auth.signOut({ scope: "local" });
      throw new Error("Tài khoản Google này không có quyền quản trị viên FarmOS.");
    }
    return account;
  } finally {
    activeOAuthCancel = null;
    try {
      await invoke("cancel_oauth_callback");
    } catch {}
  }
}

export async function signOutDesktop() {
  await invoke("clear_mobile_session");
  try {
    if (supabase) await supabase.auth.signOut({ scope: "local" });
  } finally {
    // Local logout must remove saved credentials even without a network.
    await invoke("auth_storage_remove", { key: storageKey });
    await invoke("auth_storage_remove", { key: `${storageKey}-code-verifier` });
  }
}
