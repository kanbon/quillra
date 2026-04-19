import { STEPS, type Step } from "@/components/organisms/setup/types";
import { cn } from "@/lib/cn";

/**
 * Progress strip rendered at the top of the setup wizard card.
 *
 * Pure presentation: given the current Step it shows "Step X / Y" plus a
 * row of segment bars that fill in as the user advances. Owns no state.
 */
export function StepIndicator({ step }: { step: Step }) {
  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div className="mb-8">
      <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-neutral-500">
        <span>
          Step <span className="text-neutral-900">{stepIndex + 1}</span>
          <span className="text-neutral-400"> / {STEPS.length}</span>
        </span>
        <span className="uppercase tracking-wider text-neutral-400">
          {STEPS[stepIndex]?.label}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        {STEPS.map((s, i) => (
          <div
            key={s.id}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              i < stepIndex
                ? "bg-neutral-900"
                : i === stepIndex
                  ? "bg-neutral-900"
                  : "bg-neutral-200",
            )}
          />
        ))}
      </div>
    </div>
  );
}
