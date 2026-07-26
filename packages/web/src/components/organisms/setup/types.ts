/**
 * Shared types + constants for the first-run setup wizard.
 *
 * Extracted from SetupPage so that both the page and the individual
 * step organisms (and StepIndicator) can refer to the same Step union
 * without creating a barrel re-export or causing a circular import.
 */

export type Step =
  | "welcome"
  | "anthropic"
  | "secureExecution"
  | "githubApp"
  | "email"
  | "organization"
  | "signin";

export const STEPS: Step[] = [
  "welcome",
  "anthropic",
  "secureExecution",
  "githubApp",
  "email",
  "organization",
  "signin",
];

export type E2bVerificationStageStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type E2bVerificationStage = {
  id: string;
  status: E2bVerificationStageStatus;
  message?: string;
  detail?: string;
};

export type E2bVerificationLog = {
  level: "info" | "success" | "warning" | "error";
  message: string;
};

export type E2bVerificationFeedback =
  | { phase: "idle" }
  | { phase: "running" }
  | {
      phase: "success";
      stages: E2bVerificationStage[];
      logs: E2bVerificationLog[];
    }
  | {
      phase: "error";
      message: string;
      code?: string;
      failedStage?: string;
      stages: E2bVerificationStage[];
      logs: E2bVerificationLog[];
    };
