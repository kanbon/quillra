import { createHash, randomBytes } from "node:crypto";
import { rawSqlite } from "../db/index.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { getGithubAppCredentials } from "./github-app.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_VERSION = "2022-11-28";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;
const tokenRefreshes = new Map<string, Promise<string>>();
const connectingUsers = new Set<string>();
const connections = new Map<string, Promise<{ githubLogin: string }>>();
const disconnectingUsers = new Set<string>();
const disconnects = new Map<string, Promise<void>>();
let githubAppReset: Promise<void> | null = null;
let githubAppResetting = false;

type GithubConnectionRow = {
  user_id: string;
  github_user_id: string;
  github_login: string;
  access_token: string;
  refresh_token: string | null;
  access_token_expires_at: number | null;
  refresh_token_expires_at: number | null;
};

type GithubOauthStateRow = {
  code_verifier: string;
  return_to: string;
  expires_at: number;
};

type GithubTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
};

type GithubRepositoryResponse = {
  id: number;
  full_name: string;
  default_branch: string;
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  };
};

export type GithubUserRepository = {
  repositoryId: string;
  installationId: string;
  fullName: string;
  defaultBranch: string;
};

export class GithubConnectionRequiredError extends Error {
  readonly code = "github_connection_required";

  constructor(message = "Connect your GitHub account to choose a repository.") {
    super(message);
    this.name = "GithubConnectionRequiredError";
  }
}

export class GithubRepositoryAccessError extends Error {
  readonly code = "github_repository_access_denied";

  constructor(message = "You do not have write access to that GitHub repository.") {
    super(message);
    this.name = "GithubRepositoryAccessError";
  }
}

