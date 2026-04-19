import { Modal } from "@/components/atoms/Modal";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
/**
 * Live preview debug modal.
 *
 * Fetches /api/projects/:id/preview-debug and renders every piece of
 * information relevant to diagnosing a broken preview: project info,
 * detected framework, resolved dev command, port + URL + stage, child
 * process status, upstream HTTP probe, subdomain mapping, workspace
 * state, and the last 120 lines of dev server stdout/stderr.
 *
 * Refresh button + auto-refresh every 2s while the logs are visible.
 */
import { useEffect, useMemo, useState } from "react";

type DebugResponse = {
  project: {
    id: string;
    name: string;
    githubRepoFullName: string;
    defaultBranch: string;
    previewDevCommandOverride: string | null;
  };
  framework: {
    id: string;
    label: string;
    iconSlug: string;
    color: string;
    optimizes: boolean;
  } | null;
  workspace: {
    repoPath: string;
    repoExists: boolean;
    hasPackageJson: boolean;
    hasNodeModules: boolean;
    packageManager: string | null;
    packageJsonScripts: Record<string, string> | null;
    rootFiles: string[];
  };
  devCommand: { command: string; args: string[]; label: string } | null;
  preview: {
    port: number;
    previewUrl: string;
    subdomainHost: string | null;
    subdomainId: string | null;
    stage: string;
    stageMessage: string | null;
    stageUpdatedAt: number;
  };
  childProcess: {
    running: boolean;
    pid: number | null;
    exitCode: number | null;
    signalCode: string | null;
  };
  upstreamProbe: {
    ok: boolean;
    status?: number;
    contentType?: string;
    error?: string;
  };
  logs: Array<{ t: number; stream: "stdout" | "stderr"; line: string }>;
  serverTime: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: string;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-[12px]">
      <span className="shrink-0 text-neutral-500">{label}</span>
      <span className="min-w-0 flex-1 text-right font-mono text-[11px] text-neutral-800">
        {children}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-neutral-50/50 p-4">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h3>
      <div className="divide-y divide-neutral-200/70">{children}</div>
    </section>
  );
}

function Pill({
  tone,
  children,
}: { tone: "ok" | "warn" | "err" | "neutral"; children: React.ReactNode }) {
  const colors = {
    ok: "bg-green-100 text-green-700",
    warn: "bg-amber-100 text-amber-700",
    err: "bg-red-100 text-red-700",
    neutral: "bg-neutral-200 text-neutral-700",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        colors[tone],
      )}
    >
      {children}
    </span>
  );
}

