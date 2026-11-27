import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Download, QrCode, X } from "lucide-react";
import type { ManufacturingQrLabel, NodeDevice } from "../types";
import { useI18n } from "../context/I18nContext";
import { fetchNodeQr } from "../services/api.service";

type DeviceQr = Pick<ManufacturingQrLabel, "qrId" | "deviceId" | "state" | "payload">;

interface DeviceQrModalProps {
  node: NodeDevice | null;
  onClose: () => void;
}

export function DeviceQrModal({ node, onClose }: DeviceQrModalProps) {
  const { t } = useI18n();
  const [label, setLabel] = useState<DeviceQr | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!node) return;
    let current = true;
    setLoading(true);
    setError(null);
    setLabel(null);
    setImage(null);
    void fetchNodeQr(node.id)
      .then(async (result) => {
        if (!current) return;
        if (result?.payload) {
          const dataUrl = await QRCode.toDataURL(JSON.stringify(result.payload), {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 640,
          });
          if (current) setImage(dataUrl);
        }
        if (current) setLabel(result);
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : t.nodesPage.qrLoadError);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => { current = false; };
  }, [node?.id]);

  useEffect(() => {
    if (!node) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [node, onClose]);

  if (!node) return null;

  const download = () => {
    if (!image || !label) return;
    const anchor = document.createElement("a");
    anchor.href = image;
    anchor.download = `${label.deviceId}-qr-v3.png`;
    anchor.click();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={t.nodesPage.qrTitle} className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-white"><QrCode className="h-5 w-5 text-emerald-600" />{t.nodesPage.qrTitle}</h2>
            <p className="mt-1 font-mono text-xs text-slate-500">{node.id}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t.nodesPage.qrClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4" /></button>
        </div>
        <div className="mt-5 flex min-h-64 flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/50">
          {loading ? <p className="text-sm text-slate-500">{t.nodesPage.qrLoading}</p>
            : error ? <p role="alert" className="text-center text-sm text-rose-600">{error}</p>
            : image && label ? <><img src={image} alt={`${t.nodesPage.qrTitle} ${label.deviceId}`} className="h-64 w-64 bg-white object-contain" /><p className="mt-3 font-mono text-xs text-slate-500">{label.qrId}</p></>
            : <p className="text-center text-sm text-slate-500">{label?.state === "REVOKED" || label?.state === "QUARANTINED" ? t.nodesPage.qrInactive : t.nodesPage.qrUnavailable}</p>}
        </div>
        {image && <p className="mt-3 text-center text-xs text-slate-500">{t.nodesPage.qrExistingNotice}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="action action-light">{t.nodesPage.qrClose}</button>
          <button type="button" onClick={download} disabled={!image} className="action action-green disabled:cursor-not-allowed disabled:opacity-50"><Download className="h-4 w-4" />{t.nodesPage.qrDownload}</button>
        </div>
      </section>
    </div>
  );
}