function githubOauthCredentials(): { clientId: string; clientSecret: string } {
  const creds = getGithubAppCredentials();
  if (!creds?.clientId || !creds.clientSecret) {
    throw new Error("Quillra GitHub App OAuth is not configured.");
  }
  return { clientId: creds.clientId, clientSecret: creds.clientSecret };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function stateHash(state: string): string {
  return sha256(state).toString("hex");
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function sanitizeGithubReturnTo(value: string | undefined | null): string {
  if (!value || value.length > 2_048 || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  if (value.includes("\\") || hasControlCharacters(value)) return "/";
  try {
    const parsed = new URL(value, "https://quillra.invalid");
    if (parsed.origin !== "https://quillra.invalid") return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

export function issueGithubOauthState(
  userId: string,
  returnTo: string | undefined | null,
): { state: string; codeChallenge: string } {
  if (githubAppResetting) {
    throw new GithubConnectionRequiredError("The GitHub App is being reset. Try again.");
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const now = Date.now();
  rawSqlite
    .prepare("DELETE FROM github_oauth_states WHERE expires_at <= ? OR user_id = ?")
    .run(now, userId);
  rawSqlite
    .prepare(
      `INSERT INTO github_oauth_states
        (state_hash, user_id, code_verifier, return_to, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      stateHash(state),
      userId,
      encryptSecret(verifier),
      sanitizeGithubReturnTo(returnTo),
      now + OAUTH_STATE_TTL_MS,
      now,
    );
  return {
    state,
    codeChallenge: sha256(verifier).toString("base64url"),
  };
}

export function consumeGithubOauthState(
  userId: string,
  state: string,
): { codeVerifier: string; returnTo: string } | null {
  if (!state || state.length > 512) return null;
  const hash = stateHash(state);
  const consume = rawSqlite.transaction(() => {
    const row = rawSqlite
      .prepare(
        `SELECT code_verifier, return_to, expires_at
           FROM github_oauth_states
          WHERE state_hash = ? AND user_id = ?`,
      )
      .get(hash, userId) as GithubOauthStateRow | undefined;
    if (!row) return null;
    rawSqlite.prepare("DELETE FROM github_oauth_states WHERE state_hash = ?").run(hash);
    if (row.expires_at <= Date.now()) return null;
    return row;
  });
  const row = consume();
  if (!row) return null;
  return {
    codeVerifier: decryptSecret(row.code_verifier),
    returnTo: sanitizeGithubReturnTo(row.return_to),
  };
}

function tokenExpiry(now: number, seconds: number | undefined): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? now + seconds * 1_000
    : null;
}

async function exchangeToken(body: URLSearchParams): Promise<GithubTokenResponse> {
  const res = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Quillra-Self-Hosted",
    },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as GithubTokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`GitHub OAuth token exchange failed: ${detail}`);
  }
  return data;
}

async function githubUserJson<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "Quillra-Self-Hosted",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new GithubConnectionRequiredError(
        "Your GitHub authorization is no longer valid. Connect GitHub again.",
      );
    }
    throw new Error(`GitHub user API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function performGithubConnection(args: {
  userId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ githubLogin: string }> {
  // A refresh of the previous grant must not overwrite the newly exchanged
  // authorization after it completes.
  const refresh = tokenRefreshes.get(args.userId);
  if (refresh) await refresh.catch(() => undefined);

  const { clientId, clientSecret } = githubOauthCredentials();
  const token = await exchangeToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.codeVerifier,
    }),
  );
  const profile = await githubUserJson<{ id: number; login: string }>(token.access_token!, "/user");
  if (!Number.isSafeInteger(profile.id) || profile.id <= 0 || !profile.login) {
    throw new Error("GitHub returned an invalid user profile.");
  }

  const now = Date.now();
  rawSqlite
    .prepare(
      `INSERT INTO github_user_connections (
         user_id, github_user_id, github_login, access_token, refresh_token,
         access_token_expires_at, refresh_token_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         github_user_id = excluded.github_user_id,
         github_login = excluded.github_login,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         access_token_expires_at = excluded.access_token_expires_at,
         refresh_token_expires_at = excluded.refresh_token_expires_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      args.userId,
      String(profile.id),
      profile.login,
      encryptSecret(token.access_token!),
      token.refresh_token ? encryptSecret(token.refresh_token) : null,
      tokenExpiry(now, token.expires_in),
      tokenExpiry(now, token.refresh_token_expires_in),
      now,
      now,
    );
  return { githubLogin: profile.login };
}

export function completeGithubConnection(args: {
  userId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ githubLogin: string }> {
  if (githubAppResetting) {
    return Promise.reject(
      new GithubConnectionRequiredError("The GitHub App is being reset. Try again."),
    );
  }
  if (disconnectingUsers.has(args.userId)) {
    return Promise.reject(
      new GithubConnectionRequiredError("Your GitHub connection is being disconnected."),
    );
  }
  if (connectingUsers.has(args.userId)) {
    return Promise.reject(new Error("A GitHub connection is already in progress."));
  }

  connectingUsers.add(args.userId);
  // Register the connection before performGithubConnection can reach its
  // initial wait for an in-flight refresh. Disconnect and bulk reset use this
  // promise as their lifecycle barrier; starting the async function directly
  // would leave a small window where connectingUsers was set but connections
  // did not yet contain the reconnect they needed to await.
  const connection = Promise.resolve().then(() => performGithubConnection(args));
  connections.set(args.userId, connection);
  const cleanup = () => {
    connectingUsers.delete(args.userId);
    if (connections.get(args.userId) === connection) connections.delete(args.userId);
  };
  void connection.then(cleanup, cleanup);
  return connection;
}

function connectionForUser(userId: string): GithubConnectionRow | null {
  return (
    (rawSqlite
      .prepare(
        `SELECT user_id, github_user_id, github_login, access_token, refresh_token,
                access_token_expires_at, refresh_token_expires_at
           FROM github_user_connections
          WHERE user_id = ?`,
      )
      .get(userId) as GithubConnectionRow | undefined) ?? null
  );
}

export function getGithubConnectionStatus(userId: string): {
  connected: boolean;
  githubLogin?: string;
} {
  const row = connectionForUser(userId);
  return row ? { connected: true, githubLogin: row.github_login } : { connected: false };
}

async function refreshGithubUserToken(row: GithubConnectionRow): Promise<string> {
  if (
    !row.refresh_token ||
    (row.refresh_token_expires_at !== null && row.refresh_token_expires_at <= Date.now())
  ) {
    throw new GithubConnectionRequiredError(
      "Your GitHub connection expired. Connect GitHub again.",
    );
  }
  const { clientId, clientSecret } = githubOauthCredentials();
  const token = await exchangeToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: decryptSecret(row.refresh_token),
    }),
  );
  const now = Date.now();
  rawSqlite
    .prepare(
      `UPDATE github_user_connections
          SET access_token = ?,
              refresh_token = ?,
              access_token_expires_at = ?,
              refresh_token_expires_at = ?,
              updated_at = ?
        WHERE user_id = ?`,
    )
    .run(
      encryptSecret(token.access_token!),
      token.refresh_token ? encryptSecret(token.refresh_token) : row.refresh_token,
      tokenExpiry(now, token.expires_in),
      token.refresh_token
        ? tokenExpiry(now, token.refresh_token_expires_in)
        : row.refresh_token_expires_at,
      now,
      row.user_id,
    );
  return token.access_token!;
}

export async function getGithubUserAccessToken(userId: string): Promise<string> {
  if (githubAppResetting || disconnectingUsers.has(userId) || connectingUsers.has(userId)) {
    throw new GithubConnectionRequiredError("Your GitHub connection is changing. Try again.");
  }
  const row = connectionForUser(userId);
  if (!row) throw new GithubConnectionRequiredError();
  if (
    row.access_token_expires_at === null ||
    row.access_token_expires_at > Date.now() + TOKEN_REFRESH_SKEW_MS
  ) {
    return decryptSecret(row.access_token);
  }
  const existingRefresh = tokenRefreshes.get(userId);
  if (existingRefresh) return existingRefresh;
  const refresh = refreshGithubUserToken(row);
  tokenRefreshes.set(userId, refresh);
  try {
    return await refresh;
  } finally {
    if (tokenRefreshes.get(userId) === refresh) tokenRefreshes.delete(userId);
  }
}

async function performGithubDisconnect(userId: string): Promise<void> {
  disconnectingUsers.add(userId);
  try {
    // A connection exchange that started first is allowed to finish; its
    // newest grant is then the one revoked below. New exchanges are rejected
    // while disconnectingUsers contains this user.
    const connection = connections.get(userId);
    if (connection) await connection.catch(() => undefined);

    // A refresh rotates both the access and refresh token. Let an already
    // running refresh finish, then revoke the newest grant so no rotated token
    // survives the disconnect.
    const refresh = tokenRefreshes.get(userId);
    if (refresh) await refresh.catch(() => undefined);

    const row = connectionForUser(userId);
    if (row) {
      const { clientId, clientSecret } = githubOauthCredentials();
      // GitHub's grant-deletion endpoint requires a valid access token. Refresh
      // an expired or near-expiry token while disconnectingUsers blocks new
      // token readers/reconnects and after any previous refresh has settled.
      // A refresh failure leaves the encrypted local row intact for retry.
      const accessToken =
        row.access_token_expires_at !== null &&
        row.access_token_expires_at <= Date.now() + TOKEN_REFRESH_SKEW_MS
          ? await refreshGithubUserToken(row)
          : decryptSecret(row.access_token);
      const response = await fetch(
        `${GITHUB_API}/applications/${encodeURIComponent(clientId)}/grant`,
        {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "Quillra-Self-Hosted",
          },
          body: JSON.stringify({ access_token: accessToken }),
        },
      );
      // GitHub documents 204 as the only successful grant deletion. A 404 can
      // also mean the supplied token is invalid, so treating it as success
      // could discard the only refresh token while a remote grant survives.
      if (response.status !== 204) {
        throw new Error(`GitHub authorization revocation failed with HTTP ${response.status}`);
      }
    }

    // Keep the local connection when GitHub is unavailable so the user can
    // retry the revocation. Deleting locally first would strand a still-valid
    // remote grant and its refresh token.
    rawSqlite.transaction(() => {
      rawSqlite.prepare("DELETE FROM github_oauth_states WHERE user_id = ?").run(userId);
      rawSqlite.prepare("DELETE FROM github_user_connections WHERE user_id = ?").run(userId);
    })();
  } finally {
    disconnectingUsers.delete(userId);
  }
}

export function disconnectGithubUser(userId: string): Promise<void> {
  const existing = disconnects.get(userId);
  if (existing) return existing;
  const disconnect = performGithubDisconnect(userId);
  disconnects.set(userId, disconnect);
  const cleanup = () => {
    if (disconnects.get(userId) === disconnect) disconnects.delete(userId);
  };
  void disconnect.then(cleanup, cleanup);
  return disconnect;
}

async function performGithubAppReset(revokeRemote: boolean, finalize: () => void): Promise<void> {
  githubAppResetting = true;
  try {
    // Let exchanges that started before the reset settle. New exchanges and
    // token reads are blocked until credentials and local rows are consistent.
    await Promise.all(
      [...connections.values()].map((connection) => connection.catch(() => undefined)),
    );

    const userIds = (
      rawSqlite.prepare("SELECT user_id FROM github_user_connections").all() as Array<{
        user_id: string;
      }>
    ).map((row) => row.user_id);

    if (revokeRemote) {
      // Revoke every grant while the old client secret still exists. If
      // GitHub is unavailable, keep both the credentials and the remaining
      // local rows so the owner can retry instead of stranding live grants.
      for (const userId of userIds) {
        await disconnectGithubUser(userId);
      }
    } else {
      // The App itself is confirmed deleted remotely, so its grants are
      // already unusable and only stale local state needs invalidation.
      rawSqlite.transaction(() => {
        rawSqlite.prepare("DELETE FROM github_oauth_states").run();
        rawSqlite.prepare("DELETE FROM github_user_connections").run();
      })();
    }

    rawSqlite.prepare("DELETE FROM github_oauth_states").run();
    finalize();
  } finally {
    githubAppResetting = false;
  }
}

function resetGithubUserConnections(revokeRemote: boolean, finalize: () => void): Promise<void> {
  if (githubAppReset) return githubAppReset;
  const reset = performGithubAppReset(revokeRemote, finalize);
  githubAppReset = reset;
  const cleanup = () => {
    if (githubAppReset === reset) githubAppReset = null;
  };
  void reset.then(cleanup, cleanup);
  return reset;
}

/** Revoke every user grant, then atomically finalize the App reset locally. */
export function disconnectAllGithubUsers(finalize: () => void): Promise<void> {
  return resetGithubUserConnections(true, finalize);
}

/** Clear stale local grants after GitHub confirms that the App is gone. */
export function invalidateAllGithubUsers(finalize: () => void): Promise<void> {
  return resetGithubUserConnections(false, finalize);
}

function canWriteRepository(repo: GithubRepositoryResponse): boolean {
  return repo.permissions?.push === true || repo.permissions?.admin === true;
}

function validGithubId(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

async function listRepositoriesForInstallation(
  token: string,
  installationId: string,
): Promise<GithubRepositoryResponse[]> {
  if (!validGithubId(installationId)) throw new GithubRepositoryAccessError();
  const repositories: GithubRepositoryResponse[] = [];
  for (let page = 1; page <= 50; page++) {
    const data = await githubUserJson<{
      repositories: GithubRepositoryResponse[];
    }>(token, `/user/installations/${installationId}/repositories?per_page=100&page=${page}`);
    repositories.push(...data.repositories);
    if (data.repositories.length < 100) break;
  }
  return repositories;
}

export async function listGithubRepositoriesForUser(
  userId: string,
): Promise<GithubUserRepository[]> {
  const token = await getGithubUserAccessToken(userId);
  const installations: Array<{
    id: number;
    permissions?: { contents?: "read" | "write" };
  }> = [];
  for (let page = 1; page <= 50; page++) {
    const data = await githubUserJson<{
      installations: Array<{
        id: number;
        permissions?: { contents?: "read" | "write" };
      }>;
    }>(token, `/user/installations?per_page=100&page=${page}`);
    installations.push(...data.installations);
    if (data.installations.length < 100) break;
  }

  const byRepositoryId = new Map<string, GithubUserRepository>();
  for (const installation of installations) {
    if (!Number.isSafeInteger(installation.id) || installation.id <= 0) continue;
    if (installation.permissions?.contents !== "write") continue;
    const installationId = String(installation.id);
    let repos: GithubRepositoryResponse[];
    try {
      repos = await listRepositoriesForInstallation(token, installationId);
    } catch (error) {
      if (error instanceof GithubConnectionRequiredError) throw error;
      console.warn(`[github-user] skipping inaccessible GitHub App installation ${installationId}`);
      continue;
    }
    for (const repo of repos) {
      if (!Number.isSafeInteger(repo.id) || repo.id <= 0 || !canWriteRepository(repo)) continue;
      byRepositoryId.set(String(repo.id), {
        repositoryId: String(repo.id),
        installationId,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch || "main",
      });
    }
  }
  return [...byRepositoryId.values()].sort((a, b) =>
    a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }),
  );
}

export async function getGithubRepositoryForUser(
  userId: string,
  installationId: string,
  repositoryId: string,
): Promise<GithubUserRepository> {
  if (!validGithubId(installationId) || !validGithubId(repositoryId)) {
    throw new GithubRepositoryAccessError();
  }
  const token = await getGithubUserAccessToken(userId);
  try {
    const installation = await githubUserJson<{
      id: number;
      permissions?: { contents?: "read" | "write" };
    }>(token, `/user/installations/${installationId}`);
    if (
      String(installation.id) !== installationId ||
      installation.permissions?.contents !== "write"
    ) {
      throw new GithubRepositoryAccessError();
    }
  } catch (error) {
    if (error instanceof GithubConnectionRequiredError) throw error;
    throw new GithubRepositoryAccessError();
  }
  let repos: GithubRepositoryResponse[];
  try {
    repos = await listRepositoriesForInstallation(token, installationId);
  } catch (error) {
    if (error instanceof GithubConnectionRequiredError) throw error;
    throw new GithubRepositoryAccessError();
  }
  const repo = repos.find((candidate) => String(candidate.id) === repositoryId);
  if (!repo || !canWriteRepository(repo)) throw new GithubRepositoryAccessError();
  return {
    repositoryId,
    installationId,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch || "main",
  };
}

export async function getGithubRepositoryForUserByFullName(
  userId: string,
  fullName: string,
): Promise<GithubUserRepository> {
  const normalized = fullName.toLowerCase();
  const repo = (await listGithubRepositoriesForUser(userId)).find(
    (candidate) => candidate.fullName.toLowerCase() === normalized,
  );
  if (!repo) throw new GithubRepositoryAccessError();
  return repo;
}

export async function githubJsonForUserRepository<T>(
  userId: string,
  repository: GithubUserRepository,
  path: string,
): Promise<T> {
  // Re-verify immediately before every discovery/inspection request. The user
  // token itself is also an intersection of user and App access, so revoked
  // repository access fails closed at GitHub even across this small TOCTOU gap.
  const verified = await getGithubRepositoryForUser(
    userId,
    repository.installationId,
    repository.repositoryId,
  );
  if (verified.fullName !== repository.fullName) {
    throw new GithubRepositoryAccessError();
  }
  return githubUserJson<T>(await getGithubUserAccessToken(userId), path);
}
