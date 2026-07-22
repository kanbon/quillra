import { describe, expect, it } from "vitest";
import { claimMigrationRun } from "./migration-run-lock.js";

describe("claimMigrationRun", () => {
  it("allows only one active run per project and releases idempotently", () => {
    const releaseFirst = claimMigrationRun("project-1");
    expect(releaseFirst).toBeTypeOf("function");
    expect(claimMigrationRun("project-1")).toBeNull();

    const releaseOther = claimMigrationRun("project-2");
    expect(releaseOther).toBeTypeOf("function");
    releaseFirst?.();
    releaseFirst?.();

    const releaseRetry = claimMigrationRun("project-1");
    expect(releaseRetry).toBeTypeOf("function");
    releaseRetry?.();
    releaseOther?.();
  });
});
