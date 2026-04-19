/**
 * Shared types between the Organization Settings tabs and the instance
 * settings page shell. Mirrors the shape returned by
 * packages/api/src/services/instance-settings.ts → getSetupStatus().
 */

export type SettingStatus = {
  set: boolean;
  source: "db" | "env" | "none";
  value?: string;
};

export type StatusResponse = {
  needsSetup: boolean;
  missing: string[];
  values: Record<string, SettingStatus>;
};

/** Convenience getter — returns a zero-state entry if the key is missing. */
export function getStatus(status: StatusResponse | null, key: string): SettingStatus {
  return (
    status?.values[key] ?? {
      set: false,
      source: "none",
    }
  );
}
