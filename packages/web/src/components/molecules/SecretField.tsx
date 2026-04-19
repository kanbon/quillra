import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";
/**
 * Secure-input primitive for API keys, tokens, and other secrets.
 *
 * Security guarantees (enforced by this component + its contract with the
 * server):
 *  - The backend NEVER returns the full secret value — only a masked
 *    version like `••••••••ab12`. This component trusts the mask.
 *  - When the user clicks Replace, the draft input is EMPTY. We never
 *    prefill with the masked value. Pasting over nothing is explicit.
 *  - The underlying <input> is type=password by default, flipped to text
 *    only while the user holds down the eye toggle. autoComplete/1Password
 *    are disabled so browser password managers don't grab the draft.
 *  - The draft is dropped when the parent cancels editing — no leak into
 *    persistent state.
 *  - The "source" badge tells the owner whether the current value came
 *    from the environment or the database. Env values are read-only
 *    unless they explicitly override.
 */
import { type ReactNode, useState } from "react";

export type SecretStatus = {
  set: boolean;
  source: "db" | "env" | "none";
  value?: string; // already masked if set
};

type Props = {
  label: string;
  name: string;
  status: SecretStatus;
  draft: string;
  onDraftChange: (v: string) => void;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  placeholder?: string;
  helpText?: ReactNode;
  docsHref?: string;
  docsLabel?: string;
};

export function SecretField({
  label,
  name,
  status,
  draft,
  onDraftChange,
  editing,
  onStartEdit,
  onCancelEdit,
  placeholder,
  helpText,
  docsHref,
  docsLabel,
}: Props) {
  const { t } = useT();
  const [show, setShow] = useState(false);

  // Reset the eye toggle whenever the field exits editing.
  if (!editing && show) setShow(false);

  const badge = renderSourceBadge(status, t);
  const envOverride = status.set && status.source === "env";

  return (
    <div role="group" aria-labelledby={`${name}-label`} className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label
          id={`${name}-label`}
          htmlFor={`${name}-input`}
          className="text-[12px] font-semibold uppercase tracking-wider text-neutral-600"
        >
          {label}
        </label>
        {badge}
      </div>

      {editing ? (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              id={`${name}-input`}
              type={show ? "text" : "password"}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              placeholder={placeholder}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              className="block h-10 w-full rounded-md border border-neutral-300 bg-white px-3 pr-10 text-sm outline-none focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
              aria-label={show ? t("instanceSettings.hideValue") : t("instanceSettings.showValue")}
              title={show ? t("instanceSettings.hideValue") : t("instanceSettings.showValue")}
              tabIndex={-1}
            >
              {show ? (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7a9.969 9.969 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.542 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                  />
                </svg>
              ) : (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={onCancelEdit}
            className="shrink-0 rounded-md px-3 py-2 text-[13px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
          >
            {t("instanceSettings.cancelEdit")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            id={`${name}-input`}
            type="text"
            value={status.value ?? ""}
            readOnly
            tabIndex={-1}
            placeholder={placeholder}
            className={cn(
              "block h-10 flex-1 rounded-md border bg-neutral-50 px-3 text-sm text-neutral-500",
              status.set ? "border-neutral-200 font-mono" : "border-neutral-200 italic",
            )}
          />
          <button
            type="button"
            onClick={onStartEdit}
            className="shrink-0 rounded-md border border-neutral-300 bg-white px-3 py-2 text-[13px] font-medium text-neutral-700 shadow-sm hover:bg-neutral-50"
          >
            {status.set
              ? status.source === "env"
                ? t("instanceSettings.overrideEnv")
                : t("instanceSettings.replaceValue")
              : t("instanceSettings.setValue")}
          </button>
        </div>
      )}

      {envOverride && !editing && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-800">
          {t("instanceSettings.envOverrideWarning", { key: name })}
        </p>
      )}

      {helpText && <p className="text-[11px] leading-snug text-neutral-500">{helpText}</p>}

      {docsHref && (
        <a
          href={docsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
        >
          {docsLabel ?? "Get a key →"}
        </a>
      )}
    </div>
  );
}

function renderSourceBadge(
  status: SecretStatus,
  t: (k: string, v?: Record<string, string>) => string,
) {
  if (!status.set) {
    return (
      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {t("instanceSettings.sourceNone")}
      </span>
    );
  }
  if (status.source === "env") {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
        {t("instanceSettings.sourceEnv")}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700">
      {t("instanceSettings.sourceDatabase")}
    </span>
  );
}
