import { rotateE2BRuntimeCredentials } from "./e2b-runtime.js";
import {
  E2bVerificationError,
  type E2bVerificationReport,
  verifyE2bConfiguration,
} from "./e2b-verification.js";
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

export function invalidE2bConfigurationVerification(): E2bVerificationReport {
  return {
    failedStage: "credentials",
    stages: [
      {
        id: "credentials",
        status: "failed",
        message: "Validate E2B credentials and template",
        detail: "Enter a valid E2B API key and optional template ID.",
      },
    ],
    logs: [
      {
        level: "error",
        message: "The submitted E2B configuration did not match the required input format.",
      },
    ],
  };
}

export class E2bConfigurationError extends Error {
  readonly code: "missing-api-key" | "verification-failed" | "cleanup-failed";
  readonly verification?: E2bVerificationReport;

  constructor(
    code: E2bConfigurationError["code"],
    message: string,
    verification?: E2bVerificationReport,
  ) {
    super(message);
    this.name = "E2bConfigurationError";
    this.code = code;
    this.verification = verification;
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
}): Promise<{ status: E2bConfigurationStatus; verification: E2bVerificationReport }> {
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

    let verification: E2bVerificationReport;
    try {
      verification = await verifyE2bConfiguration({ apiKey, templateId });
    } catch (error) {
      throw new E2bConfigurationError(
        error instanceof E2bVerificationError && error.code === "cleanup-failed"
          ? "cleanup-failed"
          : "verification-failed",
        error instanceof E2bVerificationError
          ? error.message
          : "E2B could not verify this API key and template.",
        error instanceof E2bVerificationError ? error.verification : undefined,
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
        const cleanupVerification: E2bVerificationReport = {
          failedStage: "existing-runtime-cleanup",
          stages: [
            ...verification.stages,
            {
              id: "existing-runtime-cleanup",
              status: "failed",
              message: "Remove existing project sandboxes",
              detail: "The previous E2B runtime could not be removed safely.",
            },
          ],
          logs: [
            ...verification.logs,
            {
              level: "error",
              message:
                "Existing project sandboxes could not be removed; the previous configuration remains active.",
            },
          ],
        };
        throw new E2bConfigurationError(
          "cleanup-failed",
          "Existing E2B sandboxes could not be removed. The previous configuration is unchanged.",
          cleanupVerification,
        );
      }
    } else {
      commit();
    }

    return { status: getE2bConfigurationStatus(), verification };
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