export function PreviewDebugModal({ open, onClose, projectId }: Props) {
  const [data, setData] = useState<DebugResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [actionBusy, setActionBusy] = useState<null | "reinstall" | "restart">(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiJson<DebugResponse>(`/api/projects/${projectId}/preview-debug`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  useEffect(() => {
    if (!open || !autoRefresh) return;
    const id = setInterval(() => {
      void load();
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoRefresh, projectId]);

  const stageTone: "ok" | "warn" | "err" | "neutral" = useMemo(() => {
    if (!data) return "neutral";
    if (data.preview.stage === "ready") return "ok";
    if (data.preview.stage === "error") return "err";
    return "warn";
  }, [data]);

  const probeTone: "ok" | "err" = data?.upstreamProbe.ok ? "ok" : "err";

  async function copyAll() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    } catch {
      /* ignore */
    }
  }

  async function runReinstall() {
    if (actionBusy) return;
    setActionBusy("reinstall");
    setActionMsg("Wiping node_modules and reinstalling…");
    try {
      await apiJson(`/api/projects/${projectId}/reinstall`, { method: "POST" });
      setActionMsg("Reinstall complete. Restarting preview…");
      await apiJson(`/api/projects/${projectId}/preview`, { method: "POST" });
      setActionMsg("Preview restarted.");
      void load();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Reinstall failed");
    } finally {
      setActionBusy(null);
    }
  }

  async function restartPreview() {
    if (actionBusy) return;
    setActionBusy("restart");
    setActionMsg("Restarting dev server…");
    try {
      await apiJson(`/api/projects/${projectId}/preview`, { method: "POST" });
      setActionMsg("Preview restarted.");
      void load();
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "Restart failed");
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} className="max-w-3xl">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-neutral-900">Preview debug</h2>
          <p className="mt-0.5 text-[13px] text-neutral-500">
            Everything Quillra knows about the live preview for this project.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2 py-1 text-[11px] font-medium text-neutral-600">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-3 w-3 accent-brand"
            />
            Auto
          </label>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-500 transition-colors hover:bg-neutral-50 hover:text-neutral-900 disabled:opacity-40"
            title="Refresh"
          >
            <svg
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v6h6M20 20v-6h-6M5.5 9A8 8 0 0118 8.5M18.5 15A8 8 0 016 15.5"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={copyAll}
            className="flex h-7 items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 text-[11px] font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
            title="Copy full JSON"
          >
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
            Copy JSON
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
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
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50/60 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Quick actions */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={restartPreview}
          disabled={!!actionBusy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 text-[12px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
          title="Kill the dev server child and start a fresh one"
        >
          <svg
            className={cn("h-3.5 w-3.5", actionBusy === "restart" && "animate-spin")}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 4v6h6M20 20v-6h-6M5.5 9A8 8 0 0118 8.5M18.5 15A8 8 0 016 15.5"
            />
          </svg>
          Restart dev server
        </button>
        <button
          type="button"
          onClick={runReinstall}
          disabled={!!actionBusy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-100 disabled:opacity-50"
          title="Wipe node_modules and reinstall dependencies with devDependencies included"
        >
          <svg
            className={cn("h-3.5 w-3.5", actionBusy === "reinstall" && "animate-spin")}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2h7m3-3l3 3m0 0l3-3m-3 3V9"
            />
          </svg>
          Reinstall dependencies
        </button>
        {actionMsg && <span className="text-[11px] text-neutral-500">{actionMsg}</span>}
      </div>

      {!data && !error && (
        <div className="flex items-center justify-center py-10">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
        </div>
      )}

      {data && (
        <div className="max-h-[72vh] space-y-4 overflow-y-auto pr-1">
          {/* Preview state */}
          <Section title="Preview state">
            <Row label="Stage">
              <Pill tone={stageTone}>{data.preview.stage}</Pill>
              {data.preview.stageMessage && (
                <span className="ml-2 text-neutral-500">{data.preview.stageMessage}</span>
              )}
            </Row>
            <Row label="Port">{data.preview.port}</Row>
            <Row label="Public URL">
              <a
                href={data.preview.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand underline-offset-2 hover:underline"
              >
                {data.preview.previewUrl}
              </a>
            </Row>
            {data.preview.subdomainHost && (
              <Row label="Subdomain host">{data.preview.subdomainHost}</Row>
            )}
            {data.preview.subdomainId && <Row label="Subdomain id">{data.preview.subdomainId}</Row>}
            <Row label="Stage updated">
              {new Date(data.preview.stageUpdatedAt).toLocaleTimeString()}
            </Row>
          </Section>

          {/* Upstream probe */}
          <Section title="Upstream probe (localhost)">
            <Row label="Reachable">
              <Pill tone={probeTone}>{data.upstreamProbe.ok ? "yes" : "no"}</Pill>
            </Row>
            {data.upstreamProbe.status !== undefined && (
              <Row label="HTTP status">{data.upstreamProbe.status}</Row>
            )}
            {data.upstreamProbe.contentType && (
              <Row label="Content-Type">{data.upstreamProbe.contentType}</Row>
            )}
            {data.upstreamProbe.error && (
              <Row label="Error">
                <span className="text-red-600">{data.upstreamProbe.error}</span>
              </Row>
            )}
          </Section>

          {/* Child process */}
          <Section title="Dev server process">
            <Row label="Running">
              <Pill tone={data.childProcess.running ? "ok" : "err"}>
                {data.childProcess.running ? "yes" : "no"}
              </Pill>
            </Row>
            {data.childProcess.pid !== null && <Row label="PID">{data.childProcess.pid}</Row>}
            {data.childProcess.exitCode !== null && (
              <Row label="Exit code">{data.childProcess.exitCode}</Row>
            )}
            {data.childProcess.signalCode && (
              <Row label="Signal">{data.childProcess.signalCode}</Row>
            )}
          </Section>

          {/* Framework + dev command */}
          <Section title="Framework & dev command">
            <Row label="Detected">
              {data.framework ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="flex h-4 w-4 items-center justify-center rounded"
                    style={{ backgroundColor: data.framework.color }}
                  >
                    <img
                      src={`https://cdn.simpleicons.org/${data.framework.iconSlug}/ffffff`}
                      alt=""
                      width={9}
                      height={9}
                    />
                  </span>
                  {data.framework.label}
                </span>
              ) : (
                <Pill tone="warn">none</Pill>
              )}
            </Row>
            {data.devCommand && (
              <>
                <Row label="Label">{data.devCommand.label}</Row>
                <Row label="Command">
                  <code className="rounded bg-white px-1 py-0.5 ring-1 ring-neutral-200">
                    {[data.devCommand.command, ...data.devCommand.args].join(" ")}
                  </code>
                </Row>
              </>
            )}
            {data.project.previewDevCommandOverride && (
              <Row label="Override (project)">
                <code className="rounded bg-white px-1 py-0.5 ring-1 ring-neutral-200">
                  {data.project.previewDevCommandOverride}
                </code>
              </Row>
            )}
          </Section>

          {/* Workspace */}
          <Section title="Workspace">
            <Row label="Repo path">
              <code className="text-[10px]">{data.workspace.repoPath}</code>
            </Row>
            <Row label="Cloned">
              <Pill tone={data.workspace.repoExists ? "ok" : "err"}>
                {data.workspace.repoExists ? "yes" : "no"}
              </Pill>
            </Row>
            <Row label="package.json">
              <Pill tone={data.workspace.hasPackageJson ? "ok" : "warn"}>
                {data.workspace.hasPackageJson ? "present" : "missing"}
              </Pill>
            </Row>
            <Row label="node_modules">
              <Pill tone={data.workspace.hasNodeModules ? "ok" : "warn"}>
                {data.workspace.hasNodeModules ? "installed" : "missing"}
              </Pill>
            </Row>
            {data.workspace.packageManager && (
              <Row label="Package manager">{data.workspace.packageManager}</Row>
            )}
            {data.workspace.packageJsonScripts &&
              Object.keys(data.workspace.packageJsonScripts).length > 0 && (
                <div className="pt-2">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                    package.json scripts
                  </p>
                  <div className="rounded-md bg-white p-2 ring-1 ring-neutral-200">
                    {Object.entries(data.workspace.packageJsonScripts).map(([k, v]) => (
                      <div key={k} className="flex gap-2 font-mono text-[10px]">
                        <span className="shrink-0 text-brand">{k}:</span>
                        <span className="truncate text-neutral-700">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            {data.workspace.rootFiles.length > 0 && (
              <div className="pt-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
                  Root files ({data.workspace.rootFiles.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {data.workspace.rootFiles.map((f) => (
                    <span
                      key={f}
                      className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-neutral-600 ring-1 ring-neutral-200"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Section>

          {/* Project */}
          <Section title="Project">
            <Row label="ID">
              <code className="text-[10px]">{data.project.id}</code>
            </Row>
            <Row label="Name">{data.project.name}</Row>
            <Row label="Repo">
              <a
                href={`https://github.com/${data.project.githubRepoFullName}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand underline-offset-2 hover:underline"
              >
                {data.project.githubRepoFullName}
              </a>
            </Row>
            <Row label="Branch">{data.project.defaultBranch}</Row>
          </Section>

          {/* Logs */}
          <Section title={`Dev server logs (${data.logs.length})`}>
            {data.logs.length === 0 ? (
              <p className="py-2 text-center text-[11px] text-neutral-400">No output yet</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-md bg-neutral-900 p-2 font-mono text-[10px] leading-snug text-neutral-100">
                {data.logs.map((l, i) => (
                  <div key={i} className="flex gap-2 whitespace-pre-wrap">
                    <span
                      className={cn(
                        "shrink-0",
                        l.stream === "stderr" ? "text-red-300" : "text-neutral-500",
                      )}
                    >
                      {new Date(l.t).toLocaleTimeString()}
                    </span>
                    <span
                      className={cn(l.stream === "stderr" ? "text-red-200" : "text-neutral-200")}
                    >
                      {l.line}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}
    </Modal>
  );
}
