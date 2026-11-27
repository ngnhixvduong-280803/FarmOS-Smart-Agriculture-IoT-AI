import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { PublicSiteLayout } from "../components/PublicSiteLayout";
import { useI18n } from "../context/I18nContext";

export function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const { t } = useI18n();
  const page = kind === "privacy" ? t.legal.privacy : t.legal.terms;
  const contactBody = kind === "privacy" ? t.legal.contactPrivacyBody : t.legal.contactTermsBody;

  return (
    <PublicSiteLayout>
      <main className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
        <Link className="inline-flex items-center gap-2 text-sm font-semibold text-[#306045] hover:text-[#126a48]" to="/">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
          {t.legal.backToHome}
        </Link>
        <article className="mt-8 rounded-2xl border border-[#d8e2d8] bg-white px-6 py-9 shadow-[0_12px_30px_rgba(18,45,29,0.06)] sm:px-10 sm:py-12">
          <p className="text-sm font-bold uppercase tracking-[0.14em] text-[#16704d]">FarmOS</p>
          <h1 className="mt-3 text-4xl font-bold tracking-[-0.04em] text-[#102319] sm:text-5xl">{page.title}</h1>
          <p className="mt-4 text-sm text-[#667a6b]">{t.legal.effectiveDate}</p>
          <p className="mt-8 text-base leading-7 text-[#3f5747]">{page.intro}</p>
          <div className="mt-10 space-y-9">
            {page.sections.map((section) => (
              <section key={section.title}>
                <h2 className="text-xl font-semibold tracking-[-0.02em] text-[#173124]">{section.title}</h2>
                <div className="mt-3 space-y-4 text-base leading-7 text-[#496152]">
                  {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                </div>
              </section>
            ))}
            <section>
              <h2 className="text-xl font-semibold tracking-[-0.02em] text-[#173124]">{t.legal.contactTitle}</h2>
              <p className="mt-3 text-base leading-7 text-[#496152]">
                {contactBody}{" "}
                <a className="font-medium text-[#126a48] underline underline-offset-4" href="mailto:farmos.iuh@gmail.com">
                  farmos.iuh@gmail.com
                </a>
                .
              </p>
            </section>
          </div>
        </article>
      </main>
    </PublicSiteLayout>
  );
}
