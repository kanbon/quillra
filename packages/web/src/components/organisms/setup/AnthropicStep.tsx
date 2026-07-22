import { Input } from "@/components/atoms/Input";
import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

/**
 * Anthropic step: collects the ANTHROPIC_API_KEY that powers the AI
 * editor. Owns no state (the input is controlled from above); signals
 * Back / Continue via callback props.
 */
export function AnthropicStep({
  value,
  onChange,
  onBack,
  onNext,
  saving,
  error,
  keyConfigured,
}: {
  value: string;
  onChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  saving: boolean;
  error: string | null;
  keyConfigured: boolean;
}) {
  const { t } = useT();

  return (
    <form
      className="p-5 sm:p-8"
      onSubmit={(event) => {
        event.preventDefault();
        onNext();
      }}
    >
      <h2
        id="setup-step-heading-anthropic"
        tabIndex={-1}
        className="text-[20px] font-semibold tracking-tight text-neutral-900 outline-none"
      >
        {t("setup.anthropic.title")}
      </h2>
      <p className="mt-2 text-sm text-neutral-500">
        {t("setup.anthropic.descriptionBeforeLink")}{" "}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand underline-offset-2 hover:underline"
        >
          {t("setup.anthropic.getKey")}
        </a>
        .
      </p>
      <div className="mt-5">
        <label
          htmlFor="setup-anthropic-key"
          className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500"
        >
          {t("setup.anthropic.apiKeyLabel")}
        </label>
        <Input
          id="setup-anthropic-key"
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="sk-ant-api03-…"
          autoFocus
          disabled={saving}
        />
        {keyConfigured && (
          <p className="mt-2 text-xs text-neutral-500">{t("setup.anthropic.configuredHelp")}</p>
        )}
      </div>
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
          disabled={saving || (!value.trim() && !keyConfigured)}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm",
            saving || (!value.trim() && !keyConfigured)
              ? "cursor-not-allowed opacity-50"
              : "hover:bg-brand/90",
          )}
        >
          {saving ? t("common.saving") : t("common.continue")}
        </button>
      </div>
    </form>
  );
}
