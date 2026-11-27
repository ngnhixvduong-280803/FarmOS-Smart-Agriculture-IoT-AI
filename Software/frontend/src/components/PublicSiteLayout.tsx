import { useState, type PropsWithChildren } from "react";
import { ArrowRight, Globe, Menu, X } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useI18n } from "../context/I18nContext";
import farmosLogo from "../assets/farmos-logo.png";

type PublicSiteLayoutProps = PropsWithChildren<{
  className?: string;
}>;

export function PublicSiteLayout({ children, className = "" }: PublicSiteLayoutProps) {
  const location = useLocation();
  const isHome = location.pathname === "/";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { t, language, setLanguage } = useI18n();

  const navLinks = [
    { label: t.landing.nav.overview, href: isHome ? "#overview" : "/#overview" },
    { label: t.landing.nav.solution, href: isHome ? "#retrofit" : "/#retrofit" },
    { label: t.landing.nav.safety, href: isHome ? "#safety" : "/#safety" },
    { label: t.landing.nav.zones, href: isHome ? "#zones" : "/#zones" },
    { label: t.landing.nav.faq, href: isHome ? "#faq" : "/#faq" },
  ];

  return (
    <div className={`min-h-[100dvh] bg-[#fbfcf9] text-[#14231b] flex flex-col antialiased ${className}`}>
      {/* Refined Header */}
      <header className="sticky top-0 z-50 border-b border-[#e5ece6] bg-[#fbfcf9]/95 backdrop-blur-md transition-colors">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between lg:grid lg:grid-cols-[1fr_auto_1fr] px-5 sm:px-8">
          {/* Brand Logo - Aligned to left */}
          <div className="flex items-center justify-start">
            <Link className="flex items-center gap-2.5 font-bold tracking-tight text-[#14231b] group shrink-0" to="/">
              <img alt="FarmOS Logo" className="h-8 w-8 object-contain transition-transform group-hover:scale-105 shrink-0" src={farmosLogo} />
              <div className="flex items-baseline gap-1.5 shrink-0">
                <span className="text-lg font-semibold tracking-tight text-[#14231b]">FarmOS</span>
                <span className="text-xs font-normal text-[#607667]">AIoT</span>
              </div>
            </Link>
          </div>

          {/* Desktop Navigation - Perfectly Centered */}
          <nav aria-label="Điều hướng" className="hidden lg:flex items-center justify-center gap-5 xl:gap-8 text-sm font-medium text-[#476050] shrink-0 whitespace-nowrap">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="transition-colors hover:text-[#124d32] whitespace-nowrap py-1"
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* Right Action - Aligned to right */}
          <div className="flex items-center justify-end gap-2 sm:gap-3 shrink-0">
            {/* Language Switcher */}
            <button
              type="button"
              onClick={() => setLanguage(language === "vi" ? "en" : "vi")}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#d2dfd5] text-xs font-semibold text-[#30523d] hover:bg-[#edf3ee] transition-all whitespace-nowrap cursor-pointer active:scale-95 shrink-0"
              title={language === "vi" ? "Switch to English" : "Chuyển sang Tiếng Việt"}
            >
              <Globe className="w-3.5 h-3.5 text-[#184e34] shrink-0" />
              <span>{language === "vi" ? "EN" : "VI"}</span>
            </button>

            <Link
              to="/login"
              className="hidden sm:inline-flex text-sm font-medium text-[#476050] hover:text-[#124d32] px-2.5 py-1 transition-colors whitespace-nowrap shrink-0"
            >
              {t.landing.nav.login}
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#184e34] px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-[#113d28] active:translate-y-px whitespace-nowrap shrink-0"
            >
              <span>{t.landing.nav.goToDashboard}</span>
              <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            </Link>

            {/* Mobile menu toggle (Visible on < lg screens) */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="lg:hidden inline-flex items-center justify-center p-2 text-[#355240] hover:bg-[#edf3ee] rounded-md focus:outline-none shrink-0"
              aria-label="Toggle Menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile Nav */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-[#e5ece6] bg-[#fbfcf9] px-6 py-4 shadow-sm animate-fade-in">
            <nav className="flex flex-col gap-3 text-sm text-[#355240]">
              {navLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className="py-1 transition-colors hover:text-[#124d32]"
                >
                  {link.label}
                </a>
              ))}
              <div className="h-px bg-[#e5ece6] my-1" />
              <Link
                className="py-1 transition-colors hover:text-[#124d32]"
                to="/privacy"
                onClick={() => setMobileMenuOpen(false)}
              >
                {t.landing.footer.privacy}
              </Link>
              <Link
                className="py-1 transition-colors hover:text-[#124d32]"
                to="/terms"
                onClick={() => setMobileMenuOpen(false)}
              >
                {t.landing.footer.terms}
              </Link>
              <div className="h-px bg-[#e5ece6] my-1" />
              <div className="flex items-center justify-between py-1">
                <span className="text-xs text-[#607667]">{t.header.switchLang}:</span>
                <button
                  type="button"
                  onClick={() => setLanguage(language === "vi" ? "en" : "vi")}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#d2dfd5] text-xs font-semibold text-[#184e34] hover:bg-[#edf3ee]"
                >
                  <Globe className="w-3.5 h-3.5 text-[#184e34]" />
                  <span>{language === "vi" ? "English (EN)" : "Tiếng Việt (VI)"}</span>
                </button>
              </div>
              <Link
                className="py-2 font-semibold text-[#184e34]"
                to="/login"
                onClick={() => setMobileMenuOpen(false)}
              >
                {t.landing.footer.mobileLoginBtn}
              </Link>
            </nav>
          </div>
        )}
      </header>

      {/* Main Content */}
      <div className="flex-1">
        {children}
      </div>

      {/* Tasteful, Clean Footer */}
      <footer className="border-t border-[#e5ece6] bg-[#f5f7f4] text-[#556c5d]">
        <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8">
          <div className="grid grid-cols-1 gap-10 md:grid-cols-12">
            {/* Col 1 */}
            <div className="md:col-span-6 space-y-3">
              <Link className="flex items-center gap-2 font-bold tracking-tight text-[#14231b]" to="/">
                <img alt="FarmOS Logo" className="h-7 w-7 object-contain" src={farmosLogo} />
                <span className="text-base font-semibold tracking-tight">FarmOS</span>
              </Link>
              <p className="max-w-md text-xs leading-relaxed text-[#5b7263]">
                {t.landing.footer.tagline}
              </p>
            </div>

            {/* Col 2 */}
            <div className="md:col-span-3 space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#21382b]">{t.landing.footer.navTitle}</p>
              <ul className="space-y-1.5 text-xs">
                <li><a href={isHome ? "#overview" : "/#overview"} className="hover:text-[#184e34] transition-colors">{t.landing.footer.navOverview}</a></li>
                <li><a href={isHome ? "#safety" : "/#safety"} className="hover:text-[#184e34] transition-colors">{t.landing.footer.navSafety}</a></li>
                <li><a href={isHome ? "#zones" : "/#zones"} className="hover:text-[#184e34] transition-colors">{t.landing.footer.navZones}</a></li>
                <li><a href={isHome ? "#faq" : "/#faq"} className="hover:text-[#184e34] transition-colors">{t.landing.footer.navFaq}</a></li>
              </ul>
            </div>

            {/* Col 3 */}
            <div className="md:col-span-3 space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#21382b]">{t.landing.footer.legalTitle}</p>
              <ul className="space-y-1.5 text-xs">
                <li><Link to="/privacy" className="hover:text-[#184e34] transition-colors">{t.landing.footer.privacy}</Link></li>
                <li><Link to="/terms" className="hover:text-[#184e34] transition-colors">{t.landing.footer.terms}</Link></li>
                <li><Link to="/login" className="hover:text-[#184e34] transition-colors">{t.landing.footer.login}</Link></li>
                <li className="pt-1">
                  <a href="mailto:farmos.iuh@gmail.com" className="text-xs text-[#184e34] hover:underline">
                    farmos.iuh@gmail.com
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-10 flex flex-col sm:flex-row items-center justify-between border-t border-[#e2eae3] pt-6 text-xs text-[#6e8576]">
            <p>© {new Date().getFullYear()} {t.landing.footer.copyright}</p>
            <p className="mt-1 sm:mt-0">{t.landing.footer.projectNote}</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
