/**
 * GitHub App integration — replaces the legacy personal-access-token
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
 * with the JWT → get back a string token that can be used as the
 * password in `https://x-access-token:{token}@github.com/…` clone URLs.
 * Exactly the same URL shape as a PAT, so the rest of workspace.ts
 * doesn't need to change its calling pattern.
 *
 * Why hand-roll the JWT instead of pulling in `@octokit/app`?
 *   - Adds zero dependencies to a package that already has a lot
 *   - RS256 via `node:crypto` is 15 lines of code, not worth a dep
 *   - Easier to audit the exact fields we send to GitHub
 */

import { createSign } from "node:crypto";
import { getInstanceSetting, setInstanceSetting } from "./instance-settings.js";

export type GithubAppCreds = {
  appId: string;
  privateKey: string;
  slug: string | null;
  name: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
};

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
  setInstanceSetting("GITHUB_APP_ID", null);
  setInstanceSetting("GITHUB_APP_SLUG", null);
  setInstanceSetting("GITHUB_APP_NAME", null);
  setInstanceSetting("GITHUB_APP_CLIENT_ID", null);
  setInstanceSetting("GITHUB_APP_CLIENT_SECRET", null);
  setInstanceSetting("GITHUB_APP_PRIVATE_KEY", null);
  setInstanceSetting("GITHUB_APP_WEBHOOK_SECRET", null);
  installationTokenCache.clear();
}

type InstallationTokenResponse = {
  token: string;
  expires_at: string;
};

/** Installation token cache — tokens are valid for 1 hour, we keep each
 *  one for 50 minutes and refresh early. Per-process, not shared across
 *  workers, intentionally — shared caches are a multi-tenant concern. */
const installationTokenCache = new Map<
  string,
  { token: string; expiresAt: number }
>();

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
 * the container and GitHub's servers — without this, JWTs are rejected
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

/**
 * Get an installation access token for a specific installation id.
 * Cached for 50 minutes to avoid hitting GitHub on every push.
 */
export async function getInstallationToken(installationId: string): Promise<string> {
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const data = await ghApp<InstallationTokenResponse>(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
  );
  const expiresAtMs = new Date(data.expires_at).getTime();
  // Refresh 10 minutes before expiry so in-flight requests don't race.
  const keepUntil = expiresAtMs - 10 * 60 * 1000;
  installationTokenCache.set(installationId, { token: data.token, expiresAt: keepUntil });
  return data.token;
}

/**
 * Find the installation id for a specific `owner/repo`. Returns null
 * when the App isn't installed on that repo (the caller should show
 * the user a helpful "install the App on this repo" message).
 */
export async function findInstallationForRepo(
  owner: string,
  repo: string,
): Promise<string | null> {
  if (!isGithubAppConfigured()) return null;
  try {
    const data = await ghApp<{ id: number }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    );
    return String(data.id);
  } catch {
    return null;
  }
}

/** Mint a token for a given `owner/repo`. */
export async function getInstallationTokenForRepo(
  owner: string,
  repo: string,
): Promise<string | null> {
  const id = await findInstallationForRepo(owner, repo);
  if (!id) return null;
  return getInstallationToken(id);
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
    const installations = await ghApp<Installation[]>(`/app/installations`);
    return { installations };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // ghApp throws `GitHub App API 404: ...` on 404 responses. Match on
    // both the HTTP status and the "Integration not found" body, because
    // some other 404 could mean a different problem (e.g. revoked auth).
    if (
      msg.includes("GitHub App API 404") &&
      msg.toLowerCase().includes("integration not found")
    ) {
      console.warn(
        "[github-app] remote App is gone (404 Integration not found) — clearing stored credentials",
      );
      clearGithubAppCredentials();
      return { installations: [], cleared: "app-deleted" };
    }
    throw e;
  }
}

/**
 * List every repository the App is installed on, across all installations.
 * Replaces `listAccessibleRepos()` from github-rest.ts when the App is
 * configured — the PAT version only knows about repos the owner's
 * personal token can see, while the App version only knows about repos
 * the App is installed on. Both are "what can I actually push to".
 */
export async function listRepositoriesAcrossInstallations(): Promise<
  Array<{ fullName: string; defaultBranch: string; installationId: number }>
> {
  const { installations } = await listInstallations();
  const out: Array<{ fullName: string; defaultBranch: string; installationId: number }> = [];
  for (const inst of installations) {
    try {
      const token = await getInstallationToken(String(inst.id));
      // Paginate installation repositories
      let page = 1;
      for (;;) {
        const res = await fetch(
          `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
          {
            headers: {
              Authorization: `token ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "Quillra-Self-Hosted",
            },
          },
        );
        if (!res.ok) break;
        const data = (await res.json()) as {
          repositories: { full_name: string; default_branch: string }[];
        };
        for (const r of data.repositories) {
          out.push({
            fullName: r.full_name,
            defaultBranch: r.default_branch,
            installationId: inst.id,
          });
        }
        if (data.repositories.length < 100) break;
        page++;
        if (page > 50) break;
      }
    } catch {
      /* skip failing installations — their repos just won't show up */
    }
  }
  // Dedupe by full_name (same repo can show up twice if multiple
  // installations have access to it) and sort.
  const seen = new Set<string>();
  const deduped = out.filter((r) => {
    if (seen.has(r.fullName)) return false;
    seen.add(r.fullName);
    return true;
  });
  deduped.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return deduped;
}

/**
 * Exchange a GitHub App Manifest conversion code for the real App
 * credentials and persist them in instance_settings. Called from the
 * `/api/setup/github-app/callback` route immediately after the owner
 * clicks "Create GitHub App" on github.com during the setup wizard.
 *
 * See: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest#implementing-the-github-app-manifest-flow
 */
export async function exchangeManifestCode(code: string): Promise<{
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

  // Persist every field — the secret ones go through the encryption layer
  // automatically via SECRET_KEYS in instance-settings.ts.
  setInstanceSetting("GITHUB_APP_ID", String(data.id));
  setInstanceSetting("GITHUB_APP_SLUG", data.slug);
  setInstanceSetting("GITHUB_APP_NAME", data.name);
  setInstanceSetting("GITHUB_APP_CLIENT_ID", data.client_id);
  setInstanceSetting("GITHUB_APP_CLIENT_SECRET", data.client_secret);
  setInstanceSetting("GITHUB_APP_PRIVATE_KEY", data.pem);
  if (data.webhook_secret) {
    setInstanceSetting("GITHUB_APP_WEBHOOK_SECRET", data.webhook_secret);
  }

  return data;
}
