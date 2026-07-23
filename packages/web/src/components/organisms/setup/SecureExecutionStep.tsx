import { Input } from "@/components/atoms/Input";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  apiKey: string;
  templateId: string;
  configured: boolean;
  enabled: boolean;
  needsVerification: boolean;
  verifiedAt?: string;
  saving: boolean;
  error: string | null;
  onApiKeyChange: (value: string) => void;
  onTemplateIdChange: (value: string) => void;
  onBack: () => void;
  onNext: () => void;
};

export function SecureExecutionStep({
  apiKey,
  templateId,
  configured,
  enabled,
  needsVerification,
  verifiedAt,
  saving,
  error,
  onApiKeyChange,
  onTemplateIdChange,
  onBack,
  onNext,
}: Props) {
  const { t } = useT();
  const canSubmit = Boolean(apiKey.trim() || configured);
  const verifiedDate =
    verifiedAt && !Number.isNaN(Date.parse(verifiedAt))
      ? new Date(verifiedAt).toLocaleString()
      : null;

  return (
    <form
      className="p-5 sm:p-8"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700 ring-1 ring-sky-200">
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 3 4.5 6v5.4c0 4.6 3.1 8 7.5 9.6 4.4-1.6 7.5-5 7.5-9.6V6L12 3Z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" d="m9.5 12 1.7 1.7 3.5-4" />
          </svg>
        </span>
        <div>
          <h2
            id="setup-step-heading-secureExecution"
            tabIndex={-1}
            className="text-[20px] font-semibold tracking-tight text-neutral-900 outline-none"
          >
            {t("setup.secureExecution.title")}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-500">
            {t("setup.secureExecution.intro")}
          </p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-xl border border-sky-100 bg-sky-50/60 px-3 py-3 text-center">
        <div className="rounded-lg bg-white px-2 py-2 ring-1 ring-sky-100">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {t("setup.secureExecution.appLabel")}
          </p>
          <p className="mt-0.5 text-[12px] font-semibold text-neutral-800">Quillra</p>
        </div>
        <svg
          className="h-4 w-4 text-sky-500"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14m-4-4 4 4-4 4" />
        </svg>
        <div className="rounded-lg bg-white px-2 py-2 ring-1 ring-sky-100">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            {t("setup.secureExecution.codeLabel")}
          </p>
          <p className="mt-0.5 text-[12px] font-semibold text-neutral-800">
            {t("setup.secureExecution.sandboxLabel")}
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <label
            htmlFor="setup-e2b-key"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("setup.secureExecution.apiKeyLabel")}
          </label>
          <Input
            id="setup-e2b-key"
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder={configured ? "••••••••" : "e2b_…"}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            autoFocus
            disabled={saving}
          />
          <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">
            {configured
              ? t("setup.secureExecution.configuredHelp")
              : t("setup.secureExecution.keyHelp")}{" "}
            <a
              href="https://e2b.dev/dashboard"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-brand hover:underline"
            >
              {t("setup.secureExecution.openE2b")}
            </a>
          </p>
        </div>

        <div>
          <label
            htmlFor="setup-e2b-template"
            className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
          >
            {t("setup.secureExecution.templateLabel")}{" "}
            <span className="font-normal normal-case tracking-normal text-neutral-400">
              · {t("setup.welcome.optional")}
            </span>
          </label>
          <Input
            id="setup-e2b-template"
            value={templateId}
            onChange={(event) => onTemplateIdChange(event.target.value)}
            placeholder="base"
            autoComplete="off"
            disabled={saving}
          />
          <p className="mt-1.5 text-[11px] text-neutral-500">
            {t("setup.secureExecution.templateHelp")}
          </p>
        </div>
      </div>

      {enabled && (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          {verifiedDate
            ? t("setup.secureExecution.verifiedAt", {
                date: verifiedDate,
              })
            : t("setup.secureExecution.enabled")}
        </p>
      )}

      {!configured && !apiKey.trim() && (
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900">
          {t("setup.secureExecution.requiredWarning")}
        </p>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900 disabled:cursor-wait disabled:opacity-50"
        >
          {t("common.back")}
        </button>
        <button
          type="submit"
          disabled={saving || !canSubmit}
          className={cn(
            "inline-flex h-10 items-center rounded-lg px-5 text-[13px] font-semibold shadow-sm",
            needsVerification
              ? "bg-sky-700 text-white hover:bg-sky-800"
              : "bg-neutral-900 text-white hover:bg-neutral-800",
            (saving || !canSubmit) && "cursor-not-allowed opacity-50",
          )}
        >
          {saving
            ? t("setup.secureExecution.verifying")
            : needsVerification
              ? t("setup.secureExecution.verifyAndEnable")
              : t("common.continue")}
        </button>
      </div>
    </form>
  );
}
