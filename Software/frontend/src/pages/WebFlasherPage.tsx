import { Link } from "react-router-dom";
import { ExternalLink, MonitorDown, Package } from "lucide-react";
import { useI18n } from "../context/I18nContext";

export interface WebFlasherPageProps { isActive?: boolean }

export function WebFlasherPage(_: WebFlasherPageProps) {
  const { language } = useI18n();
  const vi = language === "vi";
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <MonitorDown className="h-8 w-8 text-emerald-600" />
        <h1 className="text-2xl font-bold">{vi ? "Nạp USB bằng FarmOS Flasher" : "USB flashing with FarmOS Flasher"}</h1>
        <p className="text-slate-500">{vi ? "Dùng ứng dụng desktop để nạp ESP32-S3 mới và tự cấp ID/QR. Dashboard quản lý firmware và cập nhật OTA." : "Use the desktop app to flash new ESP32-S3 boards and issue their ID/QR. Manage firmware and OTA updates here."}</p>
      </header>
      <ol className="list-decimal space-y-3 pl-5">
        <li>{vi ? "Mở FarmOS Flasher và đăng nhập tài khoản Admin." : "Open FarmOS Flasher and sign in as an Admin."}</li>
        <li>{vi ? "Chọn Node hoặc Gateway, phiên bản firmware và cổng USB." : "Select Node or Gateway, the firmware version and USB port."}</li>
        <li>{vi ? "Kiểm tra thiết bị, nạp firmware rồi nhận ID/QR sau xác minh." : "Check the board, flash firmware and receive its verified ID/QR."}</li>
      </ol>
      <div className="flex flex-wrap gap-3">
        <a className="action action-dark" href="https://github.com/levanduy093-work/FarmOS/actions/workflows/desktop-flasher-release.yml" target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" />{vi ? "Bản cài desktop" : "Desktop installers"}</a>
        <Link className="action" to="/firmware"><Package className="h-4 w-4" />{vi ? "Quản lý firmware & OTA" : "Manage firmware & OTA"}</Link>
      </div>
    </div>
  );
}
