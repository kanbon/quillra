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
