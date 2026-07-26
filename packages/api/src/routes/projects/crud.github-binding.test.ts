import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "../../lib/auth.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalEncryptionKey = process.env.QUILLRA_ENCRYPTION_KEY;
const originalWorkspaceDirectory = process.env.WORKSPACE_DIR;

let tempDirectory: string;
let openDatabase: typeof import("../../db/index.js")["rawSqlite"] | null = null;

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-project-binding-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.WORKSPACE_DIR = path.join(tempDirectory, "workspaces");
  process.env.BETTER_AUTH_SECRET = "project-binding-test-secret";
  process.env.QUILLRA_ENCRYPTION_KEY = "c".repeat(64);
});

afterEach(() => {
  openDatabase?.close();
  openDatabase = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("BETTER_AUTH_SECRET", originalAuthSecret);
  restoreEnv("QUILLRA_ENCRYPTION_KEY", originalEncryptionKey);
  restoreEnv("WORKSPACE_DIR", originalWorkspaceDirectory);
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createApp() {
  vi.resetModules();
  const [{ rawSqlite }, { crudRouter }, { encryptSecret }] = await Promise.all([
    import("../../db/index.js"),
    import("./crud.js"),
    import("../../services/crypto.js"),
  ]);
  openDatabase = rawSqlite;
  const now = Date.now();
  rawSqlite
    .prepare(
      `INSERT INTO user
        (id, name, email, emailVerified, instance_role, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("user-1", "Alice", "alice@example.com", 1, "member", now, now);
  rawSqlite
    .prepare(
      `INSERT INTO github_user_connections
        (user_id, github_user_id, github_login, access_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("user-1", "1", "alice", encryptSecret("user-token"), now, now);

  type TestVariables = {
    user: SessionUser | null;
    clientSession: { projectId: string } | null;
  };
  const app = new Hono<{ Variables: TestVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", {
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    } as SessionUser);
    c.set("clientSession", null);
    await next();
  });
  app.route("/projects", crudRouter);
  return { app, rawSqlite };
}

function stubGithub(onFirstRequest?: () => void) {
  let firstRequest = true;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (firstRequest) {
        firstRequest = false;
        onFirstRequest?.();
      }
      expect(init?.headers).toMatchObject({ Authorization: "Bearer user-token" });
      const url = new URL(String(input));
      if (url.pathname === "/user/installations/11/repositories") {
        return Response.json({
          repositories: [
            {
              id: 101,
              full_name: "alice/canonical-site",
              default_branch: "main",
              permissions: { push: true, pull: true },
            },
            {
              id: 102,
              full_name: "customer/read-only",
              default_branch: "main",
              permissions: { push: false, pull: true },
            },
            {
              id: 103,
              full_name: "alice/second-site",
              default_branch: "main",
              permissions: { push: true, pull: true },
            },
          ],
        });
      }
      if (url.pathname === "/user/installations/11") {
        return Response.json({ id: 11, permissions: { contents: "write" } });
      }
      if (
        url.pathname === "/repos/alice/canonical-site/branches" ||
        url.pathname === "/repos/alice/second-site/branches"
      ) {
        return Response.json([{ name: "main" }]);
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function insertProject(
  rawSqlite: typeof import("../../db/index.js")["rawSqlite"],
  options: {
    id?: string;
    fullName?: string;
    branch?: string;
    installationId?: string | null;
    repositoryId?: string | null;
  } = {},
) {
  const id = options.id ?? "project-1";
  rawSqlite
    .prepare(
      `INSERT INTO projects
        (id, name, github_repo_full_name, github_installation_id,
         github_repository_id, default_branch)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "Existing",
      options.fullName ?? "alice/canonical-site",
      options.installationId ?? null,
      options.repositoryId ?? null,
      options.branch ?? "main",
    );
  rawSqlite
    .prepare(
      `INSERT INTO project_members (id, project_id, user_id, role)
       VALUES (?, ?, ?, ?)`,
    )
    .run(`member-${id}`, id, "user-1", "admin");
}

async function createLegacyWorkspace(
  projectId: string,
  options: { origin?: string; branch?: string } = {},
) {
  const repoPath = path.join(process.env.WORKSPACE_DIR ?? "", projectId, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  const git = simpleGit({
    baseDir: repoPath,
    config: ["user.name=Quillra Test", "user.email=test@quillra.test"],
  });
  await git.init();
  const branch = options.branch ?? "main";
  await git.raw(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
  await git.addRemote("origin", options.origin ?? "https://github.com/Alice/Canonical-Site.git");
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "published\n");
  await git.add("tracked.txt");
  await git.commit("base");
  fs.writeFileSync(path.join(repoPath, "tracked.txt"), "dirty draft\n");
  fs.writeFileSync(path.join(repoPath, "untracked.txt"), "untracked draft\n");
  fs.appendFileSync(
    path.join(repoPath, ".git", "config"),
    '\n[alias]\n\tunsafe-status = "!printf unsafe"\n',
  );
  return repoPath;
}

describe("project GitHub bindings", () => {
  it("ignores a client-supplied repo name and persists GitHub's immutable binding", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();

    const response = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Canonical project",
        githubRepoFullName: "attacker/arbitrary-name",
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(
      rawSqlite
        .prepare(
          `SELECT github_repo_full_name, github_installation_id, github_repository_id
             FROM projects WHERE id = ?`,
        )
        .get(id),
    ).toEqual({
      github_repo_full_name: "alice/canonical-site",
      github_installation_id: "11",
      github_repository_id: "101",
    });

    const membership = rawSqlite
      .prepare("SELECT user_id, role FROM project_members WHERE project_id = ?")
      .get(id);
    expect(membership).toEqual({ user_id: "user-1", role: "admin" });
  });

  it("rejects read-only repositories and generic repository rebinding", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();

    const readOnly = await app.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Read only",
        githubInstallationId: "11",
        githubRepositoryId: "102",
        defaultBranch: "main",
      }),
    });
    expect(readOnly.status).toBe(403);
    expect(rawSqlite.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({
      count: 0,
    });

    rawSqlite
      .prepare(
        `INSERT INTO projects
          (id, name, github_repo_full_name, github_installation_id, github_repository_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-1", "Existing", "alice/canonical-site", "11", "101");
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, ?)`,
      )
      .run("member-1", "project-1", "user-1", "admin");

    const bypass = await app.request("/projects/project-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubRepoFullName: "attacker/repo" }),
    });
    expect(bypass.status).toBe(400);
    expect(
      rawSqlite.prepare("SELECT github_repo_full_name FROM projects WHERE id = ?").get("project-1"),
    ).toEqual({ github_repo_full_name: "alice/canonical-site" });
  });

  it("backfills a matching legacy binding without changing dirty or untracked files", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite, { fullName: "ALICE/CANONICAL-SITE" });
    const legacySecret = "legacy-installation-secret";
    const repoPath = await createLegacyWorkspace("project-1", {
      origin: `https://x-access-token:${legacySecret}@github.com/Alice/Canonical-Site.git`,
    });

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      preservedWorkspace: true,
      githubRepoFullName: "alice/canonical-site",
    });
    expect(
      rawSqlite
        .prepare(
          `SELECT github_repo_full_name, github_installation_id, github_repository_id,
                  github_binding_generation
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_repo_full_name: "alice/canonical-site",
      github_installation_id: "11",
      github_repository_id: "101",
      github_binding_generation: 2,
    });

    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("dirty draft\n");
    expect(fs.readFileSync(path.join(repoPath, "untracked.txt"), "utf8")).toBe("untracked draft\n");
    expect(fs.existsSync(path.join(repoPath, ".git", "objects"))).toBe(true);
    const status = await simpleGit(repoPath).status();
    expect(status.modified).toContain("tracked.txt");
    expect(status.not_added).toContain("untracked.txt");
    const config = fs.readFileSync(path.join(repoPath, ".git", "config"), "utf8");
    expect(config).toContain('url = "https://github.com/alice/canonical-site.git"');
    expect(config).not.toContain(legacySecret);
    expect(config).not.toContain("x-access-token");
    expect(config).not.toContain("unsafe-status");
    expect(config).not.toContain("[alias]");
  });

  it("allows a database-only legacy backfill when no working copy exists", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      preservedWorkspace: false,
    });
    expect(
      rawSqlite
        .prepare(
          `SELECT github_installation_id, github_repository_id,
                  github_binding_generation
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_installation_id: "11",
      github_repository_id: "101",
      github_binding_generation: 2,
    });
  });

  it("fails closed when a legacy workspace exists without a real Git directory", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);
    const repoPath = path.join(process.env.WORKSPACE_DIR ?? "", "project-1", "repo");
    fs.mkdirSync(repoPath, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "important-draft.txt"), "keep me\n");

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(
      rawSqlite
        .prepare(
          `SELECT github_installation_id, github_repository_id
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
    });
    expect(fs.readFileSync(path.join(repoPath, "important-draft.txt"), "utf8")).toBe("keep me\n");
  });

  it("fails closed when matching config and HEAD do not point to a real commit", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);
    const repoPath = path.join(process.env.WORKSPACE_DIR ?? "", "project-1", "repo");
    const gitPath = path.join(repoPath, ".git");
    fs.mkdirSync(path.join(gitPath, "objects"), { recursive: true });
    fs.mkdirSync(path.join(gitPath, "refs", "heads"), { recursive: true });
    fs.writeFileSync(
      path.join(gitPath, "config"),
      '[remote "origin"]\n\turl = https://github.com/alice/canonical-site.git\n',
    );
    fs.writeFileSync(path.join(gitPath, "HEAD"), "ref: refs/heads/main\n");

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(fs.existsSync(repoPath)).toBe(true);
    expect(
      rawSqlite
        .prepare("SELECT github_installation_id, github_repository_id FROM projects WHERE id = ?")
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
    });
  });

  it("rejects a legacy Git object database that redirects through alternates", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);
    const repoPath = await createLegacyWorkspace("project-1");
    fs.mkdirSync(path.join(repoPath, ".git", "objects", "info"), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, ".git", "objects", "info", "alternates"),
      "/tmp/other-project-objects\n",
    );

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("dirty draft\n");
    expect(
      rawSqlite
        .prepare("SELECT github_installation_id, github_repository_id FROM projects WHERE id = ?")
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
    });
  });

  it("rejects nested Git metadata that could execute a submodule config", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);
    const repoPath = await createLegacyWorkspace("project-1");
    const externalGitDirectory = path.join(tempDirectory, "external-submodule.git");
    fs.mkdirSync(path.join(repoPath, "nested"), { recursive: true });
    fs.mkdirSync(externalGitDirectory, { recursive: true });
    fs.writeFileSync(path.join(repoPath, "nested", ".git"), `gitdir: ${externalGitDirectory}\n`);

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(fs.existsSync(path.join(repoPath, "nested", ".git"))).toBe(true);
    expect(
      rawSqlite
        .prepare("SELECT github_installation_id, github_repository_id FROM projects WHERE id = ?")
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
    });
  });

  it("rejects an indexed Gitlink even when no nested Git metadata remains", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);
    const repoPath = await createLegacyWorkspace("project-1");
    const git = simpleGit(repoPath);
    const head = (await git.revparse(["HEAD"])).trim();
    await git.raw(["update-index", "--add", "--cacheinfo", `160000,${head},nested`]);

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(
      rawSqlite
        .prepare("SELECT github_installation_id, github_repository_id FROM projects WHERE id = ?")
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
    });
  });

  it("fails closed when the legacy project workspace is a symbolic link", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);
    const linkedRepoPath = await createLegacyWorkspace("other-project");
    const linkedWorkspace = path.dirname(linkedRepoPath);
    const projectPath = path.join(process.env.WORKSPACE_DIR ?? "", "project-1");
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.symlinkSync(linkedWorkspace, projectPath, "dir");

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(fs.readFileSync(path.join(linkedRepoPath, "tracked.txt"), "utf8")).toBe("dirty draft\n");
    expect(fs.existsSync(path.join(linkedRepoPath, ".git", "objects"))).toBe(true);
    expect(
      rawSqlite
        .prepare("SELECT github_installation_id, github_repository_id FROM projects WHERE id = ?")
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
    });
  });

  it("compares legacy default branches case-sensitively", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite, { branch: "Main" });

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(
      rawSqlite
        .prepare(
          `SELECT github_installation_id, github_repository_id,
                  github_binding_generation
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
      github_binding_generation: 1,
    });
  });

  it("fails closed when the imported working copy origin does not match", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);
    const repoPath = await createLegacyWorkspace("project-1", {
      origin: "https://github.com/alice/second-site.git",
    });

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "legacy_github_backfill_conflict",
    });
    expect(
      rawSqlite
        .prepare(
          `SELECT github_installation_id, github_repository_id,
                  github_binding_generation
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
      github_binding_generation: 1,
    });
    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("dirty draft\n");
    expect(fs.readFileSync(path.join(repoPath, "untracked.txt"), "utf8")).toBe("untracked draft\n");
    expect(fs.readFileSync(path.join(repoPath, ".git", "config"), "utf8")).toContain(
      "https://github.com/alice/second-site.git",
    );
  });

  it("keeps the normal repository rebind destructive", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite, {
      installationId: "11",
      repositoryId: "101",
    });
    const repoPath = await createLegacyWorkspace("project-1");

    const response = await app.request("/projects/project-1/github/rebind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "103",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(200);
    expect(fs.existsSync(repoPath)).toBe(false);
    expect(
      rawSqlite
        .prepare(
          `SELECT github_repo_full_name, github_repository_id,
                  github_binding_generation
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_repo_full_name: "alice/second-site",
      github_repository_id: "103",
      github_binding_generation: 2,
    });
  });

  it("refuses a destructive direct rebind for a fully legacy project", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite);
    const repoPath = await createLegacyWorkspace("project-1");

    const response = await app.request("/projects/project-1/github/rebind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "103",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "legacy_github_backfill_required",
    });
    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("dirty draft\n");
    expect(fs.readFileSync(path.join(repoPath, "untracked.txt"), "utf8")).toBe("untracked draft\n");
    expect(
      rawSqlite
        .prepare(
          `SELECT github_installation_id, github_repository_id,
                  github_binding_generation
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
      github_binding_generation: 1,
    });
  });

  it("refuses a destructive direct rebind for a partial legacy binding", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    insertProject(rawSqlite, {
      installationId: null,
      repositoryId: "101",
    });
    const repoPath = await createLegacyWorkspace("project-1");

    const response = await app.request("/projects/project-1/github/rebind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "103",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(409);
    expect(fs.readFileSync(path.join(repoPath, "tracked.txt"), "utf8")).toBe("dirty draft\n");
    expect(
      rawSqlite
        .prepare("SELECT github_installation_id, github_repository_id FROM projects WHERE id = ?")
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: "101",
    });
  });

  it("rechecks project administrator access before scanning or committing", async () => {
    const { app, rawSqlite } = await createApp();
    insertProject(rawSqlite);
    const repoPath = await createLegacyWorkspace("project-1");
    fs.mkdirSync(path.join(repoPath, "nested"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "nested", ".git"), "unsafe nested metadata\n");
    stubGithub(() => {
      rawSqlite
        .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
        .run("project-1", "user-1");
    });

    const response = await app.request("/projects/project-1/github/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        githubInstallationId: "11",
        githubRepositoryId: "101",
        defaultBranch: "main",
      }),
    });

    expect(response.status).toBe(403);
    expect(fs.existsSync(path.join(repoPath, "nested", ".git"))).toBe(true);
    expect(
      rawSqlite
        .prepare("SELECT github_installation_id, github_repository_id FROM projects WHERE id = ?")
        .get("project-1"),
    ).toEqual({
      github_installation_id: null,
      github_repository_id: null,
    });
  });

  it("increments the binding generation across an A to B to A rebind", async () => {
    const { app, rawSqlite } = await createApp();
    stubGithub();
    rawSqlite
      .prepare(
        `INSERT INTO projects
          (id, name, github_repo_full_name, github_installation_id, github_repository_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-1", "Existing", "alice/canonical-site", "11", "101");
    rawSqlite
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, ?)`,
      )
      .run("member-1", "project-1", "user-1", "admin");

    for (const repositoryId of ["103", "101"]) {
      const response = await app.request("/projects/project-1/github/rebind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubInstallationId: "11",
          githubRepositoryId: repositoryId,
          defaultBranch: "main",
        }),
      });
      expect(response.status).toBe(200);
    }

    expect(
      rawSqlite
        .prepare(
          `SELECT github_repository_id, github_binding_generation
             FROM projects WHERE id = ?`,
        )
        .get("project-1"),
    ).toEqual({
      github_repository_id: "101",
      github_binding_generation: 3,
    });
  });
});
