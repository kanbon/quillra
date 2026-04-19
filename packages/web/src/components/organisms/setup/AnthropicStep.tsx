import { Input } from "@/components/atoms/Input";
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
  keyFromEnv,
}: {
  value: string;
  onChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
  saving: boolean;
  error: string | null;
  keyFromEnv: boolean;
}) {
  return (
    <div className="p-8">
      <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900">
        Anthropic API key
      </h2>
      <p className="mt-2 text-sm text-neutral-500">
        Quillra uses Claude to edit your site. Paste your API key below, or{" "}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand underline-offset-2 hover:underline"
        >
          get one here
        </a>
        .
      </p>
      <div className="mt-5">
        <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
          API key
        </label>
        <Input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="sk-ant-api03-…"
          autoFocus
        />
        {keyFromEnv && (
          <p className="mt-2 text-xs text-neutral-500">
            A key is already set in the environment. You can leave this blank to keep it.
          </p>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-900"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={saving || !value.trim()}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-lg bg-brand px-5 text-[13px] font-semibold text-white shadow-sm",
            saving || !value.trim() ? "cursor-not-allowed opacity-50" : "hover:bg-brand/90",
          )}
        >
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
