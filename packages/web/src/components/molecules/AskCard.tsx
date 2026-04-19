import { useT } from "@/i18n/i18n";
import { cn } from "@/lib/cn";

type Props = {
  question: string;
  options: string[];
  /** Fires when the user picks one of the server-provided options. The
   *  parent sends this string as a normal user message. */
  onPick: (answer: string) => void;
  /** Fires when the user picks the always-appended "Other" option. The
   *  card disappears and the composer pulls focus (wired in chat-store). */
  onPickOther: () => void;
};

export function AskCard({ question, options, onPick, onPickOther }: Props) {
  const { t } = useT();
  return (
    <div className="animate-[fadeIn_0.2s_ease-out] rounded-2xl border border-neutral-200 bg-white p-4 text-sm text-neutral-800 shadow-sm">
      <p className="mb-3 leading-relaxed">{question}</p>
      <div className="flex flex-col gap-1.5">
        {options.map((opt, i) => (
          <button
            key={`${i}-${opt}`}
            type="button"
            onClick={() => onPick(opt)}
            className={cn(
              "group flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-white px-3.5 py-2.5 text-left text-[13px] font-medium text-neutral-800 transition-all",
              "hover:border-brand/60 hover:bg-brand/5 hover:text-brand active:scale-[0.99]",
            )}
          >
            <span className="flex-1 truncate">{opt}</span>
            <span className="text-neutral-300 transition-colors group-hover:text-brand" aria-hidden>
              →
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={onPickOther}
          className="mt-0.5 flex w-full items-center justify-between gap-3 rounded-lg border border-dashed border-neutral-200 bg-transparent px-3.5 py-2.5 text-left text-[13px] font-medium text-neutral-500 transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-800"
        >
          <span className="flex-1 truncate">{t("chat.askOther")}</span>
          <span className="text-neutral-300" aria-hidden>
            ✎
          </span>
        </button>
      </div>
    </div>
  );
}
