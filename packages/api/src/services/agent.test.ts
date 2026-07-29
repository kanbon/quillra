import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  releaseProjectWriter: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mocks.query,
}));

vi.mock("./agent-diagnostics-tools.js", () => ({
  buildAgentDiagnosticsMcpServer: vi.fn(() => ({})),
}));

vi.mock("./agent-execution-tools.js", () => ({
  AGENT_BASH_TOOL_ALIAS: "mcp__quillra-execution__bash",
  buildAgentExecutionMcpServer: vi.fn(() => ({})),
}));

vi.mock("./agent-permissions.js", () => ({
  buildCanUseTool: vi.fn(() => vi.fn()),
}));

vi.mock("./instance-settings.js", () => ({
  getInstanceSetting: vi.fn((key: string) =>
    key === "ANTHROPIC_API_KEY" ? "test-anthropic-key" : null,
  ),
}));

vi.mock("./project-workspace-lifecycle.js", () => ({
  registerProjectWriter: vi.fn(() => mocks.releaseProjectWriter),
}));

vi.mock("./role-prompts.js", () => ({
  getRolePrompt: vi.fn(async () => ""),
}));

import { type AgentRunUsage, type ProjectAgentParams, runProjectAgent } from "./agent.js";

const tempDirectories: string[] = [];

function asyncMessages(messages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

function successResult(modelUsage: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    session_id: "session-success",
    result: "Done",
    total_cost_usd: 0.12,
    num_turns: 2,
    modelUsage,
  };
}

function errorResult(modelUsage: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "error_during_execution",
    session_id: "session-error",
    errors: ["The model request failed"],
    total_cost_usd: 0.08,
    num_turns: 1,
    modelUsage,
  };
}

function projectParams(
  cwd: string,
  onResult: (usage: AgentRunUsage) => void = vi.fn(),
): ProjectAgentParams {
  return {
    cwd,
    prompt: "Change the headline",
    role: "admin",
    projectId: "project-private-id",
    githubBindingGeneration: 1,
    userId: "user-private-id",
    authorizationEpoch: 0,
    onResult,
  };
}

async function collectAgentEvents(params: ProjectAgentParams) {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of runProjectAgent(params)) events.push(event);
  return events;
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.releaseProjectWriter.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runProjectAgent Claude SDK options", () => {
  it("uses a cacheable system prompt and persists sessions on the API data volume", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-agent-data-"));
    tempDirectories.push(dataDirectory);
    const workspace = path.join(dataDirectory, "workspaces", "project-private-id", "repo");
    vi.stubEnv("DATABASE_URL", `file:${path.join(dataDirectory, "cms.sqlite")}`);
    vi.stubEnv("E2B_API_KEY", "control-plane-secret");
    mocks.query.mockReturnValue(asyncMessages([successResult()]));

    await collectAgentEvents(projectParams(workspace));

    expect(mocks.query).toHaveBeenCalledTimes(1);
    const request = mocks.query.mock.calls[0]?.[0] as {
      options: {
        env: Record<string, string | undefined>;
        persistSession: boolean;
        systemPrompt: {
          append: string;
          excludeDynamicSections: boolean;
          preset: string;
          type: string;
        };
      };
    };
    const expectedConfigDirectory = path.join(dataDirectory, "claude-agent");

    expect(request.options.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    });
    expect(request.options.persistSession).toBe(true);
    expect(request.options.env.CLAUDE_CONFIG_DIR).toBe(expectedConfigDirectory);
    expect(request.options.env.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    expect(request.options.env.E2B_API_KEY).toBeUndefined();
    expect(fs.statSync(expectedConfigDirectory).mode & 0o777).toBe(0o700);

    const systemPrompt = JSON.stringify(request.options.systemPrompt);
    expect(systemPrompt).not.toContain("control-plane-secret");
    expect(systemPrompt).not.toContain("project-private-id");
    expect(systemPrompt).not.toContain("user-private-id");
    expect(systemPrompt).not.toContain(workspace);
  });

  it("reports billed usage for both successful and failed terminal results", async () => {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "quillra-agent-usage-"));
    tempDirectories.push(dataDirectory);
    vi.stubEnv("DATABASE_URL", `file:${path.join(dataDirectory, "cms.sqlite")}`);
    const modelUsage = {
      "claude-sonnet-test": {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 75,
        cacheCreationInputTokens: 10,
      },
    };
    const successUsage = vi.fn();
    const errorUsage = vi.fn();

    mocks.query.mockReturnValueOnce(asyncMessages([successResult(modelUsage)]));
    const successEvents = await collectAgentEvents(
      projectParams(path.join(dataDirectory, "success-repo"), successUsage),
    );
    mocks.query.mockReturnValueOnce(asyncMessages([errorResult(modelUsage)]));
    const errorEvents = await collectAgentEvents(
      projectParams(path.join(dataDirectory, "error-repo"), errorUsage),
    );

    expect(successUsage).toHaveBeenCalledOnce();
    expect(successUsage).toHaveBeenCalledWith({
      totalCostUsd: 0.12,
      numTurns: 2,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 75,
      cacheCreationTokens: 10,
      modelUsage,
    });
    expect(errorUsage).toHaveBeenCalledOnce();
    expect(errorUsage).toHaveBeenCalledWith({
      totalCostUsd: 0.08,
      numTurns: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 75,
      cacheCreationTokens: 10,
      modelUsage,
    });
    expect(successEvents).toEqual([{ type: "done", result: "Done", costUsd: 0.12 }]);
    expect(errorEvents).toEqual([
      {
        type: "error",
        message: "The model request failed",
        errors: ["The model request failed"],
      },
    ]);
  });
});
