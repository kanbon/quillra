import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import { setPreviewStatus, registerPreviewPort } from "./preview-status.js";
import { detectFromManifest, getFrameworkById } from "./framework-registry.js";
import { getInstanceSetting } from "./instance-settings.js";

const previewChildren = new Map<string, ChildProcess>();

/**
 * Bounded ring buffer of the last ~200 log lines per running dev server
 * so the debug modal can show what the framework is printing in real time.
 * Wiped whenever the dev server restarts.
 */
const MAX_LOG_LINES = 200;
const previewLogs = new Map<string, Array<{ t: number; stream: "stdout" | "stderr"; line: string }>>();

function appendLog(projectId: string, stream: "stdout" | "stderr", chunk: string) {
  const buf = previewLogs.get(projectId) ?? [];
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, ""); // strip ANSI colours
    if (!line) continue;
    buf.push({ t: Date.now(), stream, line });
  }
  while (buf.length > MAX_LOG_LINES) buf.shift();
  previewLogs.set(projectId, buf);
}

export function getPreviewLogs(projectId: string) {
  return previewLogs.get(projectId) ?? [];
}

export function clearPreviewLogs(projectId: string) {
  previewLogs.delete(projectId);
}

export function workspaceRoot(): string {
  const dir = process.env.WORKSPACE_DIR ?? path.join(process.cwd(), "data", "workspaces");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectRepoPath(projectId: string): string {
  return path.join(workspaceRoot(), projectId, "repo");
}

export function previewPortForProject(projectId: string): number {
  const base = Number(process.env.PREVIEW_PORT_BASE ?? 4321);
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return base + (h % 2000);
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function getPackageManager(repoPath: string): "yarn" | "pnpm" | "npm" {
  if (fs.existsSync(path.join(repoPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

export async function installDependenciesIfNeeded(repoPath: string, projectId?: string): Promise<void> {
  const pkg = path.join(repoPath, "package.json");
  if (!fs.existsSync(pkg)) return;
  if (fs.existsSync(path.join(repoPath, "node_modules"))) return;

  const pm = getPackageManager(repoPath);
  if (projectId) setPreviewStatus(projectId, "installing", `Running ${pm} install`);
  if (pm === "yarn") {
    await runCommand("yarn", ["install", "--non-interactive"], repoPath);
  } else if (pm === "pnpm") {
    await runCommand("pnpm", ["install"], repoPath);
  } else {
    await runCommand("npm", ["install"], repoPath);
  }
}

type DevCmd = { command: string; args: string[]; label: string };

function readPkgJson(repoPath: string) {
  const p = path.join(repoPath, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
  } catch {
    return null;
  }
}

export function resolveDevCommand(
  repoPath: string,
  port: number,
  override: string | null | undefined,
): DevCmd {
  // 1) Project-level override always wins
  const interpolated = (override?.trim() ?? "")
    .replace(/\{port\}/g, String(port))
    .replace(/\$PORT/g, String(port));
  if (interpolated) {
    if (process.platform === "win32") {
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", interpolated],
        label: "Custom",
      };
    }
    return { command: "sh", args: ["-c", interpolated], label: "Custom" };
  }

  // 2) Detect via the central framework registry
  const pkg = readPkgJson(repoPath);
  let rootFiles: string[] = [];
  try {
    rootFiles = fs.readdirSync(repoPath);
  } catch { /* ignore */ }
  const def = detectFromManifest({ packageJson: pkg, rootFiles });
  if (def) {
    return {
      command: def.devCommand.binary,
      args: def.devCommand.args.map((a) => a.replace(/\{port\}/g, String(port))),
      label: def.label,
    };
  }

  // 3) Fall back to whatever `dev` script is in package.json
  const pm = getPackageManager(repoPath);
  if (pkg?.scripts?.dev) {
    if (pm === "yarn") return { command: "yarn", args: ["run", "dev"], label: "yarn dev" };
    if (pm === "pnpm") return { command: "pnpm", args: ["run", "dev"], label: "pnpm dev" };
    return { command: "npm", args: ["run", "dev"], label: "npm run dev" };
  }

  // 4) Last-resort default
  return {
    command: "npx",
    args: ["vite", "--host", "0.0.0.0", "--port", String(port)],
    label: "Static site",
  };
}

// Re-exported so other modules can resolve a framework by id without importing the registry directly
export { getFrameworkById };

/** Returns metadata about the running (or not) preview child for a project */
export function getPreviewProcessInfo(projectId: string): {
  running: boolean;
  pid: number | null;
  exitCode: number | null;
  signalCode: string | null;
} {
  const child = previewChildren.get(projectId);
  if (!child) return { running: false, pid: null, exitCode: null, signalCode: null };
  return {
    running: child.exitCode === null && !child.killed,
    pid: child.pid ?? null,
    exitCode: child.exitCode,
    signalCode: child.signalCode ?? null,
  };
}

/** Return the current subdomain id (if any) that maps to this project */
export function getProjectSubdomainId(projectId: string): string | null {
  return projectSubdomainIds.get(projectId) ?? null;
}

/** Remove cloned workspace so the next ensureRepoCloned does a fresh clone (repo or branch change). */
export function clearProjectRepoClone(projectId: string): void {
  stopPreview(projectId);
  const dir = projectRepoPath(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function ensureRepoCloned(
  projectId: string,
  githubRepoFullName: string,
  branch: string,
): Promise<string> {
  const dir = projectRepoPath(projectId);
  const gitDir = path.join(dir, ".git");
  const token = getInstanceSetting("GITHUB_TOKEN");
  const url = token
    ? `https://x-access-token:${token}@github.com/${githubRepoFullName}.git`
    : `https://github.com/${githubRepoFullName}.git`;

  if (!fs.existsSync(gitDir)) {
    setPreviewStatus(projectId, "cloning", `Cloning ${githubRepoFullName}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await simpleGit().clone(url, dir, ["--branch", branch, "--single-branch", "--depth", "1"]);
    await installDependenciesIfNeeded(dir, projectId);
  } else {
    const g = simpleGit(dir);
    if (token) {
      await g.remote(["set-url", "origin", url]).catch(() => undefined);
    }
    await g.fetch("origin", branch);
    await g.checkout(branch);
    await g.pull("origin", branch).catch(() => undefined);
    await installDependenciesIfNeeded(dir, projectId);
  }
  return dir;
}

export function stopPreview(projectId: string): void {
  const child = previewChildren.get(projectId);
  if (child) {
    child.kill("SIGTERM");
    previewChildren.delete(projectId);
  }
}

export async function startDevPreview(
  projectId: string,
  repoPath: string,
  previewCommandOverride: string | null | undefined,
): Promise<{ port: number; label: string }> {
  stopPreview(projectId);
  const port = previewPortForProject(projectId);
  registerPreviewPort(port, projectId);
  setPreviewStatus(projectId, "starting", "Launching dev server");
  const { command, args, label } = resolveDevCommand(repoPath, port, previewCommandOverride);
  const child = spawn(command, args, {
    cwd: repoPath,
    stdio: "pipe",
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "0.0.0.0",
      NODE_ENV: "development",
      FORCE_COLOR: "0",
    },
    shell: false,
  });
  // Reset logs whenever the dev server (re)starts
  clearPreviewLogs(projectId);
  // Watch dev server output for "ready" indicators so we can flip status,
  // and buffer the lines for the debug modal.
  child.stdout?.on("data", (buf: Buffer) => {
    const s = buf.toString();
    appendLog(projectId, "stdout", s);
    if (/ready|local:|listening|started server|compiled successfully/i.test(s)) {
      setPreviewStatus(projectId, "ready");
    }
  });
  child.stderr?.on("data", (buf: Buffer) => {
    const s = buf.toString();
    appendLog(projectId, "stderr", s);
    if (/ready|local:|listening|started server|compiled successfully/i.test(s)) {
      setPreviewStatus(projectId, "ready");
    }
  });
  child.on("exit", (code) => {
    if (code !== 0) setPreviewStatus(projectId, "error", `Dev server exited with code ${code}`);
  });
  previewChildren.set(projectId, child);
  return { port, label };
}

/** Maps preview subdomain ID → localhost port */
const previewSubdomains = new Map<string, number>();

/** Reverse map: projectId → subdomain ID */
const projectSubdomainIds = new Map<string, string>();

export function getPreviewSubdomainPort(subdomainId: string): number | undefined {
  return previewSubdomains.get(subdomainId);
}

export function getPreviewUrl(projectId: string, port: number): string {
  const host = process.env.PREVIEW_DOMAIN;
  if (host) {
    // Subdomain mode: {id}.cms.kanbon.at
    let id = projectSubdomainIds.get(projectId);
    if (!id) {
      id = projectId.slice(0, 12).toLowerCase().replace(/[^a-z0-9]/g, "");
      projectSubdomainIds.set(projectId, id);
    }
    previewSubdomains.set(id, port);
    return `https://${id}.${host}`;
  }
  // Fallback: same-origin proxy
  const base = process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  return `${base}/__preview/${port}/`;
}

export async function pushToGitHub(
  repoPath: string,
  branch: string,
  githubRepoFullName: string,
  userToken?: string | null,
  committer?: { name: string; email: string } | null,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const token = userToken?.trim() || getInstanceSetting("GITHUB_TOKEN");
  if (!token) {
    throw new Error("GitHub access denied. Try signing out and back in to refresh your token.");
  }

  const g = simpleGit(repoPath);
  const authUrl = `https://x-access-token:${token}@github.com/${githubRepoFullName}.git`;
  await g.remote(["set-url", "origin", authUrl]);

  if (committer?.name) await g.addConfig("user.name", committer.name);
  if (committer?.email) await g.addConfig("user.email", committer.email);

  const status = await g.status();
  if (!status.isClean()) {
    await g.add("-A");
    const changed = [...status.modified, ...status.created, ...status.not_added, ...status.deleted];
    const summary = changed.length <= 5
      ? changed.join(", ")
      : `${changed.slice(0, 4).join(", ")} +${changed.length - 4} more`;
    await g.commit(`Update ${summary} via Quillra`);
  }

  const branches = await g.branch(["-r"]);
  const hasRemote = branches.all.includes(`origin/${branch}`);

  if (!hasRemote) {
    try {
      await g.push(["--set-upstream", "origin", branch]);
    } catch {
      await g.push("origin", branch);
    }
    return {
      ok: true,
      message: `Published ${branch} to GitHub. Your host can deploy from this branch.`,
    };
  }

  const log = await g.log({ from: `origin/${branch}`, to: "HEAD", maxCount: 100 });
  if (log.total === 0) {
    return { ok: false, message: "Nothing new to push — already in sync with GitHub." };
  }

  try {
    await g.push("origin", branch);
  } catch {
    await g.push(["--set-upstream", "origin", branch]);
  }
  return {
    ok: true,
    message: `Published ${log.total} commit(s) to GitHub.`,
  };
}
