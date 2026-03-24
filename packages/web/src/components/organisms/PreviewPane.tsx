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
        <Button variant="outline" type="button" onClick={onRefresh} disabled={starting || !hasFrame}>
          Refresh
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 bg-neutral-100/80">
        {hasFrame ? (
          <iframe title="Site preview" src={src!} className="h-full w-full border-0 bg-white shadow-inner" />
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
