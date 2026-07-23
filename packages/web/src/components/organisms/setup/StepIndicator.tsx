import { STEPS, type Step } from "@/components/organisms/setup/types";
import { useT } from "@/i18n/i18n";

const STEP_LABEL_KEYS: Record<Step, string> = {
  welcome: "setup.progress.labelWelcome",
  anthropic: "setup.progress.labelAnthropic",
  secureExecution: "setup.progress.labelSecureExecution",
  githubApp: "setup.progress.labelGithubApp",
  email: "setup.progress.labelEmail",
  organization: "setup.progress.labelOrganization",
  signin: "setup.progress.labelSignin",
};
/**
 * Quill-red progress rail rendered above the setup wizard card.
 *
 * Pure presentation: given the current Step it shows "Step X / Y" plus a
 * row of segment bars that fill in as the user advances. Owns no state.
 */
export function StepIndicator({ step }: { step: Step }) {
  const { t } = useT();
  const stepIndex = STEPS.indexOf(step);
  const currentStep = STEPS[stepIndex];
  const currentLabel = currentStep ? t(STEP_LABEL_KEYS[currentStep]) : t("setup.badge");
  const progress = ((stepIndex + 1) / STEPS.length) * 100;

  return (
    <div className="mb-6 sm:mb-8">
      <div className="mb-2.5 flex items-center justify-between text-xs font-medium text-graphite">
        <span>
          {t("setup.progress.step")} <span className="font-semibold text-ink">{stepIndex + 1}</span>
          <span className="text-graphite">
            {" "}
            {t("setup.progress.of")} {STEPS.length}
          </span>
        </span>
        <span className="font-semibold text-ink">{currentLabel}</span>
      </div>
      <progress
        className="block h-1 w-full appearance-none overflow-hidden rounded-full bg-rule accent-brand [&::-moz-progress-bar]:bg-brand [&::-webkit-progress-bar]:bg-rule [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-brand"
        aria-label={t("setup.progress.aria", {
          label: currentLabel,
          current: stepIndex + 1,
          total: STEPS.length,
        })}
        value={progress}
        max={100}
      />
    </div>
  );
}
