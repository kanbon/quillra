/**
 * GitHub App integration, replaces the legacy personal-access-token
 * flow for all server-side git operations (clone, push, and REST API
 * calls).
 *
 * A GitHub App has:
 *   - an App ID and private key (used to sign a short-lived JWT)
 *   - zero or more installations (the App is "installed" on specific
 *     repos / orgs by the owner)
 *   - an installation access token per installation, valid for 1 hour
 *     and scoped to the permissions granted at install time
 *
 * Push flow: mint a JWT → call
 *   POST /app/installations/{id}/access_tokens
 * with the JWT → get back a string token injected as a transient HTTP
 * authorization header. Repository origin URLs remain credential-free.
 *
 * Why hand-roll the JWT instead of pulling in `@octokit/app`?
 *   - Adds zero dependencies to a package that already has a lot
 *   - RS256 via `node:crypto` is 15 lines of code, not worth a dep
 *   - Easier to audit the exact fields we send to GitHub
 */

import { createSign } from "node:crypto";
import { getInstanceSetting, setInstanceSettingsAtomically } from "./instance-settings.js";

export type GithubAppCreds = {
  appId: string;
  privateKey: string;
  slug: string | null;
  name: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
};

type CachedInstallationToken = {
  token: string;
  /** Early refresh boundary, ten minutes before GitHub's real expiry. */
  expiresAt: number;
};

type IssuedInstallationToken = {
  /** GitHub's real expiry, not the cache's early refresh boundary. */
  expiresAt: number;
};

/** Installation tokens are cached for 50 minutes but remain remotely valid
 * for an hour. Keep a separate issued-token registry through the real expiry
 * so an early refresh never makes the superseded token invisible to reset. */
const installationTokenCache = new Map<string, CachedInstallationToken>();
const issuedInstallationTokens = new Map<string, IssuedInstallationToken>();
const installationTokenMints = new Map<string, Promise<string>>();
const installationTokenOperations = new Set<Promise<string>>();

type InstallationTokenResetPhase = "open" | "draining" | "finalizing";
let installationTokenResetPhase: InstallationTokenResetPhase = "open";
let installationTokenReset: Promise<void> | null = null;
let githubAppCredentialGeneration = 0;

function invalidateLocalGithubAppTokenState(): void {
  githubAppCredentialGeneration += 1;
  installationTokenCache.clear();
  issuedInstallationTokens.clear();
  installationTokenMints.clear();
  botIdentityPromise = null;
}

function pruneExpiredIssuedInstallationTokens(now = Date.now()): void {
  for (const [token, issued] of issuedInstallationTokens) {
    if (issued.expiresAt <= now) issuedInstallationTokens.delete(token);
  }
}

/**
 * Delete every GITHUB_APP_* row from instance_settings. Called both by
 * the /api/admin/github-app DELETE endpoint (explicit reset) and
 * automatically when we detect that the App was deleted on github.com
 * and the stored credentials are orphaned (the App API returns 404
 * "Integration not found" when authenticating with a JWT for a
 * deleted App).
 *
 * Also wipes the installation-token cache because any cached tokens
 * are now as dead as the App itself.
 */
export function clearGithubAppCredentials(): void {
  pruneExpiredIssuedInstallationTokens();
  if (
    installationTokenResetPhase !== "finalizing" &&
    (installationTokenOperations.size > 0 || issuedInstallationTokens.size > 0)
  ) {
    throw new Error(
      "GitHub App credentials cannot be cleared before installation tokens are revoked.",
    );
  }
  setInstanceSettingsAtomically([
    { key: "GITHUB_APP_ID", value: null },
    { key: "GITHUB_APP_SLUG", value: null },
    { key: "GITHUB_APP_NAME", value: null },
    { key: "GITHUB_APP_CLIENT_ID", value: null },
    { key: "GITHUB_APP_CLIENT_SECRET", value: null },
    { key: "GITHUB_APP_PRIVATE_KEY", value: null },
    { key: "GITHUB_APP_WEBHOOK_SECRET", value: null },
    { key: "GITHUB_APP_OAUTH_CALLBACK_URL", value: null },
  ]);
  invalidateLocalGithubAppTokenState();
}

type InstallationTokenResponse = {
  token: string;
  expires_at: string;
};

