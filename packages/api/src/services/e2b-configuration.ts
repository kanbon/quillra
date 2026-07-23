import { rotateE2BRuntimeCredentials } from "./e2b-runtime.js";
import { E2bVerificationError, verifyE2bConfiguration } from "./e2b-verification.js";
import {
  getInstanceSetting,
  getSetupStatus,
  setInstanceSettingsAtomically,
} from "./instance-settings.js";

export type E2bConfigurationStatus = {
  configured: boolean;
  enabled: boolean;
  source: "db" | "env" | "none";
  templateId: string | null;
  verifiedAt: string | null;
};

export class E2bConfigurationError extends Error {
  readonly code: "missing-api-key" | "verification-failed" | "cleanup-failed";

  constructor(code: E2bConfigurationError["code"], message: string) {
    super(message);
    this.name = "E2bConfigurationError";
    this.code = code;
  }
}

let mutationTail: Promise<void> = Promise.resolve();

function serializeMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(task, task);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function normalizeTemplateId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function getE2bConfigurationStatus(): E2bConfigurationStatus {
  const setupStatus = getSetupStatus();
  const key = setupStatus.values.E2B_API_KEY ?? { set: false, source: "none" as const };
  const enabled = getInstanceSetting("E2B_ENABLED") === "true";
  const verifiedAt = getInstanceSetting("E2B_VERIFIED_AT");
  return {
    configured: key.set,
    enabled: key.set && enabled,
    source: key.source,
    templateId: getInstanceSetting("E2B_TEMPLATE_ID") ?? null,
    verifiedAt: verifiedAt && !Number.isNaN(Date.parse(verifiedAt)) ? verifiedAt : null,
  };
}

export function configureE2b(input: {
  apiKey?: string;
  templateId?: string | null;
}): Promise<E2bConfigurationStatus> {
  return serializeMutation(async () => {
    const providedApiKey = input.apiKey?.trim() || undefined;
    const existingApiKey = getInstanceSetting("E2B_API_KEY");
    const apiKey = providedApiKey ?? existingApiKey;
    if (!apiKey) {
      throw new E2bConfigurationError(
        "missing-api-key",
        "Enter an E2B API key before enabling secure execution.",
      );
    }

    const existingTemplateId = normalizeTemplateId(getInstanceSetting("E2B_TEMPLATE_ID"));
    const templateId =
      input.templateId === undefined ? existingTemplateId : normalizeTemplateId(input.templateId);

    try {
      await verifyE2bConfiguration({ apiKey, templateId });
    } catch (error) {
      throw new E2bConfigurationError(
        error instanceof E2bVerificationError && error.code === "cleanup-failed"
          ? "cleanup-failed"
          : "verification-failed",
        error instanceof E2bVerificationError
          ? error.message
          : "E2B could not verify this API key and template.",
      );
    }

    const wasEnabled = getInstanceSetting("E2B_ENABLED") === "true";
    const configurationChanged =
      Boolean(providedApiKey && providedApiKey !== existingApiKey) ||
      templateId !== existingTemplateId;
    const commit = () => {
      setInstanceSettingsAtomically([
        ...(providedApiKey ? ([{ key: "E2B_API_KEY", value: providedApiKey }] as const) : []),
        { key: "E2B_TEMPLATE_ID", value: templateId ?? null },
        { key: "E2B_ENABLED", value: "true" },
        { key: "E2B_VERIFIED_AT", value: new Date().toISOString() },
      ]);
    };
    if (wasEnabled && configurationChanged) {
      try {
        await rotateE2BRuntimeCredentials({
          oldApiKey: existingApiKey,
          commit,
        });
      } catch {
        throw new E2bConfigurationError(
          "cleanup-failed",
          "Existing E2B sandboxes could not be removed. The previous configuration is unchanged.",
        );
      }
    } else {
      commit();
    }

    return getE2bConfigurationStatus();
  });
}

export function resetE2b(): Promise<E2bConfigurationStatus> {
  return serializeMutation(async () => {
    const apiKey = getInstanceSetting("E2B_API_KEY");
    const enabled = getInstanceSetting("E2B_ENABLED") === "true";
    const commit = () => {
      setInstanceSettingsAtomically([
        { key: "E2B_ENABLED", value: "false" },
        { key: "E2B_API_KEY", value: null },
        { key: "E2B_TEMPLATE_ID", value: null },
        { key: "E2B_VERIFIED_AT", value: null },
      ]);
    };
    if (apiKey || enabled) {
      try {
        await rotateE2BRuntimeCredentials({ oldApiKey: apiKey, commit });
      } catch {
        throw new E2bConfigurationError(
          "cleanup-failed",
          "Existing E2B sandboxes could not be removed. Secure execution remains configured.",
        );
      }
    } else {
      commit();
    }
    return getE2bConfigurationStatus();
  });
}
