import { type Context, Hono } from "hono";
import type { SessionUser } from "../lib/auth.js";
import { detectFromManifest, publicFrameworkList } from "../services/framework-registry.js";
import { getGithubAppCredentials } from "../services/github-app.js";
import {
  fetchRepoManifest,
  getRepoMeta,
  listAccessibleRepos,
  listBranches,
  resolveAccessibleRepo,
} from "../services/github-rest.js";
import {
  GithubConnectionRequiredError,
  completeGithubConnection,
  consumeGithubOauthState,
  disconnectGithubUser,
  getGithubConnectionStatus,
  issueGithubOauthState,
} from "../services/github-user-connection.js";
import { getInstanceSetting } from "../services/instance-settings.js";

type Variables = {
  user: SessionUser | null;
  clientSession: { projectId: string } | null;
};

async function requireUser(c: Context<{ Variables: Variables }>) {
  const user = c.get("user");
  if (!user) return { error: c.json({ error: "Unauthorized" }, 401) };
  if (c.get("clientSession")) return { error: c.json({ error: "Forbidden" }, 403) };
  return { user };
}

function originFromRequest(c: {
  req: { url: string; header: (key: string) => string | undefined };
}): string {
  const configured = process.env.BETTER_AUTH_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? url.host;
  return `${proto}://${host}`;
}

function connectionRequired(c: Context<{ Variables: Variables }>, error: unknown) {
  if (!(error instanceof GithubConnectionRequiredError)) return null;
  return c.json(
    {
      error: error.message,
      code: error.code,
      connectUrl: "/api/github/connect/start?returnTo=/",
    },
    409,
  );
}

