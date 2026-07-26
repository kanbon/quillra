import { Spinner } from "@/components/atoms/Spinner";
import type {
  E2bVerificationFeedback,
  E2bVerificationStageStatus,
} from "@/components/organisms/setup/types";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";
import { useEffect, useMemo, useRef, useState } from "react";

const CHECKS = [
  {
    id: "credentials",
    titleKey: "setup.secureExecution.checkCredentials",
    bodyKey: "setup.secureExecution.checkCredentialsBody",
  },
  {
    id: "sandbox",
    titleKey: "setup.secureExecution.checkSandbox",
    bodyKey: "setup.secureExecution.checkSandboxBody",
  },
  {
    id: "runtime",
    titleKey: "setup.secureExecution.checkRuntime",
    bodyKey: "setup.secureExecution.checkRuntimeBody",
  },
  {
    id: "privateAccess",
    titleKey: "setup.secureExecution.checkPrivateAccess",
    bodyKey: "setup.secureExecution.checkPrivateAccessBody",
  },
  {
    id: "cleanup",
    titleKey: "setup.secureExecution.checkCleanup",
    bodyKey: "setup.secureExecution.checkCleanupBody",
  },
] as const;

type CheckId = (typeof CHECKS)[number]["id"];

type Props = {
  feedback: E2bVerificationFeedback;
  enabled: boolean;
  hasCustomTemplate: boolean;
  canKeepExisting: boolean;
  onRetry: () => void;
  onRetryWithBaseTemplate: () => void;
  onKeepExisting: () => void;
};

function checkIdForStage(stageId: string | undefined): CheckId | null {
  if (!stageId) return null;
  const id = stageId.toLowerCase().replaceAll("_", "-");
  if (id.includes("cleanup") || id.includes("remove") || id.includes("kill")) return "cleanup";
  if (
    id.includes("traffic-server") ||
    id.includes("prerequisite") ||
    id.includes("runtime") ||
    id.includes("command") ||
    id.includes("tool")
  ) {
    return "runtime";
  }
  if (
    id.includes("protected-ingress") ||
    id.includes("traffic") ||
    id.includes("unauthenticated") ||
    id.includes("payload") ||
    id.includes("relay") ||
    id.includes("header") ||
    id.includes("private-access") ||
    id.includes("preview")
  ) {
    return "privateAccess";
  }
  if (
    id.includes("sandbox") ||
    id.includes("create") ||
    id.includes("boot") ||
    id.includes("start")
  ) {
    return "sandbox";
  }
  if (
    id.includes("credential") ||
    id.includes("api-key") ||
    id.includes("provider") ||
    id.includes("template") ||
    id.includes("connect")
  ) {
    return "credentials";
  }
  return null;
}

function aggregateStatuses(statuses: E2bVerificationStageStatus[]): E2bVerificationStageStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("pending")) return "pending";
  return statuses.every((status) => status === "passed") ? "passed" : "skipped";
}

function buildStatuses(
  feedback: E2bVerificationFeedback,
  enabled: boolean,
): Record<CheckId, E2bVerificationStageStatus> {
  const initial = Object.fromEntries(
    CHECKS.map(({ id }) => [id, enabled ? "passed" : "pending"]),
  ) as Record<CheckId, E2bVerificationStageStatus>;

  if (feedback.phase === "idle") return initial;
  if (feedback.phase === "running") {
    return {
      credentials: "running",
      sandbox: "pending",
      runtime: "pending",
      privateAccess: "pending",
      cleanup: "pending",
    };
  }

  const grouped = new Map<CheckId, E2bVerificationStageStatus[]>();
  for (const stage of feedback.stages) {
    const id = checkIdForStage(stage.id);
    if (!id) continue;
    const existing = grouped.get(id) ?? [];
    existing.push(stage.status);
    grouped.set(id, existing);
  }

  const failedId =
    feedback.phase === "error"
      ? (checkIdForStage(feedback.failedStage) ??
        checkIdForStage(feedback.stages.find(({ status }) => status === "failed")?.id))
      : null;
  const failedIndex = failedId ? CHECKS.findIndex(({ id }) => id === failedId) : -1;

  return Object.fromEntries(
    CHECKS.map(({ id }, index) => {
      const explicit = grouped.get(id);
      if (explicit?.length) return [id, aggregateStatuses(explicit)];
      // The overall verification may still have succeeded when an older or
      // malformed API response omits a detailed stage. Do not invent a green
      // check for work the browser cannot prove was reported.
      if (feedback.phase === "success") return [id, "skipped"];
      if (failedIndex === -1) return [id, "skipped"];
      if (index === failedIndex) return [id, "failed"];
      return [id, "skipped"];
    }),
  ) as Record<CheckId, E2bVerificationStageStatus>;
}

