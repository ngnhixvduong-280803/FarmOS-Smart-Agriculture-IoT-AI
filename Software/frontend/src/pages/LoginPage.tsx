import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Globe, Loader2, Sprout } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import farmosLogo from "../assets/farmos-logo.png";
import { signInWithGoogleIdToken, fetchMe, loginUser } from "../services/api.service";
import { isSupabaseConfigured } from "../services/supabase";
import { TopLoadingBar } from "../components/TopLoadingBar";
import { useI18n } from "../context/I18nContext";

const GOOGLE_GIS_SRC = "https://accounts.google.com/gsi/client";
let googleInitialization: Promise<void> | null = null;
let googleNonce: Promise<{ raw: string; hashed: string }> | null = null;
let activeCredentialHandler: ((credential: string) => Promise<void>) | null = null;

function loadGoogleIdentityServices(loadErrorMsg: string, initErrorMsg: string): Promise<void> {
  const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_GIS_SRC}"]`);
  if (window.google?.accounts.id) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = existingScript || document.createElement("script");
    const finish = () => window.google?.accounts.id ? resolve() : reject(new Error(initErrorMsg));

    if (existingScript) {
      existingScript.addEventListener("load", finish, { once: true });
      existingScript.addEventListener("error", () => reject(new Error(loadErrorMsg)), { once: true });
      return;
    }

    script.src = GOOGLE_GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = finish;
    script.onerror = () => reject(new Error(loadErrorMsg));
    document.head.appendChild(script);
  });
}

async function createNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { raw, hashed };
}

async function initializeGoogleIdentityServices(clientId: string, loadErrorMsg: string, initErrorMsg: string): Promise<{ raw: string }> {
  googleNonce ||= createNonce();
  const nonce = await googleNonce;
  await loadGoogleIdentityServices(loadErrorMsg, initErrorMsg);

  if (!googleInitialization) {
    googleInitialization = Promise.resolve().then(() => {
      if (!window.google?.accounts.id) throw new Error(initErrorMsg);
      window.google.accounts.id.initialize({
        client_id: clientId,
        nonce: nonce.hashed,
        context: "signin",
        cancel_on_tap_outside: true,
        itp_support: true,
        auto_select: false,
        use_fedcm_for_prompt: true,
        use_fedcm_for_button: true,
        callback: ({ credential }) => {
          if (credential) void activeCredentialHandler?.(credential);
        },
      });
    });
  }

  await googleInitialization;
  return { raw: nonce.raw };
}

