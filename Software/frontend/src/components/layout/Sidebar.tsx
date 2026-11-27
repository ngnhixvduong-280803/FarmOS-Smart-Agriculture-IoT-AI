import React, { useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { LayoutDashboard, Server, MapPin, LogOut, Sprout, Shield, Loader2, X, Cpu, MonitorDown, PackageOpen, Users } from "lucide-react";
import clsx from "clsx";
import { useI18n } from "../../context/I18nContext";
import { getCurrentUser, logoutUser } from "../../services/api.service";
import { TopLoadingBar } from "../TopLoadingBar";

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen = false, onClose }) => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const currentUser = getCurrentUser();
  const isAdmin = currentUser?.role === "ADMIN";
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const farmItems = [
    { name: t.sidebar.dashboard, path: "/dashboard", icon: LayoutDashboard },
    { name: "Xem vườn", path: "/farm-assistant", icon: Sprout },
    { name: isAdmin ? t.sidebar.systemMap : t.sidebar.farmMap, path: "/map", icon: MapPin },
    ...(!isAdmin ? [{ name: t.sidebar.farmNodes, path: "/nodes", icon: Server }] : []),
  ];

  const adminManagementItems = [
    { name: t.sidebar.customerManagement, path: "/users", icon: Users },
    { name: t.sidebar.allNodes, path: "/nodes", icon: Server },
  ];

  const adminHardwareItems = [
    { name: t.sidebar.deviceFlasher, path: "/flasher", icon: MonitorDown },
    { name: t.sidebar.firmwareOta, path: "/firmware", icon: PackageOpen },
  ];

  const handleConfirmLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    setShowConfirmModal(false);
    try {
      await logoutUser();
      navigate("/login", { replace: true });
    } finally {
      setIsLoggingOut(false);
    }
  };

  const renderSidebarContent = (isMobile = false) => (
    <div className="relative flex flex-col h-full bg-white dark:bg-slate-900 font-sans">
      {/* Contextual Anchored Confirmation Popover */}
      {showConfirmModal && (
        <>
          {/* Invisible backdrop to dismiss when clicking outside */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setShowConfirmModal(false)}
          />

          {/* Clean Anchored Card directly above the logout button */}
          <div className="absolute bottom-[4.75rem] left-3 right-3 z-50 p-4 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-xl shadow-slate-900/10 dark:shadow-black/60 animate-fade-in font-sans">
            <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">
              {t.sidebar.logoutConfirmTitle || "Đăng xuất tài khoản?"}
            </h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              {t.sidebar.logoutConfirmMessage || "Bạn có chắc chắn muốn đăng xuất không?"}
            </p>

            <div className="mt-3.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-1.5 px-3 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                {t.sidebar.cancel || "Hủy"}
              </button>
              <button
                type="button"
                onClick={handleConfirmLogout}
                disabled={isLoggingOut}
                className="flex-1 py-1.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-95 text-white text-xs font-bold transition-all shadow-sm shadow-rose-600/20 disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {isLoggingOut && <Loader2 className="w-3 h-3 animate-spin" />}
                <span>{t.sidebar.confirm || "Đăng xuất"}</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* Header with Close Button for Mobile */}
      <div className="flex items-center justify-between h-14 shrink-0 px-5 border-b border-slate-200 dark:border-slate-800">
        <Link
          to="/"
          onClick={() => isMobile && onClose?.()}
          className="flex items-center hover:opacity-90 transition-opacity group cursor-pointer"
        >
          <div className="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center text-emerald-700 dark:text-emerald-400 mr-2.5 group-hover:bg-emerald-100 dark:group-hover:bg-emerald-900/50 transition-colors">
            <Sprout className="w-5 h-5" />
          </div>
          <div>
            <span className="text-base font-bold text-slate-800 dark:text-white block leading-tight group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
              FarmOS
            </span>
            <span className="text-[10px] text-slate-500 dark:text-slate-400 font-medium uppercase tracking-[0.14em]">
              {currentUser?.role === "ADMIN" ? t.sidebar.adminPortal : t.sidebar.farmPortal}
            </span>
          </div>
        </Link>

        {isMobile && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label={t.modals.close}
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* User Mini Profile */}
      <div className="px-3.5 py-3 mx-3 my-3 bg-slate-50 dark:bg-slate-950/60 rounded-xl border border-slate-200/80 dark:border-slate-800 flex items-center gap-2.5">
        {currentUser?.avatar_url ? (
          <img
            src={currentUser.avatar_url}
            alt={currentUser.name || currentUser.email || "Avatar"}
            referrerPolicy="no-referrer"
            className="w-9 h-9 rounded-lg object-cover shrink-0 border border-slate-200 dark:border-slate-700 shadow-xs"
            onError={(e) => {
              (e.currentTarget as HTMLElement).style.display = "none";
              const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
              if (fallback) fallback.style.display = "flex";
            }}
          />
        ) : null}
        <div
          className="w-9 h-9 rounded-lg bg-slate-900 dark:bg-emerald-700 text-white flex items-center justify-center font-bold text-xs shrink-0"
          style={{ display: currentUser?.avatar_url ? "none" : "flex" }}
        >
          {(currentUser?.name || currentUser?.email || "U").charAt(0).toUpperCase()}
        </div>
        <div className="truncate flex-1 min-w-0">
          <p className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">
            {currentUser?.name || t.sidebar.defaultUser}
          </p>
          <p className="text-[10px] text-slate-400 truncate">{currentUser?.email || "user@farmos.local"}</p>
        </div>
        {currentUser?.role === "ADMIN" && (
          <span title="Admin" className="p-1 rounded-lg bg-purple-100 dark:bg-purple-950/50">
            <Shield className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0" />
          </span>
        )}
      </div>

      {/* Navigation items */}
      <nav aria-label={t.layout.openNavMenu} className="flex-1 px-3 py-2 space-y-4 overflow-y-auto">
        <div>
          <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
            {t.sidebar.sectionFarm}
          </div>
          <div className="space-y-1">
            {farmItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={() => isMobile && onClose?.()}
                  className={({ isActive }) =>
                    clsx(
                      "flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 text-xs font-medium",
                      isActive
                        ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300 font-semibold"
                        : "text-slate-600 hover:bg-slate-100/70 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
                    )
                  }
                >
                  <Icon className="w-4 h-4" />
                  {item.name}
                </NavLink>
              );
            })}
          </div>
        </div>

        {isAdmin && (
          <div>
            <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {t.sidebar.sectionAdmin}
            </div>
            <div className="space-y-1">
              {adminManagementItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => isMobile && onClose?.()}
                    className={({ isActive }) =>
                      clsx(
                        "flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 text-xs font-medium",
                        isActive
                          ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300 font-semibold"
                          : "text-slate-600 hover:bg-slate-100/70 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
                      )
                    }
                  >
                    <Icon className="w-4 h-4" />
                    {item.name}
                  </NavLink>
                );
              })}
            </div>
          </div>
        )}

        {isAdmin && (
          <div>
            <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
              {t.sidebar.sectionHardware}
            </div>
            <div className="space-y-1">
              {adminHardwareItems.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    onClick={() => isMobile && onClose?.()}
                    className={({ isActive }) =>
                      clsx(
                        "flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 text-xs font-medium",
                        isActive
                          ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300 font-semibold"
                          : "text-slate-600 hover:bg-slate-100/70 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200"
                      )
                    }
                  >
                    <Icon className="w-4 h-4" />
                    {item.name}
                  </NavLink>
                );
              })}
            </div>
          </div>
        )}
      </nav>

      {/* Logout button */}
      <div className="p-4 border-t border-slate-200 dark:border-slate-800">
        <button
          onClick={() => setShowConfirmModal(true)}
          disabled={isLoggingOut}
          className="flex items-center gap-3 px-3.5 py-2.5 w-full rounded-lg text-sm font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-all duration-150 active:scale-98 disabled:opacity-60"
        >
          {isLoggingOut ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
          {isLoggingOut ? t.sidebar.loggingOut : t.sidebar.logout}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <TopLoadingBar isLoading={isLoggingOut} />

      {/* Desktop Fixed Sidebar */}
      <aside className="hidden lg:flex w-64 h-screen shrink-0 border-r border-slate-200 dark:border-slate-800 flex-col">
        {renderSidebarContent(false)}
      </aside>

      {/* Mobile Drawer (Slide-over with Backdrop) */}
      {isOpen && (
        <div className="fixed inset-0 z-50 lg:hidden font-sans">
          {/* Backdrop overlay */}
          <div
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs animate-fade-in transition-opacity"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Slide-over Drawer Panel */}
          <div className="fixed inset-y-0 left-0 w-72 max-w-[85vw] bg-white dark:bg-slate-900 shadow-2xl z-50 flex flex-col animate-in slide-in-from-left duration-200 border-r border-slate-200 dark:border-slate-800 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
            {renderSidebarContent(true)}
          </div>
        </div>
      )}
    </>
  );
};
