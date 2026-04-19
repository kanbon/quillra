import { Modal } from "@/components/atoms/Modal";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useQuery } from "@tanstack/react-query";
/**
 * Version history modal — sources from the git commit log in the cloned
 * workspace. Shows a vertical timeline with author, message, relative
 * time, short SHA, and whether the commit has been pushed to origin yet.
 */
import { useMemo } from "react";

type Commit = {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  message: string;
  subject: string;
  body: string;
  timestamp: number;
  isHead: boolean;
  isPushed: boolean;
};

type Response = {
  commits: Commit[];
  branch: string;
  repo: string;
  headSha: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: string;
};

function initialsOf(name: string, email: string): string {
  const src = name || email;
  return (
    src
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "·"
  );
}

function timeAgo(ts: number, locale: string): string {
  const diffSec = Math.max(0, (Date.now() - ts) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diffSec < 60) return rtf.format(-Math.round(diffSec), "second");
  if (diffSec < 3600) return rtf.format(-Math.round(diffSec / 60), "minute");
  if (diffSec < 86400) return rtf.format(-Math.round(diffSec / 3600), "hour");
  if (diffSec < 604800) return rtf.format(-Math.round(diffSec / 86400), "day");
  if (diffSec < 2592000) return rtf.format(-Math.round(diffSec / 604800), "week");
  if (diffSec < 31536000) return rtf.format(-Math.round(diffSec / 2592000), "month");
  return rtf.format(-Math.round(diffSec / 31536000), "year");
}

export function VersionHistoryModal({ open, onClose, projectId }: Props) {
  const { t, language } = useT();
  const q = useQuery({
    queryKey: ["project-commits", projectId],
    queryFn: () => apiJson<Response>(`/api/projects/${projectId}/commits?limit=50`),
    enabled: open,
  });

  const commits = q.data?.commits ?? [];
  const headerMeta = useMemo(() => {
    if (!q.data) return null;
    return { branch: q.data.branch, repo: q.data.repo };
  }, [q.data]);

  return (
    <Modal open={open} onClose={onClose} className="max-w-2xl">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">
            {t("versionHistory.title")}
          </h2>
          {headerMeta && (
            <p className="mt-0.5 text-[12px] text-neutral-500">
              <code className="font-mono">{headerMeta.repo}</code>
              {" · "}
              <span className="font-medium">{headerMeta.branch}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 -mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          aria-label={t("common.close")}
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {q.isLoading && (
        <div className="flex items-center justify-center py-14">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
        </div>
      )}

      {q.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50/60 p-4 text-sm text-red-700">
          {(q.error as Error)?.message ?? t("versionHistory.loadError")}
        </div>
      )}

      {q.data && commits.length === 0 && (
        <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/50 p-8 text-center text-sm text-neutral-400">
          {t("versionHistory.empty")}
        </div>
      )}

      {q.data && commits.length > 0 && (
        <div className="max-h-[72vh] overflow-y-auto">
          <ol className="relative">
            {/* Vertical timeline line */}
            <div className="absolute left-[17px] top-3 bottom-3 w-px bg-neutral-200" aria-hidden />
            {commits.map((c) => (
              <li key={c.sha} className="relative flex gap-3 py-3">
                {/* Avatar / marker */}
                <div className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-white bg-gradient-to-br from-neutral-100 to-neutral-200 text-[10px] font-semibold text-neutral-500 shadow-sm ring-1 ring-neutral-200">
                  {initialsOf(c.author, c.email)}
                </div>
                {/* Content */}
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-start justify-between gap-2">
                    <p
                      className={cn(
                        "min-w-0 flex-1 text-[13px] leading-snug text-neutral-900",
                        c.isHead && "font-semibold",
                      )}
                    >
                      {c.subject}
                    </p>
                    {c.isHead && (
                      <span className="shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
                        {t("versionHistory.latest")}
                      </span>
                    )}
                    {!c.isPushed && (
                      <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700">
                        {t("versionHistory.notPushed")}
                      </span>
                    )}
                  </div>
                  {c.body && (
                    <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-[11px] leading-snug text-neutral-500">
                      {c.body}
                    </p>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-400">
                    <span className="font-medium text-neutral-600">{c.author}</span>
                    <span className="text-neutral-300">·</span>
                    <span>{timeAgo(c.timestamp, language)}</span>
                    <span className="text-neutral-300">·</span>
                    <code className="rounded bg-neutral-100 px-1 font-mono text-[10px] text-neutral-600">
                      {c.shortSha}
                    </code>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