function sanitizeDiagnosticLine(value: string): string {
  const bounded = value.slice(0, 2_000);
  const sensitiveLabel =
    "(?:authorization|proxy[-_ ]?authorization|(?:e2b[-_ ]?)?traffic[-_ ]?access[-_ ]?token|x[-_ ]?access[-_ ]?token|api[-_ ]?key|client[-_ ]?secret)";

  return bounded
    .replace(
      new RegExp(
        `((?:\\\\?["']?)${sensitiveLabel}(?:\\\\?["']?)\\s*[:=]\\s*)(\\\\?["'])(.*?)\\2`,
        "gis",
      ),
      "$1$2[redacted]$2",
    )
    .replace(
      new RegExp(
        `((?:\\\\?["']?)${sensitiveLabel}(?:\\\\?["']?)\\s*[:=]\\s*)(\\\\?["'])(?:(?!\\2).)*$`,
        "gis",
      ),
      "$1$2[redacted]",
    )
    .replace(
      /((?:\\?["']?)(?:authorization|proxy[-_ ]?authorization)(?:\\?["']?)\s*[:=]\s*)(?!\\?["'])[^\r\n]+/gi,
      "$1[redacted]",
    )
    .replace(
      new RegExp(
        `((?:\\\\?["']?)${sensitiveLabel}(?:\\\\?["']?)\\s*[:=]\\s*)(?:bearer\\s+|basic\\s+)?[^"',;\\s}\\]\\\\]+`,
        "gi",
      ),
      "$1[redacted]",
    )
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.~-]{4,}/gi, "[redacted]")
    .replace(/\be2b_[A-Za-z0-9._~-]{4,}\b/gi, "e2b_[redacted]");
}

