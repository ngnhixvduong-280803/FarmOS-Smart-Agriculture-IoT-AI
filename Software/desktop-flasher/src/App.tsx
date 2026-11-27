import { SESSION_RESTORE_TIMEOUT } from "./session";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { prepareBoardForReflash } from "./boardManagement";
import { selectedFactoryReleaseId, visibleFactoryVersions } from "./firmwareSelection";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import {
  Activity,
  AlertCircle,
  Battery,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  Droplets,
  Eye,
  QrCode,
  FileArchive,
  FileCode2,
  Globe,
  HardDriveDownload,
  Info,
  Layers,
  LayoutGrid,
  Link2Off,
  List,
  Loader2,
  LogOut,
  MapPin,
  MonitorDown,
  Package,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Signal,
  Sparkles,
  SquareTerminal,
  Sun,
  TerminalSquare,
  Thermometer,
  Trash2,
  Upload,
  UploadCloud,
  Usb,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import farmosLogo from "../../frontend/src/assets/farmos-logo.png";
import {
  listNativePorts,
  listDesktopReleases,
  nativeToolchainStatus,
  probeEsp32,
  inspectBoardForFlash,
  verifyFlashIdentity,
  flashServerRelease,
  uploadDesktopRelease,
  inspectLocalFile,
  updateDesktopReleaseStatus,
  deleteDesktopRelease,
  downloadDesktopArtifact,
  listDesktopNodes,
  unbindDesktopNode,
  deleteDesktopNode,
  saveQrPng,
  getDesktopNodeQr,
  type DesktopDeviceQr,
  startSerialMonitor,
  stopSerialMonitor,
  sendSerialData,
  resetEsp32Device,
  type DesktopRelease,
  type DesktopImage,
  type DesktopNode,
  type NativePort,
  type NativeFlashResult,
  type BoardPreflight,
  type FlashIdentityStatus,
  type NativeToolchain,
} from "./native";
import {
  isDesktopGoogleConfigured,
  signInDesktopWithGoogle,
  cancelDesktopSignIn,
  signOutDesktop,
  restoreDesktopSession,
  type DesktopAccount,
} from "./auth";

type Step = 0 | 1 | 2 | 3;
type View = "nodes" | "flasher" | "releases";

function FactoryQrPreview({ result, identityState }: { result: NativeFlashResult; identityState: string | null }) {
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");
  useEffect(() => {
    let active = true;
    setImage(null);
    setError(false);
    if (!result.qrPayload) return;
    void QRCode.toDataURL(JSON.stringify(result.qrPayload), {
      errorCorrectionLevel: "Q", margin: 4, width: 320,
      color: { dark: "#000000", light: "#ffffff" },
    }).then((dataUrl) => { if (active) setImage(dataUrl); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [result.qrPayload]);

  async function downloadQr() {
    if (!image || saving) return;
    setSaving(true); setSaveNotice("");
    try {
      const path = await save({ title: "Lưu QR thiết bị", defaultPath: `${result.qrId || result.deviceId || "farmos-qr-v3"}.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
      if (!path) return;
      const bytes = Array.from(atob(image.split(",")[1]), (character) => character.charCodeAt(0));
      await saveQrPng(path, bytes);
      setSaveNotice(`Đã lưu QR: ${path}`);
    } catch (error) { setSaveNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  if (!result.qrPayload) return null;
  return (
    <div className="factory-qr-preview">
      {image && <img src={image} alt={`QR v3 cho ${result.deviceId || "thiết bị"}`} width={240} height={240} />}
      {error && <small role="alert">Không tạo được hình QR từ payload đã ký.</small>}
      <div>
        <strong>QR v3 của {result.deviceId}</strong>
        <p>Dùng app FarmOS quét mã này để thêm thiết bị và cấu hình kết nối. Thiết bị cần ở trạng thái READY_TO_SHIP; giữ BOOT 3 giây để mở ghép nối BLE.</p>
        <small>Trạng thái identity: {identityState || "chưa xác minh"}</small>
        {image && <button className="button light" disabled={saving} onClick={() => void downloadQr()}>{saving ? "Đang lưu QR…" : "Tải ảnh QR PNG"}</button>}
        {saveNotice && <small role="status">{saveNotice}</small>}
      </div>
    </div>
  );
}
const time = () =>
  new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());

const appendLog = (
  setLogs: React.Dispatch<React.SetStateAction<string[]>>,
  message: string
) => setLogs((old) => [...old.slice(-79), `${time()} · ${message}`]);

const initials = (account: DesktopAccount) =>
  (account.name?.trim() || account.email)
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

function GoogleIcon() {
  return (
    <svg className="google-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.25v3.15C3.26 21.36 7.34 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.25C.45 8.18 0 10.03 0 12s.45 3.82 1.25 5.42l4.03-3.15z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.34 0 3.26 2.64 1.25 6.58l4.03 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
      />
    </svg>
  );
}

type Language = "vi" | "en";

const LOGIN_I18N = {
  vi: {
    badge: "TRẠM NẠP THIẾT BỊ",
    heroTitle: "Quản trị & Nạp firmware thiết bị.",
    heroSubtitle: "Nạp phần mềm, kiểm tra kết nối phần cứng và quản lý phát hành bản cập nhật tập trung.",
    allInOne: "Dành riêng cho Quản trị viên & Kỹ thuật viên",
    welcomeBack: "Đăng nhập Quản trị viên",
    loginSubtitle: "Đăng nhập để tiếp tục làm việc với thiết bị của bạn.",
    googleButton: "Tiếp tục với Google",
    connecting: "Đang kết nối...",
    restoring: "Đang khôi phục phiên đăng nhập…",
    retrySession: "Thử lại phiên đăng nhập",
    restoreTimeout: "Không thể khôi phục phiên đăng nhập. Hãy cho phép app truy cập Keychain rồi thử lại.",
    cancelButton: "Hủy",
    cancelLogin: "Hủy đăng nhập",
    missingConfig: "Chưa cấu hình dịch vụ xác thực.",
    privacyPolicy: "Chính sách bảo mật",
    termsOfService: "Điều khoản dịch vụ",
    switchTitle: "Switch to English",
    switchLabel: "EN",
  },
  en: {
    badge: "HARDWARE FLASHER",
    heroTitle: "Firmware Flashing & Device Management.",
    heroSubtitle: "Flash firmware, inspect hardware connections, and manage releases in one place.",
    allInOne: "For Administrators & Technicians",
    welcomeBack: "Admin Sign In",
    loginSubtitle: "Sign in to continue managing and flashing your devices.",
    googleButton: "Continue with Google",
    connecting: "Connecting...",
    restoring: "Restoring your session…",
    retrySession: "Retry saved session",
    restoreTimeout: "Session restoration timed out. Allow the app to access Keychain, then retry.",
    cancelButton: "Cancel",
    cancelLogin: "Cancel sign-in",
    missingConfig: "Authentication service not configured.",
    privacyPolicy: "Privacy Policy",
    termsOfService: "Terms of Service",
    switchTitle: "Chuyển sang Tiếng Việt",
    switchLabel: "VI",
  },
};

export default function App() {
  const [toolchain, setToolchain] = useState<NativeToolchain | null>(null);
  const [ports, setPorts] = useState<NativePort[]>([]);
  const [port, setPort] = useState("");
  const [targetType, setTargetType] = useState<"NODE" | "GATEWAY">("NODE");
  const [logs, setLogs] = useState<string[]>(["Khởi tạo hệ thống thành công."]);
  const [step, setStep] = useState<Step>(0);
  const [view, setView] = useState<View>("flasher");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [board, setBoard] = useState<{ chip: string; mac: string } | null>(null);
  const [flashResult, setFlashResult] = useState<NativeFlashResult | null>(null);
  const [identityStatus, setIdentityStatus] = useState<FlashIdentityStatus | null>(null);
  const [identityCheckError, setIdentityCheckError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<BoardPreflight | null>(null);
  const [account, setAccount] = useState<DesktopAccount | null>(null);
  const [releases, setReleases] = useState<DesktopRelease[]>([]);
  const [authBusy, setAuthBusy] = useState(false);
  const [authRestoring, setAuthRestoring] = useState(true);
  const [authRestoreAttempt, setAuthRestoreAttempt] = useState(0);
  const [language, setLanguage] = useState<Language>(() => {
    const saved = typeof localStorage !== "undefined" ? (localStorage.getItem("farmos_lang") as Language) : null;
    return saved === "en" || saved === "vi" ? saved : "vi";
  });

  const toggleLanguage = () => {
    const next = language === "vi" ? "en" : "vi";
    setLanguage(next);
    try { localStorage.setItem("farmos_lang", next); } catch {}
  };

  const refresh = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const [nextTools, nextPorts] = await Promise.all([
        nativeToolchainStatus(),
        listNativePorts(),
      ]);
      setToolchain(nextTools);
      setPorts(nextPorts);
      setPort((current) =>
        nextPorts.some((item) => item.path === current)
          ? current
          : nextPorts.length === 1
          ? nextPorts[0].path
          : ""
      );
      appendLog(setLogs, `Tìm thấy ${nextPorts.length} cổng USB.`);
    } catch (error) {
      if (typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      setNotice(`Không thể kết nối native bridge: ${message}`);
      appendLog(setLogs, `Lỗi native bridge: ${message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void listen<string>("flash-stage", (event) => { if (active) appendLog(setLogs, event.payload); })
      .then((unlisten) => { if (active) stop = unlisten; else unlisten(); });
    return () => { active = false; stop?.(); };
  }, []);


  useEffect(() => {
    let active = true;
    setAuthRestoring(true);
    void restoreDesktopSession().then(async (savedAccount) => {
      if (!active || !savedAccount) return;
      setAccount(savedAccount);
      const nextReleases = await listDesktopReleases();
      if (active) setReleases(nextReleases);
    }).catch((error) => {
      if (active) setNotice(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (active) setAuthRestoring(false);
    });
    return () => { active = false; };
  }, [authRestoreAttempt]);

  useEffect(() => {
    let active = true;
    const scanPorts = async () => {
      try {
        const nextPorts = await listNativePorts();
        if (!active) return;
        setPorts(nextPorts);
        setPort((current) =>
          nextPorts.some((item) => item.path === current)
            ? current
            : nextPorts.length === 1
            ? nextPorts[0].path
            : ""
        );
      } catch {
        // The manual refresh path presents native bridge errors to the user.
      }
    };
    const onFocus = () => void scanPorts();
    const interval = window.setInterval(() => void scanPorts(), 2500);
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const selectedPort = useMemo(
    () => ports.find((item) => item.path === port),
    [port, ports]
  );
  const toolsReady = Boolean(toolchain?.ready);
  const [selectedReleaseId, setSelectedReleaseId] = useState("");

  useEffect(() => {
    setBoard(null);
    setPreflight(null);
    setFlashResult(null);
    setIdentityStatus(null);
    setIdentityCheckError(null);
    setStep(0);
  }, [port, targetType, selectedReleaseId]);

  async function inspectBoard() {
    if (!selectedReleaseId) { setNotice("Vui lòng chọn phiên bản firmware trước khi kiểm tra."); return; }
    if (!port) {
      setNotice("Vui lòng chọn cổng USB trước khi kiểm tra.");
      return;
    }
    setBusy(true);
    setNotice(null);
    setFlashResult(null);
    setIdentityStatus(null);
    setIdentityCheckError(null);
    setPreflight(null);
    setStep(1);
    appendLog(setLogs, `Kiểm tra cổng ${port}...`);
    try {
      const result = await probeEsp32(port);
      result.output
        .split("\n")
        .filter(Boolean)
        .slice(-16)
        .forEach((line) => appendLog(setLogs, line));
      if (!result.ok || !result.chip?.includes("ESP32-S3") || !result.mac || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(result.mac)) {
        throw new Error("Không xác minh được chip ESP32-S3 và MAC của bo mạch.");
      }
      appendLog(setLogs, "Nạp firmware USB thông thường, không thay đổi eFuse.");
      setBoard({ chip: result.chip, mac: result.mac });
      let inspection = await inspectBoardForFlash({ chipFamily: "ESP32-S3", macAddress: result.mac, targetType, releaseId: selectedFactoryReleaseId(releases, selectedReleaseId) });
      setPreflight(inspection);
      if (inspection.typeMismatch) {
        setNotice(`Board này đang có identity ${inspection.currentDeviceType} (${inspection.currentDeviceId}). Cần quy trình cấp lại identity trước khi nạp ${targetType}.`);
      } else if (!inspection.release) {
        setNotice(inspection.releaseError || `Chưa có gói firmware xuất xưởng ${targetType === "GATEWAY" ? "Gateway" : "Sensor Node"} đang hoạt động và tương thích.`);
      } else if (!inspection.ready) {
        setNotice(inspection.reason === "IDENTITY_UNAVAILABLE"
          ? `Identity ${inspection.currentDeviceId} hiện không đủ điều kiện nạp lại.`
          : `Board chưa sẵn sàng để nạp: ${inspection.board?.state || "không xác định"}.`);
      }
      appendLog(
        setLogs,
        `Nhận diện thành công ${result.chip || "ESP32"}${result.mac ? ` · MAC ${result.mac}` : ""}.`
      );
      return { board: { chip: result.chip, mac: result.mac }, preflight: inspection };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBoard(null);
      setPreflight(null);
      setNotice(message);
      setStep(0);
      appendLog(setLogs, `Lỗi kiểm tra: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteBoardForReflash() {
    if (busy || !board || !preflight?.currentDeviceId || !preflight.release) return;
    const deviceId = preflight.currentDeviceId;
    const selectedBoard = board;
    const releaseId = preflight.release.id;
    const selectedTarget = targetType;
    const selectedUsb = port;
    const approved = await confirm(`Xóa vĩnh viễn ${deviceId} để nạp lại board ${selectedBoard.mac}? ID và QR cũ sẽ bị thu hồi; lần nạp sau sẽ cấp ID/QR mới. Nếu nạp thất bại, cần thử lại.`, { title: "Xóa để nạp lại", kind: "warning" });
    if (!approved) return;
    setBusy(true); setNotice(null);
    let deleted = false;
    try {
      const updated = await prepareBoardForReflash({ mac: selectedBoard.mac, deviceId, releaseId }, {
        probe: () => probeEsp32(selectedUsb),
        inspect: () => inspectBoardForFlash({ chipFamily: "ESP32-S3", macAddress: selectedBoard.mac, targetType: selectedTarget, releaseId }),
        remove: async (id) => { await deleteDesktopNode(id); deleted = true; },
      });
      setPreflight(updated); setFlashResult(null); setIdentityStatus(null);
      setNotice(updated.ready ? `Đã xóa ${deviceId}. Board sẵn sàng; bấm Nạp firmware để cấp ID và QR mới.` : `Đã xóa ${deviceId}; hãy kiểm tra board và firmware trước khi nạp.`);
      appendLog(setLogs, `Đã xóa đúng thiết bị ${deviceId} của board ${selectedBoard.mac}; giữ cổng USB và phiên bản đã chọn.`);
    } catch (error) {
      if (deleted) setPreflight(null);
      setNotice(`${deleted ? `Đã xóa ${deviceId}. Hãy kiểm tra lại board. ` : ""}${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  async function flashBoard() {
    const checked = board && preflight ? { board, preflight } : await inspectBoard();
    if (!checked) return;
    const currentBoard = checked.board;
    const currentPreflight = checked.preflight;
    if (!currentBoard || !port || !currentPreflight?.ready) return;
    setBusy(true);
    setNotice(null);
    setFlashResult(null);
    setIdentityStatus(null);
    setIdentityCheckError(null);
    setStep(2);
    appendLog(setLogs, "Khởi tạo tác vụ nạp firmware...");
    try {
      const latest = await inspectBoardForFlash({ chipFamily: "ESP32-S3", macAddress: currentBoard.mac, targetType, releaseId: currentPreflight.release!.id });
      setPreflight(latest);
      if (!latest.ready || latest.currentDeviceId !== currentPreflight.currentDeviceId ||
        latest.board?.id !== currentPreflight.board?.id || latest.release?.id !== currentPreflight.release?.id) {
        throw new Error("Trạng thái board hoặc bản firmware đã thay đổi. Hãy kiểm tra lại trước khi nạp.");
      }
      const result = await flashServerRelease({
        port,
        targetType,
        chipFamily: currentBoard.chip.includes("S3") ? "ESP32-S3" : currentBoard.chip,
        macAddress: currentBoard.mac,
        releaseId: latest.release!.id,
        expectedDeviceId: latest.currentDeviceId,
      });
      setLogs((old) => [
        ...old.slice(-20),
        ...result.logs.map((line) => `${time()} · ${line}`),
      ]);
      setStep(3);
      setFlashResult(result);
      if (result.deviceId) setPreflight((current) => current ? { ...current, currentDeviceId: result.deviceId, currentDeviceType: targetType === "GATEWAY" ? "GATEWAY" : "SENSOR_NODE" } : current);
      if (result.deviceId) {
        try {
          setIdentityStatus(await verifyFlashIdentity(result.deviceId));
        } catch (error) {
          setIdentityCheckError(error instanceof Error ? error.message : String(error));
        }
      }
      appendLog(
        setLogs,
        `Hoàn tất nạp ${result.jobId}${result.deviceId ? ` · ${result.deviceId}` : ""}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message.split("\n").slice(-1)[0] || message);
      setStep(1);
      setLogs((old) => [
        ...old.slice(-20),
        ...message.split("\n").map((line) => `${time()} · ${line}`),
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    setAuthBusy(true);
    setNotice(null);
    try {
      const nextAccount = await signInDesktopWithGoogle(language);
      setAccount(nextAccount);
      appendLog(setLogs, language === "vi" ? `Đăng nhập thành công: ${nextAccount.email}.` : `Signed in successfully: ${nextAccount.email}.`);
      const nextReleases = await listDesktopReleases();
      setReleases(nextReleases);
      appendLog(setLogs, language === "vi" ? `Đồng bộ ${nextReleases.length} bản firmware.` : `Synced ${nextReleases.length} firmware releases.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isCancelled = message.includes("hủy") || message.includes("cancelled") || message.includes("canceled");
      if (!isCancelled) {
        setNotice(message);
        appendLog(setLogs, language === "vi" ? `Lỗi xác thực: ${message}` : `Authentication error: ${message}`);
      } else {
        appendLog(setLogs, language === "vi" ? "Đã hủy phiên đăng nhập Google." : "Google sign-in cancelled.");
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleCancelSignIn() {
    try {
      await cancelDesktopSignIn();
    } catch {}
    setAuthBusy(false);
    setNotice(null);
    appendLog(setLogs, language === "vi" ? "Đã hủy phiên đăng nhập." : "Sign-in cancelled.");
  }

  async function signOut() {
    await signOutDesktop();
    setAccount(null);
    setReleases([]);
    setBoard(null);
    setStep(0);
    setNotice(null);
    appendLog(setLogs, "Đã đăng xuất khỏi hệ thống.");
  }



  if (!account) {
    const configured = isDesktopGoogleConfigured();
    const t = LOGIN_I18N[language];
    return (
      <main className="login-screen">
        <div aria-hidden="true" className="login-glow login-glow-top" />
        <div aria-hidden="true" className="login-glow login-glow-bottom" />

        <div className="login-lang-switcher">
          <button
            type="button"
            className="lang-toggle-btn"
            onClick={toggleLanguage}
            title={t.switchTitle}
          >
            <Globe size={14} />
            <span>{t.switchLabel}</span>
          </button>
        </div>

        <section className="login-card-container">
          <div className="login-hero">
            <div className="login-brand">
              <img className="brand-logo" src={farmosLogo} alt="FarmOS" />
              <span className="brand-name">FarmOS</span>
            </div>

            <div className="login-hero-body">
              <span className="login-badge">{t.badge}</span>
              <h1 className="login-hero-title">
                {t.heroTitle}
              </h1>
              <p className="login-hero-subtitle">
                {t.heroSubtitle}
              </p>

              <svg viewBox="0 0 540 330" className="login-wave-graphic" fill="none" aria-hidden="true">
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

            <div className="login-hero-footer">
              <span className="check-bullet">✓</span>
              <span>{t.allInOne}</span>
            </div>

            <div className="decor-circle decor-circle-1" />
            <div className="decor-circle decor-circle-2" />
          </div>

          <div className="login-panel">
            <div className="login-card">
              <div className="login-icon-badge" aria-hidden="true">
                <Cpu size={24} />
              </div>

              <h2 className="login-form-title">{t.welcomeBack}</h2>
              <p className="login-form-subtitle">{t.loginSubtitle}</p>

              {notice && (
                <div className="login-error" role="alert">
                  <AlertCircle size={16} />
                  <span>{notice === SESSION_RESTORE_TIMEOUT ? t.restoreTimeout : notice}</span>
                </div>
              )}

              {!configured && (
                <div className="login-error" role="alert">
                  <AlertCircle size={16} />
                  <span>{t.missingConfig}</span>
                </div>
              )}

              <div className="login-btn-wrapper">
                <button
                  type="button"
                  className={`google-login-btn ${authBusy ? "is-busy" : ""}`}
                  disabled={!configured || authRestoring}
                  onClick={() => {
                    if (authBusy) {
                      void handleCancelSignIn();
                    } else {
                      void signIn();
                    }
                  }}
                  title={authBusy ? t.cancelLogin : undefined}
                >
                  {authRestoring ? t.restoring : authBusy ? (
                    <>
                      <Loader2 size={18} className="spinner" />
                      <span>{t.connecting}</span>
                    </>
                  ) : (
                    <>
                      <GoogleIcon />
                      <span>{t.googleButton}</span>
                    </>
                  )}
                </button>

                {!authRestoring && !authBusy && notice && configured && (
                  <button type="button" className="login-cancel-btn" onClick={() => { setNotice(''); setAuthRestoreAttempt(value => value + 1); }}>
                    {t.retrySession}
                  </button>
                )}

                {authBusy && (
                  <button
                    type="button"
                    className="login-cancel-btn"
                    onClick={() => void handleCancelSignIn()}
                    title={t.cancelLogin}
                  >
                    <X size={15} />
                    <span>{t.cancelButton}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="login-legal-footer">
              <div className="legal-links">
                <span>{t.privacyPolicy}</span>
                <span className="bullet">•</span>
                <span>{t.termsOfService}</span>
              </div>
              <span className="legal-copy">FarmOS © {new Date().getFullYear()}</span>
            </div>
          </div>
        </section>
      </main>
    );
  }

  const title =
    view === "nodes"
      ? "Tất cả thiết bị"
      : view === "flasher"
      ? "Nạp thiết bị"
      : "Firmware & OTA";
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img className="sidebar-brand-logo" src={farmosLogo} alt="FarmOS" />
          <div className="sidebar-brand-info">
            <span className="sidebar-brand-name">FarmOS</span>
            <span className="sidebar-brand-tag">FLASHER</span>
          </div>
        </div>
        <div className="operator">
          <span className="avatar">{initials(account)}</span>
          <div className="operator-info">
            <b>{account.name || account.email}</b>
            <small>ADMINISTRATOR</small>
          </div>
          <ShieldCheck className="shield" size={18} />
        </div>
        <nav>
          <button className={view === "nodes" ? "selected" : ""} onClick={() => setView("nodes")}>
            <Server size={17} />
            <span>Tất cả thiết bị</span>
          </button>
          <button className={view === "flasher" ? "selected" : ""} onClick={() => setView("flasher")}>
            <HardDriveDownload size={17} />
            <span>Nạp thiết bị</span>
          </button>
          <button className={view === "releases" ? "selected" : ""} onClick={() => setView("releases")}>
            <FileArchive size={17} />
            <span>Firmware & OTA</span>
          </button>
        </nav>
        <button className="signout-button" onClick={() => void signOut()}>
          <LogOut size={16} /> Đăng xuất
        </button>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <b>{title}</b>
          <div className="top-actions">
            <span className={toolsReady ? "top-status ready" : "top-status"}>
              {toolsReady ? "Hệ thống sẵn sàng" : "Đang kiểm tra"}
            </span>
            <button className="account-button" onClick={() => void signOut()}>
              {account.name || account.email}
              <small>ADMIN</small>
            </button>
          </div>
        </header>
        <div className="page">
          {notice && (
            <div className="toast" role="alert">
              <AlertCircle size={18} />
              <span>{notice}</span>
              <button onClick={() => setNotice(null)}>×</button>
            </div>
          )}
          {view === "nodes" && (
            <NodesView
              onNavigateFlasher={(devType) => {
                setTargetType(devType === "GATEWAY" ? "GATEWAY" : "NODE");
                setView("flasher");
              }}
              setNotice={setNotice}
            />
          )}
          {view === "flasher" && (
            <FlasherView
              {...{
                busy,
                board,
                logs,
                notice,
                port,
                ports,
                selectedPort,
                step,
                targetType,
                toolchain,
                toolsReady,
                refresh,
                inspectBoard,
                flashBoard,
                deleteBoardForReflash,
                releases,
                selectedReleaseId,
                setSelectedReleaseId,
                flashResult,
                identityStatus,
                identityCheckError,
                preflight,
                setPreflight,
                setFlashResult,
                onRecheckIdentity: async () => {
                  if (!flashResult?.deviceId) return;
                  setIdentityCheckError(null);
                  try { setIdentityStatus(await verifyFlashIdentity(flashResult.deviceId)); }
                  catch (error) { setIdentityCheckError(error instanceof Error ? error.message : String(error)); }
                },
                setBoard,
                setPort,
                setStep,
                setTargetType,
              }}
            />
          )}
          {view === "releases" && (
            <ReleasesView
              releases={releases}
              setReleases={setReleases}
              setLogs={setLogs}
              onNavigateFlasher={(devType) => {
                setTargetType(devType === "GATEWAY" ? "GATEWAY" : "NODE");
                setView("flasher");
              }}
            />
          )}
        </div>
      </section>
    </main>
  );
}

function TechLogsCard({
  logs,
  title = "Nhật ký kỹ thuật",
  defaultOpen = true,
  maxHeight,
}: {
  logs: string[];
  title?: string;
  defaultOpen?: boolean;
  maxHeight?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, open]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!logs.length) return;
    void navigator.clipboard.writeText(logs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <details
      className="tech-logs-card"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="tech-logs-summary">
        <span className="tech-logs-title-group">
          <TerminalSquare size={16} className="tech-logs-icon" />
          <span className="tech-logs-title">{title}</span>
        </span>
        <span className="tech-logs-meta">
          <span className="tech-logs-badge">{logs.length} dòng</span>
          {logs.length > 0 && (
            <button
              type="button"
              className="tech-logs-copy-btn"
              onClick={handleCopy}
              title={copied ? "Đã sao chép!" : "Sao chép nhật ký"}
              aria-label="Sao chép nhật ký"
            >
              {copied ? <CheckCheck size={13} /> : <Copy size={13} />}
            </button>
          )}
        </span>
      </summary>
      <div className="tech-logs-body">
        <div
          ref={scrollRef}
          className="tech-logs-content"
          style={maxHeight ? { maxHeight } : undefined}
        >
          {logs.length ? (
            logs.map((line, index) => (
              <div key={`${index}-${line}`} className="tech-logs-line">
                {line}
              </div>
            ))
          ) : (
            <span className="tech-logs-empty">Chưa có bản ghi nhật ký.</span>
          )}
        </div>
      </div>
    </details>
  );
}

type SerialLogEntry = {
  id: number;
  text: string;
  time: string;
  type: "rx" | "tx" | "sys";
};

type SerialMonitorProps = {
  currentPort: string;
  ports: NativePort[];
  disabledDuringFlash: boolean;
  flashStep: Step;
};

const BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600];

function SerialMonitorCard({
  currentPort,
  ports,
  disabledDuringFlash,
  flashStep,
}: SerialMonitorProps) {
  const [selectedPort, setSelectedPort] = useState<string>(currentPort || (ports[0]?.path ?? ""));
  const [baudRate, setBaudRate] = useState<number>(115200);
  const [connected, setConnected] = useState<boolean>(false);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [showTimestamp, setShowTimestamp] = useState<boolean>(true);
  const [lineEnding, setLineEnding] = useState<string>("\r\n");
  const [inputCommand, setInputCommand] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);
  const [lines, setLines] = useState<SerialLogEntry[]>([]);

  const lineIdCounter = useRef<number>(1);
  const bufferRef = useRef<string>("");
  const terminalRef = useRef<HTMLDivElement>(null);

  // Sync selectedPort when currentPort changes and we're not currently connected
  useEffect(() => {
    if (currentPort && !connected) {
      setSelectedPort(currentPort);
    }
  }, [currentPort, connected]);

  // If flashing starts, backend forcibly stops session; update frontend state
  useEffect(() => {
    if (disabledDuringFlash && connected) {
      setConnected(false);
      setLines((prev) => [
        ...prev,
        {
          id: lineIdCounter.current++,
          text: "[FarmOS] Tạm ngắt kết nối Serial để tiến hành nạp firmware.",
          time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
          type: "sys",
        },
      ]);
    }
  }, [disabledDuringFlash, connected]);

  // Auto-scroll terminal when lines update
  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  // Listen to Tauri native events
  useEffect(() => {
    let unlistenData: (() => void) | null = null;
    let unlistenStatus: (() => void) | null = null;

    listen<string>("serial-data", (event) => {
      bufferRef.current += event.payload;
      if (bufferRef.current.includes("\n")) {
        const parts = bufferRef.current.split("\n");
        bufferRef.current = parts.pop() || "";
        const now = new Date().toLocaleTimeString("vi-VN", { hour12: false });
        const newEntries: SerialLogEntry[] = parts.map((part) => ({
          id: lineIdCounter.current++,
          text: part.replace(/\r$/, ""),
          time: now,
          type: "rx",
        }));
        setLines((prev) => {
          const updated = [...prev, ...newEntries];
          return updated.length > 2000 ? updated.slice(-2000) : updated;
        });
      }
    }).then((fn) => {
      unlistenData = fn;
    });

    listen<{ connected: boolean; port?: string; error?: string }>("serial-status", (event) => {
      setConnected(event.payload.connected);
      setConnecting(false);
      if (event.payload.error) {
        setLines((prev) => [
          ...prev,
          {
            id: lineIdCounter.current++,
            text: `[Lỗi cổng Serial] ${event.payload.error}`,
            time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
            type: "sys",
          },
        ]);
      }
    }).then((fn) => {
      unlistenStatus = fn;
    });

    return () => {
      if (unlistenData) unlistenData();
      if (unlistenStatus) unlistenStatus();
    };
  }, []);

  const handleConnect = async () => {
    if (!selectedPort) return;
    setConnecting(true);
    try {
      await startSerialMonitor(selectedPort, baudRate);
      setConnected(true);
      setLines((prev) => [
        ...prev,
        {
          id: lineIdCounter.current++,
          text: `[FarmOS] Đã mở cổng ${selectedPort} (${baudRate} baud). Đang nhận dữ liệu...`,
          time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
          type: "sys",
        },
      ]);
    } catch (err: any) {
      setLines((prev) => [
        ...prev,
        {
          id: lineIdCounter.current++,
          text: `[Lỗi mở cổng] ${err?.message || String(err)}`,
          time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
          type: "sys",
        },
      ]);
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await stopSerialMonitor();
    } catch (err) {
      console.error(err);
    }
    setConnected(false);
    setLines((prev) => [
      ...prev,
      {
        id: lineIdCounter.current++,
        text: `[FarmOS] Đã đóng cổng Serial.`,
        time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
        type: "sys",
      },
    ]);
  };

  const handleReset = async () => {
    if (!selectedPort) return;
    setResetting(true);
    try {
      setLines((prev) => [
        ...prev,
        {
          id: lineIdCounter.current++,
          text: `[FarmOS] Đang kích hoạt xung EN/RTS để khởi động lại ESP32...`,
          time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
          type: "sys",
        },
      ]);
      await resetEsp32Device(selectedPort);
    } catch (err: any) {
      setLines((prev) => [
        ...prev,
        {
          id: lineIdCounter.current++,
          text: `[Lỗi Reset bo mạch] ${err?.message || String(err)}`,
          time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
          type: "sys",
        },
      ]);
    } finally {
      setResetting(false);
    }
  };

  const handleSend = async () => {
    if (!inputCommand || !connected) return;
    setSending(true);
    const textToSend = inputCommand + lineEnding;
    try {
      await sendSerialData(textToSend);
      setLines((prev) => [
        ...prev,
        {
          id: lineIdCounter.current++,
          text: `> ${inputCommand}`,
          time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
          type: "tx",
        },
      ]);
      setInputCommand("");
    } catch (err: any) {
      setLines((prev) => [
        ...prev,
        {
          id: lineIdCounter.current++,
          text: `[Lỗi gửi lệnh] ${err?.message || String(err)}`,
          time: new Date().toLocaleTimeString("vi-VN", { hour12: false }),
          type: "sys",
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  const [open, setOpen] = useState<boolean>(true);

  const handleClear = (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    setLines([]);
    bufferRef.current = "";
  };

  const handleCopy = async (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (!lines.length) return;
    const text = lines
      .map((l) => (showTimestamp ? `[${l.time}] ${l.text}` : l.text))
      .join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <details
      className="tech-logs-card serial-tech-card"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="tech-logs-summary serial-tech-summary">
        <span className="tech-logs-title-group">
          <TerminalSquare size={16} className="tech-logs-icon" />
          <span className="tech-logs-title">Serial Monitor (UART Log)</span>
          {selectedPort && <span className="serial-tech-port-tag">({selectedPort})</span>}
        </span>
        <span className="tech-logs-meta">
          <span
            className={`tech-logs-badge ${
              connected ? "serial-badge-online" : "serial-badge-offline"
            }`}
          >
            {connected ? `● Online (${baudRate} baud)` : "○ Đã ngắt"}
          </span>
          <span className="tech-logs-badge">{lines.length} dòng</span>
          {lines.length > 0 && (
            <>
              <button
                type="button"
                className="tech-logs-copy-btn"
                onClick={handleClear}
                title="Xóa toàn bộ log"
                aria-label="Xóa log"
              >
                <Trash2 size={13} />
              </button>
              <button
                type="button"
                className="tech-logs-copy-btn"
                onClick={handleCopy}
                title={copied ? "Đã sao chép!" : "Sao chép nhật ký"}
                aria-label="Sao chép nhật ký"
              >
                {copied ? <CheckCheck size={13} /> : <Copy size={13} />}
              </button>
            </>
          )}
        </span>
      </summary>

      {flashStep === 3 && !connected && (
        <div className="serial-tech-banner">
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Sparkles size={14} style={{ color: "#34d399", flexShrink: 0 }} />
            <span>
              <strong>Nạp hoàn tất!</strong> Bấm "Mở cổng" để theo dõi log khởi động thiết bị.
            </span>
          </div>
          <button
            type="button"
            className="serial-tech-btn connect"
            onClick={() => void handleConnect()}
            disabled={disabledDuringFlash || connecting || !selectedPort}
          >
            <Play size={12} /> Mở Serial ngay
          </button>
        </div>
      )}

      <div className="serial-tech-toolbar">
        <div className="serial-tech-toolbar-left">
          <select
            className="serial-tech-select"
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            disabled={connected || disabledDuringFlash}
            title="Chọn cổng Serial"
          >
            <option value="">Chọn cổng USB</option>
            {ports.map((p) => (
              <option key={p.path} value={p.path}>
                {p.label}
              </option>
            ))}
          </select>

          <select
            className="serial-tech-select"
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={connected || disabledDuringFlash}
            title="Tốc độ Baud"
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b} baud
              </option>
            ))}
          </select>

          {connected ? (
            <button
              type="button"
              className="serial-tech-btn disconnect"
              onClick={() => void handleDisconnect()}
              title="Đóng kết nối cổng Serial"
            >
              <Pause size={12} /> Đóng cổng
            </button>
          ) : (
            <button
              type="button"
              className="serial-tech-btn connect"
              onClick={() => void handleConnect()}
              disabled={disabledDuringFlash || connecting || !selectedPort}
              title="Mở kết nối nhận log từ cổng Serial"
            >
              {connecting ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
              {connecting ? "Đang mở…" : "Mở cổng"}
            </button>
          )}

          <button
            type="button"
            className="serial-tech-btn reset"
            onClick={() => void handleReset()}
            disabled={disabledDuringFlash || resetting || !selectedPort}
            title="Kích hoạt xung EN/RTS để khởi động lại bo mạch ESP32"
          >
            <RotateCcw size={12} />
            {resetting ? "Đang reset…" : "Reset bo mạch"}
          </button>
        </div>

        <div className="serial-tech-toolbar-right">
          <label className="serial-tech-checkbox-label" title="Tự động cuộn xuống khi có log mới">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Tự cuộn
          </label>
          <label className="serial-tech-checkbox-label" title="Hiện mốc thời gian nhận dữ liệu">
            <input
              type="checkbox"
              checked={showTimestamp}
              onChange={(e) => setShowTimestamp(e.target.checked)}
            />
            Thời gian
          </label>
        </div>
      </div>

      <div className="tech-logs-body" style={{ padding: 0 }}>
        <div
          ref={terminalRef}
          className="tech-logs-content serial-tech-content"
          style={{ maxHeight: "320px", height: "260px", padding: "12px 16px" }}
        >
          {lines.length ? (
            lines.map((l) => (
              <div key={l.id} className="tech-logs-line serial-line">
                {showTimestamp && <span className="serial-time">[{l.time}] </span>}
                <span className={`serial-text ${l.type}`}>{l.text}</span>
              </div>
            ))
          ) : (
            <span className="tech-logs-empty">
              Chưa có dữ liệu Serial. Bấm "Mở cổng" để theo dõi log từ ESP32.
            </span>
          )}
        </div>
      </div>

      <div className="serial-tech-send-bar">
        <input
          type="text"
          className="serial-tech-send-input"
          placeholder={
            connected
              ? "Nhập lệnh gửi tới ESP32 qua Serial (VD: ping, status, help)..."
              : "Mở cổng Serial để gửi lệnh..."
          }
          value={inputCommand}
          onChange={(e) => setInputCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSend();
          }}
          disabled={!connected || sending}
        />
        <select
          className="serial-tech-select"
          value={lineEnding}
          onChange={(e) => setLineEnding(e.target.value)}
          title="Ký tự kết thúc dòng"
        >
          <option value="\r\n">CRLF (\r\n)</option>
          <option value="\n">LF (\n)</option>
          <option value="\r">CR (\r)</option>
          <option value="">Không có</option>
        </select>
        <button
          type="button"
          className="serial-tech-btn send"
          onClick={() => void handleSend()}
          disabled={!connected || !inputCommand.trim() || sending}
        >
          {sending ? <Loader2 size={12} className="spin" /> : <Send size={12} />}
          Gửi
        </button>
      </div>
    </details>
  );
}

type FlasherProps = {
  busy: boolean;
  board: { chip: string; mac: string } | null;
  logs: string[];
  notice: string | null;
  port: string;
  ports: NativePort[];
  selectedPort?: NativePort;
  step: Step;
  targetType: "NODE" | "GATEWAY";
  toolchain: NativeToolchain | null;
  toolsReady: boolean;
  refresh: () => Promise<void>;
  inspectBoard: () => Promise<unknown>;
  flashBoard: () => Promise<void>;
  deleteBoardForReflash: () => Promise<void>;
  releases: DesktopRelease[];
  selectedReleaseId: string;
  setSelectedReleaseId: React.Dispatch<React.SetStateAction<string>>;
  flashResult: NativeFlashResult | null;
  identityStatus: FlashIdentityStatus | null;
  identityCheckError: string | null;
  preflight: BoardPreflight | null;
  setFlashResult: React.Dispatch<React.SetStateAction<NativeFlashResult | null>>;
  setPreflight: React.Dispatch<React.SetStateAction<BoardPreflight | null>>;
  onRecheckIdentity: () => Promise<void>;
  setBoard: React.Dispatch<React.SetStateAction<{ chip: string; mac: string } | null>>;
  setPort: React.Dispatch<React.SetStateAction<string>>;
  setStep: React.Dispatch<React.SetStateAction<Step>>;
  setTargetType: React.Dispatch<React.SetStateAction<"NODE" | "GATEWAY">>;
};

function FlasherView(props: FlasherProps) {
  const [copyNotice, setCopyNotice] = useState("");
  const {
    busy,
    board,
    logs,
    notice,
    port,
    ports,
    selectedPort,
    step,
    targetType,
    toolchain,
    toolsReady,
    refresh,
    inspectBoard,
    flashBoard,
    deleteBoardForReflash,
    releases,
    selectedReleaseId,
    setSelectedReleaseId,
    flashResult,
    identityStatus,
    identityCheckError,
    preflight,
    setFlashResult,
    setPreflight,
    onRecheckIdentity,
    setBoard,
    setPort,
    setStep,
    setTargetType,
  } = props;
  return (
    <>
      <div className="page-heading">
        <div className="page-heading-left">
          <div className="page-heading-title-row">
            <h1>Nạp thiết bị qua USB</h1>
            <span className="admin-badge">Admin</span>
          </div>
          <p>Kết nối bo mạch ESP32-S3 qua cáp USB để nạp firmware mới và lưu cấu hình vào hệ thống.</p>
        </div>
        <button className="button light" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw size={15} /> Kiểm tra lại
        </button>
      </div>
      <section className="progress" aria-label="Tiến trình nạp">
        {[
          { label: "Kết nối", sub: "Chọn cổng USB" },
          { label: "Kiểm tra", sub: "Xác minh firmware" },
          { label: "Ghi flash", sub: "Nạp và kiểm tra" },
          { label: "Hoàn tất", sub: "Sẵn sàng hoạt động" },
        ].map((item, index) => (
          <div
            key={item.label}
            className={`progress-item ${index < step ? "done" : ""} ${
              index === step ? "active" : ""
            }`}
          >
            <span>{index < step ? <Check size={12} /> : index + 1}</span>
            <div>
              <b>{item.label}</b>
              <small>{item.sub}</small>
            </div>
          </div>
        ))}
      </section>
      <div className="content-grid">
        <div className="main-stack">
          <section className="panel flash-card">
            <div className="panel-title">
              <div>
                <h2>Cấu hình nạp</h2>
                <p className="panel-subtitle">Chọn phiên bản rồi kiểm tra bo qua USB. Khi nạp lại, thiết bị giữ ID và QR hiện tại.</p>
              </div>
              <Wrench size={18} />
            </div>
            <div className="fields">
              <label>
                Loại thiết bị
                <select
                  value={targetType}
                  disabled={busy}
                  onChange={(event) => {
                    setTargetType(event.target.value === "GATEWAY" ? "GATEWAY" : "NODE");
                    setStep(0);
                    setBoard(null);
                    setFlashResult(null);
                    setPreflight(null);
                  }}
                >
                  <option value="NODE">Node cảm biến</option>
                  <option value="GATEWAY">Gateway</option>
                </select>
              </label>
              <label>
                Phiên bản firmware
                <select value={selectedReleaseId} disabled={busy} onChange={(event) => setSelectedReleaseId(event.target.value)}>
                  <option value="">Chọn phiên bản firmware</option>
                  {visibleFactoryVersions(releases).filter((release) => release.deviceType === (targetType === "GATEWAY" ? "GATEWAY" : "SENSOR_NODE")).map((release) => <option key={release.id} value={release.id}>{release.version} · {release.firmwareTarget}</option>)}
                </select>
              </label>
              <label>
                Cổng kết nối USB
                <select
                  value={port}
                  disabled={busy}
                  onChange={(event) => {
                    setPort(event.target.value);
                    setStep(0);
                    setBoard(null);
                    setFlashResult(null);
                    setPreflight(null);
                  }}
                >
                  <option value="">Chọn cổng USB của thiết bị</option>
                  {ports.map((item) => (
                    <option key={item.path} value={item.path}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="actions">
              <button
                className="button light"
                disabled={busy || !toolsReady || !port}
                onClick={() => void inspectBoard()}
              >
                <Search size={15} />
                {busy ? "Đang kiểm tra…" : "Kiểm tra thiết bị"}
              </button>
              <button
                className="button dark"
                disabled={busy || !toolsReady || !port || !selectedReleaseId || preflight?.ready === false}
                onClick={() => void flashBoard()}
              >
                <Download size={15} />
                {busy ? "Đang nạp…" : preflight?.currentDeviceId ? "Nạp lại, giữ ID và QR" : "Nạp firmware"}
              </button>
            </div>
            <div className="status-row">
              <span
                className={`dot ${
                  notice ? "red" : step >= 1 ? "green" : "amber"
                }`}
              />
              <b>
                {notice
                  ? "Cần xử lý"
                  : step >= 1
                  ? "Đã nhận diện thiết bị"
                  : "Sẵn sàng"}
              </b>
              <small>{selectedPort?.path || ""}</small>
            </div>
          </section>
          {preflight && (
            <section className="panel flash-preflight" role="status">
              <h2>Kiểm tra trước khi nạp</h2>
              <dl>
                <dt>Identity hiện tại</dt><dd>{preflight.currentDeviceId ? `${preflight.currentDeviceId} · ${preflight.currentDeviceType}` : "Chưa đăng ký"}</dd>
                <dt>Firmware tương thích</dt><dd>{preflight.release ? `${preflight.release.version} · ${preflight.release.firmwareTarget}` : "Chưa có bản xuất xưởng đang hoạt động"}</dd>
                <dt>Trạng thái</dt><dd>{preflight.ready ? "Sẵn sàng nạp" : preflight.typeMismatch ? "Loại identity không khớp board đã chọn" : "Chưa đủ điều kiện nạp"}</dd>
              </dl>
              {preflight.currentDeviceId ? <>
                <p>Nạp lại firmware giữ ID và QR hiện tại. Để cấp ID và QR mới, chọn Xóa để nạp lại.</p>
                <button className="button light" disabled={busy || !board || !preflight.release} onClick={() => void deleteBoardForReflash()}>Xóa để nạp lại</button>
              </> : preflight.ready && <p>Phiên bản do bạn chọn. Nạp xong sẽ cấp mã thiết bị và QR mới.</p>}
            </section>
          )}
          {flashResult && (
            <section className="panel flash-result" role="status">
              <h2><CheckCheck size={18} /> {flashResult.newIdentity ? "Đã nạp và tạo thiết bị mới" : "Nạp lại firmware hoàn tất"}</h2>
              <p>{flashResult.newIdentity ? "FarmOS đã xác nhận bản nạp và cấp identity QR v3. Kiểm tra kho và trạng thái cloud ở dưới." : "FarmOS đã xác nhận bản nạp và giữ nguyên identity của thiết bị."}</p>
              <dl>
                <dt>Mã thiết bị</dt><dd>{flashResult.deviceId}</dd>
                <dt>Mã QR</dt><dd>{flashResult.qrId}</dd>
                <dt>FlashJob</dt><dd>{flashResult.jobId}</dd>
                <dt>Kho thiết bị</dt><dd>{identityStatus ? identityStatus.found ? `Đã ghi nhận · ${identityStatus.identityState || "chưa rõ trạng thái"}` : "Chưa tìm thấy" : "Chưa xác minh"}</dd>
                <dt>Kết nối cloud</dt><dd>{identityStatus?.online ? "Online" : "Chưa xác nhận online"}</dd>
                {identityStatus?.lastSeen && <><dt>Gặp lần cuối</dt><dd>{new Date(identityStatus.lastSeen).toLocaleString("vi-VN")}</dd></>}
              </dl>
              <FactoryQrPreview result={flashResult} identityState={identityStatus?.identityState || null} />
              <div className="flash-result-actions">
                <button className="button light" onClick={() => void onRecheckIdentity()}>Kiểm tra lại kho và kết nối</button>
                {flashResult.qrPayload && (
                  <button className="button light" onClick={() => {
                    void navigator.clipboard.writeText(JSON.stringify(flashResult.qrPayload))
                      .then(() => setCopyNotice("Đã sao chép payload QR v3."))
                      .catch(() => setCopyNotice("Không sao chép được payload QR v3."));
                  }}>Sao chép QR v3 đã ký</button>
                )}
              </div>
              {copyNotice && <small role="status">{copyNotice}</small>}
              {identityCheckError && <small role="alert">Không kiểm tra được kho: {identityCheckError}</small>}
            </section>
          )}
          <SerialMonitorCard
            currentPort={port}
            ports={ports}
            disabledDuringFlash={busy}
            flashStep={step}
          />
        </div>
        <aside className="side-stack">
          {board && (
            <section className="panel board">
              <h2>
                <Cpu size={17} /> Thông tin phần cứng
              </h2>
              <dl>
                <dt>Chip</dt>
                <dd>{board.chip}</dd>
                <dt>MAC</dt>
                <dd>{board.mac}</dd>
                <dt>Cổng</dt>
                <dd>{port}</dd>
              </dl>
            </section>
          )}
          <details className="diagnostic-card-collapsible" open>
            <summary className="panel-summary">
              <span className="summary-left">
                <Settings2 size={16} />
                <span>Bộ nạp & Môi trường</span>
              </span>
              <span className={`status-pill ${toolsReady ? "active" : "paused"}`}>
                {toolsReady ? "Sẵn sàng" : "Chưa sẵn sàng"}
              </span>
            </summary>
            <div className="panel-body">
              <dl>
                <dt>Trạng thái</dt>
                <dd className={toolsReady ? "ok-text" : "warning-text"}>
                  {toolsReady ? "Bộ nạp sẵn sàng" : "Chưa sẵn sàng"}
                </dd>
                <dt>Đường dẫn</dt>
                <dd className="path-text" title={toolchain?.esptoolPath || ""}>
                  {toolchain?.esptoolPath || "Chưa tìm thấy"}
                </dd>
                <dt>PlatformIO</dt>
                <dd className="path-text" title={toolchain?.pioPath || ""}>
                  {toolchain?.pioPath || "—"}
                </dd>
                <dt>Cổng USB</dt>
                <dd>
                  {ports.length ? (
                    <div className="usb-quick-list">
                      {ports.map((p) => (
                        <span key={p.path} className="usb-quick-tag" title={p.path}>
                          <span className="dot green" /> {p.label}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="muted-text">Không tìm thấy thiết bị kết nối.</span>
                  )}
                </dd>
              </dl>
            </div>
          </details>
          <TechLogsCard logs={logs} title="Nhật ký kỹ thuật" defaultOpen={true} />
        </aside>
      </div>
    </>
  );
}

type SelectedSlotFile = {
  path: string;
  name: string;
  size: number;
};

function sizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function roleLabel(role: string): string {
  switch (role.toUpperCase()) {
    case "BOOTLOADER":
      return "Bootloader (0x0)";
    case "PARTITION_TABLE":
      return "Bảng phân vùng (0x10000)";
    case "OTA_DATA":
      return "Khởi tạo OTA (0x19000)";
    case "APP":
      return "App chính (0x20000)";
    default:
      return role;
  }
}

function otaStatusLabel(status: string) {
  if (status === "ACTIVE") return "Đang phát hành";
  if (status === "PAUSED") return "Tạm dừng";
  if (status === "REVOKED") return "Đã thu hồi";
  return "Bản nháp";
}

function statusBadgeClass(status: string) {
  if (status === "ACTIVE") return "status-pill active";
  if (status === "PAUSED") return "status-pill paused";
  if (status === "REVOKED") return "status-pill revoked";
  return "status-pill draft";
}

function dateLabel(dateStr?: string | null) {
  if (!dateStr) return "—";
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

function ReleasesView({
  releases,
  setReleases,
  setLogs,
  onNavigateFlasher,
}: {
  releases: DesktopRelease[];
  setReleases: React.Dispatch<React.SetStateAction<DesktopRelease[]>>;
  setLogs: React.Dispatch<React.SetStateAction<string[]>>;
  onNavigateFlasher: (deviceType: string) => void;
}) {
  const [uploadMode, setUploadMode] = useState<"ota" | "factory">("factory");
  const [factoryDirectory, setFactoryDirectory] = useState("");
  const [releaseChannel, setReleaseChannel] = useState<"OTA" | "FACTORY">("FACTORY");
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  // File slot states
  const [appFile, setAppFile] = useState<SelectedSlotFile | null>(null);
  const [bootloaderFile, setBootloaderFile] = useState<SelectedSlotFile | null>(null);
  const [partitionsFile, setPartitionsFile] = useState<SelectedSlotFile | null>(null);
  const [otaDataFile, setOtaDataFile] = useState<SelectedSlotFile | null>(null);

  // Metadata form states
  const [deviceType, setDeviceType] = useState<"" | "GATEWAY" | "SENSOR_NODE">("");
  const [changelog, setChangelog] = useState("");

  // Process states
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  const resetUploadForm = () => {
    setAppFile(null);
    setBootloaderFile(null);
    setPartitionsFile(null);
    setOtaDataFile(null);
    setDeviceType("");
    setChangelog("");
    setProgress(0);
  };

  const getFileInfo = async (filePath: string): Promise<SelectedSlotFile> => {
    try {
      const info = await inspectLocalFile(filePath);
      return { path: filePath, name: info.name, size: info.sizeBytes };
    } catch {
      const name = filePath.split(/[/\\]/).pop() || filePath;
      return { path: filePath, name, size: 0 };
    }
  };

  const handleFilePaths = async (rawPaths: string[]) => {
    const binPaths = rawPaths.filter((p) => p.toLowerCase().endsWith(".bin"));
    if (binPaths.length === 0) {
      setNotice({ kind: "error", text: "Vui lòng chọn các file firmware có định dạng .bin." });
      return;
    }

    const fileInfos = await Promise.all(binPaths.map(getFileInfo));

    if (uploadMode === "ota" || fileInfos.length === 1) {
      setAppFile(fileInfos[0]);
      return;
    }

    // Chế độ Factory: phân loại thông minh theo tên file
    let foundBoot: SelectedSlotFile | null = null;
    let foundPart: SelectedSlotFile | null = null;
    let foundOta: SelectedSlotFile | null = null;
    let foundApp: SelectedSlotFile | null = null;
    const remaining: SelectedSlotFile[] = [];

    for (const f of fileInfos) {
      const lower = f.name.toLowerCase();
      if (!foundBoot && (lower.includes("bootloader") || lower.includes("boot.bin"))) {
        foundBoot = f;
      } else if (!foundPart && (lower.includes("partition") || lower.includes("partitions"))) {
        foundPart = f;
      } else if (!foundOta && (lower.includes("ota_data") || lower.includes("ota-data") || lower.includes("ota_initial"))) {
        foundOta = f;
      } else {
        remaining.push(f);
      }
    }

    for (const f of remaining) {
      const lower = f.name.toLowerCase();
      if (!foundApp && (lower.includes("firmware") || lower.includes("app") || lower.includes("gateway") || lower.includes("node"))) {
        foundApp = f;
      } else if (!foundApp) {
        foundApp = f;
      } else if (!foundBoot) {
        foundBoot = f;
      } else if (!foundPart) {
        foundPart = f;
      } else if (!foundOta) {
        foundOta = f;
      }
    }

    if (foundApp) setAppFile(foundApp);
    if (foundBoot) setBootloaderFile(foundBoot);
    if (foundPart) setPartitionsFile(foundPart);
    if (foundOta) setOtaDataFile(foundOta);

    setNotice({
      kind: "success",
      text: `Đã tự động nhận diện và gán ${fileInfos.length} file nhị phân vào các phân vùng.`,
    });
  };

  const pickSlotFile = async (slot: "app" | "bootloader" | "partitions" | "otaData") => {
    const title =
      slot === "app"
        ? "Chọn firmware chính (app.bin)"
        : slot === "bootloader"
        ? "Chọn bootloader (bootloader.bin)"
        : slot === "partitions"
        ? "Chọn bảng phân vùng (partitions.bin)"
        : "Chọn khởi tạo OTA (ota_data_initial.bin)";
    const selected = await open({
      multiple: false,
      title,
      filters: [{ name: "ESP Binary", extensions: ["bin"] }],
    });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    const info = await getFileInfo(path);
    if (slot === "app") setAppFile(info);
    else if (slot === "bootloader") setBootloaderFile(info);
    else if (slot === "partitions") setPartitionsFile(info);
    else if (slot === "otaData") setOtaDataFile(info);
  };

  const pickBatchFiles = async () => {
    const selected = await open({
      multiple: true,
      title: "Chọn cùng lúc các file build ESP32 (.bin)",
      filters: [{ name: "ESP Binary", extensions: ["bin"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    if (paths.length) {
      await handleFilePaths(paths);
    }
  };

  const loadFactoryBuildDir = async () => {
    try {
      const selected = factoryDirectory.trim() || await open({
        directory: true, multiple: false, title: "Chọn gói firmware đã ký trong dist/firmware",
      });
      if (!selected || Array.isArray(selected)) return;
      const directory = selected.replace(/[/\\]+$/, "");
      const paths = ["firmware.bin", "bootloader.bin", "partitions.bin", "ota_data_initial.bin"].map((name) => `${directory}/${name}`);
      const files = await Promise.all(paths.map(inspectLocalFile));
      if (files.some((file) => file.sizeBytes === 0)) throw new Error("Gói firmware có file rỗng.");
      await handleFilePaths(paths);
    } catch (error) {
      setNotice({ kind: "error", text: `Không đọc được bộ build: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setIsDragging(true);
        } else if (event.payload.type === "drop") {
          setIsDragging(false);
          if (event.payload.paths && event.payload.paths.length > 0) {
            void handleFilePaths(event.payload.paths);
          }
        } else {
          setIsDragging(false);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [uploadMode]);

  const loadReleases = async () => {
    setLoading(true);
    try {
      const next = await listDesktopReleases();
      setReleases(next);
      appendLog(setLogs, `Đồng bộ ${next.length} bản firmware.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ kind: "error", text: `Lỗi tải danh sách firmware: ${msg}` });
    } finally {
      setLoading(false);
    }
  };

  const submitUpload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!appFile) {
      setNotice({ kind: "error", text: "Vui lòng chọn file App chính (firmware.bin)." });
      return;
    }
    if (uploadMode === "factory" && (!bootloaderFile || !partitionsFile || !otaDataFile)) {
      setNotice({
        kind: "error",
        text: "Chế độ xuất xưởng yêu cầu đủ 4 file: App, Bootloader, Bảng phân vùng và Khởi tạo OTA.",
      });
      return;
    }

    setNotice(null);
    setUploading(true);
    setProgress(20);

    try {
      setProgress(50);
      const result = await uploadDesktopRelease({
        app: appFile.path,
        bootloader: uploadMode === "factory" ? bootloaderFile?.path : undefined,
        partitionTable: uploadMode === "factory" ? partitionsFile?.path : undefined,
        otaData: uploadMode === "factory" ? otaDataFile?.path : undefined,
        deviceType: deviceType || undefined,
        changelog: changelog.trim() || undefined,
      });
      setProgress(100);
      setNotice({
        kind: "success",
        text: result.factoryReady
          ? `Đã tải lên và tạo Gói xuất xưởng v${result.version} thành công!`
          : `Đã tải lên và tạo bản phát hành OTA v${result.version} thành công!`,
      });
      appendLog(setLogs, `Đã tải lên firmware v${result.version}.`);
      resetUploadForm();
      const updated = await listDesktopReleases();
      setReleases(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ kind: "error", text: `Lỗi tải firmware: ${msg}` });
      appendLog(setLogs, `Lỗi tải firmware: ${msg}`);
    } finally {
      setUploading(false);
      setTimeout(() => setProgress(0), 1200);
    }
  };

  const handleChangeStatus = async (
    release: DesktopRelease,
    channel: "OTA" | "FACTORY",
    newStatus: "ACTIVE" | "PAUSED"
  ) => {
    setBusyId(release.id);
    setNotice(null);
    try {
      const updated = await updateDesktopReleaseStatus(release.id, channel, newStatus);
      setReleases((curr) => curr.map((r) => (r.id === release.id ? updated : r)));
      setNotice({
        kind: "success",
        text: `Đã cập nhật trạng thái v${release.version} thành ${otaStatusLabel(newStatus)}.`,
      });
      appendLog(setLogs, `Cập nhật v${release.version} -> ${newStatus}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ kind: "error", text: `Lỗi cập nhật trạng thái: ${msg}` });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (release: DesktopRelease) => {
    const ok = await confirm(
      `Bạn có chắc chắn muốn xóa bản phát hành v${release.version}? Thao tác này sẽ xóa vĩnh viễn cả file nhị phân trên server.`,
      { title: "Xác nhận xóa firmware", kind: "warning" }
    );
    if (!ok) return;

    setBusyId(release.id);
    setNotice(null);
    try {
      await deleteDesktopRelease(release.id);
      setReleases((curr) => curr.filter((r) => r.id !== release.id));
      if (expandedId === release.id) setExpandedId(null);
      setNotice({ kind: "success", text: `Đã xóa bản phát hành v${release.version}.` });
      appendLog(setLogs, `Đã xóa bản firmware v${release.version}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ kind: "error", text: `Lỗi xóa firmware: ${msg}` });
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (release: DesktopRelease, imageId?: string, defaultFileName?: string) => {
    const key = `${release.id}-${imageId || "default"}`;
    setDownloadingKey(key);
    try {
      const savePath = await save({
        title: "Lưu file firmware nhị phân",
        defaultPath: defaultFileName || release.artifactFileName || `firmware-${release.version}.bin`,
        filters: [{ name: "ESP Binary", extensions: ["bin"] }],
      });
      if (!savePath) return;
      await downloadDesktopArtifact(release.id, imageId, savePath);
      setNotice({ kind: "success", text: `Đã lưu file vào: ${savePath}` });
      appendLog(setLogs, `Đã tải file firmware về: ${savePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice({ kind: "error", text: `Lỗi tải file: ${msg}` });
    } finally {
      setDownloadingKey(null);
    }
  };

  const otaReleases = useMemo(() => releases.filter((r) => !r.factoryReady), [releases]);
  const factoryReleases = useMemo(() => releases.filter((r) => r.factoryReady), [releases]);
  const visibleReleases = releaseChannel === "OTA" ? otaReleases : factoryReleases;
  const activeCount = useMemo(() => otaReleases.filter((r) => r.otaStatus === "ACTIVE").length, [otaReleases]);
  const factoryCount = useMemo(() => factoryReleases.filter((r) => r.flashStatus === "ACTIVE").length, [factoryReleases]);

  return (
    <div className="firmware-page-container">
      {/* Header */}
      <div className="fw-header">
        <div>
          <h1 className="fw-title">Firmware & Cập nhật OTA</h1>
          <p className="fw-subtitle">
            Quản lý và phát hành các bản cập nhật phần mềm từ xa cho Gateway và Node cảm biến.
          </p>
        </div>
        <div className="fw-header-right">
          <div className="fw-stats-text">
            <span>Đang phát hành:</span>
            <span className="count-green">{activeCount} bản</span>
            <span className="divider">|</span>
            <span>Xuất xưởng:</span>
            <span className="count-indigo">{factoryCount} bản</span>
          </div>
          <button
            type="button"
            className="fw-refresh-btn"
            onClick={() => void loadReleases()}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            <span>Làm mới</span>
          </button>
        </div>
      </div>

      {/* Thông báo Alert Banner */}
      {notice && (
        <div className={`fw-notice-banner ${notice.kind}`}>
          <div className="notice-content">
            {notice.kind === "success" ? <Check size={16} /> : <XCircle size={16} />}
            <span>{notice.text}</span>
          </div>
          <button type="button" onClick={() => setNotice(null)} className="notice-close">
            <X size={15} />
          </button>
        </div>
      )}

      {/* Khu vực Upload Form */}
      <section className="fw-card fw-upload-section">
        <div className="fw-upload-header">
          <div>
            <h2 className="upload-title">Tải lên bản firmware mới</h2>
            <p className="upload-subtitle">
              {uploadMode === "ota"
                ? "Chế độ OTA: Nạp 1 file ứng dụng chính để nâng cấp thiết bị qua Wi-Fi."
                : "Chế độ Xuất xưởng: Nạp đủ 4 file nhị phân của ESP32-S3 để nạp trắng thiết bị qua cáp USB."}
            </p>
          </div>

          {/* Toggle Chế độ nạp */}
          <div className="fw-mode-toggle">
            <button
              type="button"
              onClick={() => {
                setUploadMode("ota");
                setBootloaderFile(null);
                setPartitionsFile(null);
                setOtaDataFile(null);
              }}
              className={`mode-btn ${uploadMode === "ota" ? "active-ota" : ""}`}
            >
              <Radio size={14} className="icon-green" />
              <span>Chỉ OTA (1 file)</span>
            </button>
            <button
              type="button"
              onClick={() => setUploadMode("factory")}
              className={`mode-btn ${uploadMode === "factory" ? "active-factory" : ""}`}
            >
              <Cpu size={14} className="icon-indigo" />
              <span>Gói xuất xưởng Factory (4 file)</span>
            </button>
          </div>
        </div>

        <form onSubmit={submitUpload} className="fw-upload-form">
          {uploadMode === "ota" ? (
            /* Dropzone 1 File cho OTA */
            <div
              onClick={() => void pickSlotFile("app")}
              className={`fw-ota-dropzone ${isDragging ? "dragging" : ""} ${appFile ? "has-file" : ""}`}
            >
              {appFile ? (
                <div className="selected-file-preview">
                  <div className="file-icon-box green">
                    <FileCode2 size={20} />
                  </div>
                  <div className="file-meta">
                    <span className="file-name">{appFile.name}</span>
                    <span className="file-hint">
                      {sizeLabel(appFile.size)} · Nhấp để đổi file
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAppFile(null);
                    }}
                    className="clear-file-btn"
                    title="Hủy file này"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <>
                  <div className="cloud-icon-circle">
                    <UploadCloud size={24} className="cloud-icon" />
                  </div>
                  <p className="drop-prompt">
                    Kéo thả file firmware (.bin) vào đây hoặc{" "}
                    <span className="link-text">chọn từ máy tính</span>
                  </p>
                  <p className="drop-hint">File ứng dụng chính (nạp tại offset 0x20000 - OTA slot 0)</p>
                </>
              )}
            </div>
          ) : (
            /* Chế độ Gói xuất xưởng Factory (4 file) */
            <div className="fw-factory-zone">
              {/* Batch Dropzone */}
              <div
                onClick={() => void pickBatchFiles()}
                className={`fw-batch-dropzone ${isDragging ? "dragging" : ""}`}
              >
                <div className="batch-prompt">
                  <Sparkles size={16} className="sparkle-icon" />
                  <span>Kéo thả 4 file từ gói firmware đã ký</span>
                </div>
                <p className="batch-hint">
                  Hệ thống tự nhận diện firmware.bin, bootloader.bin, partitions.bin và ota_data_initial.bin.
                </p>
              </div>
              <div className="fw-build-path">
                <input
                  value={factoryDirectory}
                  onChange={(event) => setFactoryDirectory(event.target.value)}
                  aria-label="Đường dẫn thư mục gói firmware"
                  placeholder="Đường dẫn thư mục gói firmware"
                />
                <button type="button" className="button light" onClick={() => void loadFactoryBuildDir()}>
                  {factoryDirectory.trim() ? "Đọc thư mục" : "Chọn gói firmware"}
                </button>
              </div>

              {/* 4 File Slots (2x2 Grid) */}
              <div className="fw-slots-grid">
                {/* 1. App File */}
                <div
                  onClick={() => void pickSlotFile("app")}
                  className={`fw-slot-card ${appFile ? "filled" : ""}`}
                >
                  <div className="slot-left">
                    <div className={`slot-icon-box ${appFile ? "green" : "gray"}`}>
                      <FileCode2 size={16} />
                    </div>
                    <div className="slot-texts">
                      <div className="slot-title-row">
                        <span className="slot-name">1. App chính (0x20000)</span>
                        <span className="req-star">*</span>
                      </div>
                      <p className="slot-subtext">
                        {appFile ? `${appFile.name} (${sizeLabel(appFile.size)})` : "Chọn firmware.bin"}
                      </p>
                    </div>
                  </div>
                  {appFile && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAppFile(null);
                      }}
                      className="slot-clear-btn"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* 2. Bootloader File */}
                <div
                  onClick={() => void pickSlotFile("bootloader")}
                  className={`fw-slot-card ${bootloaderFile ? "filled" : ""}`}
                >
                  <div className="slot-left">
                    <div className={`slot-icon-box ${bootloaderFile ? "green" : "gray"}`}>
                      <FileCode2 size={16} />
                    </div>
                    <div className="slot-texts">
                      <div className="slot-title-row">
                        <span className="slot-name">2. Bootloader (0x0)</span>
                        <span className="req-star">*</span>
                      </div>
                      <p className="slot-subtext">
                        {bootloaderFile
                          ? `${bootloaderFile.name} (${sizeLabel(bootloaderFile.size)})`
                          : "Chọn bootloader.bin"}
                      </p>
                    </div>
                  </div>
                  {bootloaderFile && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBootloaderFile(null);
                      }}
                      className="slot-clear-btn"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* 3. Partitions File */}
                <div
                  onClick={() => void pickSlotFile("partitions")}
                  className={`fw-slot-card ${partitionsFile ? "filled" : ""}`}
                >
                  <div className="slot-left">
                    <div className={`slot-icon-box ${partitionsFile ? "green" : "gray"}`}>
                      <FileCode2 size={16} />
                    </div>
                    <div className="slot-texts">
                      <div className="slot-title-row">
                        <span className="slot-name">3. Bảng phân vùng (0x10000)</span>
                        <span className="req-star">*</span>
                      </div>
                      <p className="slot-subtext">
                        {partitionsFile
                          ? `${partitionsFile.name} (${sizeLabel(partitionsFile.size)})`
                          : "Chọn partitions.bin"}
                      </p>
                    </div>
                  </div>
                  {partitionsFile && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPartitionsFile(null);
                      }}
                      className="slot-clear-btn"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* 4. OTA Data File */}
                <div
                  onClick={() => void pickSlotFile("otaData")}
                  className={`fw-slot-card ${otaDataFile ? "filled" : ""}`}
                >
                  <div className="slot-left">
                    <div className={`slot-icon-box ${otaDataFile ? "green" : "gray"}`}>
                      <FileCode2 size={16} />
                    </div>
                    <div className="slot-texts">
                      <div className="slot-title-row">
                        <span className="slot-name">4. Khởi tạo OTA (0x19000)</span>
                        <span className="req-star">*</span>
                      </div>
                      <p className="slot-subtext">
                        {otaDataFile
                          ? `${otaDataFile.name} (${sizeLabel(otaDataFile.size)})`
                          : "Chọn ota_data_initial.bin"}
                      </p>
                    </div>
                  </div>
                  {otaDataFile && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOtaDataFile(null);
                      }}
                      className="slot-clear-btn"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Form thông tin đi kèm: 2 cột cân đối */}
          <div className="fw-inputs-row">
            <div className="fw-input-col">
              <label className="fw-field-label">
                Loại thiết bị <span className="label-sub">(Tự nhận diện nếu để trống)</span>
              </label>
              <select
                value={deviceType}
                onChange={(e) => setDeviceType(e.target.value as "" | "GATEWAY" | "SENSOR_NODE")}
                disabled={uploading}
                className="fw-select"
              >
                <option value="">Tự nhận diện theo file</option>
                <option value="GATEWAY">Gateway (Bộ điều khiển trung tâm)</option>
                <option value="SENSOR_NODE">Node cảm biến (Bộ thu thập dữ liệu)</option>
              </select>
            </div>

            <div className="fw-input-col">
              <label className="fw-field-label">
                Ghi chú phát hành (Changelog) <span className="label-sub">(Tuỳ chọn)</span>
              </label>
              <input
                type="text"
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                disabled={uploading}
                placeholder="Tóm tắt các cải tiến, sửa lỗi trong bản này..."
                className="fw-text-input"
              />
            </div>
          </div>

          {/* Progress Bar khi tải lên */}
          {uploading && (
            <div className="fw-upload-progress">
              <div className="progress-info">
                <span>Đang tải lên & xác thực firmware...</span>
                <span>{progress}%</span>
              </div>
              <div className="progress-bar-bg">
                <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {/* Action Footer */}
          <div className="fw-form-footer">
            {(appFile || bootloaderFile || partitionsFile || otaDataFile) && !uploading && (
              <button
                type="button"
                onClick={resetUploadForm}
                className="fw-btn-cancel"
              >
                Hủy chọn
              </button>
            )}
            <button
              type="submit"
              disabled={
                uploading ||
                !appFile ||
                (uploadMode === "factory" && (!bootloaderFile || !partitionsFile || !otaDataFile))
              }
              className="fw-btn-submit"
            >
              {uploading ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Upload size={15} />
              )}
              <span>
                {uploading
                  ? `Đang tải... ${progress}%`
                  : uploadMode === "factory"
                  ? "Tải lên Gói xuất xưởng (4 file)"
                  : "Tải lên & Lưu bản OTA"}
              </span>
            </button>
          </div>
        </form>
      </section>

      {/* Catalog: Hai catalog độc lập */}
      <section className="fw-card fw-catalog-section">
        <div className="fw-catalog-header">
          <div>
            <h2 className="catalog-title">
              {releaseChannel === "OTA" ? "Bản phát hành OTA" : "Gói firmware xuất xưởng"}
            </h2>
            <p className="catalog-subtitle">
              {releaseChannel === "OTA"
                ? "Chỉ firmware app để thiết bị đang hoạt động tải và cập nhật từ xa."
                : "Chỉ bộ 4 file đã kiểm tra để nạp bo mạch mới qua USB."}
            </p>
          </div>
          <div className="fw-channel-tabs">
            <button
              type="button"
              onClick={() => setReleaseChannel("OTA")}
              className={`channel-tab-btn ${releaseChannel === "OTA" ? "active-ota" : ""}`}
            >
              OTA (1 file)
            </button>
            <button
              type="button"
              onClick={() => setReleaseChannel("FACTORY")}
              className={`channel-tab-btn ${releaseChannel === "FACTORY" ? "active-factory" : ""}`}
            >
              Xuất xưởng (4 file)
            </button>
          </div>
        </div>

        <div className="fw-table-container">
          <table className="fw-table">
            <thead>
              <tr>
                <th>PHIÊN BẢN</th>
                <th>LOẠI THIẾT BỊ</th>
                <th>GHI CHÚ PHÁT HÀNH (CHANGELOG)</th>
                <th>TRẠNG THÁI</th>
                <th>NGÀY PHÁT HÀNH</th>
                <th className="text-right">THAO TÁC</th>
              </tr>
            </thead>
            <tbody>
              {loading && releases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    <RefreshCw size={20} className="spin empty-icon" />
                    <span>Đang tải danh sách firmware...</span>
                  </td>
                </tr>
              ) : visibleReleases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    <FileArchive size={28} className="empty-icon-gray" />
                    <span>
                      {releaseChannel === "OTA"
                        ? "Chưa có bản firmware OTA nào."
                        : "Chưa có gói firmware xuất xưởng nào."}
                    </span>
                  </td>
                </tr>
              ) : (
                visibleReleases.map((release) => {
                  const expanded = expandedId === release.id;
                  const busy = busyId === release.id;
                  const isGateway = release.deviceType === "GATEWAY";
                  const status = releaseChannel === "OTA" ? release.otaStatus : release.flashStatus;
                  const canFlash = releaseChannel === "FACTORY" && release.flashStatus === "ACTIVE";

                  return (
                    <React.Fragment key={release.id}>
                      <tr className="fw-row">
                        <td className="version-cell">
                          <div className="version-content">
                            <button
                              type="button"
                              onClick={() => setExpandedId(expanded ? null : release.id)}
                              className="expand-toggle-btn"
                              title="Xem chi tiết phân vùng"
                            >
                              <ChevronDown
                                size={14}
                                className={`chevron-icon ${expanded ? "expanded" : ""}`}
                              />
                            </button>
                            <span className="version-tag">v{release.version}</span>
                            {releaseChannel === "FACTORY" ? (
                              <span className="pill-badge factory" title="Gói xuất xưởng">
                                <Cpu size={11} /> Factory
                              </span>
                            ) : (
                              <span className="pill-badge ota" title="OTA Update">
                                OTA
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className="device-type-badge">
                            {isGateway ? "Gateway" : "Node cảm biến"}
                          </span>
                        </td>
                        <td className="changelog-cell" title={release.changelog || ""}>
                          {release.changelog || "—"}
                        </td>
                        <td>
                          <span className={statusBadgeClass(status)}>
                            {otaStatusLabel(status)}
                          </span>
                        </td>
                        <td className="date-cell">
                          {dateLabel(release.createdAt || release.updatedAt)}
                        </td>
                        <td className="actions-cell">
                          <div className="actions-cluster">
                            {/* Nút Nạp USB */}
                            {canFlash && (
                              <button
                                type="button"
                                onClick={() => onNavigateFlasher(release.deviceType)}
                                className="action-btn flash-usb"
                                title="Nạp trực tiếp qua cổng USB"
                              >
                                <MonitorDown size={13} />
                                <span>Nạp USB</span>
                              </button>
                            )}

                            {/* Nút Tải về */}
                            <button
                              type="button"
                              onClick={() => void handleDownload(release)}
                              disabled={downloadingKey === `${release.id}-default`}
                              className="action-btn light"
                              title="Tải file firmware về máy"
                            >
                              {downloadingKey === `${release.id}-default` ? (
                                <Loader2 size={13} className="spin" />
                              ) : (
                                <Download size={13} />
                              )}
                              <span>Tải về</span>
                            </button>

                            {/* Nút Đổi trạng thái (Tạm dừng / Kích hoạt) */}
                            {status !== "REVOKED" && (
                              <button
                                type="button"
                                onClick={() =>
                                  void handleChangeStatus(
                                    release,
                                    releaseChannel,
                                    status === "ACTIVE" ? "PAUSED" : "ACTIVE"
                                  )
                                }
                                disabled={busy}
                                className={`action-btn ${status === "ACTIVE" ? "btn-pause" : "btn-activate"}`}
                                title={status === "ACTIVE" ? "Tạm dừng phát hành" : "Kích hoạt phát hành"}
                              >
                                {busy ? (
                                  <Loader2 size={12} className="spin" />
                                ) : status === "ACTIVE" ? (
                                  <Pause size={12} />
                                ) : (
                                  <Play size={12} />
                                )}
                                <span>{status === "ACTIVE" ? "Tạm dừng" : "Kích hoạt"}</span>
                              </button>
                            )}

                            {/* Nút Xóa */}
                            <button
                              type="button"
                              onClick={() => void handleDelete(release)}
                              disabled={busy}
                              className="action-btn delete"
                              title="Xóa bản phát hành này"
                            >
                              {busy ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Chi tiết phân vùng mở rộng */}
                      {expanded && (
                        <tr className="fw-detail-row">
                          <td colSpan={6} className="detail-container">
                            <div className="detail-inner">
                              <div className="detail-meta-grid">
                                <div>
                                  <span className="meta-label">File chính:</span>
                                  <p className="meta-val">{release.artifactFileName || "firmware.bin"}</p>
                                </div>
                                <div>
                                  <span className="meta-label">Chip mục tiêu:</span>
                                  <p className="meta-val">{release.firmwareTarget || "ESP32-S3"}</p>
                                </div>
                                <div>
                                  <span className="meta-label">Mã SHA-256:</span>
                                  <p className="meta-val truncate" title={release.artifactSha256 || ""}>
                                    {release.artifactSha256 ? `${release.artifactSha256.slice(0, 24)}...` : "—"}
                                  </p>
                                </div>
                              </div>

                              {release.images && release.images.length > 0 && (
                                <div className="detail-partitions">
                                  <span className="partitions-header">
                                    Danh sách {release.images.length} file nhị phân trong bản phát hành:
                                  </span>
                                  <div className="partitions-grid">
                                    {release.images.map((img) => (
                                      <div key={img.id} className="partition-card">
                                        <div className="partition-info">
                                          <b className="partition-role">{roleLabel(img.role)}</b>
                                          <p className="partition-sub">
                                            {img.fileName || img.name} · {sizeLabel(img.sizeBytes)}
                                          </p>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            void handleDownload(release, img.id, img.fileName || img.name)
                                          }
                                          disabled={downloadingKey === `${release.id}-${img.id}`}
                                          className="partition-download-btn"
                                          title={`Tải ${img.fileName || img.name}`}
                                        >
                                          {downloadingKey === `${release.id}-${img.id}` ? (
                                            <Loader2 size={12} className="spin" />
                                          ) : (
                                            <Download size={12} />
                                          )}
                                          <span>Tải về</span>
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function renderSignalBars(rssi?: number | null) {
  if (rssi === null || rssi === undefined) {
    return <span style={{ color: "#94a3b8", fontSize: "11px" }}>--</span>;
  }
  const bars = rssi > -65 ? 4 : rssi > -75 ? 3 : rssi > -85 ? 2 : 1;
  return (
    <div className="signal-bars" title={`Cường độ tín hiệu RSSI: ${rssi} dBm`}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`signal-bar ${i <= bars ? "filled" : ""}`}
          style={{ height: `${i * 3}px` }}
        />
      ))}
    </div>
  );
}

function formatNodeTimestamp(value?: string | null) {
  if (!value) return "Chưa ghi nhận";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function DeviceQrModal({ node, onClose }: { node: DesktopNode; onClose: () => void }) {
  const [qr, setQr] = useState<DesktopDeviceQr | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setQr(null);
    void getDesktopNodeQr(node.id).then(response => {
      if (!active) return;
      if (response && response.deviceId !== node.id) throw new Error("QR trả về không khớp thiết bị đã chọn.");
      setQr(response);
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : "Không tải được QR thiết bị."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [node.id, attempt]);
  const revoked = qr?.state === "REVOKED" || qr?.state === "QUARANTINED";
  return <div className="device-detail-overlay" onClick={onClose}>
    <div className="device-detail-modal" role="dialog" aria-modal="true" aria-label={`QR thiết bị ${node.id}`} onClick={event => event.stopPropagation()}>
      <div className="device-detail-head">
        <div><h3>QR thiết bị</h3><p>{node.id}</p></div>
        <button type="button" className="node-action-btn" aria-label="Đóng QR" onClick={onClose}><X size={18} /></button>
      </div>
      <div style={{ padding: 24 }}>
        {loading ? <p role="status">Đang tải QR đã lưu…</p> : error ? <div role="alert"><p>{error}</p><button className="button light" onClick={() => setAttempt(value => value + 1)}>Thử lại</button></div>
          : revoked ? <p role="alert">QR đã bị thu hồi hoặc thiết bị đang bị cách ly; mã này không thể dùng để ghép nối.</p>
          : !qr?.payload ? <p>Thiết bị chưa có QR v3 đã phát hành.</p>
          : <FactoryQrPreview result={{ jobId: "", status: "", logs: [], deviceId: qr.deviceId, qrId: qr.qrId, qrPayload: qr.payload, newIdentity: false }} identityState={node.is_activated ? "Đã kích hoạt" : "Chưa kích hoạt"} />}
      </div>
    </div>
  </div>;
}

function DeviceDetailModal({
  node,
  onClose,
  onNavigateFlasher,
}: {
  node: DesktopNode | null;
  onClose: () => void;
  onNavigateFlasher: (devType: string) => void;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!node) return null;

  const isGw = node.type === "GATEWAY";
  const tel = node.latest_telemetry;
  const ownerName = node.owner?.name?.trim() || node.owner?.email || "Chưa gán";
  const hasCoordinates = node.latitude != null && node.longitude != null;
  const deploymentName = !node.is_activated
    ? "Kho xuất xưởng (chưa vào mạng)"
    : isGw
    ? "Gateway trung tâm"
    : node.gateway
    ? node.gateway.name || node.gateway.id
    : "Kết nối trực tiếp qua WiFi";

  const handleCopy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1800);
  };

  return (
    <div className="device-detail-overlay" onClick={onClose}>
      <div className="device-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="device-detail-head">
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div className={`node-type-icon ${isGw ? "gateway" : "sensor"}`}>
              {isGw ? <Radio size={18} /> : <Cpu size={18} />}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
                  {node.name || node.id}
                </h3>
                <span className={`node-type-tag ${isGw ? "gateway" : "sensor"}`}>
                  {isGw ? "GATEWAY" : "CẢM BIẾN"}
                </span>
              </div>
              <p style={{ margin: "4px 0 0" }}>
                {node.is_activated ? (
                  <span className={`node-status-badge ${node.online ? "online" : "offline"}`}>
                    <span className={`node-status-dot ${node.online ? "online" : "offline"}`} />
                    {node.online ? "Trực tuyến" : "Ngoại tuyến"}
                  </span>
                ) : (
                  <span className="node-status-badge inventory">
                    <span className="node-status-dot inventory" />
                    Kho xuất xưởng
                  </span>
                )}
              </p>
            </div>
          </div>
          <button className="device-detail-close" onClick={onClose} title="Đóng">
            <X size={18} />
          </button>
        </div>

        {/* Copy ID & Serial Bar */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", margin: "14px 0 16px" }}>
          <button
            type="button"
            className="node-serial-copy"
            onClick={() => handleCopy(node.id, "id")}
            title="Sao chép Device ID"
          >
            <span>ID: {node.id}</span>
            {copiedKey === "id" ? <Check size={12} color="#059669" /> : <Copy size={12} />}
          </button>
          {node.serial_number && (
            <button
              type="button"
              className="node-serial-copy"
              onClick={() => handleCopy(node.serial_number!, "sn")}
              title="Sao chép số Serial"
            >
              <span>SN: {node.serial_number}</span>
              {copiedKey === "sn" ? <Check size={12} color="#059669" /> : <Copy size={12} />}
            </button>
          )}
        </div>

        {/* 4-item Summary Grid */}
        <div className="node-grid-meta" style={{ marginBottom: "16px" }}>
          <div>
            <dt>Liên kết mạng</dt>
            <dd style={{ fontSize: "11px" }}>{deploymentName}</dd>
          </div>
          <div>
            <dt>Tín hiệu (RSSI)</dt>
            <dd>{node.rssi != null ? `${node.rssi} dBm` : "Chưa ghi nhận"}</dd>
          </div>
          <div>
            <dt>Firmware</dt>
            <dd>{node.firmware_version || "Không xác định"}</dd>
          </div>
          <div>
            <dt>Cập nhật lần cuối</dt>
            <dd style={{ fontSize: "11px" }}>{formatNodeTimestamp(tel?.timestamp || node.last_seen)}</dd>
          </div>
        </div>

        {/* Dữ liệu đo đạc */}
        <h4
          style={{
            margin: "16px 0 8px",
            fontSize: "12px",
            color: "#64748b",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Dữ liệu đo đạc mới nhất
        </h4>
        {tel ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
              gap: "10px",
              marginBottom: "16px",
            }}
          >
            <div
              style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "10px",
                padding: "10px 12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "5px",
                  color: "#3b82f6",
                  fontSize: "11px",
                  fontWeight: 600,
                }}
              >
                <Droplets size={14} /> Độ ẩm đất
              </div>
              <div
                style={{
                  fontSize: "18px",
                  fontWeight: 750,
                  color: "#0f172a",
                  marginTop: "4px",
                }}
              >
                {tel.soil_moisture ?? "--"}%
              </div>
            </div>
            {tel.air_temp != null && (
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "10px 12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    color: "#f59e0b",
                    fontSize: "11px",
                    fontWeight: 600,
                  }}
                >
                  <Thermometer size={14} /> Nhiệt độ KK
                </div>
                <div
                  style={{
                    fontSize: "18px",
                    fontWeight: 750,
                    color: "#0f172a",
                    marginTop: "4px",
                  }}
                >
                  {tel.air_temp}°C
                </div>
              </div>
            )}
            {tel.air_humidity != null && (
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "10px 12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    color: "#06b6d4",
                    fontSize: "11px",
                    fontWeight: 600,
                  }}
                >
                  <Droplets size={14} /> Độ ẩm KK
                </div>
                <div
                  style={{
                    fontSize: "18px",
                    fontWeight: 750,
                    color: "#0f172a",
                    marginTop: "4px",
                  }}
                >
                  {tel.air_humidity}%
                </div>
              </div>
            )}
            {tel.soil_temp != null && (
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "10px 12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    color: "#f59e0b",
                    fontSize: "11px",
                    fontWeight: 600,
                  }}
                >
                  <Thermometer size={14} /> Nhiệt độ đất
                </div>
                <div
                  style={{
                    fontSize: "18px",
                    fontWeight: 750,
                    color: "#0f172a",
                    marginTop: "4px",
                  }}
                >
                  {tel.soil_temp}°C
                </div>
              </div>
            )}
            {tel.lux != null && (
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "10px 12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    color: "#eab308",
                    fontSize: "11px",
                    fontWeight: 600,
                  }}
                >
                  <Sun size={14} /> Ánh sáng
                </div>
                <div
                  style={{
                    fontSize: "18px",
                    fontWeight: 750,
                    color: "#0f172a",
                    marginTop: "4px",
                  }}
                >
                  {tel.lux} Lux
                </div>
              </div>
            )}
            {tel.battery_level != null && (
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "10px 12px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    color: "#10b981",
                    fontSize: "11px",
                    fontWeight: 600,
                  }}
                >
                  <Battery size={14} /> Pin
                </div>
                <div
                  style={{
                    fontSize: "18px",
                    fontWeight: 750,
                    color: "#0f172a",
                    marginTop: "4px",
                  }}
                >
                  {tel.battery_level}%
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #e2e8f0",
              borderRadius: "8px",
              padding: "12px",
              textAlign: "center",
              color: "#94a3b8",
              fontSize: "12px",
              marginBottom: "16px",
            }}
          >
            {isGw
              ? "Gateway trung tâm quản lý mạng kết nối, không đo cảm biến đất trực tiếp."
              : "Chưa có bản tin dữ liệu đo đạc nào từ thiết bị này."}
          </div>
        )}

        {/* Thông tin Nông trại & Phân bổ */}
        <h4
          style={{
            margin: "16px 0 8px",
            fontSize: "12px",
            color: "#64748b",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Thông tin nông trại & Vị trí
        </h4>
        <dl className="device-detail-dl">
          <dt>Chủ sở hữu</dt>
          <dd>{ownerName}</dd>
          <dt>Nông trại</dt>
          <dd>{node.farm?.name || "Chưa gán vào nông trại"}</dd>
          <dt>Phân khu</dt>
          <dd>{node.zone?.name || "Chưa gán phân khu"}</dd>
          {node.zone?.crop_type && (
            <>
              <dt>Cây trồng</dt>
              <dd>{node.zone.crop_type}</dd>
            </>
          )}
          <dt>Tọa độ GPS</dt>
          <dd>
            {hasCoordinates ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <MapPin size={13} color="#059669" />
                {node.latitude!.toFixed(6)}, {node.longitude!.toFixed(6)}
              </span>
            ) : (
              <span style={{ color: "#94a3b8" }}>Chưa cấu hình tọa độ</span>
            )}
          </dd>
          <dt>Chế độ triển khai</dt>
          <dd>{node.deployment_mode || "Mặc định (LoRa P2P)"}</dd>
          {node.gateway_id && (
            <>
              <dt>Gateway điều phối</dt>
              <dd>{node.gateway?.name || node.gateway_id}</dd>
            </>
          )}
        </dl>

        <div className="device-detail-actions">
          <button
            type="button"
            className="fw-action-btn"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#ecfdf5",
              color: "#047857",
              border: "1px solid #a7f3d0",
              padding: "8px 14px",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "12px",
              cursor: "pointer",
            }}
            onClick={() => {
              onClose();
              onNavigateFlasher(node.type);
            }}
          >
            <HardDriveDownload size={15} />
            <span>Nạp firmware cho thiết bị</span>
          </button>
          <button
            type="button"
            className="fw-action-btn"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#f1f5f9",
              color: "#334155",
              border: "1px solid #cbd5e1",
              padding: "8px 14px",
              borderRadius: "8px",
              fontWeight: 600,
              fontSize: "12px",
              cursor: "pointer",
            }}
            onClick={onClose}
          >
            <X size={15} />
            <span>Đóng</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function NodesView({
  onNavigateFlasher,
  setNotice,
}: {
  onNavigateFlasher: (devType: string) => void;
  setNotice: (msg: string | null) => void;
}) {
  const [nodes, setNodes] = useState<DesktopNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCategory, setFilterCategory] = useState<
    "all" | "inventory" | "active" | "gateways" | "sensors" | "online" | "offline"
  >("all");
  const [selectedFarmFilter, setSelectedFarmFilter] = useState("all");
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  const [selectedNode, setSelectedNode] = useState<DesktopNode | null>(null);
  const [qrNode, setQrNode] = useState<DesktopNode | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyNodeId, setBusyNodeId] = useState<string | null>(null);

  const handleCopy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const loadNodes = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const res = await listDesktopNodes();
      const list = Array.isArray(res) ? res : (res as any)?.data || [];
      setNodes(list);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`Lỗi tải danh sách thiết bị: ${msg}`);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void loadNodes();
  }, []);

  const handleUnbind = async (node: DesktopNode) => {
    const isGw = node.type === "GATEWAY";
    const name = node.name || node.id;
    const ok = await confirm(
      isGw
        ? `Bạn có chắc muốn hủy liên kết Gateway "${name}"? Thiết bị sẽ bị xóa cấu hình nông trại và đưa về trạng thái kho xuất xưởng.`
        : `Bạn có chắc muốn hủy liên kết Node cảm biến "${name}"? Thiết bị sẽ được đưa về trạng thái kho xuất xưởng.`,
      { title: "Xác nhận hủy liên kết thiết bị", kind: "warning" }
    );
    if (!ok) return;

    setBusyNodeId(node.id);
    try {
      await unbindDesktopNode(node.id);
      setNotice(`Đã hủy liên kết thiết bị ${name} thành công.`);
      await loadNodes(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`Không thể hủy liên kết: ${msg}`);
    } finally {
      setBusyNodeId(null);
    }
  };

  const handleDelete = async (node: DesktopNode) => {
    const name = node.name || node.id;
    const ok = await confirm(
      `Bạn có chắc chắn muốn xóa vĩnh viễn thiết bị "${name}" khỏi hệ thống? Thao tác này KHÔNG THỂ hoàn tác!`,
      { title: "Xác nhận xóa vĩnh viễn", kind: "warning" }
    );
    if (!ok) return;

    setBusyNodeId(node.id);
    try {
      await deleteDesktopNode(node.id);
      setNotice(`Đã xóa thiết bị ${name} vĩnh viễn.`);
      setNodes((prev) => prev.filter((n) => n.id !== node.id));
      if (selectedNode?.id === node.id) setSelectedNode(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setNotice(`Không thể xóa thiết bị: ${msg}`);
    } finally {
      setBusyNodeId(null);
    }
  };

  const availableFarms = useMemo(() => {
    const farmMap = new Map<string, string>();
    nodes.forEach((n) => {
      if (n.farm) {
        farmMap.set(n.farm.id, n.farm.name);
      }
    });
    return Array.from(farmMap.entries()).map(([id, name]) => ({ id, name }));
  }, [nodes]);

  const stats = useMemo(() => {
    const gateways = nodes.filter((n) => n.type === "GATEWAY");
    const sensors = nodes.filter((n) => n.type !== "GATEWAY");
    const inventory = nodes.filter((n) => !n.is_activated);
    const active = nodes.filter((n) => n.is_activated !== false);
    const online = nodes.filter((n) => n.online);
    const offline = nodes.filter((n) => !n.online);
    const onlinePct = nodes.length > 0 ? Math.round((online.length / nodes.length) * 100) : 0;

    return {
      total: nodes.length,
      gateways: gateways.length,
      sensors: sensors.length,
      inventory: inventory.length,
      active: active.length,
      online: online.length,
      offline: offline.length,
      onlinePct,
    };
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();

    return nodes.filter((node) => {
      if (filterCategory === "inventory" && node.is_activated !== false) return false;
      if (filterCategory === "active" && !node.is_activated) return false;
      if (filterCategory === "gateways" && node.type !== "GATEWAY") return false;
      if (filterCategory === "sensors" && node.type === "GATEWAY") return false;
      if (filterCategory === "online" && !node.online) return false;
      if (filterCategory === "offline" && node.online) return false;

      if (selectedFarmFilter !== "all" && node.farm_id !== selectedFarmFilter) return false;

      if (q) {
        const matches =
          node.id.toLowerCase().includes(q) ||
          (node.name || "").toLowerCase().includes(q) ||
          (node.serial_number || "").toLowerCase().includes(q) ||
          (node.owner?.name || "").toLowerCase().includes(q) ||
          (node.owner?.email || "").toLowerCase().includes(q) ||
          (node.farm?.name || "").toLowerCase().includes(q) ||
          (node.zone?.name || "").toLowerCase().includes(q);
        if (!matches) return false;
      }

      return true;
    });
  }, [nodes, filterCategory, selectedFarmFilter, searchQuery]);

  return (
    <div className="nodes-view-container">
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 750, color: "#0f172a" }}>
              Tất cả thiết bị
            </h1>
            <span
              style={{
                fontSize: "11px",
                fontWeight: 650,
                background: "#eff6ff",
                color: "#1d4ed8",
                border: "1px solid #bfdbfe",
                padding: "2px 8px",
                borderRadius: "6px",
              }}
            >
              Master Registry
            </span>
          </div>
          <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#64748b" }}>
            Quản lý tập trung toàn bộ Gateway và Node cảm biến trong hệ sinh thái FarmOS.
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            type="button"
            className="fw-refresh-btn"
            onClick={() => void loadNodes(false)}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            <span>Làm mới</span>
          </button>
          <button
            type="button"
            className="node-action-btn flash-btn"
            style={{ width: "auto", padding: "0 12px", height: "34px", borderRadius: "8px", gap: "6px", fontWeight: 600, fontSize: "12px" }}
            onClick={() => onNavigateFlasher("NODE")}
          >
            <Cpu size={14} />
            <span>Nạp thiết bị</span>
          </button>
        </div>
      </div>

      {/* 3 KPI Summary Cards */}
      <div className="nodes-kpi-grid">
        <button
          type="button"
          className={`nodes-kpi-card ${filterCategory === "all" ? "active" : ""}`}
          onClick={() => setFilterCategory("all")}
        >
          <div className="nodes-kpi-icon-wrap slate">
            <Cpu size={20} />
          </div>
          <div>
            <div className="nodes-kpi-title">Tổng số thiết bị</div>
            <div className="nodes-kpi-value">{stats.total}</div>
            <div className="nodes-kpi-sub">
              {stats.gateways} Gateway · {stats.sensors} Cảm biến
            </div>
          </div>
        </button>

        <button
          type="button"
          className={`nodes-kpi-card ${filterCategory === "inventory" ? "active" : ""}`}
          onClick={() => setFilterCategory("inventory")}
        >
          <div className="nodes-kpi-icon-wrap amber">
            <Package size={20} />
          </div>
          <div>
            <div className="nodes-kpi-title">Kho xuất xưởng</div>
            <div className="nodes-kpi-value">{stats.inventory}</div>
            <div className="nodes-kpi-sub">Chưa bàn giao khách hàng</div>
          </div>
        </button>

        <button
          type="button"
          className={`nodes-kpi-card ${filterCategory === "online" ? "active" : ""}`}
          onClick={() => setFilterCategory("online")}
        >
          <div className="nodes-kpi-icon-wrap emerald">
            <Activity size={20} />
          </div>
          <div>
            <div className="nodes-kpi-title">Đang trực tuyến</div>
            <div className="nodes-kpi-value">
              {stats.online} <small style={{ fontSize: "12px", color: "#94a3b8", fontWeight: 500 }}>/ {stats.total}</small>
            </div>
            <div className="nodes-kpi-sub">
              {stats.offline} ngoại tuyến · {stats.onlinePct}% hoạt động
            </div>
          </div>
        </button>
      </div>

      {/* Toolbar: Search, Farm, Category Tabs & View Mode */}
      <div className="nodes-toolbar">
        <div className="nodes-toolbar-left">
          <div className="nodes-search-box">
            <Search size={14} className="nodes-search-icon" />
            <input
              type="text"
              className="nodes-search-input"
              placeholder="Tìm theo tên, ID, Serial, Farm, Owner..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="nodes-search-clear"
                onClick={() => setSearchQuery("")}
                title="Xóa tìm kiếm"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {availableFarms.length > 1 && (
            <select
              className="nodes-farm-select"
              value={selectedFarmFilter}
              onChange={(e) => setSelectedFarmFilter(e.target.value)}
            >
              <option value="all">Tất cả nông trại ({availableFarms.length})</option>
              {availableFarms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="nodes-toolbar-right">
          <div className="nodes-category-tabs">
            <button
              type="button"
              className={`nodes-tab-btn ${filterCategory === "all" ? "active" : ""}`}
              onClick={() => setFilterCategory("all")}
            >
              Tất cả ({stats.total})
            </button>
            <button
              type="button"
              className={`nodes-tab-btn ${filterCategory === "inventory" ? "active" : ""}`}
              onClick={() => setFilterCategory("inventory")}
            >
              Kho ({stats.inventory})
            </button>
            <button
              type="button"
              className={`nodes-tab-btn ${filterCategory === "active" ? "active" : ""}`}
              onClick={() => setFilterCategory("active")}
            >
              Đã gán ({stats.active})
            </button>
            <button
              type="button"
              className={`nodes-tab-btn ${filterCategory === "gateways" ? "active" : ""}`}
              onClick={() => setFilterCategory("gateways")}
            >
              Gateways ({stats.gateways})
            </button>
            <button
              type="button"
              className={`nodes-tab-btn ${filterCategory === "sensors" ? "active" : ""}`}
              onClick={() => setFilterCategory("sensors")}
            >
              Cảm biến ({stats.sensors})
            </button>
            <button
              type="button"
              className={`nodes-tab-btn ${filterCategory === "online" ? "active" : ""}`}
              onClick={() => setFilterCategory("online")}
            >
              Online ({stats.online})
            </button>
            <button
              type="button"
              className={`nodes-tab-btn ${filterCategory === "offline" ? "active" : ""}`}
              onClick={() => setFilterCategory("offline")}
            >
              Offline ({stats.offline})
            </button>
          </div>

          <div className="nodes-view-mode-group">
            <button
              type="button"
              className={`nodes-view-btn ${viewMode === "table" ? "active" : ""}`}
              onClick={() => setViewMode("table")}
              title="Dạng bảng chi tiết"
            >
              <List size={15} />
            </button>
            <button
              type="button"
              className={`nodes-view-btn ${viewMode === "grid" ? "active" : ""}`}
              onClick={() => setViewMode("grid")}
              title="Dạng lưới thẻ"
            >
              <LayoutGrid size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      {loading && nodes.length === 0 ? (
        <div className="nodes-empty-state">
          <RefreshCw size={26} className="spin" color="#059669" />
          <div className="nodes-empty-title" style={{ marginTop: "12px" }}>
            Đang tải danh sách thiết bị...
          </div>
          <p className="nodes-empty-desc">Hệ thống đang đồng bộ dữ liệu với máy chủ FarmOS.</p>
        </div>
      ) : filteredNodes.length === 0 ? (
        <div className="nodes-empty-state">
          <div className="nodes-empty-icon">
            <Cpu size={24} />
          </div>
          <div className="nodes-empty-title">Không tìm thấy thiết bị nào</div>
          <p className="nodes-empty-desc">
            {searchQuery || filterCategory !== "all" || selectedFarmFilter !== "all"
              ? "Không có thiết bị nào phù hợp với bộ lọc hiện tại."
              : "Hệ thống chưa ghi nhận thiết bị nào."}
          </p>
          {(searchQuery || filterCategory !== "all" || selectedFarmFilter !== "all") && (
            <button
              type="button"
              className="nodes-empty-btn"
              onClick={() => {
                setSearchQuery("");
                setFilterCategory("all");
                setSelectedFarmFilter("all");
              }}
            >
              Xóa tất cả bộ lọc
            </button>
          )}
        </div>
      ) : viewMode === "table" ? (
        /* TABLE VIEW */
        <div className="nodes-table-wrapper">
          <table className="nodes-table">
            <thead>
              <tr>
                <th style={{ width: "28%" }}>THIẾT BỊ</th>
                <th style={{ width: "22%" }}>VỊ TRÍ & NÔNG TRẠI</th>
                <th style={{ width: "16%" }}>TRẠNG THÁI</th>
                <th style={{ width: "18%" }}>DỮ LIỆU ĐO</th>
                <th style={{ width: "16%", textAlign: "right" }}>THAO TÁC</th>
              </tr>
            </thead>
            <tbody>
              {filteredNodes.map((node) => {
                const isGw = node.type === "GATEWAY";
                const tel = node.latest_telemetry;
                const isBusy = busyNodeId === node.id;

                return (
                  <tr
                    key={node.id}
                    onClick={() => setSelectedNode(node)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      <div className="node-title-cell">
                        <div className={`node-type-icon ${isGw ? "gateway" : "sensor"}`}>
                          {isGw ? <Radio size={17} /> : <Cpu size={17} />}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span className="node-name">{node.name || node.id}</span>
                            <span className={`node-type-tag ${isGw ? "gateway" : "sensor"}`}>
                              {isGw ? "GATEWAY" : "CẢM BIẾN"}
                            </span>
                          </div>
                          <div className="node-meta-row">
                            <button
                              type="button"
                              className="node-serial-copy"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCopy(node.id, `tbl-id-${node.id}`);
                              }}
                              title="Sao chép ID"
                            >
                              <span>{node.id}</span>
                              {copiedId === `tbl-id-${node.id}` ? (
                                <Check size={11} color="#059669" />
                              ) : (
                                <Copy size={11} />
                              )}
                            </button>
                            {node.serial_number && (
                              <button
                                type="button"
                                className="node-serial-copy"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopy(node.serial_number!, `tbl-sn-${node.id}`);
                                }}
                                title="Sao chép Serial"
                              >
                                <span>SN: {node.serial_number}</span>
                                {copiedId === `tbl-sn-${node.id}` ? (
                                  <Check size={11} color="#059669" />
                                ) : (
                                  <Copy size={11} />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td>
                      {!node.is_activated ? (
                        <span className="node-status-badge inventory">
                          <span className="node-status-dot inventory" />
                          Kho xuất xưởng
                        </span>
                      ) : (
                        <div className="node-farm-info">
                          <b>{node.farm?.name || "Nông trại chưa gán"}</b>
                          <small>
                            {node.zone
                              ? `${node.zone.name}${node.zone.crop_type ? ` · ${node.zone.crop_type}` : ""}`
                              : node.owner
                              ? node.owner.name || node.owner.email
                              : "Chưa gán phân khu"}
                          </small>
                        </div>
                      )}
                    </td>

                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          {node.is_activated ? (
                            <span className={`node-status-badge ${node.online ? "online" : "offline"}`}>
                              <span className={`node-status-dot ${node.online ? "online" : "offline"}`} />
                              {node.online ? "Trực tuyến" : "Ngoại tuyến"}
                            </span>
                          ) : (
                            <span className="node-status-badge inventory">
                              <span className="node-status-dot inventory" />
                              Chưa kích hoạt
                            </span>
                          )}
                          {node.is_activated && renderSignalBars(node.rssi)}
                        </div>
                        {node.firmware_version && (
                          <span style={{ fontSize: "10px", color: "#94a3b8", fontFamily: "monospace" }}>
                            v{node.firmware_version}
                          </span>
                        )}
                      </div>
                    </td>

                    <td>
                      {node.is_activated && tel ? (
                        <div className="node-telemetry-pill">
                          <div className="telemetry-chip" title="Độ ẩm đất">
                            <Droplets size={12} />
                            <span>{tel.soil_moisture}%</span>
                          </div>
                          {tel.air_temp != null && (
                            <div className="telemetry-chip" title="Nhiệt độ không khí">
                              <Thermometer size={12} />
                              <span>{tel.air_temp}°C</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                          {isGw ? "Gateway trung tâm" : "Chưa có dữ liệu"}
                        </span>
                      )}
                    </td>

                    <td style={{ textAlign: "right" }}>
                      <div className="node-actions-cell" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="node-action-btn"
                          onClick={() => setSelectedNode(node)}
                          title="Xem thông tin chi tiết"
                        >
                          <Eye size={14} />
                        </button>
                        <button type="button" className="node-action-btn" onClick={() => setQrNode(node)} title="Xem QR thiết bị" aria-label={`Xem QR của ${node.id}`}><QrCode size={14} /></button>
                        <button
                          type="button"
                          className="node-action-btn flash-btn"
                          onClick={() => onNavigateFlasher(node.type)}
                          title="Nạp firmware cho thiết bị này"
                        >
                          <HardDriveDownload size={14} />
                        </button>
                        <button
                          type="button"
                          className="node-action-btn"
                          disabled={isBusy}
                          onClick={() => void handleUnbind(node)}
                          title="Hủy gán / Đưa về kho xuất xưởng"
                        >
                          <Link2Off size={14} />
                        </button>
                        <button
                          type="button"
                          className="node-action-btn danger"
                          disabled={isBusy}
                          onClick={() => void handleDelete(node)}
                          title="Xóa vĩnh viễn thiết bị"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* GRID VIEW */
        <div className="nodes-grid-view">
          {filteredNodes.map((node) => {
            const isGw = node.type === "GATEWAY";
            const tel = node.latest_telemetry;
            const isBusy = busyNodeId === node.id;

            return (
              <div key={node.id} className="node-grid-card">
                <div>
                  <div className="node-grid-head">
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                      <div className={`node-type-icon ${isGw ? "gateway" : "sensor"}`}>
                        {isGw ? <Radio size={18} /> : <Cpu size={18} />}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: "13px", color: "#0f172a" }} className="truncate">
                          {node.name || node.id}
                        </div>
                        <div className="node-meta-row">
                          <button
                            type="button"
                            className="node-serial-copy"
                            onClick={() => handleCopy(node.id, `crd-id-${node.id}`)}
                            title="Sao chép ID"
                          >
                            <span>{node.id}</span>
                            {copiedId === `crd-id-${node.id}` ? (
                              <Check size={11} color="#059669" />
                            ) : (
                              <Copy size={11} />
                            )}
                          </button>
                          {node.serial_number && (
                            <button
                              type="button"
                              className="node-serial-copy"
                              onClick={() => handleCopy(node.serial_number!, `crd-sn-${node.id}`)}
                              title="Sao chép Serial"
                            >
                              <span>SN: {node.serial_number}</span>
                              {copiedId === `crd-sn-${node.id}` ? (
                                <Check size={11} color="#059669" />
                              ) : (
                                <Copy size={11} />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    <div>
                      {node.is_activated ? (
                        <span className={`node-status-badge ${node.online ? "online" : "offline"}`}>
                          <span className={`node-status-dot ${node.online ? "online" : "offline"}`} />
                          {node.online ? "Online" : "Offline"}
                        </span>
                      ) : (
                        <span className="node-status-badge inventory">
                          <span className="node-status-dot inventory" />
                          Kho
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Badges line */}
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", margin: "10px 0" }}>
                    <span className={`node-type-tag ${isGw ? "gateway" : "sensor"}`}>
                      {isGw ? "GATEWAY" : "CẢM BIẾN"}
                    </span>
                    {node.is_activated && node.farm && (
                      <span style={{ fontSize: "10px", fontWeight: 600, color: "#475569", background: "#f1f5f9", padding: "1px 6px", borderRadius: "4px" }}>
                        {node.farm.name}
                      </span>
                    )}
                    {node.is_activated && node.zone && (
                      <span style={{ fontSize: "10px", fontWeight: 600, color: "#047857", background: "#ecfdf5", padding: "1px 6px", borderRadius: "4px" }}>
                        {node.zone.name}
                      </span>
                    )}
                  </div>

                  {/* Telemetry Card */}
                  <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "10px 12px", marginBottom: "8px" }}>
                    {!node.is_activated ? (
                      <div style={{ fontSize: "11.5px", color: "#94a3b8", textAlign: "center", padding: "4px 0" }}>
                        Thiết bị trong kho, chưa kích hoạt
                      </div>
                    ) : tel ? (
                      <div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "11.5px", marginBottom: "4px" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: "4px", color: "#3b82f6", fontWeight: 600 }}>
                            <Droplets size={12} /> Độ ẩm đất
                          </span>
                          <b style={{ color: "#0f172a" }}>{tel.soil_moisture}%</b>
                        </div>
                        <div style={{ width: "100%", height: "4px", background: "#e2e8f0", borderRadius: "999px", overflow: "hidden", marginBottom: "8px" }}>
                          <div
                            style={{
                              width: `${Math.min(tel.soil_moisture ?? 0, 100)}%`,
                              height: "100%",
                              background: "#10b981",
                              borderRadius: "999px",
                            }}
                          />
                        </div>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "11px", color: "#64748b", borderTop: "1px solid #edf2f7", paddingTop: "6px" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                            <Thermometer size={12} color="#f59e0b" />
                            {tel.air_temp != null ? `${tel.air_temp}°C` : "--"}
                          </span>
                          <span>{renderSignalBars(node.rssi)}</span>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: "11.5px", color: "#94a3b8", textAlign: "center", padding: "4px 0" }}>
                        {isGw ? "Gateway điều phối mạng trung tâm" : "Chưa có dữ liệu cảm biến gần đây"}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer Actions */}
                <div className="node-grid-footer">
                  <div style={{ fontSize: "11px", color: "#64748b", display: "flex", alignItems: "center", gap: "4px" }}>
                    <MapPin size={12} color="#94a3b8" />
                    <span>
                      {node.latitude != null && node.longitude != null
                        ? `${node.latitude.toFixed(3)}, ${node.longitude.toFixed(3)}`
                        : "Chưa định vị GPS"}
                    </span>
                  </div>

                  <div className="node-actions-cell">
                    <button
                      type="button"
                      className="node-action-btn"
                      onClick={() => setSelectedNode(node)}
                      title="Xem chi tiết"
                    >
                      <Eye size={13} />
                    </button>
                        <button type="button" className="node-action-btn" onClick={() => setQrNode(node)} title="Xem QR thiết bị" aria-label={`Xem QR của ${node.id}`}><QrCode size={14} /></button>
                    <button
                      type="button"
                      className="node-action-btn flash-btn"
                      onClick={() => onNavigateFlasher(node.type)}
                      title="Nạp firmware"
                    >
                      <HardDriveDownload size={13} />
                    </button>
                    <button
                      type="button"
                      className="node-action-btn"
                      disabled={isBusy}
                      onClick={() => void handleUnbind(node)}
                      title="Hủy gán"
                    >
                      <Link2Off size={13} />
                    </button>
                    <button
                      type="button"
                      className="node-action-btn danger"
                      disabled={isBusy}
                      onClick={() => void handleDelete(node)}
                      title="Xóa vĩnh viễn"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {qrNode && <DeviceQrModal key={qrNode.id} node={qrNode} onClose={() => setQrNode(null)} />}

      {/* Detail Modal */}
      <DeviceDetailModal
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
        onNavigateFlasher={onNavigateFlasher}
      />
    </div>
  );
}
