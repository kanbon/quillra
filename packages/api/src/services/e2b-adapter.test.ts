import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

import { E2BSdkAdapter, SECURE_DIRECTORY_SETUP_SCRIPT } from "./e2b-adapter.js";
import {
  type E2BTrustedEnvironmentError,
  E2B_PROJECT_HOME,
  E2B_PROJECT_USER,
  E2B_RELAY_USER,
} from "./e2b-preview-relay.js";

const execFileAsync = promisify(execFile);

function fakeSdkSandbox() {
  const run = vi.fn(
    async (_command: string, _options?: Record<string, unknown>): Promise<unknown> => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
  );
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
    write: vi.fn(async (_files: unknown, _options?: { user?: string }) => []),
    makeDir: vi.fn(async (_path: string, _options?: { user?: string }) => true),
    exists: vi.fn(async (_path: string, _options?: { user?: string }) => true),
    remove: vi.fn(async (_path: string, _options?: { user?: string }) => undefined),
    rename: vi.fn(async (_from: string, _to: string, _options?: { user?: string }) => ({})),
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
  sdk.kill.mockResolvedValue(true);
});

describe("E2B SDK adapter", () => {
  it("creates a secure, auto-pausing sandbox without sandbox environment secrets", async () => {
    const sandbox = fakeSdkSandbox();
    sdk.create.mockResolvedValue(sandbox);
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
    const bootstrapCalls = sandbox.commands.run.mock.calls;
    expect(bootstrapCalls.every(([, commandOptions]) => commandOptions?.user === "root")).toBe(
      true,
    );
    expect(
      bootstrapCalls.some(([command]) => command.includes(`--reuid=${E2B_PROJECT_USER}`)),
    ).toBe(true);
    expect(bootstrapCalls.some(([command]) => command.includes(`--reuid=${E2B_RELAY_USER}`))).toBe(
      true,
    );
    expect(
      bootstrapCalls
        .filter(([command]) => command.includes("--reuid="))
        .every(
          ([command]) =>
            command.includes("--no-new-privs") &&
            command.includes("--bounding-set=-all") &&
            command.includes("/usr/bin/env -i"),
        ),
    ).toBe(true);
    expect(
      bootstrapCalls.some(
        ([command]) =>
          command.includes("/process.Process/List") &&
          command.includes("cm9vdDo=") &&
          command.includes("NoNewPrivs"),
      ),
    ).toBe(true);
    const bootstrap =
      bootstrapCalls.find(([command]) => command.includes("quillra_project_uid="))?.[0] ?? "";
    expect(bootstrap).toContain("--no-create-home");
    expect(bootstrap).toContain("os.O_NOFOLLOW");
    expect(bootstrap).toContain("os.fchown");
    expect(bootstrap).not.toContain(
      `/usr/bin/install -d -o ${E2B_PROJECT_USER} -g ${E2B_PROJECT_USER}`,
    );
    expect(bootstrap).not.toContain(`${E2B_PROJECT_HOME}/.quillra-processes`);
    const envdProbe =
      bootstrapCalls.find(([command]) => command.includes("/process.Process/List"))?.[0] ?? "";
    expect(envdProbe).toContain("except ConnectionRefusedError:");
    expect(envdProbe).toContain("error.errno==errno.ECONNREFUSED");
    expect(envdProbe).toContain("status in (401,403)");
    expect(envdProbe).not.toMatch(/except OSError:\\?n\s*sys\.exit\(0\)/);
    expect(
      sandbox.files.write.mock.calls.some(([, fileOptions]) => fileOptions?.user === "root"),
    ).toBe(true);
    expect(
      sandbox.files.remove.mock.calls.some(([, fileOptions]) => fileOptions?.user === "root"),
    ).toBe(true);
  });

  it("refuses a managed-directory symlink without mutating its target metadata", async () => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    expect(uid).toBeTypeOf("number");
    expect(gid).toBeTypeOf("number");
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "quillra-secure-dir-"));
    const trustedParent = path.join(fixtureRoot, "trusted-parent");
    const target = path.join(fixtureRoot, "system-target");
    const managedPath = path.join(trustedParent, "managed");
    try {
      await mkdir(trustedParent, { mode: 0o700 });
      await mkdir(target, { mode: 0o755 });
      await chmod(target, 0o755);
      await symlink(target, managedPath);
      const before = await lstat(target);
      const fixtureScript = SECURE_DIRECTORY_SETUP_SCRIPT.replace(
        "TRUSTED_PARENT_UID=0",
        `TRUSTED_PARENT_UID=${uid}`,
      );

      await expect(
        execFileAsync("/usr/bin/python3", [
          "-I",
          "-S",
          "-c",
          fixtureScript,
          managedPath,
          String(uid),
          String(gid),
          "0700",
        ]),
      ).rejects.toBeDefined();

      const after = await lstat(target);
      expect((after.mode & 0o777).toString(8)).toBe((before.mode & 0o777).toString(8));
      expect(after.uid).toBe(before.uid);
      expect(after.gid).toBe(before.gid);
      expect((await lstat(managedPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("supports disposable network-closed verification sandboxes without changing defaults", async () => {
    sdk.create.mockResolvedValue(fakeSdkSandbox());
    const adapter = new E2BSdkAdapter();

    await adapter.create({
      apiKey: "e2b_control_plane_secret",
      templateId: "base",
      projectId: "verification",
      timeoutMs: 60_000,
      requestTimeoutMs: 60_000,
      lifecycle: { onTimeout: "kill" },
      allowInternetAccess: false,
    });

    expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({
      lifecycle: { onTimeout: "kill" },
      allowInternetAccess: false,
    });
  });

  it("kills a sandbox when trusted bootstrap fails", async () => {
    const sandbox = fakeSdkSandbox();
    sandbox.commands.run.mockRejectedValueOnce(new Error("provider detail"));
    sdk.create.mockResolvedValue(sandbox);
    const adapter = new E2BSdkAdapter();

    await expect(
      adapter.create({
        apiKey: "e2b_control_plane_secret",
        templateId: "base",
        projectId: "project-a",
        timeoutMs: 900_000,
        requestTimeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      code: "trusted-environment-failed",
      stage: "bootstrap",
      cleanupStatus: "confirmed",
    } satisfies Partial<E2BTrustedEnvironmentError>);
    expect(sdk.kill).toHaveBeenCalledWith("sandbox-1", {
      apiKey: "e2b_control_plane_secret",
      requestTimeoutMs: 60_000,
    });
  });

  it("treats an already absent sandbox as confirmed bootstrap cleanup", async () => {
    const sandbox = fakeSdkSandbox();
    sandbox.commands.run.mockRejectedValueOnce(new Error("provider detail"));
    sdk.create.mockResolvedValue(sandbox);
    sdk.kill.mockResolvedValueOnce(false);

    await expect(
      new E2BSdkAdapter().create({
        apiKey: "e2b_control_plane_secret",
        templateId: "base",
        projectId: "project-a",
        timeoutMs: 900_000,
        requestTimeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      cleanupStatus: "confirmed",
    });
  });

  it("reports a sanitized failed cleanup when bootstrap sandbox removal is unconfirmed", async () => {
    const sandbox = fakeSdkSandbox();
    sandbox.commands.run.mockRejectedValueOnce(new Error("provider detail"));
    sdk.create.mockResolvedValue(sandbox);
    sdk.kill.mockRejectedValueOnce(new Error("sensitive cleanup detail"));

    await expect(
      new E2BSdkAdapter().create({
        apiKey: "e2b_control_plane_secret",
        templateId: "base",
        projectId: "project-a",
        timeoutMs: 900_000,
        requestTimeoutMs: 60_000,
      }),
    ).rejects.toMatchObject({
      name: "E2BTrustedEnvironmentError",
      code: "trusted-environment-failed",
      stage: "bootstrap",
      cleanupStatus: "failed",
      message:
        "The E2B trusted execution environment failed and its cleanup could not be confirmed.",
    });
  });

  it("proves the privileged port boundary before starting the root-binding relay", async () => {
    const sandbox = fakeSdkSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const handle = await new E2BSdkAdapter().create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });
    sandbox.commands.run.mockClear();

    await handle.startPreviewRelay(4_321);

    const calls = sandbox.commands.run.mock.calls;
    const privilegedPortProbeIndex = calls.findIndex(
      ([command]) =>
        command.includes("--reuid=quillra-project") &&
        command.includes("socket.AF_INET6") &&
        command.includes("errno.EACCES"),
    );
    const relayStartIndex = calls.findIndex(
      ([command]) =>
        command.includes("/usr/bin/setsid --fork") &&
        command.includes("/usr/local/libexec/quillra-preview-relay.mjs"),
    );
    expect(privilegedPortProbeIndex).toBeGreaterThan(-1);
    expect(relayStartIndex).toBeGreaterThan(privilegedPortProbeIndex);
    const relayStart = calls[relayStartIndex]?.[0] ?? "";
    expect(relayStart).toContain("--no-new-privs");
    expect(relayStart).not.toContain("--reuid=quillra-relay");
    expect(calls[relayStartIndex]?.[1]).toMatchObject({
      user: "root",
      envs: expect.objectContaining({
        BASH_ENV: "/dev/null",
        HOME: "/run/quillra-preview/control-home",
      }),
    });
  });

  it("cannot lose dumpable-zero project or relay processes through proc inode ownership", async () => {
    const sandbox = fakeSdkSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const handle = await new E2BSdkAdapter().create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });
    sandbox.commands.run.mockClear();

    await handle.quiesceProjectProcesses();
    await handle.stopPreviewRelay();

    const quiescers = sandbox.commands.run.mock.calls
      .map(([command]) => command)
      .filter((command) => command.includes("pwd.getpwnam") && command.includes("signal.SIGKILL"));
    expect(quiescers).toHaveLength(2);
    for (const command of quiescers) {
      // PR_SET_DUMPABLE=0 (also triggered by the relay's root -> UID drop)
      // can make /proc/<pid> root-owned. The kernel's credential fields remain
      // authoritative and expose real/effective/saved/fs UIDs.
      expect(command).toContain('"/proc/"+name+"/status"');
      expect(command).toContain('line.startswith(b"Uid:")');
      expect(command).toContain("len(uid_fields)!=5");
      expect(command).toContain("uid not in process_uids");
      expect(command).toContain("errno.ENOENT,errno.ESRCH");
      expect(command).not.toContain("os.stat(proc).st_uid");
      expect(command).not.toContain("PermissionError");
      expect(command).not.toMatch(/except OSError:[\s\S]*?\n\s*pass/);
    }
  });

  it("performs every workspace filesystem operation as the isolated project user", async () => {
    const sandbox = fakeSdkSandbox();
    sdk.create.mockResolvedValue(sandbox);
    const handle = await new E2BSdkAdapter().create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });
    sandbox.files.getInfo.mockClear();
    sandbox.files.write.mockClear();
    sandbox.files.makeDir.mockClear();
    sandbox.files.exists.mockClear();
    sandbox.files.remove.mockClear();
    sandbox.files.rename.mockClear();

    await handle.getInfo(`${E2B_PROJECT_HOME}/file`);
    await handle.writeFiles([
      {
        path: `${E2B_PROJECT_HOME}/file`,
        data: new TextEncoder().encode("safe"),
      },
    ]);
    await handle.makeDir(`${E2B_PROJECT_HOME}/directory`);
    await handle.exists(`${E2B_PROJECT_HOME}/directory`);
    await handle.rename(`${E2B_PROJECT_HOME}/file`, `${E2B_PROJECT_HOME}/renamed`);
    await handle.remove(`${E2B_PROJECT_HOME}/renamed`);

    for (const operation of [
      sandbox.files.getInfo,
      sandbox.files.write,
      sandbox.files.makeDir,
      sandbox.files.exists,
      sandbox.files.remove,
      sandbox.files.rename,
    ]) {
      expect(operation.mock.calls.at(-1)?.at(-1)).toEqual(
        expect.objectContaining({ user: E2B_PROJECT_USER }),
      );
    }
  });

  it("keeps untrusted output out of CommandHandle and reads only bounded remote logs", async () => {
    const sandbox = fakeSdkSandbox();
    const commandHandle = {
      pid: 77,
      wait: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      kill: vi.fn(async () => true),
    };
    sdk.create.mockResolvedValue(sandbox);
    const adapter = new E2BSdkAdapter();
    const handle = await adapter.create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });
    sandbox.commands.run.mockClear();
    sandbox.commands.run.mockImplementation(
      async (command: string, options?: { background?: boolean }) =>
        options?.background
          ? commandHandle
          : {
              exitCode: 0,
              stdout: command.includes("/usr/bin/head -c") ? "hello" : "",
              stderr: "",
            },
    );
    const onStdout = vi.fn();

    const process = await handle.startCommand("yes unsafe", {
      cwd: `${E2B_PROJECT_HOME}/quillra-workspace`,
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
    expect(startOptions).toMatchObject({
      user: "root",
      envs: {
        BASH_ENV: "/dev/null",
        ENV: "/dev/null",
        HOME: "/run/quillra-preview/control-home",
        USER: "root",
      },
    });
    expect(wrapped).toContain(`--reuid=${E2B_PROJECT_USER}`);
    expect(wrapped).toContain("--no-new-privs");
    expect(wrapped).toContain("--bounding-set=-all");
    expect(wrapped).toContain("/usr/bin/env -i");
    expect(wrapped).toContain(`'HOME=${E2B_PROJECT_HOME}'`);
    expect(onStdout).toHaveBeenCalledWith("hello");
    expect(sandbox.files.makeDir.mock.calls.slice(0, 2)).toEqual([
      [
        `${E2B_PROJECT_HOME}/.quillra-processes`,
        expect.objectContaining({ user: E2B_PROJECT_USER }),
      ],
      [
        expect.stringMatching(new RegExp(`^${E2B_PROJECT_HOME}/\\.quillra-processes/[0-9a-f-]+$`)),
        expect.objectContaining({ user: E2B_PROJECT_USER }),
      ],
    ]);
    expect(sandbox.files.getInfo).not.toHaveBeenCalled();
    expect(sandbox.files.read).not.toHaveBeenCalled();
    const retrievals = sandbox.commands.run.mock.calls
      .slice(1)
      .map(([command]) => command)
      .filter((command) => command.includes("/usr/bin/head -c"));
    expect(retrievals).toHaveLength(2);
    expect(retrievals.every((command) => command.includes("/usr/bin/head -c 1024 -- "))).toBe(true);
    const controlOptions = sandbox.commands.run.mock.calls
      .slice(1)
      .map(([, options]) => options)
      .filter(Boolean);
    expect(
      controlOptions.every(
        (options) =>
          (options as { envs?: Record<string, string>; user?: string }).envs?.PATH ===
            "/usr/local/bin:/usr/sbin:/usr/bin:/bin" &&
          (options as { user?: string }).user === "root",
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
    sandbox.commands.run.mockClear();

    await expect(
      handle.startCommand("echo ok", {
        cwd: `${E2B_PROJECT_HOME}/quillra-workspace`,
        timeoutMs: 30_000,
        maxOutputBytes: 8 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow("output limit");
    expect(sandbox.commands.run).not.toHaveBeenCalled();
  });

  it("reads workspace files through fixed-size binary chunks, never files.read", async () => {
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
    sandbox.commands.run.mockClear();
    sandbox.commands.run.mockResolvedValue({
      exitCode: 0,
      stdout: Buffer.from([0, 255, 42]).toString("base64"),
      stderr: "",
    });

    await expect(handle.readFileChunk("/tmp/untrusted file", 65_536, 3)).resolves.toEqual(
      Uint8Array.from([0, 255, 42]),
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringMatching(
        /--reuid=quillra-project[\s\S]*\/usr\/bin\/dd if=[\s\S]*skip=65536 count=3 /,
      ),
      expect.objectContaining({
        user: "root",
        timeoutMs: 10_000,
        envs: expect.objectContaining({
          HOME: "/run/quillra-preview/control-home",
          PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/bin",
        }),
      }),
    );
    expect(sandbox.commands.run.mock.calls[0]?.[0]).toContain("| /usr/bin/base64");
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  it("lists one directory with hard budgets and preserves symlink/special metadata", async () => {
    const sandbox = fakeSdkSandbox();
    const encode = (value: string) => Buffer.from(value).toString("base64");
    sdk.create.mockResolvedValue(sandbox);
    const adapter = new E2BSdkAdapter();
    const handle = await adapter.create({
      apiKey: "e2b_key",
      templateId: "base",
      projectId: "project-a",
      timeoutMs: 900_000,
      requestTimeoutMs: 60_000,
    });
    sandbox.commands.run.mockClear();
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

    await expect(
      handle.list(`${E2B_PROJECT_HOME}/quillra-workspace`, {
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
        user: "root",
        timeoutMs: 10_000,
        envs: expect.objectContaining({
          HOME: "/run/quillra-preview/control-home",
          PATH: "/usr/local/bin:/usr/sbin:/usr/bin:/bin",
        }),
      }),
    );
    expect(sandbox.commands.run.mock.calls[0]?.[0]).toContain(
      `${E2B_PROJECT_HOME}/quillra-workspace`,
    );
    expect(sandbox.commands.run.mock.calls[0]?.[0]).toContain(" 3 1024");
  });

  it("fails closed when a directory exceeds its entry or byte budget", async () => {
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
    sandbox.commands.run.mockClear();
    sandbox.commands.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ ok: false, error: "entry_limit" }),
      stderr: "",
    });

    await expect(
      handle.list(`${E2B_PROJECT_HOME}/quillra-workspace`, {
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
      handle.list(`${E2B_PROJECT_HOME}/quillra-workspace`, {
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
      handle.list(`${E2B_PROJECT_HOME}/quillra-workspace`, {
        maxEntries: 1,
        maxOutputBytes: 512,
      }),
    ).rejects.toThrow("entry limit");
    expect(sandbox.files.list).not.toHaveBeenCalled();
  });
});
