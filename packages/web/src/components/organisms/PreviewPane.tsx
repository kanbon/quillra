import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Heading } from "@/components/atoms/Heading";

type Props = {
  src: string | null;
  onRefresh: () => void;
  onStartPreview: () => void;
  starting?: boolean;
  engineLabel?: string;
  startLabel: string;
  errorMessage?: string | null;
};

const startSteps = [
  "Preparing workspace…",
  "Installing dependencies if needed…",
  "Starting dev server…",
];

function usePreviewReady(src: string | null) {
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);
  const prevSrc = useRef<string | null>(null);

  useEffect(() => {
    if (!src) {
      setReady(false);
      setProgress(0);
      prevSrc.current = null;
      return;
    }

    // If src changed (refresh), check immediately
    const baseUrl = src.split("?")[0];
    const prevBase = prevSrc.current?.split("?")[0];
    if (baseUrl === prevBase && ready) return;
    prevSrc.current = src;

    setReady(false);
    setProgress(0);
    let attempt = 0;
    const maxAttempts = 30;
    let cancelled = false;

    const poll = async () => {
      while (attempt < maxAttempts && !cancelled) {
        attempt++;
        setProgress(Math.min(90, (attempt / maxAttempts) * 100));
        try {
          const res = await fetch(src.split("?")[0], { method: "HEAD", cache: "no-store" });
          if (res.ok) {
            setProgress(100);
            setTimeout(() => { if (!cancelled) setReady(true); }, 300);
            return;
          }
        } catch { /* not ready yet */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
      // After max attempts, show it anyway (might work)
      if (!cancelled) {
        setProgress(100);
        setReady(true);
      }
    };

    void poll();
    return () => { cancelled = true; };
  }, [src]);

  return { ready, progress };
}

export function PreviewPane({
  src,
  onRefresh,
  onStartPreview,
  starting,
  engineLabel,
  startLabel,
  errorMessage,
}: Props) {
  const hasFrame = Boolean(src);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const { ready, progress } = usePreviewReady(src);
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
    <div className="flex h-full min-h-0 flex-col border-l border-neutral-200 bg-neutral-50">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-3">
        <div>
          <Heading as="h3" className="text-[15px] font-semibold tracking-tight text-neutral-900">
            Live preview
          </Heading>
          {engineLabel && engineLabel !== "—" ? (
            <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-400">
              {engineLabel}
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-neutral-400">Local dev server in your repo</p>
          )}
        </div>
        <Button variant="outline" type="button" onClick={onRefresh} disabled={starting || !hasFrame || !ready}>
          Refresh
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 bg-neutral-100/80">
        {hasFrame && ready ? (
          <>
            {!bannerDismissed && (
              <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-amber-50/95 px-3 py-1.5 text-xs text-amber-700 backdrop-blur-sm">
                <span>Dev preview — may be slower than production</span>
                <button
                  type="button"
                  className="ml-2 rounded px-1.5 py-0.5 text-amber-500 hover:bg-amber-100 hover:text-amber-700"
                  onClick={() => setBannerDismissed(true)}
                >
                  &#10005;
                </button>
              </div>
            )}
            <iframe
              ref={iframeRef}
              title="Site preview"
              src={src!}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              className="h-full w-full border-0 bg-white shadow-inner animate-[fadeIn_0.3s_ease-out]"
              onLoad={handleIframeLoad}
            />
          </>
        ) : hasFrame && !ready ? (
          /* Waiting for preview server to be ready */
          <div className="flex h-full flex-col items-center justify-center px-8 py-12">
            <div className="relative mb-8 h-16 w-16">
              {/* Outer ring */}
              <svg className="h-16 w-16" viewBox="0 0 64 64">
                <circle
                  cx="32" cy="32" r="28"
                  fill="none"
                  stroke="#e5e5e5"
                  strokeWidth="3"
                />
                <circle
                  cx="32" cy="32" r="28"
                  fill="none"
                  stroke="#c1121f"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${progress * 1.76} 176`}
                  className="transition-all duration-500 ease-out"
                  style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold text-neutral-500">
                {Math.round(progress)}%
              </span>
            </div>
            <p className="mb-2 text-center text-sm font-medium text-neutral-700">
              Starting your preview
            </p>
            <p className="text-center text-xs text-neutral-400">
              Setting up the dev server — this usually takes a few seconds
            </p>
            <div className="mt-6 h-1 w-48 max-w-full overflow-hidden rounded-full bg-neutral-200/80">
              <div
                className="h-full rounded-full bg-brand/40 transition-all duration-500 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : starting ? (
          <div className="flex h-full flex-col items-center justify-center px-8 py-12">
            <div
              className="mb-8 h-14 w-14 rounded-full border-2 border-brand/20 border-t-brand"
              style={{ animation: "preview-orbit 0.9s linear infinite" }}
              aria-hidden
            />
            <p className="mb-6 text-center text-sm font-medium text-neutral-800">Starting preview</p>
            <ul className="flex w-full max-w-xs flex-col gap-3">
              {startSteps.map((label, i) => (
                <li
                  key={label}
                  className="flex items-center gap-3 text-sm text-neutral-600"
                  style={{
                    animation: `preview-pulse 1.8s ease-in-out ${i * 0.35}s infinite`,
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
                    style={{
                      animation: `preview-pulse 1.2s ease-in-out ${i * 0.25}s infinite`,
                    }}
                  />
                  {label}
                </li>
              ))}
            </ul>
            <div
              className="mt-10 h-1 w-48 max-w-full overflow-hidden rounded-full bg-neutral-200/80"
              aria-hidden
            >
              <div
                className="h-full w-1/2 rounded-full"
                style={{
                  background:
                    "linear-gradient(90deg, transparent, rgba(193, 18, 31, 0.45), transparent)",
                  backgroundSize: "200% 100%",
                  animation: "preview-shimmer 1.5s ease-in-out infinite",
                }}
              />
            </div>
          </div>
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
              No preview yet
            </Heading>
            <p className="mb-8 max-w-sm text-center text-sm leading-relaxed text-neutral-500">
              Spin up the dev server to see your site here. The first run may take a minute while dependencies
              install.
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
