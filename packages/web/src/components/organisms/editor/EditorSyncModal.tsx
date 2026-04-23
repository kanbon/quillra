/**
 * Blocking modal shown on editor load when the workspace has both local
 * changes and new remote commits. Two choices, plain-language buttons,
 * no "merge" or "rebase" jargon.
 *
 * Shown via useEditorSync's `phase === "needs_choice"`. While the user is
 * mid-action, `phase === "working"` flips the buttons to a busy state.
 * The working state also covers the post-conflict-resolver commit so the
 * user sees a single spinner rather than two.
 */

import type { SyncController } from "./useEditorSync";

function timeAgo(when: number): string {
  const diff = Date.now() - when;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function EditorSyncModal({ controller }: { controller: SyncController }) {
  const { phase, status, error, acceptMerge, acceptDiscard } = controller;
  const visible = phase === "needs_choice" || phase === "working" || phase === "failed";
  if (!visible) return null;
  if (!status || status.state !== "behind_with_local_changes") {
    if (phase !== "failed") return null;
  }

  const behindInfo = status && status.state === "behind_with_local_changes" ? status : null;

  const busy = phase === "working";

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl">
        <div className="border-b border-neutral-200 p-6">
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600">
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 9v4m0 4h.01" />
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              </svg>
            </span>
            <h2 className="text-[17px] font-semibold tracking-tight text-neutral-900">
              Your team pushed new changes
            </h2>
          </div>
          <p className="text-[13.5px] leading-relaxed text-neutral-600">
            Someone on your team updated this site while you were away, and you also have your own
            unsaved edits. Pick how you want to combine them.
          </p>
        </div>

        {behindInfo && (
          <div className="max-h-48 space-y-3 overflow-y-auto border-b border-neutral-200 px-6 py-4 text-[12.5px]">
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                New from your team ({behindInfo.remoteAhead})
              </p>
              <ul className="space-y-1">
                {behindInfo.remoteCommits.slice(0, 6).map((c) => (
                  <li key={c.sha} className="text-neutral-700">
                    <span className="text-neutral-900">{c.message.split("\n")[0]}</span>{" "}
                    <span className="text-neutral-400">
                      by {c.author || "someone"} · {timeAgo(c.when)}
                    </span>
                  </li>
                ))}
                {behindInfo.remoteCommits.length > 6 && (
                  <li className="text-neutral-400">+ {behindInfo.remoteCommits.length - 6} more</li>
                )}
              </ul>
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                Your unsaved changes ({behindInfo.localChanges.length})
              </p>
              <ul className="space-y-0.5 font-mono text-[11.5px] text-neutral-700">
                {behindInfo.localChanges.slice(0, 8).map((f) => (
                  <li key={f.path}>
                    <span className="text-neutral-400">{f.status[0]?.toUpperCase() ?? "M"}</span>{" "}
                    {f.path}
                  </li>
                ))}
                {behindInfo.localChanges.length > 8 && (
                  <li className="text-neutral-400">+ {behindInfo.localChanges.length - 8} more</li>
                )}
              </ul>
            </div>
          </div>
        )}

        {error && (
          <div className="border-b border-red-200 bg-red-50 px-6 py-3 text-[12.5px] text-red-700">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2 p-5 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => void acceptDiscard()}
            disabled={busy}
            className="inline-flex h-11 items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 text-[13px] font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Hard-reset onto origin; your uncommitted edits are gone."
          >
            Throw away my changes
          </button>
          <button
            type="button"
            onClick={() => void acceptMerge()}
            disabled={busy}
            className="inline-flex h-11 items-center justify-center rounded-lg bg-neutral-900 px-4 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Working…" : "Keep my changes and update"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Small floating toast that sits under the project header while the
 * sync check auto-pulled silently. Disappears after a few seconds.
 */
export function EditorSyncToast({ toast }: { toast: string | null }) {
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed right-4 top-16 z-50">
      <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[12.5px] text-neutral-800 shadow-md">
        {toast}
      </div>
    </div>
  );
}
