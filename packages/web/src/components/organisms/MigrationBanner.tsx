/**
 * Full-bleed panel that takes over the preview column (and the mobile
 * preview sheet) while the migration agent is rewriting the project
 * to Astro. Non-interactive by design — the user is locked out of
 * intervening while the agent works. They can still watch the chat
 * transcript stream to see progress.
 *
 * Brand treatment: Astro's signature orange (#FF5D01) — muted, not
 * shouting. Subtle radial glow + a slow pulsing dot near the logo so
 * the card feels alive without a loud spinner.
 */
import { useT } from "@/i18n/i18n";

export function MigrationBanner() {
  const { t } = useT();
  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-[#FFF4EC] via-white to-[#FFEDDF] px-6 py-10">
      {/* Radial glow accents */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-20 -top-20 h-72 w-72 rounded-full bg-[#FF5D01] opacity-[0.08] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -right-16 h-80 w-80 rounded-full bg-[#FF5D01] opacity-[0.05] blur-3xl"
      />

      <div className="relative flex max-w-md flex-col items-center text-center">
        <div
          className="relative flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg"
          style={{ backgroundColor: "#FF5D01" }}
        >
          <img
            src="https://cdn.simpleicons.org/astro/ffffff"
            alt="Astro"
            width={32}
            height={32}
          />
          {/* Pulsing presence dot in the corner */}
          <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center">
            <span className="absolute h-4 w-4 animate-ping rounded-full bg-[#FF5D01] opacity-50" />
            <span className="relative h-2.5 w-2.5 rounded-full bg-[#FF5D01] ring-2 ring-white" />
          </span>
        </div>

        <h2 className="mt-6 text-xl font-semibold tracking-tight text-neutral-900">
          {t("migration.banner.title")}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-neutral-600">
          {t("migration.banner.subtitle")}
        </p>

        <div className="mt-6 flex items-center gap-2 rounded-full border border-[#FF5D01]/20 bg-white/70 px-3 py-1.5 text-[11px] font-medium text-[#FF5D01] shadow-sm backdrop-blur">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#FF5D01]" />
          {t("migration.banner.composerDisabled")}
        </div>
      </div>
    </div>
  );
}