export function isGithubAppConfigured(): boolean {
  const appId = getInstanceSetting("GITHUB_APP_ID");
  const pem = getInstanceSetting("GITHUB_APP_PRIVATE_KEY");
  return Boolean(appId && pem);
}

export function getGithubAppCredentials(): GithubAppCreds | null {
  const appId = getInstanceSetting("GITHUB_APP_ID");
  const privateKey = getInstanceSetting("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) return null;
  return {
    appId,
    privateKey,
    slug: getInstanceSetting("GITHUB_APP_SLUG") ?? null,
    name: getInstanceSetting("GITHUB_APP_NAME") ?? null,
    clientId: getInstanceSetting("GITHUB_APP_CLIENT_ID") ?? null,
    clientSecret: getInstanceSetting("GITHUB_APP_CLIENT_SECRET") ?? null,
    webhookSecret: getInstanceSetting("GITHUB_APP_WEBHOOK_SECRET") ?? null,
  };
}

/**
 * Mint a short-lived RS256-signed JWT that identifies Quillra as the
 * GitHub App. Max lifetime per GitHub's docs is 10 minutes; we use 9.
 * The `iat` is backdated by 60 seconds to absorb clock skew between
 * the container and GitHub's servers, without this, JWTs are rejected
 * as "too far in the future" on hosts with loose NTP.
 */
export function mintAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

async function ghApp<T>(path: string, init: RequestInit = {}): Promise<T> {
  const creds = getGithubAppCredentials();
  if (!creds) throw new Error("GitHub App is not configured");
  const jwt = mintAppJwt(creds.appId, creds.privateKey);
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Quillra-Self-Hosted",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub App API ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json() as Promise<T>;
}

let botIdentityPromise: Promise<{ name: string; email: string } | null> | null = null;

/**
 * Resolve GitHub's real bot user id so commit attribution uses its noreply
 * address. The public user endpoint does not accept an App JWT reliably; when
 * publishing, pass the already repository-scoped installation token.
 */
export function getGithubAppBotIdentity(
  installationToken?: string,
): Promise<{ name: string; email: string } | null> {
  if (botIdentityPromise) return botIdentityPromise;
  const lookup = (async () => {
    const creds = getGithubAppCredentials();
    if (!creds?.slug) return null;
    const name = `${creds.slug}[bot]`;
    try {
      const response = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}`, {
        headers: {
          Accept: "application/vnd.github+json",
          ...(installationToken ? { Authorization: `Bearer ${installationToken}` } : {}),
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Quillra-Self-Hosted",
        },
      });
      if (!response.ok) return null;
      const account = (await response.json()) as { id: number; login: string };
      if (!Number.isInteger(account.id) || account.id <= 0) return null;
      return {
        name: account.login || name,
        email: `${account.id}+${name}@users.noreply.github.com`,
      };
    } catch {
      return null;
    }
  })();
  botIdentityPromise = lookup;
  void lookup.then((identity) => {
    // A transient GitHub failure must not permanently switch all later
    // commits to the fallback committer until the process restarts.
    if (!identity && botIdentityPromise === lookup) botIdentityPromise = null;
  });
  return lookup;
}

export async function requireGithubAppBotIdentity(
  installationToken: string,
): Promise<{ name: string; email: string }> {
  const identity = await getGithubAppBotIdentity(installationToken);
  if (!identity) {
    throw new Error(
      "GitHub could not verify the Quillra App bot identity. Please retry publishing.",
    );
  }
  return identity;
}

export type GithubContentsPermission = "read" | "write";

function trackInstallationTokenOperation(operation: Promise<string>): Promise<string> {
  installationTokenOperations.add(operation);
  const cleanup = () => {
    installationTokenOperations.delete(operation);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

function assertGithubNumericId(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid GitHub ${label}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid GitHub ${label}`);
  return number;
}

/**
 * Mint an installation token for one immutable repository id and the minimum
 * contents permission needed by the operation. Omitting `repository_ids`
 * would silently grant the token every repository in the installation.
 */
async function mintInstallationToken(
  installationId: string,
  repositoryId: string,
  contents: GithubContentsPermission,
  cacheKey: string,
  credentialGeneration: number,
): Promise<string> {
  const numericRepositoryId = assertGithubNumericId(repositoryId, "repository id");
  const data = await ghApp<InstallationTokenResponse>(
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repository_ids: [numericRepositoryId],
        permissions: { contents },
      }),
    },
  );
  if (!data.token || typeof data.token !== "string") {
    throw new Error("GitHub returned an invalid installation token");
  }
  const expiresAtMs = new Date(data.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("GitHub returned an invalid installation token expiry");
  }
  // Register before returning or caching. Even if a credential-generation
  // check fails, a token GitHub successfully minted must remain revocable.
  const previousIssue = issuedInstallationTokens.get(data.token);
  issuedInstallationTokens.set(data.token, {
    expiresAt: Math.max(previousIssue?.expiresAt ?? 0, expiresAtMs),
  });
  // Refresh 10 minutes before expiry so in-flight requests don't race.
  const keepUntil = expiresAtMs - 10 * 60 * 1000;
  if (credentialGeneration !== githubAppCredentialGeneration) {
    throw new Error("The GitHub App changed while repository access was being prepared.");
  }
  installationTokenCache.set(cacheKey, { token: data.token, expiresAt: keepUntil });
  return data.token;
}

