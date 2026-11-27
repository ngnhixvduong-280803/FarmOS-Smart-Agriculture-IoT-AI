import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check,
  ChevronDown,
  Cpu,
  Download,
  FileCode2,
  Layers,
  Loader2,
  MonitorDown,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";
import {
  downloadFirmwareArtifact,
  deleteFirmwareRelease,
  fetchFirmwareReleases,
  updateFirmwareRelease,
  uploadFirmwareRelease,
  type FirmwareDeviceType,
  type FirmwareReleaseChannel,
  type FirmwareRelease,
  type FirmwareReleaseStatus,
} from "../services/firmware.service";
import { useI18n } from "../context/I18nContext";

type Notice = { kind: "success" | "error"; text: string } | null;

function sizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function statusClass(status: FirmwareReleaseStatus) {
  if (status === "ACTIVE") return "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800";
  if (status === "PAUSED") return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800";
  if (status === "REVOKED") return "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800";
  return "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700";
}

export interface FirmwarePageProps {
  isActive?: boolean;
}

export const FirmwarePage: React.FC<FirmwarePageProps> = ({ isActive = true }) => {
  const { t, language } = useI18n();
  const [releases, setReleases] = useState<FirmwareRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const roleLabel = (role: string): string => {
    switch (role) {
      case "BOOTLOADER": return t.firmwarePage.slotBootloader;
      case "PARTITION_TABLE": return t.firmwarePage.slotPartitionTable;
      case "OTA_DATA": return t.firmwarePage.slotOtaData;
      case "APP": return t.firmwarePage.slotApp;
      default: return role;
    }
  };

  const otaStatusLabel = (status: FirmwareReleaseStatus) => {
    return status === "ACTIVE"
      ? t.firmwarePage.statusActive
      : status === "PAUSED"
      ? t.firmwarePage.statusPaused
      : status === "REVOKED"
      ? t.firmwarePage.statusRevoked
      : t.firmwarePage.statusDraft;
  };

  const dateLabel = (value: string) => {
    return new Intl.DateTimeFormat(language === "en" ? "en-US" : "vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  };
  const [notice, setNotice] = useState<Notice>(null);
  const [deviceType, setDeviceType] = useState<FirmwareDeviceType | "">("");
  const [changelog, setChangelog] = useState("");
  const [uploadMode, setUploadMode] = useState<"ota" | "factory">("factory");
  const [releaseChannel, setReleaseChannel] = useState<FirmwareReleaseChannel>("OTA");

  // File states
  const [appFile, setAppFile] = useState<File | null>(null);
  const [bootloaderFile, setBootloaderFile] = useState<File | null>(null);
  const [partitionsFile, setPartitionsFile] = useState<File | null>(null);
  const [otaDataFile, setOtaDataFile] = useState<File | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);

  const uploadAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const batchInputRef = useRef<HTMLInputElement>(null);
  const bootloaderInputRef = useRef<HTMLInputElement>(null);
  const partitionsInputRef = useRef<HTMLInputElement>(null);
  const otaDataInputRef = useRef<HTMLInputElement>(null);

  const loadReleases = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const next = await fetchFirmwareReleases();
      setReleases(next);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : t.firmwarePage.loadFailed });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadReleases();
  }, [loadReleases]);

  useEffect(() => {
    if (isActive) void loadReleases(true);
  }, [isActive, loadReleases]);

  const resetUploadForm = () => {
    setDeviceType("");
    setChangelog("");
    setAppFile(null);
    setBootloaderFile(null);
    setPartitionsFile(null);
    setOtaDataFile(null);
    setProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (batchInputRef.current) batchInputRef.current.value = "";
    if (bootloaderInputRef.current) bootloaderInputRef.current.value = "";
    if (partitionsInputRef.current) partitionsInputRef.current.value = "";
    if (otaDataInputRef.current) otaDataInputRef.current.value = "";
  };

  const classifyAndAssignFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((f) => f.name.endsWith(".bin"));
    if (files.length === 0) {
      setNotice({ kind: "error", text: t.firmwarePage.onlyBinError });
      return;
    }

    if (uploadMode === "ota" || files.length === 1) {
      setAppFile(files[0]);
      return;
    }

    // Chế độ Factory: phân loại thông minh theo tên file
    let foundBoot = false;
    let foundPart = false;
    let foundOta = false;
    let foundApp = false;
    const remaining: File[] = [];

    for (const f of files) {
      const lower = f.name.toLowerCase();
      if (!foundBoot && (lower.includes("bootloader") || lower.includes("boot.bin"))) {
        setBootloaderFile(f);
        foundBoot = true;
      } else if (!foundPart && (lower.includes("partition") || lower.includes("partitions"))) {
        setPartitionsFile(f);
        foundPart = true;
      } else if (!foundOta && (lower.includes("ota_data") || lower.includes("ota-data") || lower.includes("ota_initial"))) {
        setOtaDataFile(f);
        foundOta = true;
      } else {
        remaining.push(f);
      }
    }

    for (const f of remaining) {
      const lower = f.name.toLowerCase();
      if (!foundApp && (lower.includes("firmware") || lower.includes("app") || lower.includes("gateway") || lower.includes("node"))) {
        setAppFile(f);
        foundApp = true;
      } else if (!foundApp) {
        setAppFile(f);
        foundApp = true;
      } else if (!foundBoot) {
        setBootloaderFile(f);
        foundBoot = true;
      } else if (!foundPart) {
        setPartitionsFile(f);
        foundPart = true;
      } else if (!foundOta) {
        setOtaDataFile(f);
        foundOta = true;
      }
    }

    setNotice({
      kind: "success",
      text: t.firmwarePage.classifiedFilesNotice.replace("{{count}}", String(files.length)),
    });
  };

  const submitUpload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!appFile) {
      setNotice({ kind: "error", text: t.firmwarePage.missingAppError });
      return;
    }
    if (uploadMode === "factory" && (!bootloaderFile || !partitionsFile || !otaDataFile)) {
      setNotice({
        kind: "error",
        text: t.firmwarePage.missingFactoryError,
      });
      return;
    }
    setNotice(null);
    setUploading(true);
    setProgress(0);
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    try {
      const result = await uploadFirmwareRelease({
        deviceType: deviceType || undefined,
        app: appFile,
        bootloader: uploadMode === "factory" ? bootloaderFile || undefined : undefined,
        partitionTable: uploadMode === "factory" ? partitionsFile || undefined : undefined,
        otaData: uploadMode === "factory" ? otaDataFile || undefined : undefined,
        changelog: changelog.trim() || undefined,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setNotice({
        kind: "success",
        text: result.factoryReady
          ? t.firmwarePage.uploadSuccessFactory.replace("{{version}}", result.release.version)
          : t.firmwarePage.uploadSuccessOta.replace("{{version}}", result.release.version),
      });
      resetUploadForm();
      await loadReleases(true);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : t.firmwarePage.uploadFailed });
    } finally {
      uploadAbortRef.current = null;
      setUploading(false);
    }
  };

  const channelStatus = (release: FirmwareRelease, channel: FirmwareReleaseChannel) => channel === "OTA" ? release.otaStatus : release.flashStatus;

  const changeStatus = async (release: FirmwareRelease, channel: FirmwareReleaseChannel, status: FirmwareReleaseStatus) => {
    setBusyId(release.id);
    setNotice(null);
    try {
      const next = await updateFirmwareRelease(release.id, { channel, status, rolloutPercent: 100 });
      setReleases((current) => current.map((item) => (item.id === release.id ? next : item)));
      setNotice({ kind: "success", text: t.firmwarePage.statusUpdated.replace("{{version}}", release.version).replace("{{status}}", otaStatusLabel(channelStatus(next, channel))) });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : t.firmwarePage.statusUpdateFailed });
    } finally {
      setBusyId(null);
    }
  };

  const deleteRelease = async (release: FirmwareRelease) => {
    if (!window.confirm(t.firmwarePage.confirmDelete.replace("{{version}}", release.version))) return;
    setBusyId(release.id);
    setNotice(null);
    try {
      await deleteFirmwareRelease(release.id);
      setReleases((current) => current.filter((item) => item.id !== release.id));
      if (expandedId === release.id) setExpandedId(null);
      setNotice({ kind: "success", text: t.firmwarePage.deleteSuccess.replace("{{version}}", release.version) });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : t.firmwarePage.deleteFailed });
    } finally {
      setBusyId(null);
    }
  };

  const handleDownload = async (release: FirmwareRelease, imageId?: string, fileName?: string) => {
    const key = `${release.id}-${imageId || "default"}`;
    setDownloadingKey(key);
    try {
      await downloadFirmwareArtifact(release.id, imageId, fileName);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : t.firmwarePage.downloadFailed });
    } finally {
      setDownloadingKey(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      classifyAndAssignFiles(e.dataTransfer.files);
    }
  };

  const otaReleases = useMemo(() => releases.filter((release) => !release.factoryReady), [releases]);
  const factoryReleases = useMemo(() => releases.filter((release) => release.factoryReady), [releases]);
  const visibleReleases = releaseChannel === "OTA" ? otaReleases : factoryReleases;
  const activeCount = useMemo(() => otaReleases.filter((r) => r.otaStatus === "ACTIVE").length, [otaReleases]);
  const factoryCount = useMemo(() => factoryReleases.filter((r) => r.flashStatus === "ACTIVE").length, [factoryReleases]);

  return (
    <div className="space-y-6 pb-12 font-sans">
      {/* Header */}
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 dark:border-slate-800 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">{t.firmwarePage.title}</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t.firmwarePage.intro}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>{t.firmwarePage.activeCount}</span>
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">{activeCount} {t.firmwarePage.activeCountUnit}</span>
            <span className="text-slate-300 dark:text-slate-700">|</span>
            <span>{t.firmwarePage.factoryCount}</span>
            <span className="font-semibold text-indigo-600 dark:text-indigo-400">{factoryCount} {t.firmwarePage.factoryCountUnit}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadReleases()}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-xs hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 transition"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t.firmwarePage.refresh}
          </button>
        </div>
      </div>

      {/* Thông báo thông tin */}
      {notice && (
        <div
          className={`flex items-center justify-between rounded-xl border p-3.5 text-xs ${
            notice.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"
              : "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
          }`}
        >
          <div className="flex items-center gap-2">
            {notice.kind === "success" ? <Check className="h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="h-4 w-4 shrink-0 text-rose-600" />}
            <span>{notice.text}</span>
          </div>
          <button type="button" onClick={() => setNotice(null)} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Khu vực Upload */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-0.5">{t.firmwarePage.uploadTitle}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {uploadMode === "ota"
                ? t.firmwarePage.otaDesc
                : t.firmwarePage.factoryDesc}
            </p>
          </div>

          {/* Toggle Chế độ nạp */}
          <div className="flex items-center rounded-xl bg-slate-100 p-1 dark:bg-slate-800 shrink-0 self-start sm:self-auto">
            <button
              type="button"
              onClick={() => {
                setUploadMode("ota");
                setBootloaderFile(null);
                setPartitionsFile(null);
                setOtaDataFile(null);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                uploadMode === "ota"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-white"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <Radio className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{t.firmwarePage.modeOta}</span>
            </button>
            <button
              type="button"
              onClick={() => setUploadMode("factory")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                uploadMode === "factory"
                  ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-white"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
              }`}
            >
              <Cpu className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
              <span>{t.firmwarePage.modeFactory}</span>
            </button>
          </div>
        </div>

        <form onSubmit={submitUpload} className="space-y-4">
          {uploadMode === "ota" ? (
            /* Dropzone 1 File cho OTA */
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition ${
                isDragging
                  ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20"
                  : appFile
                  ? "border-emerald-400 bg-emerald-50/20 dark:border-emerald-700 dark:bg-emerald-950/10"
                  : "border-slate-300 hover:border-slate-400 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-950/40 hover:bg-slate-50"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".bin,application/octet-stream"
                className="sr-only"
                onChange={(e) => {
                  if (e.target.files?.[0]) classifyAndAssignFiles(e.target.files);
                }}
              />
              {appFile ? (
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                    <FileCode2 className="h-5 w-5" />
                  </div>
                  <div className="text-left">
                    <p className="font-mono text-xs font-semibold text-slate-900 dark:text-white truncate max-w-sm">
                      {appFile.name}
                    </p>
                    <p className="text-[11px] text-slate-500">{sizeLabel(appFile.size)} · {t.firmwarePage.clickToChange}</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 mb-2">
                    <UploadCloud className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    {t.firmwarePage.dropOtaPrompt}<span className="text-emerald-600 dark:text-emerald-400 underline">{t.firmwarePage.chooseFromPc}</span>
                  </p>
                  <p className="text-[11px] text-slate-400 mt-1">{t.firmwarePage.otaAppHint}</p>
                </>
              )}
            </div>
          ) : (
            /* Chế độ Gói xuất xưởng Factory (4 file) */
            <div className="space-y-3">
              {/* Batch Dropzone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => batchInputRef.current?.click()}
                className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 text-center cursor-pointer transition ${
                  isDragging
                    ? "border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20"
                    : "border-indigo-200 hover:border-indigo-400 bg-indigo-50/30 dark:border-indigo-900/50 dark:bg-indigo-950/10"
                }`}
              >
                <input
                  ref={batchInputRef}
                  type="file"
                  multiple
                  accept=".bin,application/octet-stream"
                  className="sr-only"
                  onChange={(e) => {
                    if (e.target.files) classifyAndAssignFiles(e.target.files);
                  }}
                />
                <div className="flex items-center gap-2 text-indigo-700 dark:text-indigo-400 mb-1">
                  <Sparkles className="h-4 w-4" />
                  <span className="text-xs font-bold">{t.firmwarePage.dropFactoryPrompt}</span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t.firmwarePage.autoDetectHint}
                </p>
              </div>

              {/* 4 File Slots */}
              <div className="grid gap-3 sm:grid-cols-2">
                {/* 1. App File */}
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className={`flex items-center justify-between rounded-xl border p-3 cursor-pointer transition ${
                    appFile
                      ? "border-emerald-300 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/20"
                      : "border-slate-200 bg-slate-50/60 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40"
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".bin"
                    className="sr-only"
                    onChange={(e) => setAppFile(e.target.files?.[0] || null)}
                  />
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${appFile ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" : "bg-slate-200 text-slate-500 dark:bg-slate-800"}`}>
                      <FileCode2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-900 dark:text-white">{t.firmwarePage.appSlotTitle}</span>
                        <span className="text-[10px] text-rose-500 font-bold">*</span>
                      </div>
                      <p className="font-mono text-[11px] text-slate-500 truncate">
                        {appFile ? `${appFile.name} (${sizeLabel(appFile.size)})` : t.firmwarePage.selectApp}
                      </p>
                    </div>
                  </div>
                  {appFile && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setAppFile(null); }}
                      className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-slate-200 dark:hover:bg-slate-800"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* 2. Bootloader File */}
                <div
                  onClick={() => bootloaderInputRef.current?.click()}
                  className={`flex items-center justify-between rounded-xl border p-3 cursor-pointer transition ${
                    bootloaderFile
                      ? "border-emerald-300 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/20"
                      : "border-slate-200 bg-slate-50/60 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40"
                  }`}
                >
                  <input
                    ref={bootloaderInputRef}
                    type="file"
                    accept=".bin"
                    className="sr-only"
                    onChange={(e) => setBootloaderFile(e.target.files?.[0] || null)}
                  />
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${bootloaderFile ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" : "bg-slate-200 text-slate-500 dark:bg-slate-800"}`}>
                      <FileCode2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-900 dark:text-white">{t.firmwarePage.bootloaderSlotTitle}</span>
                        <span className="text-[10px] text-rose-500 font-bold">*</span>
                      </div>
                      <p className="font-mono text-[11px] text-slate-500 truncate">
                        {bootloaderFile ? `${bootloaderFile.name} (${sizeLabel(bootloaderFile.size)})` : t.firmwarePage.selectBootloader}
                      </p>
                    </div>
                  </div>
                  {bootloaderFile && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setBootloaderFile(null); }}
                      className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-slate-200 dark:hover:bg-slate-800"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* 3. Partitions File */}
                <div
                  onClick={() => partitionsInputRef.current?.click()}
                  className={`flex items-center justify-between rounded-xl border p-3 cursor-pointer transition ${
                    partitionsFile
                      ? "border-emerald-300 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/20"
                      : "border-slate-200 bg-slate-50/60 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40"
                  }`}
                >
                  <input
                    ref={partitionsInputRef}
                    type="file"
                    accept=".bin"
                    className="sr-only"
                    onChange={(e) => setPartitionsFile(e.target.files?.[0] || null)}
                  />
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${partitionsFile ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" : "bg-slate-200 text-slate-500 dark:bg-slate-800"}`}>
                      <FileCode2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-900 dark:text-white">{t.firmwarePage.partitionsSlotTitle}</span>
                        <span className="text-[10px] text-rose-500 font-bold">*</span>
                      </div>
                      <p className="font-mono text-[11px] text-slate-500 truncate">
                        {partitionsFile ? `${partitionsFile.name} (${sizeLabel(partitionsFile.size)})` : t.firmwarePage.selectPartitions}
                      </p>
                    </div>
                  </div>
                  {partitionsFile && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setPartitionsFile(null); }}
                      className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-slate-200 dark:hover:bg-slate-800"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* 4. OTA Data File */}
                <div
                  onClick={() => otaDataInputRef.current?.click()}
                  className={`flex items-center justify-between rounded-xl border p-3 cursor-pointer transition ${
                    otaDataFile
                      ? "border-emerald-300 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/20"
                      : "border-slate-200 bg-slate-50/60 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40"
                  }`}
                >
                  <input
                    ref={otaDataInputRef}
                    type="file"
                    accept=".bin"
                    className="sr-only"
                    onChange={(e) => setOtaDataFile(e.target.files?.[0] || null)}
                  />
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${otaDataFile ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300" : "bg-slate-200 text-slate-500 dark:bg-slate-800"}`}>
                      <FileCode2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-slate-900 dark:text-white">{t.firmwarePage.otaDataSlotTitle}</span>
                        <span className="text-[10px] text-rose-500 font-bold">*</span>
                      </div>
                      <p className="font-mono text-[11px] text-slate-500 truncate">
                        {otaDataFile ? `${otaDataFile.name} (${sizeLabel(otaDataFile.size)})` : t.firmwarePage.selectOtaData}
                      </p>
                    </div>
                  </div>
                  {otaDataFile && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setOtaDataFile(null); }}
                      className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-slate-200 dark:hover:bg-slate-800"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Form thông tin đi kèm - Cân đối 2 cột */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t.firmwarePage.deviceTypeLabel} <span className="font-normal text-slate-400">({t.firmwarePage.autoDetectIfEmpty})</span>
              </label>
              <select
                value={deviceType}
                onChange={(e) => setDeviceType(e.target.value as FirmwareDeviceType | "")}
                disabled={uploading}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none transition focus:border-emerald-600 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              >
                <option value="">{t.firmwarePage.autoDetectType}</option>
                <option value="GATEWAY">{t.firmwarePage.gatewayType}</option>
                <option value="SENSOR_NODE">{t.firmwarePage.nodeType}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                {t.firmwarePage.changelogLabel} <span className="font-normal text-slate-400">({t.firmwarePage.optionalLabel})</span>
              </label>
              <input
                type="text"
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                disabled={uploading}
                placeholder={t.firmwarePage.changelogPlaceholder}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none transition focus:border-emerald-600 dark:border-slate-700 dark:bg-slate-950 dark:text-white"
              />
            </div>
          </div>

          {/* Progress Bar */}
          {uploading && (
            <div className="space-y-1.5 pt-1">
              <div className="flex justify-between text-[11px] text-slate-500 font-mono">
                <span>{t.firmwarePage.uploadingVerifying}</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div className="h-full bg-emerald-600 transition-all duration-150" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            {(appFile || bootloaderFile || partitionsFile || otaDataFile) && !uploading && (
              <button
                type="button"
                onClick={resetUploadForm}
                className="rounded-lg px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 transition"
              >
                {t.firmwarePage.cancelSelect}
              </button>
            )}
            <button
              type="submit"
              disabled={uploading || !appFile || (uploadMode === "factory" && (!bootloaderFile || !partitionsFile || !otaDataFile))}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-700 shadow-xs"
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              <span>
                {uploading
                  ? t.firmwarePage.uploadProgress.replace("{{progress}}", String(progress))
                  : uploadMode === "factory"
                  ? t.firmwarePage.uploadFactoryButton
                  : t.firmwarePage.uploadOtaButton}
              </span>
            </button>
          </div>
        </form>
      </section>

      {/* Hai catalog độc lập: OTA không phải là một gói nạp xuất xưởng. */}
      <section className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">{releaseChannel === "OTA" ? t.firmwarePage.otaReleasesTitle : t.firmwarePage.factoryReleasesTitle}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {releaseChannel === "OTA" ? t.firmwarePage.otaReleasesHint : t.firmwarePage.factoryReleasesHint}
            </p>
          </div>
          <div className="flex rounded-lg bg-slate-100 p-1 text-[11px] font-semibold dark:bg-slate-800">
            <button type="button" onClick={() => setReleaseChannel("OTA")} className={`rounded-md px-2.5 py-1.5 transition ${releaseChannel === "OTA" ? "bg-white text-emerald-700 shadow-xs dark:bg-slate-900 dark:text-emerald-300" : "text-slate-500"}`}>
              {t.firmwarePage.otaCatalogTab}
            </button>
            <button type="button" onClick={() => setReleaseChannel("FACTORY")} className={`rounded-md px-2.5 py-1.5 transition ${releaseChannel === "FACTORY" ? "bg-white text-indigo-700 shadow-xs dark:bg-slate-900 dark:text-indigo-300" : "text-slate-500"}`}>
              {t.firmwarePage.factoryCatalogTab}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/75 dark:border-slate-800 dark:bg-slate-950/40 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                <th className="px-4 py-3">{t.firmwarePage.tableVersion}</th>
                <th className="px-4 py-3">{t.firmwarePage.tableType}</th>
                <th className="px-4 py-3">{t.firmwarePage.changelogLabel}</th>
                <th className="px-4 py-3">{t.firmwarePage.tableStatus}</th>
                <th className="px-4 py-3">{t.firmwarePage.tableReleaseDate}</th>
                <th className="px-4 py-3 text-right">{t.firmwarePage.tableActions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {loading && releases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400">
                    <RefreshCw className="mx-auto mb-2 h-5 w-5 animate-spin text-emerald-500" />
                    {t.firmwarePage.loadingReleases}
                  </td>
                </tr>
              ) : visibleReleases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-400 text-xs">
                    {releaseChannel === "OTA" ? t.firmwarePage.emptyOtaReleases : t.firmwarePage.emptyFactoryReleases}
                  </td>
                </tr>
              ) : (
                visibleReleases.map((release) => {
                  const expanded = expandedId === release.id;
                  const busy = busyId === release.id;
                  const isGateway = release.deviceType === "GATEWAY";
                  const status = channelStatus(release, releaseChannel);
                  const canFlash = releaseChannel === "FACTORY" && release.flashStatus === "ACTIVE";

                  return (
                    <React.Fragment key={release.id}>
                      <tr className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                        <td className="px-4 py-3 font-medium">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setExpandedId(expanded ? null : release.id)}
                              className="text-slate-400 hover:text-slate-600 transition"
                            >
                              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
                            </button>
                            <span className="font-mono font-semibold text-slate-900 dark:text-white">v{release.version}</span>
                            {releaseChannel === "FACTORY" ? (
                              <span
                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800"
                                title="Factory"
                              >
                                <Cpu className="h-3 w-3" /> Factory
                              </span>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                                title={t.firmwarePage.modeOta}
                              >
                                {t.firmwarePage.modeOta}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                            {isGateway ? t.firmwarePage.gatewayLabel : t.firmwarePage.nodeLabel}
                          </span>
                        </td>
                        <td className="px-4 py-3 max-w-xs truncate text-slate-600 dark:text-slate-300">
                          {release.changelog || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass(status)}`}>
                            {otaStatusLabel(status)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-500 whitespace-nowrap text-[11px]">
                          {dateLabel(release.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Nút Nạp USB nhanh nếu có bản Factory Active */}
                            {canFlash && (
                              <Link
                                to="/flasher"
                                title={t.firmwarePage.flashUsb}
                                className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-800 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300 transition"
                              >
                                <MonitorDown className="h-3.5 w-3.5" />
                                <span>{t.firmwarePage.flashUsb}</span>
                              </Link>
                            )}

                            {/* Nút Tải về */}
                            <button
                              type="button"
                              onClick={() => void handleDownload(release)}
                              disabled={downloadingKey === `${release.id}-default`}
                              title={t.firmwarePage.download}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 transition"
                            >
                              {downloadingKey === `${release.id}-default` ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Download className="h-3.5 w-3.5" />
                              )}
                              <span className="hidden md:inline">{t.firmwarePage.download}</span>
                            </button>

                            {/* Nút Đổi trạng thái */}
                            {status !== "REVOKED" && (
                              <button
                                type="button"
                                onClick={() => void changeStatus(release, releaseChannel, status === "ACTIVE" ? "PAUSED" : "ACTIVE")}
                                disabled={busy}
                                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition ${
                                  status === "ACTIVE"
                                    ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                                    : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                                }`}
                              >
                                {busy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : status === "ACTIVE" ? (
                                  <Pause className="h-3 w-3" />
                                ) : (
                                  <Play className="h-3 w-3" />
                                )}
                                <span>{status === "ACTIVE" ? t.firmwarePage.pause : t.firmwarePage.activate}</span>
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => void deleteRelease(release)}
                              disabled={busy}
                              title={t.firmwarePage.delete}
                              className="p-1 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-rose-950/30 transition"
                            >
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Chi tiết phân vùng mở rộng */}
                      {expanded && (
                        <tr className="bg-slate-50/50 dark:bg-slate-950/30 text-slate-600 dark:text-slate-400">
                          <td colSpan={6} className="px-6 py-4 border-t border-slate-100 dark:border-slate-800">
                            <div className="space-y-3">
                              <div className="grid gap-3 sm:grid-cols-3 text-[11px]">
                                <div>
                                  <span className="font-semibold text-slate-700 dark:text-slate-300">{t.firmwarePage.mainFirmwareFile}</span>
                                  <p className="font-mono mt-0.5 text-slate-500">{release.artifactFileName || "firmware.bin"}</p>
                                </div>
                                <div>
                                  <span className="font-semibold text-slate-700 dark:text-slate-300">{t.firmwarePage.targetChip}</span>
                                  <p className="font-mono mt-0.5 text-slate-500">{release.firmwareTarget || "ESP32-S3"}</p>
                                </div>
                                <div>
                                  <span className="font-semibold text-slate-700 dark:text-slate-300">{t.firmwarePage.sha256Code}</span>
                                  <p className="font-mono mt-0.5 text-slate-500 truncate" title={release.artifactSha256}>
                                    {release.artifactSha256 ? `${release.artifactSha256.slice(0, 24)}...` : "—"}
                                  </p>
                                </div>
                              </div>

                              {/* Danh sách các file nhị phân trong bản phát hành */}
                              {release.images && release.images.length > 0 && (
                                <div className="mt-3 pt-3 border-t border-slate-200/60 dark:border-slate-800/60">
                                  <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block mb-2">
                                    {t.firmwarePage.binaryPartitionsCount.replace("{{count}}", String(release.images.length))}
                                  </span>
                                  <div className="grid gap-2 sm:grid-cols-2">
                                    {release.images.map((img) => (
                                      <div
                                        key={img.id}
                                        className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-2.5 text-[11px] dark:border-slate-800 dark:bg-slate-900"
                                      >
                                        <div className="min-w-0 pr-2">
                                          <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-200">
                                            <span>{roleLabel(img.role)}</span>
                                          </div>
                                          <p className="font-mono text-[10px] text-slate-400 truncate">
                                            {img.fileName || img.name} · {sizeLabel(img.sizeBytes)}
                                          </p>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => void handleDownload(release, img.id, img.fileName || img.name)}
                                          disabled={downloadingKey === `${release.id}-${img.id}`}
                                          title={`${t.firmwarePage.downloadFile} ${img.fileName || img.name}`}
                                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 shrink-0 transition"
                                        >
                                          {downloadingKey === `${release.id}-${img.id}` ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                          ) : (
                                            <Download className="h-3 w-3" />
                                          )}
                                          <span>{t.firmwarePage.downloadFile}</span>
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
};
