import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";
import { PreviewDebugModal } from "@/components/organisms/PreviewDebugModal";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  projectId: string;
  src: string | null;
  onRefresh: () => void;
  onStartPreview: () => void;
  starting?: boolean;
  engineLabel?: string;
  startLabel: string;
  errorMessage?: string | null;
  /** When true, render only the iframe/empty-state without the header bar.
      Used inside the mobile bottom sheet which has its own chrome. */
  compact?: boolean;
};

export function PreviewPane({
  projectId,
  src,
  onRefresh,
  onStartPreview,
  starting,
  engineLabel,
  startLabel,
  errorMessage,
  compact,
}: Props) {
  const { t } = useT();
  const hasFrame = Boolean(src);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("quillra:preview-banner-dismissed") === "1";
  });
  const dismissBanner = useCallback(() => {
    setBannerDismissed(true);
    try {
      window.localStorage.setItem("quillra:preview-banner-dismissed", "1");
    } catch { /* private mode etc. */ }
  }, []);
  const ready = hasFrame; // The iframe handles its own loading state via the proxy boot page
  const basePreviewPath = src?.split("?")[0] ?? "";

  const handleIframeLoad = useCallback(() => {
    try {
      const frame = iframeRef.current;
      if (!frame || !basePreviewPath) return;
      const currentSrc = frame.contentWindow?.location.href;
      if (currentSrc && !currentSrc.includes("/__preview/")) {
        frame.src = src!;
      }
    } catch { /* cross-origin */ }
  }, [src, basePreviewPath]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-neutral-50", !compact && "border-l border-neutral-200")}>
      {!compact && (
        <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
          <div>
            <Heading as="h3" className="text-[15px] font-semibold tracking-tight text-neutral-900">
              {t("preview.title")}
            </Heading>
            {engineLabel && engineLabel !== "—" ? (
              <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-400">
                {engineLabel}
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] text-neutral-400">{t("preview.subtitle")}</p>
            )}
          </div>
          {hasFrame && (
            <div className="flex items-center overflow-hidden rounded-lg border border-neutral-200 bg-white">
              <a
                href={ready && src ? src.split("?")[0] : "#"}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex h-8 w-9 items-center justify-center text-neutral-500 transition-colors no-underline",
                  ready
                    ? "hover:bg-neutral-50 hover:text-neutral-900"
                    : "pointer-events-none opacity-40",
                )}
                title={t("preview.openInNewTab")}
                aria-label={t("preview.openInNewTab")}
                onClick={(e) => { if (!ready) e.preventDefault(); }}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              <div className="h-5 w-px bg-neutral-200" />
              <button
                type="button"
                onClick={onRefresh}
                disabled={starting || !hasFrame || !ready}
                className="flex h-8 w-9 items-center justify-center text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-900 disabled:opacity-40 disabled:hover:bg-transparent"
                title={t("preview.refresh")}
                aria-label={t("preview.refresh")}
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6M5.5 9A8 8 0 0118 8.5M18.5 15A8 8 0 016 15.5" />
                </svg>
              </button>
              <div className="h-5 w-px bg-neutral-200" />
              <button
                type="button"
                onClick={() => setDebugOpen(true)}
                className="flex h-8 w-9 items-center justify-center text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
                title="Debug live preview"
                aria-label="Debug live preview"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 4l-2 3M16 4l2 3" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

      <PreviewDebugModal open={debugOpen} onClose={() => setDebugOpen(false)} projectId={projectId} />

      <div className="relative min-h-0 flex-1 bg-neutral-100/80">
        {hasFrame ? (
          <>
            {!bannerDismissed && (
              <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-amber-50/95 px-3 py-1.5 text-xs text-amber-700 backdrop-blur-sm">
                <span>{t("preview.devBanner")}</span>
                <button
                  type="button"
                  className="ml-2 rounded px-1.5 py-0.5 text-amber-500 hover:bg-amber-100 hover:text-amber-700"
                  onClick={dismissBanner}
                >
                  &#10005;
                </button>
              </div>
            )}
            <iframe
              ref={iframeRef}
              title={t("preview.iframeTitle")}
              src={src!}
              className="h-full w-full border-0 bg-white shadow-inner animate-[fadeIn_0.3s_ease-out]"
              onLoad={handleIframeLoad}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 py-10">
            <div
              className="mb-8 flex h-24 w-24 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-neutral-200/80"
              aria-hidden
            >
              <svg
                className="h-10 w-10 text-neutral-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.25}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008H12V8.25z"
                />
              </svg>
            </div>
            <Heading as="h3" className="mb-2 text-center text-lg font-semibold tracking-tight text-neutral-900">
              {t("preview.noPreview")}
            </Heading>
            <p className="mb-8 max-w-sm text-center text-sm leading-relaxed text-neutral-500">
              {t("preview.noPreviewHelp")}
            </p>
            {errorMessage ? (
              <p className="mb-4 max-w-sm text-center text-sm text-red-600">{errorMessage}</p>
            ) : null}
            <Button
              variant="brand"
              type="button"
              className="min-w-[200px] rounded-xl px-8 py-3 text-[15px] font-semibold shadow-md transition-transform hover:shadow-lg"
              onClick={onStartPreview}
            >
              {startLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