function oauthCallbackConfiguration(c: Context<{ Variables: Variables }>) {
  const callbackUrl = `${originFromRequest(c)}/api/github/connect/callback`;
  const configuredCallback =
    process.env.GITHUB_APP_OAUTH_CALLBACK_URL?.trim() ||
    getInstanceSetting("GITHUB_APP_OAUTH_CALLBACK_URL");
  return {
    callbackUrl,
    configured: configuredCallback === callbackUrl,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function callbackMigrationResponse(
  c: Context<{ Variables: Variables }>,
  callbackUrl: string,
  appSlug: string | null,
) {
  const settingsUrl = appSlug
    ? `https://github.com/settings/apps/${encodeURIComponent(appSlug)}`
    : "https://github.com/settings/apps";
  return c.html(
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Update the Quillra GitHub App</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:64px auto;padding:0 24px;line-height:1.5">
  <h1>One GitHub App update is required</h1>
  <p>This Quillra instance predates per-user repository authorization. An instance owner must add this exact callback URL to the GitHub App:</p>
  <pre style="white-space:pre-wrap;padding:16px;background:#f4f4f5;border-radius:8px">${escapeHtml(callbackUrl)}</pre>
  <p>Open <a href="${escapeHtml(settingsUrl)}">GitHub App settings</a>, add the URL under <strong>Callback URLs</strong>, save it, then set <code>GITHUB_APP_OAUTH_CALLBACK_URL</code> to the same value and restart Quillra.</p>
  <p>No repository authorization was started.</p>
</body>
</html>`,
    409,
  );
}

export const githubRouter = new Hono<{ Variables: Variables }>()
  .get("/connection", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const status = getGithubConnectionStatus(r.user.id);
    const slug = getGithubAppCredentials()?.slug;
    const callback = oauthCallbackConfiguration(c);
    return c.json({
      ...status,
      oauthCallbackConfigured: callback.configured,
      oauthCallbackUrl: callback.callbackUrl,
      installUrl: slug
        ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
        : null,
    });
  })
  .get("/connect/start", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const creds = getGithubAppCredentials();
    if (!creds?.clientId || !creds.clientSecret) {
      return c.json({ error: "Quillra GitHub App OAuth is not configured." }, 503);
    }
    const callback = oauthCallbackConfiguration(c);
    if (!callback.configured) {
      return callbackMigrationResponse(c, callback.callbackUrl, creds.slug);
    }
    const redirectUri = callback.callbackUrl;
    const flow = issueGithubOauthState(r.user.id, c.req.query("returnTo"));
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", creds.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", flow.state);
    authorize.searchParams.set("code_challenge", flow.codeChallenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    return c.redirect(authorize.toString());
  })
  .get("/connect/callback", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const state = c.req.query("state") ?? "";
    const flow = consumeGithubOauthState(r.user.id, state);
    if (!flow) return c.json({ error: "Invalid or expired GitHub OAuth state." }, 400);
    const oauthError = c.req.query("error");
    if (oauthError) {
      return c.json(
        {
          error: `GitHub authorization failed: ${c.req.query("error_description") ?? oauthError}`,
        },
        400,
      );
    }
    const code = c.req.query("code");
    if (!code) return c.json({ error: "GitHub did not return an authorization code." }, 400);
    const origin = originFromRequest(c);
    await completeGithubConnection({
      userId: r.user.id,
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: `${origin}/api/github/connect/callback`,
    });
    const webOrigin = process.env.WEB_ORIGIN?.replace(/\/+$/, "") || origin;
    const destination = new URL(flow.returnTo, webOrigin);
    destination.searchParams.set("githubConnected", "1");
    return c.redirect(destination.toString());
  })
  .delete("/connection", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    await disconnectGithubUser(r.user.id);
    return c.newResponse(null, 204);
  })
  .get("/repos", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    try {
      const repos = await listAccessibleRepos(r.user.id);
      return c.json({ repos });
    } catch (e) {
      const missing = connectionRequired(c, e);
      if (missing) return missing;
      const msg = e instanceof Error ? e.message : "Failed to list repositories";
      return c.json({ error: msg }, msg.includes("GitHub App") ? 503 : 400);
    }
  })
  .get("/repos/:owner/:repo/branches", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    try {
      const repository = await resolveAccessibleRepo(r.user.id, owner, repo);
      const branches = await listBranches(r.user.id, repository);
      let defaultBranch: string | undefined;
      try {
        const meta = await getRepoMeta(r.user.id, repository);
        defaultBranch = meta.defaultBranch;
      } catch {
        defaultBranch = branches.includes("main") ? "main" : branches[0];
      }
      return c.json({ branches, defaultBranch });
    } catch (e) {
      const missing = connectionRequired(c, e);
      if (missing) return missing;
      return c.json({ error: e instanceof Error ? e.message : "Failed to list branches" }, 400);
    }
  })
  /**
   * Identify the framework of a GitHub repo at a given branch BEFORE the user
   * commits to creating a project. We fetch package.json + the root file list
   * via the GitHub API (no clone), then run it through the central registry.
   */
  .get("/repos/:owner/:repo/framework", async (c) => {
    const r = await requireUser(c);
    if ("error" in r) return r.error;
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const ref = c.req.query("ref") ?? "";
    if (!ref) return c.json({ error: "ref query param required" }, 400);
    try {
      const repository = await resolveAccessibleRepo(r.user.id, owner, repo);
      const manifest = await fetchRepoManifest(r.user.id, repository, ref);
      const def = detectFromManifest(manifest);
      if (!def) {
        return c.json({
          supported: false,
          reason: "We couldn't recognise the framework in this repository.",
          rootFilesSample: manifest.rootFiles.slice(0, 20),
        });
      }
      return c.json({
        supported: true,
        framework: {
          id: def.id,
          label: def.label,
          iconSlug: def.iconSlug,
          color: def.color,
          blurb: def.blurb,
          optimizes: def.optimizes,
        },
      });
    } catch (e) {
      const missing = connectionRequired(c, e);
      if (missing) return missing;
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to inspect repository" },
        400,
      );
    }
  })
  /** Public list of every framework Quillra supports, used by the connect modal and the badge */
  .get("/frameworks", async (c) => {
    return c.json({ frameworks: publicFrameworkList() });
  });
