import React, { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation, Navigate } from 'react-router-dom';
import clsx from 'clsx';
import { Sidebar } from './Sidebar';
import { Moon, Sun, Globe, Menu } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useI18n } from '../../context/I18nContext';
import { fetchMe, getCurrentUser } from '../../services/api.service';

// The flasher, map engines and charts are expensive. Load each workspace only
// after its tab is visited so the first dashboard paint is not blocked by
// MapLibre, Web Serial, or ESP flashing code.
const DashboardPage = React.lazy(() => import('../../pages/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const FarmMapPage = React.lazy(() => import('../../pages/FarmMapPage').then((module) => ({ default: module.FarmMapPage })));
const NodesPage = React.lazy(() => import('../../pages/NodesPage').then((module) => ({ default: module.NodesPage })));
const DeviceInventoryPage = React.lazy(() => import('../../pages/DeviceInventoryPage').then((module) => ({ default: module.DeviceInventoryPage })));
const UsersPage = React.lazy(() => import('../../pages/UsersPage').then((module) => ({ default: module.UsersPage })));
const WebFlasherPage = React.lazy(() => import('../../pages/WebFlasherPage').then((module) => ({ default: module.WebFlasherPage })));
const FirmwarePage = React.lazy(() => import('../../pages/FirmwarePage').then((module) => ({ default: module.FirmwarePage })));

const FarmAssistantPage = React.lazy(() => import('../../pages/FarmAssistantPage').then((module) => ({ default: module.FarmAssistantPage })));

function TabLoading() {
  const { t } = useI18n();
  return <div className="min-h-32 flex items-center justify-center text-sm text-slate-500" aria-busy="true">{t.layout.loadingWorkspace}</div>;
}

const PORTAL_TABS = ['/dashboard', '/map', '/nodes', '/inventory', '/flasher', '/firmware', '/users', '/farm-assistant'] as const;
const ADMIN_PORTAL_TABS = new Set(['/inventory', '/flasher', '/firmware', '/users']);
type PortalTab = (typeof PORTAL_TABS)[number];

export const Layout: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
  const location = useLocation();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const currentUser = getCurrentUser();
  const isAdmin = currentUser?.role === 'ADMIN';

  const currentPath = location.pathname === '/' ? '/dashboard' : location.pathname;
  const isPortalTab = PORTAL_TABS.includes(currentPath as PortalTab);

  // Keep-Alive: Track visited tabs so each page mounts lazily once and stays alive in DOM
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set([currentPath]));

  useEffect(() => {
    let active = true;
    void fetchMe()
      .then(() => active && setAuthenticated(true))
      .catch(() => active && setAuthenticated(false));
    return () => {
      active = false;
    };
  }, []);

  // Record visited tab to mount it if accessed for the first time
  useEffect(() => {
    if (isPortalTab) {
      setVisitedTabs((prev) => {
        if (prev.has(currentPath)) return prev;
        const next = new Set(prev);
        next.add(currentPath);
        return next;
      });
    }
  }, [currentPath, isPortalTab]);

  // Auto close mobile drawer on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  if (authenticated === null) {
    return <div className="min-h-screen bg-slate-50 dark:bg-slate-950" aria-busy="true" />;
  }

  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // A direct bookmark to an admin route must never leave a non-admin with a
  // blank keep-alive shell. Redirect after fetchMe has established the role.
  if (!isAdmin && ADMIN_PORTAL_TABS.has(currentPath)) {
    return <Navigate to="/dashboard" replace state={{ from: location }} />;
  }

  const getPageTitle = () => {
    switch (currentPath) {
      case '/farm-assistant':
        return 'Xem vườn';
      case '/map':
        return t.sidebar.map;
      case '/nodes':
        return t.nodesPage.title;
      case '/inventory':
        return t.sidebar.inventory;
      case '/flasher':
        return t.sidebar.deviceFlasher;
      case '/firmware':
        return t.sidebar.firmwareOta;
      case '/users':
        return t.usersPage.title;
      case '/dashboard':
      default:
        return t.sidebar.dashboard;
    }
  };

  return (
    <div className="flex h-[100dvh] bg-slate-50 dark:bg-slate-950 font-sans text-slate-900 dark:text-slate-100">
      <Sidebar isOpen={isMobileMenuOpen} onClose={() => setIsMobileMenuOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 px-4 sm:px-6 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0 z-20">
          <div className="flex items-center gap-2 min-w-0">
            {/* Hamburger Button for Mobile / Tablet */}
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-1.5 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title={t.layout.openMenu}
              aria-label={t.layout.openNavMenu}
            >
              <Menu className="w-5 h-5" />
            </button>
            <h2 className="text-sm sm:text-base font-bold truncate">{getPageTitle()}</h2>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Language Switcher */}
            <button
              onClick={() => setLanguage(language === 'vi' ? 'en' : 'vi')}
              className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all duration-200 active:scale-95 shadow-2xs"
              title={t.header.switchLang}
            >
              <Globe className="w-3.5 h-3.5 text-emerald-500" />
              <span>{language === 'vi' ? 'EN' : 'VI'}</span>
            </button>

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="p-2 rounded-xl text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 transition-all duration-200 active:scale-95"
              title={t.header.switchTheme}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-slate-600" />}
            </button>
          </div>
        </header>

        {/* KEEP-ALIVE TAB SYSTEM:
            Pages are kept alive in the DOM once visited and toggled via CSS hidden/block.
            This eliminates component remounts, prevents map tiles re-downloading, 
            preserves scroll positions, and keeps search queries intact. */}

        {/* TAB 1: Bản đồ Nông trại (GPS) */}
        <div
          className={clsx(
            'flex-1 overflow-hidden relative w-full h-full',
            currentPath === '/map' ? 'block' : 'hidden'
          )}
        >
          {visitedTabs.has('/map') && <Suspense fallback={<TabLoading />}><FarmMapPage isActive={currentPath === '/map'} /></Suspense>}
        </div>

        {/* TAB 2: Giám sát & Điều khiển (Dashboard) */}
        <div
          className={clsx(
            'flex-1 overflow-y-auto p-4 sm:p-6 transition-colors',
            currentPath === '/dashboard' ? 'block' : 'hidden'
          )}
        >
          <div className="mx-auto max-w-7xl">
            {visitedTabs.has('/dashboard') && <Suspense fallback={<TabLoading />}><DashboardPage isActive={currentPath === '/dashboard'} /></Suspense>}
          </div>
        </div>

        {/* TAB 3: Quản lý Thiết bị (Nodes) */}
        <div
          className={clsx(
            'flex-1 overflow-y-auto p-4 sm:p-6 transition-colors',
            currentPath === '/nodes' ? 'block' : 'hidden'
          )}
        >
          <div className="mx-auto max-w-7xl">
            {visitedTabs.has('/nodes') && <Suspense fallback={<TabLoading />}><NodesPage isActive={currentPath === '/nodes'} /></Suspense>}
          </div>
        </div>

        {/* TAB 4: Kho Thiết Bị (Admin only) */}
        {isAdmin && (
          <div
            className={clsx(
              'flex-1 overflow-y-auto p-4 sm:p-6 transition-colors',
              currentPath === '/inventory' ? 'block' : 'hidden'
            )}
          >
            <div className="mx-auto max-w-7xl">
              {visitedTabs.has('/inventory') && <Suspense fallback={<TabLoading />}><DeviceInventoryPage isActive={currentPath === '/inventory'} /></Suspense>}
            </div>
          </div>
        )}

        {isAdmin && (
          <div
            className={clsx(
              'flex-1 overflow-y-auto p-4 sm:p-6 transition-colors',
              currentPath === '/flasher' ? 'block' : 'hidden'
            )}
          >
            <div className="mx-auto max-w-7xl">
              {visitedTabs.has('/flasher') && <Suspense fallback={<TabLoading />}><WebFlasherPage isActive={currentPath === '/flasher'} /></Suspense>}
            </div>
          </div>
        )}

        {isAdmin && (
          <div
            className={clsx(
              'flex-1 overflow-y-auto p-4 sm:p-6 transition-colors',
              currentPath === '/firmware' ? 'block' : 'hidden'
            )}
          >
            <div className="mx-auto max-w-7xl">
              {visitedTabs.has('/firmware') && <Suspense fallback={<TabLoading />}><FirmwarePage isActive={currentPath === '/firmware'} /></Suspense>}
            </div>
          </div>
        )}

        {/* TAB 5: Quản lý Khách hàng (Admin only) */}
        {isAdmin && (
          <div
            className={clsx(
              'flex-1 overflow-y-auto p-4 sm:p-6 transition-colors',
              currentPath === '/users' ? 'block' : 'hidden'
            )}
          >
            <div className="mx-auto max-w-7xl">
              {visitedTabs.has('/users') && <Suspense fallback={<TabLoading />}><UsersPage isActive={currentPath === '/users'} /></Suspense>}
            </div>
          </div>
        )}

        <div className={clsx('flex-1 overflow-y-auto p-4 sm:p-6', currentPath === '/farm-assistant' ? 'block' : 'hidden')}>{visitedTabs.has('/farm-assistant') && <Suspense fallback={<TabLoading />}><FarmAssistantPage isActive={currentPath === '/farm-assistant'} isAdmin={isAdmin} /></Suspense>}</div>
        {/* Fallback for any other child route */}
        {!isPortalTab && (
          <main className="flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="mx-auto max-w-7xl">
              <Outlet />
            </div>
          </main>
        )}
      </div>
    </div>
  );
};
