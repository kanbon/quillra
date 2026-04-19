import { Modal } from "@/components/atoms/Modal";
import { Spinner } from "@/components/atoms/Spinner";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useQueryClient } from "@tanstack/react-query";
/**
 * Technical, git-like changes overview for the ProjectHeader "N changes"
 * pill. Shows one collapsible card per changed file with its unified diff
 * (red/green line-by-line), plus a list of unpushed commits at the top.
 *
 * Deliberately not pretty and not translated — this is the debug view the
 * user asked for: "a technical almost debug like overview of changes".
 * It's meant to be informationally dense and instantly obvious to anyone
 * who has ever typed `git status`. We do not apologize for showing raw
 * diff hunks here — that's the point.
 */
import { useEffect, useState } from "react";

type FileStatus = "modified" | "added" | "deleted" | "untracked" | "renamed";

type FileChange = {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  diff: string;
  isBinary: boolean;
};

type CommitEntry = {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
};

type ChangesResponse = {
  files: FileChange[];
  commits: CommitEntry[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: string;
};

const STATUS_STYLES: Record<FileStatus, { label: string; cls: string }> = {
  modified: { label: "MODIFIED", cls: "bg-amber-100 text-amber-800" },
  added: { label: "ADDED", cls: "bg-green-100 text-green-800" },
  deleted: { label: "DELETED", cls: "bg-red-100 text-red-800" },
  untracked: { label: "UNTRACKED", cls: "bg-blue-100 text-blue-800" },
  renamed: { label: "RENAMED", cls: "bg-purple-100 text-purple-800" },
};

/** Split a unified diff into lines and colour them by their prefix. */
function renderDiffLines(diff: string) {
  const lines = diff.split("\n");
  return lines.map((line, i) => {
    let cls = "text-neutral-600";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "text-neutral-400";
    else if (line.startsWith("+")) cls = "bg-green-50 text-green-800";
    else if (line.startsWith("-")) cls = "bg-red-50 text-red-800";
    else if (line.startsWith("@@")) cls = "bg-blue-50 text-blue-700";
    return (
      <div key={i} className={cn("whitespace-pre px-3 font-mono text-[11px] leading-[1.5]", cls)}>
        {line || " "}
      </div>
    );
  });
}

function FileCard({ file }: { file: FileChange }) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLES[file.status];
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-50"
      >
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide",
            style.cls,
          )}
        >
          {style.label}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-neutral-800">
          {file.path}
        </code>
        {!file.isBinary && (file.additions > 0 || file.deletions > 0) && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-green-700">+{file.additions}</span>{" "}
            <span className="text-red-700">-{file.deletions}</span>
          </span>
        )}
        {file.isBinary && (
          <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
            binary
          </span>
        )}
        <svg
          className={cn(
            "h-4 w-4 shrink-0 text-neutral-400 transition-transform",
            expanded && "rotate-90",
          )}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {expanded && !file.isBinary && file.diff && (
        <div className="max-h-[400px] overflow-auto border-t border-neutral-200 bg-neutral-50 py-1">
          {renderDiffLines(file.diff)}
        </div>
      )}
      {expanded && file.isBinary && (
        <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-3 text-[11px] text-neutral-500">
          Binary file — no diff preview.
        </div>
      )}
      {expanded && !file.isBinary && !file.diff && (
        <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-3 text-[11px] text-neutral-500">
          No diff available.
        </div>
      )}
    </div>
  );
}

export function ChangesModal({ open, onClose, projectId }: Props) {
  const { t } = useT();
  const qc = useQueryClient();
  const [data, setData] = useState<ChangesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiscardError(null);
    (async () => {
      try {
        const r = await apiJson<ChangesResponse>(`/api/projects/${projectId}/changes`);
        if (!cancelled) setData(r);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  async function discardAll() {
    if (!data) return;
    const total = data.files.length + data.commits.length;
    if (total === 0) return;
    const ok = confirm(t("changes.discardConfirm", { count: String(total) }));
    if (!ok) return;
    setDiscarding(true);
    setDiscardError(null);
    try {
      await apiJson(`/api/projects/${projectId}/discard-changes`, { method: "POST" });
      // Invalidate the polling publish-status so the "N changes" pill
      // in the header flips back to hidden immediately.
      void qc.invalidateQueries({ queryKey: ["publish-status", projectId] });
      // Tell the Editor (if mounted) to refresh its preview iframe.
      // The dev server's file watcher should HMR most edits, but a
      // hard reset touches a lot of files at once — a cheap iframe
      // src bump guarantees the user sees the reverted state
      // without having to manually refresh.
      window.dispatchEvent(new CustomEvent("quillra:refresh-preview"));
      onClose();
    } catch (e) {
      setDiscardError(e instanceof Error ? e.message : "Failed");
    } finally {
      setDiscarding(false);
    }
  }

  const totalChanges = data ? data.files.length + data.commits.length : 0;

  return (
    <Modal open={open} onClose={onClose} className="max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">Pending changes</h2>
          <p className="text-[12px] text-neutral-500">
            Technical view — uncommitted files and unpushed commits.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-2 -mt-1 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          aria-label="Close"
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

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Spinner className="size-5" />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">
          {error}
        </div>
      )}

      {data && !loading && (
        <div className="max-h-[70vh] space-y-4 overflow-auto pr-1">
          {data.files.length === 0 && data.commits.length === 0 && (
            <div className="rounded-lg border border-dashed border-neutral-200 bg-neutral-50 px-4 py-10 text-center text-[12px] text-neutral-400">
              Working tree clean. No changes to publish.
            </div>
          )}

          {data.commits.length > 0 && (
            <section>
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Unpushed commits · {data.commits.length}
              </h3>
              <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
                {data.commits.map((commit) => (
                  <div
                    key={commit.sha}
                    className="flex items-start gap-3 border-b border-neutral-100 px-3 py-2 last:border-b-0"
                  >
                    <code className="mt-0.5 shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600">
                      {commit.shortSha}
                    </code>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] text-neutral-800">{commit.message}</p>
                      <p className="mt-0.5 text-[10px] text-neutral-400">
                        {commit.author} · {new Date(commit.date).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {data.files.length > 0 && (
            <section>
              <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                Working tree · {data.files.length} {data.files.length === 1 ? "file" : "files"}
              </h3>
              <div className="space-y-2">
                {data.files.map((f) => (
                  <FileCard key={f.path} file={f} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {data && !loading && totalChanges > 0 && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-neutral-100 pt-4">
          <div className="min-w-0 flex-1">
            {discardError && <p className="text-[11px] text-red-600">{discardError}</p>}
          </div>
          <button
            type="button"
            onClick={discardAll}
            disabled={discarding}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 text-[12px] font-semibold text-red-600 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
          >
            {discarding ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-red-300 border-t-red-600" />
                {t("changes.discarding")}
              </>
            ) : (
              <>
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                {t("changes.discard")}
              </>
            )}
          </button>
        </div>
      )}
    </Modal>
  );
}
