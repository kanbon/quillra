import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";
/**
 * Full-bleed panel that takes over the preview column (and the mobile
 * preview sheet) while the migration agent is rewriting the project
 * to Astro. Non-interactive by design — the user is locked out of
 * intervening while the agent works.
 *
 * One exception: a subtle "Cancel" link at the bottom. The
 * migration_target flag can get stuck if the server crashes
 * mid-stream, the agent hits an unrecoverable error, or a container
 * restart drops the WebSocket before `done` fires. This link is the
 * frontend-reachable escape hatch — clicking it clears the flag
 * (and resets the workspace to origin) so the UI unlocks and the
 * user can either retry or use the project normally.
 *
 * Brand treatment: Astro orange (#FF5D01) gradient with soft radial
 * glows and a pulsing presence dot on the logo tile.
 */
import { useState } from "react";

type Props = {
  /** Called when the user clicks "Cancel migration". Handler is
   *  expected to POST /api/projects/:id/cancel-migration, then
   *  invalidate the project query so the banner unmounts. */
  onCancel?: () => Promise<void> | void;
};

export function MigrationBanner({ onCancel }: Props) {
  const { t } = useT();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCancel() {
    if (!onCancel || cancelling) return;
    const ok = confirm(t("migration.banner.cancelConfirm"));
    if (!ok) return;
    setCancelling(true);
    setError(null);
    try {
      await onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setCancelling(false);
    }
    // On success the parent unmounts the banner, so no need to flip
    // the spinner off — the component will be gone.
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col items-center justify-center overflow-hidden bg-gradient-to-br from-[#FFF4EC] via-white to-[#FFEDDF] px-6 py-10">
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
          <img src="https://cdn.simpleicons.org/astro/ffffff" alt="Astro" width={32} height={32} />
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

        {/* Subtle escape hatch — always visible so a stuck migration
            is recoverable without SQL. Spelled out in small grey
            text so it doesn't dominate the happy-path UI. */}
        {onCancel && (
          <div className="mt-10 text-[11px] leading-snug text-neutral-500">
            <p>{t("migration.banner.stuckHint")}</p>
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className={cn(
                "mt-1.5 font-medium text-neutral-600 underline-offset-2 transition-colors hover:text-red-600 hover:underline",
                cancelling && "cursor-wait opacity-60",
              )}
            >
              {cancelling ? t("migration.banner.cancelling") : t("migration.banner.cancel")}
            </button>
            {error && <p className="mt-2 text-red-600">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
