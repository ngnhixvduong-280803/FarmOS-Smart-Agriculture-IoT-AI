import {
  ArrowRight,
  Check,
  ChevronDown,
  Cpu,
  Database,
  Layers,
  Radio,
  RefreshCw,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PublicSiteLayout } from "../components/PublicSiteLayout";
import { useI18n } from "../context/I18nContext";

const layerIcons = [Radio, Cpu, Database, Layers];

export function HomePage() {
  const { t } = useI18n();
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const retrofitSteps = [
    {
      step: "01",
      title: t.landing.retrofit.step1Title,
      detail: t.landing.retrofit.step1Desc,
    },
    {
      step: "02",
      title: t.landing.retrofit.step2Title,
      detail: t.landing.retrofit.step2Desc,
    },
    {
      step: "03",
      title: t.landing.retrofit.step3Title,
      detail: t.landing.retrofit.step3Desc,
    },
  ];

  return (
    <PublicSiteLayout>
      <main>
        {/* =========================================================================
            1. HERO SECTION: Pure Product & System Presentation
            ========================================================================= */}
        <section id="overview" className="mx-auto max-w-6xl px-5 pt-14 pb-16 sm:px-8 sm:pt-20 sm:pb-24">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#1e583b]">
              {t.landing.hero.badge}
            </p>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-[#112419] sm:text-5xl sm:leading-[1.15]">
              {t.landing.hero.titleStart}
              <span className="text-[#184e34]">{t.landing.hero.titleHighlight}</span>
              {t.landing.hero.titleEnd}
            </h1>
            <p className="mt-5 text-base leading-relaxed text-[#4a6352] sm:text-lg">
              {t.landing.hero.description}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3.5">
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-lg bg-[#184e34] px-5 py-3 text-sm font-semibold text-white shadow-xs transition hover:bg-[#113d28] active:translate-y-px"
              >
                <span>{t.landing.hero.ctaDashboard}</span>
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Link>
              <a
                href="#architecture"
                className="inline-flex items-center gap-2 rounded-lg border border-[#cfddd1] bg-white px-5 py-3 text-sm font-medium text-[#294c37] transition hover:bg-[#f4f8f4] hover:border-[#a8c5ae] active:translate-y-px"
              >
                <span>{t.landing.hero.ctaArchitecture}</span>
              </a>
            </div>

            {/* Reassurance bar */}
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-[#5f7a69]">
              <span className="flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-[#184e34]" />
                {t.landing.hero.reassuranceFloat}
              </span>
              <span className="flex items-center gap-1.5">
                <WifiOff className="h-4 w-4 text-[#184e34]" />
                {t.landing.hero.reassuranceOffline}
              </span>
              <span className="flex items-center gap-1.5">
                <RefreshCw className="h-4 w-4 text-[#184e34]" />
                {t.landing.hero.reassuranceRetrofit}
              </span>
            </div>
          </div>

          {/* =======================================================================
              SYSTEM BLUEPRINT OVERVIEW (Clean 3-Column Architectural Flow)
              ======================================================================= */}
          <div className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-3">
            {/* Card 1 */}
            <div className="rounded-xl border border-[#d8e3da] bg-white p-6 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold text-[#184e34]">{t.landing.blueprint.layer1Tag}</span>
                <Radio className="h-4 w-4 text-[#184e34]" />
              </div>
              <h3 className="mt-4 text-base font-semibold text-[#14231b]">{t.landing.blueprint.layer1Title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-[#516b5b]">
                {t.landing.blueprint.layer1Desc}
              </p>
              <div className="mt-4 pt-3 border-t border-[#edf3ee] text-[11px] font-medium text-[#3b5d47]">
                {t.landing.blueprint.layer1Foot}
              </div>
            </div>

            {/* Card 2 */}
            <div className="rounded-xl border border-[#d8e3da] bg-white p-6 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold text-[#184e34]">{t.landing.blueprint.layer2Tag}</span>
                <Cpu className="h-4 w-4 text-[#184e34]" />
              </div>
              <h3 className="mt-4 text-base font-semibold text-[#14231b]">{t.landing.blueprint.layer2Title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-[#516b5b]">
                {t.landing.blueprint.layer2Desc}
              </p>
              <div className="mt-4 pt-3 border-t border-[#edf3ee] text-[11px] font-medium text-[#3b5d47]">
                {t.landing.blueprint.layer2Foot}
              </div>
            </div>

            {/* Card 3 */}
            <div className="rounded-xl border border-[#d8e3da] bg-white p-6 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold text-[#184e34]">{t.landing.blueprint.layer3Tag}</span>
                <Database className="h-4 w-4 text-[#184e34]" />
              </div>
              <h3 className="mt-4 text-base font-semibold text-[#14231b]">{t.landing.blueprint.layer3Title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-[#516b5b]">
                {t.landing.blueprint.layer3Desc}
              </p>
              <div className="mt-4 pt-3 border-t border-[#edf3ee] text-[11px] font-medium text-[#3b5d47]">
                {t.landing.blueprint.layer3Foot}
              </div>
            </div>
          </div>
        </section>

        {/* =========================================================================
            2. RETROFIT PARADIGM: Upgrade Without Replacing Existing Infrastructure
            ========================================================================= */}
        <section id="retrofit" className="border-t border-[#e5ece6] bg-[#f6f8f5] py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#1e583b]">
                {t.landing.retrofit.badge}
              </p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#112419] sm:text-3xl">
                {t.landing.retrofit.title}
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-[#4f6757]">
                {t.landing.retrofit.description}
              </p>
            </div>

            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              {retrofitSteps.map((step) => (
                <div key={step.step} className="rounded-xl border border-[#dfe7e0] bg-white p-6 shadow-2xs">
                  <span className="font-mono text-xs font-semibold text-[#184e34]">
                    {t.landing.retrofit.stepTag} {step.step}
                  </span>
                  <h3 className="mt-3 text-base font-semibold text-[#14231b]">{step.title}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-[#516a5a]">{step.detail}</p>
                </div>
              ))}
            </div>

            {/* Economic and Operational Summary */}
            <div className="mt-8 rounded-xl border border-[#dbe4dd] bg-white p-6 sm:p-8 shadow-2xs">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-3 md:divide-x md:divide-[#edf2ee]">
                <div className="md:pr-6">
                  <span className="text-3xl font-bold tracking-tight text-[#184e34]">
                    {t.landing.retrofit.stat1Number}
                  </span>
                  <p className="mt-1 text-xs font-semibold text-[#1c3526]">{t.landing.retrofit.stat1Title}</p>
                  <p className="mt-1 text-xs text-[#55705f]">
                    {t.landing.retrofit.stat1Desc}
                  </p>
                </div>

                <div className="md:px-6">
                  <span className="text-3xl font-bold tracking-tight text-[#184e34]">
                    {t.landing.retrofit.stat2Number}
                  </span>
                  <p className="mt-1 text-xs font-semibold text-[#1c3526]">{t.landing.retrofit.stat2Title}</p>
                  <p className="mt-1 text-xs text-[#55705f]">
                    {t.landing.retrofit.stat2Desc}
                  </p>
                </div>

                <div className="md:pl-6">
                  <span className="text-3xl font-bold tracking-tight text-[#184e34]">
                    {t.landing.retrofit.stat3Number}
                  </span>
                  <p className="mt-1 text-xs font-semibold text-[#1c3526]">{t.landing.retrofit.stat3Title}</p>
                  <p className="mt-1 text-xs text-[#55705f]">
                    {t.landing.retrofit.stat3Desc}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =========================================================================
            3. SYSTEM ARCHITECTURE: 4 Technical Layers Deep-Dive
            ========================================================================= */}
        <section id="architecture" className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#1e583b]">
              {t.landing.architecture.badge}
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#112419] sm:text-3xl">
              {t.landing.architecture.title}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[#4f6757]">
              {t.landing.architecture.description}
            </p>
          </div>

          <div className="mt-10 space-y-6">
            {t.landing.architecture.layers.map((layer, index) => {
              const Icon = layerIcons[index] || Cpu;
              return (
                <div
                  key={layer.step}
                  className="rounded-xl border border-[#dfe7e0] bg-white p-6 sm:p-8 shadow-2xs transition-all hover:border-[#c5d8c8]"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#edf3ee] pb-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#edf4ee] text-[#184e34]">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <span className="font-mono text-xs font-semibold text-[#184e34]">
                          {t.landing.architecture.layerTag} {layer.step}
                        </span>
                        <h3 className="text-base font-bold text-[#14231b]">{layer.name}</h3>
                      </div>
                    </div>
                    <span className="font-mono text-xs text-[#63806e]">{layer.enName}</span>
                  </div>

                  <p className="mt-4 text-xs sm:text-sm leading-relaxed text-[#4f6757]">
                    {layer.description}
                  </p>

                  <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 pt-4 border-t border-[#edf3ee]">
                    {layer.specs.map((spec, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-[#395644]">
                        <Check className="h-3.5 w-3.5 shrink-0 mt-0.5 text-[#184e34]" />
                        <span>{spec}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* =========================================================================
            4. INDUSTRIAL SAFETY ENGINE: 5 Hardened Principles
            ========================================================================= */}
        <section id="safety" className="border-t border-[#e5ece6] bg-[#f6f8f5] py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#1e583b]">
                {t.landing.safety.badge}
              </p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#112419] sm:text-3xl">
                {t.landing.safety.title}
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-[#4f6757]">
                {t.landing.safety.description}
              </p>
            </div>

            <div className="mt-10 divide-y divide-[#e5ece6] rounded-xl border border-[#dfe7e0] bg-white">
              {t.landing.safety.layers.map((layer) => (
                <div key={layer.number} className="p-6 sm:p-7 flex flex-col sm:flex-row gap-5 items-start">
                  <span className="font-mono text-xl font-bold text-[#184e34] sm:w-12 shrink-0">
                    {layer.number}
                  </span>
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-[#14231b]">{layer.title}</h3>
                    <p className="mt-1.5 text-xs sm:text-sm leading-relaxed text-[#4f6757]">
                      {layer.summary}
                    </p>
                    <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-md bg-[#edf5ef] px-2.5 py-1 text-[11px] font-medium text-[#184e34]">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      <span>{layer.benefit}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* =========================================================================
            5. MULTI-ZONE DATA MODEL: Farm -> Zone -> Node
            ========================================================================= */}
        <section id="zones" className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#1e583b]">
              {t.landing.zones.badge}
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#112419] sm:text-3xl">
              {t.landing.zones.title}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[#4f6757]">
              {t.landing.zones.description}
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="rounded-xl border border-[#dfe7e0] bg-white p-6 shadow-2xs">
              <span className="font-mono text-xs font-semibold text-[#184e34]">
                {t.landing.zones.levelTag} 01
              </span>
              <h3 className="mt-3 text-base font-semibold text-[#14231b]">{t.landing.zones.level1Title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-[#516a5a]">
                {t.landing.zones.level1Desc}
              </p>
            </div>

            <div className="rounded-xl border border-[#dfe7e0] bg-white p-6 shadow-2xs">
              <span className="font-mono text-xs font-semibold text-[#184e34]">
                {t.landing.zones.levelTag} 02
              </span>
              <h3 className="mt-3 text-base font-semibold text-[#14231b]">{t.landing.zones.level2Title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-[#516a5a]">
                {t.landing.zones.level2Desc}
              </p>
            </div>

            <div className="rounded-xl border border-[#dfe7e0] bg-white p-6 shadow-2xs">
              <span className="font-mono text-xs font-semibold text-[#184e34]">
                {t.landing.zones.levelTag} 03
              </span>
              <h3 className="mt-3 text-base font-semibold text-[#14231b]">{t.landing.zones.level3Title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-[#516a5a]">
                {t.landing.zones.level3Desc}
              </p>
            </div>
          </div>
        </section>

        {/* =========================================================================
            6. COMPARISON: Honest System Comparison
            ========================================================================= */}
        <section className="border-t border-[#e5ece6] bg-[#f6f8f5] py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-5 sm:px-8">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-wider text-[#1e583b]">
                {t.landing.comparison.badge}
              </p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#112419] sm:text-3xl">
                {t.landing.comparison.title}
              </h2>
            </div>

            <div className="mt-8 overflow-x-auto">
              <table className="w-full min-w-[600px] border-collapse text-left text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-[#d8e3da] text-[#14231b]">
                    <th className="py-3.5 pr-4 font-semibold">{t.landing.comparison.criteriaCol}</th>
                    <th className="px-4 py-3.5 font-medium text-[#5c7566]">{t.landing.comparison.timerCol}</th>
                    <th className="px-4 py-3.5 font-medium text-[#5c7566]">{t.landing.comparison.smartHomeCol}</th>
                    <th className="px-4 py-3.5 font-semibold text-[#184e34] bg-[#edf4ee] rounded-t-md">
                      {t.landing.comparison.farmosCol}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e3ebe4] text-xs">
                  {t.landing.comparison.rows.map((row, index) => (
                    <tr key={index}>
                      <td className="py-3.5 pr-4 font-medium text-[#183123]">{row.criteria}</td>
                      <td className="px-4 py-3.5 text-[#587363]">{row.timer}</td>
                      <td className="px-4 py-3.5 text-rose-600">{row.smartHome}</td>
                      <td className={`px-4 py-3.5 font-semibold text-[#184e34] bg-[#edf4ee] ${index === t.landing.comparison.rows.length - 1 ? "rounded-b-md" : ""}`}>
                        {row.farmos}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* =========================================================================
            7. FREQUENTLY ASKED QUESTIONS (FAQ)
            ========================================================================= */}
        <section id="faq" className="mx-auto max-w-4xl px-5 py-16 sm:px-8 sm:py-20">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#1e583b]">
              {t.landing.faq.badge}
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-[#112419] sm:text-3xl">
              {t.landing.faq.title}
            </h2>
          </div>

          <div className="mt-8 space-y-3">
            {t.landing.faq.items.map((faq, index) => {
              const isOpen = openFaq === index;
              return (
                <div
                  key={index}
                  className="overflow-hidden rounded-lg border border-[#dfe7e0] bg-white transition-all"
                >
                  <button
                    type="button"
                    onClick={() => setOpenFaq(isOpen ? null : index)}
                    className="flex w-full items-center justify-between p-4 text-left text-xs sm:text-sm font-semibold text-[#162a1f] hover:bg-[#f7faf7]"
                  >
                    <span>{faq.q}</span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-[#184e34] transition-transform duration-200 ${
                        isOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {isOpen && (
                    <div className="border-t border-[#e8efe9] bg-[#fafcfb] p-4 text-xs leading-relaxed text-[#4f6757]">
                      <p>{faq.a}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* =========================================================================
            8. CALL TO ACTION
            ========================================================================= */}
        <section className="mx-auto max-w-6xl px-5 pb-16 sm:px-8 sm:pb-20">
          <div className="rounded-xl border border-[#d2dfd5] bg-[#edf4ee] p-8 sm:p-12">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-bold tracking-tight text-[#112419] sm:text-3xl">
                {t.landing.cta.title}
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-[#496653]">
                {t.landing.cta.description}
              </p>

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Link
                  to="/login"
                  className="inline-flex items-center gap-2 rounded-lg bg-[#184e34] px-5 py-2.5 text-xs sm:text-sm font-semibold text-white shadow-xs transition hover:bg-[#113d28] active:translate-y-px"
                >
                  <span>{t.landing.cta.dashboardBtn}</span>
                  <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </Link>
                <Link
                  to="/privacy"
                  className="inline-flex items-center gap-2 rounded-lg border border-[#c4d6c7] bg-white px-4 py-2.5 text-xs sm:text-sm font-medium text-[#294c37] transition hover:bg-[#f6faf6] active:translate-y-px"
                >
                  <span>{t.landing.cta.privacyBtn}</span>
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>
    </PublicSiteLayout>
  );
}