function StatusIcon({ status }: { status: E2bVerificationStageStatus }) {
  if (status === "running") {
    return (
      <span className="flex size-7 items-center justify-center rounded-full bg-sky-100 text-sky-700 ring-4 ring-sky-50">
        <Spinner className="size-3.5 border-sky-200 border-t-sky-700" />
      </span>
    );
  }
  if (status === "passed") {
    return (
      <span className="flex size-7 items-center justify-center rounded-full bg-emerald-600 text-white ring-4 ring-emerald-50">
        <svg
          className="size-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m5 12 4 4L19 6" />
        </svg>
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex size-7 items-center justify-center rounded-full bg-red-600 text-white ring-4 ring-red-50">
        <svg
          className="size-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          aria-hidden="true"
        >
          <path strokeLinecap="round" d="M12 7v6m0 4h.01" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex size-7 items-center justify-center rounded-full border bg-white ring-4 ring-white",
        status === "skipped"
          ? "border-neutral-200 text-neutral-300"
          : "border-sky-200 text-sky-400",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
    </span>
  );
}

export function E2bVerificationCheck({
  feedback,
  enabled,
  hasCustomTemplate,
  canKeepExisting,
  onRetry,
  onRetryWithBaseTemplate,
  onKeepExisting,
}: Props) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const statuses = useMemo(() => buildStatuses(feedback, enabled), [enabled, feedback]);
  const diagnosticLines = useMemo(() => {
    if (feedback.phase !== "error") return [];
    const lines = [
      `[error] ${feedback.message}`,
      ...(feedback.code ? [`[code] ${feedback.code}`] : []),
      ...(feedback.failedStage ? [`[failed-stage] ${feedback.failedStage}`] : []),
      ...feedback.stages.map(
        ({ id, status, message, detail }) =>
          `[stage:${status}] ${id}${message ? `: ${message}` : ""}${detail ? ` (${detail})` : ""}`,
      ),
      ...feedback.logs.map(({ level, message }) => `[${level}] ${message}`),
    ];
    return lines.map(sanitizeDiagnosticLine).slice(0, 100);
  }, [feedback]);

  const stateLabel =
    feedback.phase === "running"
      ? t("setup.secureExecution.checkRunning")
      : feedback.phase === "success" || (feedback.phase === "idle" && enabled)
        ? t("setup.secureExecution.checkPassed")
        : feedback.phase === "error"
          ? t("setup.secureExecution.checkFailed")
          : t("setup.secureExecution.checkReady");
  const failedCheck =
    feedback.phase === "error"
      ? (checkIdForStage(feedback.failedStage) ??
        checkIdForStage(feedback.stages.find(({ status }) => status === "failed")?.id))
      : null;
  const canRetryWithBaseTemplate =
    hasCustomTemplate &&
    (failedCheck === "credentials" || failedCheck === "sandbox" || failedCheck === "runtime");
  const failedDetail =
    feedback.phase === "error"
      ? feedback.stages.find(({ status }) => status === "failed")?.detail
      : undefined;

  useEffect(() => {
    if (feedback.phase !== "error") return;
    retryButtonRef.current?.focus();
  }, [feedback.phase]);

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(diagnosticLines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      className={cn(
        "mt-5 overflow-hidden rounded-2xl border bg-white",
        feedback.phase === "error"
          ? "border-red-200 shadow-[0_12px_34px_-24px_rgba(185,28,28,0.5)]"
          : "border-sky-100 shadow-[0_12px_34px_-26px_rgba(3,105,161,0.45)]",
      )}
      aria-live="polite"
      aria-busy={feedback.phase === "running"}
    >
      <div className="flex items-start justify-between gap-4 border-b border-neutral-100 bg-neutral-50/70 px-4 py-3.5 sm:px-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-700">
            {t("setup.secureExecution.securityCheck")}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-neutral-500">
            {t("setup.secureExecution.securityCheckBody")}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
            feedback.phase === "error"
              ? "bg-red-100 text-red-700"
              : feedback.phase === "success" || (feedback.phase === "idle" && enabled)
                ? "bg-emerald-100 text-emerald-700"
                : feedback.phase === "running"
                  ? "bg-sky-100 text-sky-700"
                  : "bg-white text-neutral-500 ring-1 ring-neutral-200",
          )}
        >
          {stateLabel}
        </span>
      </div>

      <ol className="px-4 py-4 sm:px-5" aria-label={t("setup.secureExecution.securityCheck")}>
        {CHECKS.map(({ id, titleKey, bodyKey }, index) => {
          const status = statuses[id];
          return (
            <li key={id} className="relative flex gap-3 pb-4 last:pb-0">
              {index < CHECKS.length - 1 && (
                <span
                  className={cn(
                    "absolute left-[13px] top-7 h-[calc(100%-1.25rem)] w-px",
                    status === "passed" ? "bg-emerald-200" : "bg-neutral-200",
                  )}
                  aria-hidden="true"
                />
              )}
              <div className="relative z-10 shrink-0">
                <StatusIcon status={status} />
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p
                      className={cn(
                        "text-[13px] font-semibold",
                        status === "failed" ? "text-red-800" : "text-neutral-800",
                      )}
                    >
                      {t(titleKey)}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
                      {t(bodyKey)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "mt-0.5 shrink-0 text-[11px] font-medium",
                      status === "failed"
                        ? "text-red-700"
                        : status === "passed"
                          ? "text-emerald-700"
                          : status === "running"
                            ? "text-sky-700"
                            : "text-neutral-600",
                    )}
                  >
                    {t(`setup.secureExecution.status${status[0]?.toUpperCase()}${status.slice(1)}`)}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {feedback.phase === "error" && (
        <div className="border-t border-red-100 bg-red-50/60 px-4 py-4 sm:px-5">
          <div className="flex items-start gap-2.5" role="alert">
            <span
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-700"
              aria-hidden="true"
            >
              !
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-red-900">
                {t("setup.secureExecution.failureTitle")}
              </p>
              <p className="mt-0.5 break-words text-[12px] leading-relaxed text-red-800">
                {sanitizeDiagnosticLine(feedback.message)}
              </p>
              {failedDetail && (
                <p className="mt-1.5 break-words text-[12px] font-medium leading-relaxed text-red-900">
                  {sanitizeDiagnosticLine(failedDetail)}
                </p>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              ref={retryButtonRef}
              type="button"
              onClick={() => onRetry()}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-neutral-900 px-3.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-neutral-800"
            >
              {t("setup.secureExecution.retry")}
            </button>
            {canRetryWithBaseTemplate && (
              <button
                type="button"
                onClick={onRetryWithBaseTemplate}
                className="inline-flex h-9 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-[12px] font-semibold text-neutral-700 transition-colors hover:bg-neutral-50"
              >
                {t("setup.secureExecution.retryBase")}
              </button>
            )}
            {canKeepExisting && (
              <button
                type="button"
                onClick={onKeepExisting}
                className="inline-flex h-9 items-center justify-center rounded-lg border border-neutral-300 bg-white px-3.5 text-[12px] font-semibold text-neutral-700 transition-colors hover:bg-neutral-50"
              >
                {t("setup.secureExecution.keepExisting")}
              </button>
            )}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-red-800/80">
            {t("setup.secureExecution.noLocalFallback")}
          </p>

          <details className="mt-3 overflow-hidden rounded-lg border border-red-200 bg-neutral-950 text-neutral-200">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-[11px] font-semibold text-neutral-200 marker:hidden hover:bg-white/5">
              <span>{t("setup.secureExecution.advancedLogs")}</span>
              <span className="font-normal text-neutral-500">
                {diagnosticLines.length} {t("setup.secureExecution.logLines")}
              </span>
            </summary>
            <div className="border-t border-white/10">
              <div className="flex items-center justify-end border-b border-white/10 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => void copyDiagnostics()}
                  className="rounded px-2 py-1 text-[10px] font-medium text-neutral-400 hover:bg-white/10 hover:text-white"
                >
                  {copied
                    ? t("setup.secureExecution.logsCopied")
                    : t("setup.secureExecution.copyLogs")}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-[10px] leading-relaxed text-neutral-300">
                {diagnosticLines.join("\n")}
              </pre>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
