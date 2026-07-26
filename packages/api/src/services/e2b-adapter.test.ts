import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  kill: vi.fn(),
}));

vi.mock("e2b", () => {
  class CommandExitError extends Error {}
  class SandboxNotFoundError extends Error {}
  return {
    CommandExitError,
    SandboxNotFoundError,
    FileType: { FILE: "file", DIR: "dir" },
    Sandbox: {
      create: sdk.create,
      connect: sdk.connect,
      kill: sdk.kill,
    },
  };
});

import { E2BSdkAdapter } from "./e2b-adapter.js";

function fakeSdkSandbox() {
  const run = vi.fn();
  const files = {
    list: vi.fn(async () => []),
    getInfo: vi.fn(async (filePath: string) => ({
      name: filePath.split("/").at(-1) ?? "",
      path: filePath,
      type: "file",
      size: 5,
      mode: 0o644,
    })),
    read: vi.fn(async () => new TextEncoder().encode("hello")),
    write: vi.fn(async () => []),
    makeDir: vi.fn(async () => true),
    exists: vi.fn(async () => true),
    remove: vi.fn(async () => undefined),
    rename: vi.fn(async () => ({})),
  };
  return {
    sandboxId: "sandbox-1",
    trafficAccessToken: "traffic-token",
    files,
    commands: {
      run,
      kill: vi.fn(async () => false),
    },
    getHost: vi.fn(() => "4321-sandbox.e2b.app"),
    pause: vi.fn(async () => true),
    kill: vi.fn(async () => true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("E2B SDK adapter", () => {
  it("creates a secure, auto-pausing sandbox without sandbox environment secrets", async () => {
    sdk.create.mockResolvedValue(fakeSdkSandbox());
    const adapter = new E2BSdkAdapter();

    await adapter.create({
      apiKey: "e2b_control_plane_secret",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });

    expect(sdk.create).toHaveBeenCalledOnce();
    const options = sdk.create.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      apiKey: "e2b_control_plane_secret",
      secure: true,
      lifecycle: { onTimeout: "pause", autoResume: true },
      network: { allowPublicTraffic: false },
      metadata: { "quillra.project_id": "project-a" },
    });
    expect(options).not.toHaveProperty("envs");
  });

  it("keeps untrusted output out of CommandHandle and reads only bounded remote logs", async () => {
    const sandbox = fakeSdkSandbox();
    const commandHandle = {
      pid: 77,
      wait: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      kill: vi.fn(async () => true),
    };
    sandbox.commands.run
      .mockResolvedValueOnce(commandHandle)
      .mockImplementation(async (command: string) => ({
        exitCode: 0,
        stdout: command.startsWith("/usr/bin/head -c") ? "hello" : "",
        stderr: "",
      }));
    sdk.create.mockResolvedValue(sandbox);
    const adapter = new E2BSdkAdapter();
    const handle = await adapter.create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });
    const onStdout = vi.fn();

    const process = await handle.startCommand("yes unsafe", {
      cwd: "/home/user/quillra-workspace",
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
      onStdout,
    });
    await expect(process.wait()).resolves.toMatchObject({
      exitCode: 0,
      stdout: "hello",
      stderr: "hello",
    });

    const [wrapped, startOptions] = sandbox.commands.run.mock.calls[0] ?? [];
    expect(wrapped).toContain("/usr/bin/head -c 1024");
    expect(wrapped).toContain("/usr/bin/cat >/dev/null");
    expect(wrapped).toContain("/usr/bin/mkfifo");
    expect(wrapped).toContain("/bin/rm");
    expect(wrapped).toContain("/usr/bin/setsid /bin/bash");
    expect(wrapped).toContain(">/dev/null 2>/dev/null");
    expect(startOptions).not.toHaveProperty("onStdout");
    expect(startOptions).not.toHaveProperty("onStderr");
    expect(onStdout).toHaveBeenCalledWith("hello");
    expect(sandbox.files.getInfo).not.toHaveBeenCalled();
    expect(sandbox.files.read).not.toHaveBeenCalled();
    const retrievals = sandbox.commands.run.mock.calls
      .slice(1)
      .map(([command]) => command)
      .filter((command) => command.startsWith("/usr/bin/head -c"));
    expect(retrievals).toHaveLength(2);
    expect(retrievals.every((command) => command.startsWith("/usr/bin/head -c 1024 -- "))).toBe(
      true,
    );
    const controlOptions = sandbox.commands.run.mock.calls
      .slice(1)
      .map(([, options]) => options)
      .filter(Boolean);
    expect(
      controlOptions.every(
        (options) => (options as { envs?: Record<string, string> }).envs?.PATH === "/usr/bin:/bin",
      ),
    ).toBe(true);
  });

  it("rejects an output cap that is too large before starting the command", async () => {
    const sandbox = fakeSdkSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const adapter = new E2BSdkAdapter();
    const handle = await adapter.create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });

    await expect(
      handle.startCommand("echo ok", {
        cwd: "/home/user/quillra-workspace",
        timeoutMs: 30_000,
        maxOutputBytes: 8 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow("output limit");
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("reads workspace files through fixed-size binary chunks, never files.read", async () => {
    const sandbox = fakeSdkSandbox();
    sandbox.commands.run.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from([0, 255, 42]).toString("base64"),
      stderr: "",
    });
    sdk.create.mockResolvedValue(sandbox);
    const adapter = new E2BSdkAdapter();
    const handle = await adapter.create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });

    await expect(handle.readFileChunk("/tmp/untrusted file", 65_536, 3)).resolves.toEqual(
      Uint8Array.from([0, 255, 42]),
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining(
        "/usr/bin/dd if='/tmp/untrusted file' iflag=skip_bytes,count_bytes skip=65536 count=3 ",
      ),
      expect.objectContaining({
        timeoutMs: 10_000,
        envs: { PATH: "/usr/bin:/bin" },
      }),
    );
    expect(sandbox.commands.run.mock.calls[0]?.[0]).toContain("| /usr/bin/base64");
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  it("lists one directory with hard budgets and preserves symlink/special metadata", async () => {
    const sandbox = fakeSdkSandbox();
    const encode = (value: string) => Buffer.from(value).toString("base64");
    sandbox.commands.run.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        entries: [
          { n: encode("file.txt"), t: "file", s: 12, m: 0o644, l: null },
          { n: encode("escape"), t: "file", s: 0, m: 0o777, l: encode("/etc/passwd") },
          { n: encode("socket"), t: "special", s: 0, m: 0o600, l: null },
        ],
      }),
      stderr: "",
    });
    sdk.create.mockResolvedValue(sandbox);
    const adapter = new E2BSdkAdapter();
    const handle = await adapter.create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });

    await expect(
      handle.list("/home/user/quillra-workspace", {
        maxEntries: 3,
        maxOutputBytes: 1_024,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ name: "file.txt", type: "file", size: 12 }),
      expect.objectContaining({
        name: "escape",
        type: "file",
        symlinkTarget: "/etc/passwd",
      }),
      expect.objectContaining({ name: "socket", type: "special" }),
    ]);
    expect(sandbox.files.list).not.toHaveBeenCalled();
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("/usr/bin/python3 -I -S -c "),
      expect.objectContaining({
        timeoutMs: 10_000,
        envs: { PATH: "/usr/bin:/bin" },
      }),
    );
    expect(sandbox.commands.run.mock.calls[0]?.[0]).toContain(
      "'/home/user/quillra-workspace' 3 1024",
    );
  });

  it("fails closed when a directory exceeds its entry or byte budget", async () => {
    const sandbox = fakeSdkSandbox();
    sandbox.commands.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ ok: false, error: "entry_limit" }),
      stderr: "",
    });
    sdk.create.mockResolvedValue(sandbox);
    const adapter = new E2BSdkAdapter();
    const handle = await adapter.create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });

    await expect(
      handle.list("/home/user/quillra-workspace", {
        maxEntries: 1,
        maxOutputBytes: 256,
      }),
    ).rejects.toThrow("entry limit");

    sandbox.commands.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "x".repeat(257),
      stderr: "",
    });
    await expect(
      handle.list("/home/user/quillra-workspace", {
        maxEntries: 1,
        maxOutputBytes: 256,
      }),
    ).rejects.toThrow("byte limit");

    const encode = (value: string) => Buffer.from(value).toString("base64");
    sandbox.commands.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        entries: [
          { n: encode("one"), t: "file", s: 0, m: 0o644, l: null },
          { n: encode("two"), t: "file", s: 0, m: 0o644, l: null },
        ],
      }),
      stderr: "",
    });
    await expect(
      handle.list("/home/user/quillra-workspace", {
        maxEntries: 1,
        maxOutputBytes: 512,
      }),
    ).rejects.toThrow("entry limit");
    expect(sandbox.files.list).not.toHaveBeenCalled();
  });
});