async function performGetInstallationToken(
  installationId: string,
  repositoryId: string,
  contents: GithubContentsPermission,
): Promise<string> {
  assertGithubNumericId(installationId, "installation id");
  assertGithubNumericId(repositoryId, "repository id");
  const credentialGeneration = githubAppCredentialGeneration;
  const cacheKey = `${credentialGeneration}:${installationId}:${repositoryId}:${contents}`;
  const cached = installationTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const existingMint = installationTokenMints.get(cacheKey);
  if (existingMint) return existingMint;

  const mint = mintInstallationToken(
    installationId,
    repositoryId,
    contents,
    cacheKey,
    credentialGeneration,
  );
  installationTokenMints.set(cacheKey, mint);
  const cleanup = () => {
    if (installationTokenMints.get(cacheKey) === mint) installationTokenMints.delete(cacheKey);
  };
  void mint.then(cleanup, cleanup);
  return mint;
}

/**
 * Resolve one repository-scoped installation token. Reset closes the gate
 * synchronously before doing any asynchronous work, so calls beginning after
 * reset cannot read a cached token or start a new mint.
 */
export function getInstallationToken(
  installationId: string,
  repositoryId: string,
  contents: GithubContentsPermission,
): Promise<string> {
  if (installationTokenResetPhase !== "open") {
    return Promise.reject(new Error("The GitHub App is being reset. Try again."));
  }
  return trackInstallationTokenOperation(
    performGetInstallationToken(installationId, repositoryId, contents),
  );
}

async function revokeInstallationToken(token: string): Promise<void> {
  const response = await fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Quillra-Self-Hosted",
    },
  });
  // 401 means the token is already expired or revoked, which is the desired
  // postcondition. Every other non-204 response is ambiguous and must remain
  // retryable locally.
  if (response.status !== 204 && response.status !== 401) {
    throw new Error(`GitHub installation-token revocation failed with HTTP ${response.status}`);
  }
}

function forgetRevokedInstallationToken(token: string): void {
  issuedInstallationTokens.delete(token);
  for (const [cacheKey, cached] of installationTokenCache) {
    if (cached.token === token) installationTokenCache.delete(cacheKey);
  }
}

async function performInstallationTokenReset(finalize: () => void | Promise<void>): Promise<void> {
  // The closed gate means the set can only shrink. allSettled deliberately
  // drains failed mints too; a failed mint produced no token to revoke.
  while (installationTokenOperations.size > 0) {
    await Promise.allSettled([...installationTokenOperations]);
  }

  pruneExpiredIssuedInstallationTokens();
  const tokens = [...issuedInstallationTokens.keys()];
  const revocations = await Promise.allSettled(
    tokens.map(async (token) => {
      await revokeInstallationToken(token);
      forgetRevokedInstallationToken(token);
    }),
  );
  const failure = revocations.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason instanceof Error
      ? failure.reason
      : new Error("GitHub installation-token revocation failed");
  }

  installationTokenResetPhase = "finalizing";
  const generationBeforeFinalize = githubAppCredentialGeneration;
  await finalize();
  // A credential finalizer normally calls clearGithubAppCredentials(), which
  // already invalidates local token state. Keep the lifecycle useful for a
  // token-only reset too, without incrementing twice.
  if (githubAppCredentialGeneration === generationBeforeFinalize) {
    invalidateLocalGithubAppTokenState();
  }
}