export const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as any)?.from?.pathname || "/dashboard";
  const { t, language, setLanguage } = useI18n();
  const buttonRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const [status, setStatus] = useState<"ready" | "working">("ready");
  const [error, setError] = useState<string | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  // Explicit build opt-in, loopback only, and a separate server opt-in are required.
  const previewLogin = (import.meta as any).env?.VITE_PREVIEW_LOGIN === "true"
    && !isSupabaseConfigured && ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const [previewEmail, setPreviewEmail] = useState("");
  const [previewPassword, setPreviewPassword] = useState("");
  const handlePreviewLogin = async (event: React.FormEvent) => {
    event.preventDefault(); setError(null); setStatus("working");
    try { await loginUser(previewEmail, previewPassword); navigate(from, { replace: true }); }
    catch (failure: any) { setError(failure.message || "Không đăng nhập được preview"); }
    finally { setStatus("ready"); }
  };
  const googleClientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string | undefined;

  // Tự động chuyển hướng vào Dashboard nếu người dùng đã có phiên đăng nhập hợp lệ
  useEffect(() => {
    let isCurrent = true;
    void fetchMe()
      .then(() => {
        if (isCurrent) {
          navigate(from, { replace: true });
        }
      })
      .catch(() => {
        if (isCurrent) {
          setCheckingAuth(false);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [navigate, from]);

  const handleCredential = useCallback(async (credential: string, nonce: string) => {
    if (!mountedRef.current) return;
    setError(null);
    setStatus("working");
    try {
      await signInWithGoogleIdToken(credential, nonce);
      if (!mountedRef.current) return;
      navigate("/dashboard", { replace: true });
    } catch (authError: any) {
      if (!mountedRef.current) return;
      setStatus("ready");
      setError(authError.message || t.login.loginFailed);
    }
  }, [navigate, t]);

  const renderGoogleButton = useCallback(() => {
    if (!buttonRef.current || !window.google?.accounts.id) return;
    const parentWidth = buttonRef.current.parentElement?.clientWidth || buttonRef.current.clientWidth || 320;
    // GIS button width must be between 200 and 400 pixels
    const targetWidth = Math.min(360, Math.max(220, Math.floor(parentWidth)));
    buttonRef.current.replaceChildren();
    window.google.accounts.id.renderButton(buttonRef.current, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      logo_alignment: "left",
      width: targetWidth,
    });
  }, []);

  useEffect(() => {
    if (checkingAuth) return;
    mountedRef.current = true;
    if (!isSupabaseConfigured || !googleClientId || !buttonRef.current) return;

    let isCurrent = true;
    const handleResize = () => {
      if (mountedRef.current && buttonRef.current && window.google?.accounts.id) {
        renderGoogleButton();
      }
    };

    const initialize = async () => {
      try {
        const { raw } = await initializeGoogleIdentityServices(
          googleClientId,
          t.login.loadFailed,
          t.login.initFailed
        );
        if (!isCurrent || !buttonRef.current || !window.google?.accounts.id) return;
        activeCredentialHandler = (credential) => handleCredential(credential, raw);
        renderGoogleButton();
        window.google.accounts.id.prompt();
      } catch (setupError: any) {
        if (mountedRef.current) setError(setupError.message || t.login.setupFailed);
      }
    };

    void initialize();
    window.addEventListener("resize", handleResize);

    return () => {
      isCurrent = false;
      mountedRef.current = false;
      activeCredentialHandler = null;
      window.removeEventListener("resize", handleResize);
    };
  }, [checkingAuth, googleClientId, handleCredential, renderGoogleButton, t]);

  const isReady = isSupabaseConfigured && Boolean(googleClientId);

  return (
    <main className="relative flex min-h-[100dvh] flex-col justify-between bg-gradient-to-br from-[#05140f] via-[#071a14] to-[#040e0b] text-[#eff7ed] p-0 sm:p-6 lg:p-8 sm:items-center sm:justify-center overflow-x-hidden">
      <TopLoadingBar isLoading={status === "working" || checkingAuth} />

      {/* Subtle ambient lighting glows */}
      <div aria-hidden="true" className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full bg-emerald-500/10 blur-[120px]" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-emerald-600/10 blur-[140px]" />

      {/* Floating Language Switcher for Desktop (lg+) */}
      <div className="hidden lg:block absolute top-6 right-8 z-30">
        <button
          type="button"
          onClick={() => setLanguage(language === "vi" ? "en" : "vi")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-emerald-500/30 bg-[#0b2a1f]/80 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 backdrop-blur-md transition-all active:scale-95 shadow-md"
          title={language === "vi" ? "Switch to English" : "Chuyển sang Tiếng Việt"}
        >
          <Globe className="w-3.5 h-3.5 text-emerald-400" />
          <span>{language === "vi" ? "EN" : "VI"}</span>
        </button>
      </div>

      {/* Mobile Top Navigation Header */}
      <header className="lg:hidden w-full flex items-center justify-between px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3 z-30 shrink-0">
        <Link to="/" className="inline-flex items-center gap-2.5 hover:opacity-90 transition-opacity">
          <img src={farmosLogo} alt="FarmOS" className="h-8 w-8 object-contain drop-shadow-sm" />
          <span className="text-lg font-bold tracking-tight text-white">FarmOS</span>
        </Link>
        <button
          type="button"
          onClick={() => setLanguage(language === "vi" ? "en" : "vi")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-emerald-500/30 bg-[#0b2a1f]/80 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 backdrop-blur-md transition-all active:scale-95 shadow-sm"
          title={language === "vi" ? "Switch to English" : "Chuyển sang Tiếng Việt"}
        >
          <Globe className="w-3.5 h-3.5 text-emerald-400" />
          <span>{language === "vi" ? "EN" : "VI"}</span>
        </button>
      </header>

      {/* Main Interactive Card */}
      <section className="relative flex flex-col flex-1 sm:flex-initial sm:grid sm:min-h-[min(1024px,calc(100dvh-4rem))] w-full max-w-6xl sm:overflow-hidden sm:rounded-[32px] lg:rounded-[36px] sm:border sm:border-emerald-500/20 sm:bg-[#082018]/90 sm:backdrop-blur-xl sm:shadow-[0_24px_80px_rgba(0,0,0,0.5),0_0_50px_rgba(16,185,129,0.12)] lg:grid-cols-[1.08fr_0.92fr]">
        {/* Left Column: Desktop Hero Graphic */}
        <div className="relative hidden min-h-[680px] border-r border-emerald-100/10 bg-[#0b2a1f]/80 p-12 lg:block">
          <Link to="/" className="inline-flex items-center gap-3 hover:opacity-90 transition-opacity">
            <img src={farmosLogo} alt="FarmOS" className="h-11 w-11 object-contain drop-shadow-md" />
            <span className="text-xl font-bold tracking-tight text-white">FarmOS</span>
          </Link>
          <div className="absolute inset-x-12 top-1/2 -translate-y-1/2">
            <div className="relative z-10 mb-12 max-w-sm">
              <span className="inline-block px-3 py-1 rounded-full text-xs font-bold tracking-wider text-emerald-300 bg-emerald-500/15 border border-emerald-400/20">
                {t.login.badge}
              </span>
              <h2 className="mt-4 text-5xl font-extrabold leading-[1.06] tracking-tight text-white">
                {t.login.heroTitle}
              </h2>
              <p className="mt-6 text-base leading-7 text-emerald-50/70">
                {t.login.heroSubtitle}
              </p>
            </div>
            <svg viewBox="0 0 540 330" className="w-full text-emerald-300/80" fill="none" aria-hidden="true">
              <path d="M16 262C111 161 195 161 270 230c80 72 157 55 254-50" stroke="currentColor" strokeWidth="2" opacity=".45" />
              <path d="M16 301C111 200 195 200 270 269c80 72 157 55 254-50" stroke="currentColor" strokeWidth="2" opacity=".3" />
              <path d="M16 223C111 122 195 122 270 191c80 72 157 55 254-50" stroke="currentColor" strokeWidth="2" opacity=".2" />
              <path d="M60 206c34-48 69-79 105-93M208 206c20-36 42-63 67-79M352 195c18-31 40-56 65-73" stroke="currentColor" strokeLinecap="round" strokeWidth="2" opacity=".36" />
              <circle cx="122" cy="112" r="9" fill="#c4f2ca" />
              <circle cx="275" cy="126" r="7" fill="#c4f2ca" opacity=".8" />
              <circle cx="417" cy="121" r="9" fill="#c4f2ca" opacity=".9" />
              <circle cx="122" cy="112" r="19" stroke="currentColor" opacity=".25" />
              <circle cx="417" cy="121" r="19" stroke="currentColor" opacity=".25" />
            </svg>
          </div>
          <div className="absolute bottom-12 left-12 flex items-center gap-3 text-sm text-emerald-50/70">
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-400/15 text-emerald-300 font-bold shadow-sm">✓</span>
            {t.login.allInOne}
          </div>
          <div className="absolute inset-x-0 bottom-0 h-px bg-emerald-100/10" />
          <div className="absolute -bottom-32 -right-24 h-80 w-80 rounded-full border border-emerald-300/10" />
          <div className="absolute -bottom-14 -right-4 h-48 w-48 rounded-full border border-emerald-300/10" />
        </div>

        {/* Right Column: Form Body & Legal Footer */}
        <div className="flex flex-1 flex-col justify-between px-6 py-6 sm:px-12 sm:py-12 lg:px-16 lg:py-16">
          {/* Main Form Body */}
          <div className="my-auto flex flex-col justify-center">
            {/* Desktop-only Sprout badge */}
            <div className="hidden lg:flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-400/10 text-emerald-300 shadow-sm mb-6" aria-hidden="true">
              <Sprout className="h-6 w-6" />
            </div>

            {/* Mobile-only badge */}
            <div className="lg:hidden mb-4">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-semibold tracking-wider text-emerald-300 bg-emerald-500/15 border border-emerald-400/20 uppercase">
                {t.login.badge}
              </span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              {t.login.welcomeBack}
            </h1>
            <p className="mt-2.5 max-w-sm text-sm leading-6 text-emerald-50/70">
              {t.login.loginSubtitle}
            </p>

            <div className="mt-8 min-h-11 w-full" aria-live="polite">
              {checkingAuth ? (
                <div className="flex items-center gap-2.5 text-xs text-emerald-300/80 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
                  <span>{language === "vi" ? "Đang kiểm tra phiên đăng nhập..." : "Checking session..."}</span>
                </div>
              ) : previewLogin ? (
                <form onSubmit={handlePreviewLogin} className="space-y-3">
                  <p className="text-xs text-amber-200">VPS PREVIEW · Dữ liệu thử nghiệm riêng</p>
                  <label className="block text-sm">Email preview
                    <input required type="email" autoComplete="username" value={previewEmail} onChange={e => setPreviewEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-emerald-800 bg-slate-950 p-3 text-white" />
                  </label>
                  <label className="block text-sm">Mật khẩu preview
                    <input required type="password" autoComplete="current-password" value={previewPassword} onChange={e => setPreviewPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-emerald-800 bg-slate-950 p-3 text-white" />
                  </label>
                  <button disabled={status === "working"} className="w-full rounded-lg bg-emerald-600 p-3 font-medium disabled:opacity-50">Đăng nhập preview</button>
                </form>
              ) : isReady ? (
                <div className="w-full flex justify-center sm:justify-start">
                  <div
                    ref={buttonRef}
                    className={`transition-all duration-200 min-h-[44px] w-full max-w-[360px] flex justify-center sm:justify-start ${
                      status === "working" ? "pointer-events-none opacity-50" : "hover:opacity-95"
                    }`}
                  />
                </div>
              ) : (
                <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-4 text-sm leading-6 text-amber-100 shadow-sm">
                  {t.login.missingClientId}
                </div>
              )}
            </div>

            {error && (
              <div className="mt-5 flex gap-3 rounded-2xl border border-rose-300/25 bg-rose-400/10 p-4 text-sm leading-6 text-rose-100 shadow-sm" role="alert">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* Bottom Legal Footer */}
          <div className="mt-8 pt-4 border-t border-emerald-500/10 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-emerald-300/60 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:pb-0">
            <div className="flex items-center gap-4">
              <Link
                to="/privacy"
                className="hover:text-emerald-200 transition-colors underline-offset-4 hover:underline"
              >
                {t.login.privacyPolicy}
              </Link>
              <span className="text-emerald-500/40">•</span>
              <Link
                to="/terms"
                className="hover:text-emerald-200 transition-colors underline-offset-4 hover:underline"
              >
                {t.login.termsOfService}
              </Link>
            </div>
            <span className="text-[11px] text-emerald-400/40">
              FarmOS © {new Date().getFullYear()}
            </span>
          </div>
        </div>
      </section>
    </main>
  );
};