/**
 * Close installation-token access immediately, drain existing gets/mints,
 * revoke every still-live token issued by this process, then run the supplied
 * local/user-credential finalizer. Failed revocations keep their cache and
 * issued-token records so the owner can retry safely.
 *
 * The App-reset route should wrap its existing user-grant reset with this:
 *   resetGithubAppInstallationTokens(() =>
 *     disconnectAllGithubUsers(clearGithubAppCredentials)
 *   )
 */
export function resetGithubAppInstallationTokens(
  finalize: () => void | Promise<void>,
): Promise<void> {
  if (installationTokenReset) return installationTokenReset;
  installationTokenResetPhase = "draining";
  const reset = performInstallationTokenReset(finalize);
  installationTokenReset = reset;
  const cleanup = () => {
    if (installationTokenReset !== reset) return;
    installationTokenReset = null;
    installationTokenResetPhase = "open";
  };
  void reset.then(cleanup, cleanup);
  return reset;
}

type Installation = {
  id: number;
  account: { login: string; type: string; avatar_url?: string | null };
  repository_selection: "all" | "selected";
};

export type InstallationsResult = {
  installations: Installation[];
  /** Set when we auto-wiped the stored credentials because the App
   *  no longer exists remotely. The caller should refetch setup
   *  status so the UI transitions to the "Create App" state. */
  cleared?: "app-deleted";
};

/**
 * List every installation of the App, used by the Integrations tab.
 *
 * If github.com says "Integration not found" (HTTP 404) the App has
 * been deleted remotely and our stored credentials are orphaned. We
 * auto-wipe them so the UI transitions to the fresh "Create App"
 * state instead of showing a stuck error banner forever.
 */
export async function listInstallations(): Promise<InstallationsResult> {
  if (!isGithubAppConfigured()) return { installations: [] };
  try {
    const installations = await ghApp<Installation[]>("/app/installations");
    return { installations };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // ghApp throws `GitHub App API 404: ...` on 404 responses. Match on
    // both the HTTP status and the "Integration not found" body, because
    // some other 404 could mean a different problem (e.g. revoked auth).
    if (msg.includes("GitHub App API 404") && msg.toLowerCase().includes("integration not found")) {
      console.warn(
        "[github-app] remote App is gone (404 Integration not found), clearing stored credentials",
      );
      const { invalidateAllGithubUsers } = await import("./github-user-connection.js");
      await resetGithubAppInstallationTokens(() =>
        invalidateAllGithubUsers(clearGithubAppCredentials),
      );
      return { installations: [], cleared: "app-deleted" };
    }
    throw e;
  }
}

/**
 * Exchange a GitHub App Manifest conversion code for the real App
 * credentials and persist them in instance_settings. Called from the
 * `/api/setup/github-app/callback` route immediately after the owner
 * clicks "Create GitHub App" on github.com during the setup wizard.
 *
 * See: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest#implementing-the-github-app-manifest-flow
 */
export async function exchangeManifestCode(
  code: string,
  oauthCallbackUrl: string,
): Promise<{
  id: number;
  slug: string;
  name: string;
  client_id: string;
  client_secret: string;
  pem: string;
  webhook_secret: string | null;
  html_url: string;
}> {
  const res = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Quillra-Self-Hosted",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub manifest conversion failed: ${res.status} ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    id: number;
    slug: string;
    name: string;
    client_id: string;
    client_secret: string;
    pem: string;
    webhook_secret: string | null;
    html_url: string;
  };

  // Persist every field, the secret ones go through the encryption layer
  // automatically via SECRET_KEYS in instance-settings.ts.
  setInstanceSettingsAtomically([
    { key: "GITHUB_APP_ID", value: String(data.id) },
    { key: "GITHUB_APP_SLUG", value: data.slug },
    { key: "GITHUB_APP_NAME", value: data.name },
    { key: "GITHUB_APP_CLIENT_ID", value: data.client_id },
    { key: "GITHUB_APP_CLIENT_SECRET", value: data.client_secret },
    { key: "GITHUB_APP_PRIVATE_KEY", value: data.pem },
    { key: "GITHUB_APP_WEBHOOK_SECRET", value: data.webhook_secret },
    { key: "GITHUB_APP_OAUTH_CALLBACK_URL", value: oauthCallbackUrl },
  ]);

  return data;
}
