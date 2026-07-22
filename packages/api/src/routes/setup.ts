/**
 * First-run setup wizard API.
 *
 * GET  /api/setup/status, returns configuration status
 * POST /api/setup/save, writes setting values to the DB
 * GET  /api/setup/github-app/start, emits an auto-submitting form
 *                                              that hands the user off to the
 *                                              GitHub App Manifest flow
 * GET  /api/setup/github-app/callback, receives the manifest code back
 *                                              from GitHub, exchanges it for
 *                                              the App credentials, persists
 *                                              them, then redirects the user
 *                                              to the install-on-repos step
 *
 * First-run writes require proof of server access. Once an owner exists,
 * setup reads and writes require that authenticated owner instead.
 */

import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { user } from "../db/auth-schema.js";
import { db } from "../db/index.js";
import type { SessionUser } from "../lib/auth.js";
import { shouldUseSecureCookies } from "../lib/cookies.js";
import {
  fixedWindowRateLimiter,
  getRequestIp,
  rateLimitFingerprint,
} from "../lib/fixed-window-rate-limit.js";
import {
  GITHUB_MANIFEST_FLOW_COOKIE,
  GITHUB_MANIFEST_FLOW_COOKIE_PATH,
  githubAppManifestName,
  githubManifestFlowStore,
} from "../lib/github-manifest-flow.js";
import {
  SERVER_ACCESS_COOKIE,
  issueServerAccessSession,
  logServerAccessInstructions,
  verifyServerAccessSession,
  verifyServerAccessToken,
} from "../lib/server-access.js";
import { exchangeManifestCode } from "../services/github-app.js";
import {
  SETTABLE_KEYS,
  type SettableKey,
  getSetupStatus,
  setInstanceSetting,
} from "../services/instance-settings.js";
import { resetMailer } from "../services/mailer.js";

type Variables = { user: SessionUser | null };

const saveSchema = z.object({
  values: z.record(z.string().min(1).max(64), z.string().nullable()),
});

const unlockSchema = z.object({ token: z.string().trim().min(1).max(512) });

type SetupContext = Context<{ Variables: Variables }>;

async function isOwner(c: SetupContext): Promise<boolean> {
  const sessionUser = c.get("user");
  if (!sessionUser) return false;
  const [row] = await db
    .select({ instanceRole: user.instanceRole })
    .from(user)
    .where(eq(user.id, sessionUser.id))
    .limit(1);
  return row?.instanceRole === "owner";
}

function hasServerAccess(c: SetupContext): boolean {
  return verifyServerAccessSession(getCookie(c, SERVER_ACCESS_COOKIE));
}

async function requireSetupAccess(
  c: SetupContext,
): Promise<{ allowed: true } | { allowed: false; status: 401 | 403; message: string }> {
  const status = getSetupStatus();
  if (status.needsOwner) {
    if (hasServerAccess(c)) return { allowed: true };
    logServerAccessInstructions();
    return { allowed: false, status: 401, message: "Server access token required" };
  }
  if (await isOwner(c)) return { allowed: true };
  return {
    allowed: false,
    status: c.get("user") ? 403 : 401,
    message: c.get("user") ? "Owner only" : "Owner sign-in required",
  };
}

function originFromRequest(c: {
  req: { url: string; header: (k: string) => string | undefined };
}): string {
  const envBase = process.env.BETTER_AUTH_URL?.replace(/\/$/, "");
  if (envBase) return envBase;
  // Fallback: compute from request. Honor X-Forwarded-Proto if present
  // so proxied setups don't emit http:// URLs when the client is on https.
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? u.host;
  return `${proto}://${host}`;
}

/** Identify loopback and private hosts for local-development redirects. */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "0.0.0.0") return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (hostname.endsWith(".local")) return true;
  if (hostname.endsWith(".localhost")) return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  // 172.16.0.0 - 172.31.255.255
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  return false;
}

/**
 * Browser-facing origin for redirects back into the SPA.
 *
 * Production: same as the API origin. The API serves the built SPA
 * out of `packages/api/public/`, so a redirect to `${origin}/setup`
 * lands on the right place.
 *
 * Local dev: the API runs on `:3000` but the SPA is served by Vite
 * on `:5173`. A redirect to `:3000/setup` hits the API's "no built
 * SPA" placeholder (the "Run `pnpm build`" message). We detect the
 * dev port and swap it for the Vite port so post-OAuth redirects
 * land on the SPA the user is actually looking at. Operators can
 * override with WEB_ORIGIN if they run a non-default Vite port.
 */
function webOriginFromRequest(c: {
  req: { url: string; header: (k: string) => string | undefined };
}): string {
  const explicit = process.env.WEB_ORIGIN?.replace(/\/$/, "");
  if (explicit) return explicit;
  const apiOrigin = originFromRequest(c);
  const u = new URL(apiOrigin);
  if (isLoopbackHost(u.hostname) && u.port === "3000") {
    u.port = "5173";
    return u.origin;
  }
  return apiOrigin;
}

export const setupRouter = new Hono<{ Variables: Variables }>()
  .get("/status", async (c) => {
    const status = getSetupStatus();
    if (await isOwner(c)) return c.json({ ...status, access: "granted" as const });
    if (status.needsOwner && hasServerAccess(c)) {
      return c.json({ ...status, access: "granted" as const });
    }
    if (status.needsOwner) {
      logServerAccessInstructions();
      return c.json({
        needsSetup: status.needsSetup,
        needsOwner: true,
        access: "token-required" as const,
      });
    }
    if (status.needsSetup) {
      return c.json({
        needsSetup: true,
        needsOwner: false,
        access: "owner-required" as const,
      });
    }
    return c.json({
      needsSetup: false,
      needsOwner: false,
      access: "complete" as const,
    });
  })
  .post("/unlock", async (c) => {
    const status = getSetupStatus();
    if (!status.needsOwner) {
      return c.json({ error: "The instance owner must manage setup now." }, 409);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = unlockSchema.safeParse(body);
    const ipKey = rateLimitFingerprint(getRequestIp(c));
    const perIp = fixedWindowRateLimiter.consume({
      key: `setup-unlock:ip:${ipKey}`,
      limit: 10,
      windowMs: 15 * 60_000,
    });
    const global = fixedWindowRateLimiter.consume({
      key: "setup-unlock:global",
      limit: 200,
      windowMs: 15 * 60_000,
    });
    if (!perIp.allowed || !global.allowed) {
      const retryAfter = Math.max(perIp.retryAfterSeconds, global.retryAfterSeconds);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Too many attempts. Try again later." }, 429);
    }
    if (!parsed.success || !verifyServerAccessToken(parsed.data.token)) {
      logServerAccessInstructions();
      return c.json({ error: "Invalid server access token" }, 401);
    }
    const session = issueServerAccessSession();
    setCookie(c, SERVER_ACCESS_COOKIE, session.value, {
      path: "/",
      httpOnly: true,
      secure: shouldUseSecureCookies(),
      sameSite: "Lax",
      expires: session.expires,
    });
    return c.json({ ok: true });
  })
  .post("/save", async (c) => {
    const access = await requireSetupAccess(c);
    if (!access.allowed) {
      return access.status === 401
        ? c.json({ error: access.message }, 401)
        : c.json({ error: access.message }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    // Only allow known keys. Silently ignore anything else, no surprise writes.
    const allowed = new Set<SettableKey>(SETTABLE_KEYS);
    const writes: Array<{ key: SettableKey; value: string | null }> = [];
    for (const [k, v] of Object.entries(parsed.data.values)) {
      if (!allowed.has(k as SettableKey)) continue;
      writes.push({ key: k as SettableKey, value: v });
    }
    for (const w of writes) setInstanceSetting(w.key, w.value);

    // Mailer may have new SMTP/Resend config, reset its cached transport
    resetMailer();

    return c.json({ ok: true, status: { ...getSetupStatus(), access: "granted" as const } });
  })
  /**
   * GitHub App Manifest flow, step 1: emit an HTML page with a form that
   * auto-submits to github.com/settings/apps/new with the manifest.
   *
   * This is a SERVER-RENDERED page (not JSON) because GitHub's manifest
   * flow expects a standard form POST with the manifest JSON in a hidden
   * field. We can't do this from the SPA, the SPA can only issue
   * JSON/fetch, not a form POST with navigation. So the wizard opens
   * this URL in the same tab, the page auto-submits the form, GitHub
   * renders its "Create GitHub App" preview, and the user clicks approve.
   */
  .get("/github-app/start", async (c) => {
    const access = await requireSetupAccess(c);
    if (!access.allowed) {
      return access.status === 401 ? c.text(access.message, 401) : c.text(access.message, 403);
    }

    const origin = originFromRequest(c);
    const instanceName = getSetupStatus().values.INSTANCE_NAME?.value ?? "Quillra";
    const installationSecret = process.env.BETTER_AUTH_SECRET;
    if (!installationSecret) throw new Error("BETTER_AUTH_SECRET is required");
    // GitHub App names are global. The readable host helps owners identify the
    // App, while a stable installation-specific suffix also disambiguates the
    // many local installs that share localhost:3000.
    const appName = githubAppManifestName(instanceName, origin, installationSecret);
    const manifestFlow = githubManifestFlowStore.issue();
    setCookie(c, GITHUB_MANIFEST_FLOW_COOKIE, manifestFlow.value, {
      path: GITHUB_MANIFEST_FLOW_COOKIE_PATH,
      httpOnly: true,
      secure: shouldUseSecureCookies(),
      sameSite: "Lax",
      expires: manifestFlow.expires,
    });

    const manifest: Record<string, unknown> = {
      name: appName,
      url: origin,
      redirect_url: `${origin}${GITHUB_MANIFEST_FLOW_COOKIE_PATH}`,
      // After install GitHub redirects here so Quillra learns the
      // installation id and can immediately start using the App.
      setup_url: `${origin}/api/setup/github-app/installed`,
      setup_on_update: false,
      // PUBLIC, this is required so the owner can install the App on
      // organizations they admin, not just their personal account. A
      // private App created under a personal account is installable
      // only on that personal account, which breaks any self-hosted
      // setup where repos live in a company org. The "public" tag on
      // the App just means the install URL is reachable without a
      // GitHub auth wall; nobody else meaningfully benefits from
      // installing another org's Quillra App on their own repos.
      public: true,
      default_permissions: {
        // read+write access to repository file contents, this is what
        // github.com's install screen labels "Read and write access to
        // code". It's the permission that lets Quillra commit and push.
        contents: "write",
        // required by every GitHub App
        metadata: "read",
      },
    };
    // No webhook is requested: Quillra does not expose a webhook receiver.
    // Omitting it also keeps first-run setup functional on private/local hosts.
    const manifestJson = JSON.stringify(manifest).replace(/</g, "\\u003c");

    // GitHub reflects the unguessable `state` action parameter into the
    // redirect_url callback. A tiny inline script submits the form so the
    // user doesn't see an intermediate page; they approve on github.com and
    // come back with both `code` and `state`.
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Creating GitHub App…</title>
  <style>
    body{font:14px/1.5 system-ui,sans-serif;color:#171717;background:#fafafa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .card{background:#fff;border:1px solid #e5e5e5;border-radius:16px;padding:32px;max-width:360px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}
    p{margin:0 0 16px 0;color:#525252}
    button{appearance:none;background:#24292F;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer}
    button:hover{background:#32383F}
  </style>
</head>
<body>
  <form class="card" method="post" action="https://github.com/settings/apps/new?state=${encodeURIComponent(manifestFlow.value)}">
    <p><strong>One more step.</strong></p>
    <p>GitHub will ask you to create a <strong>${appName.replace(/</g, "&lt;")}</strong> App. Click approve and we'll handle the rest.</p>
    <input type="hidden" name="manifest" value='${manifestJson.replace(/'/g, "&apos;")}'>
    <button type="submit">Continue to GitHub →</button>
  </form>
  <script>setTimeout(function(){document.querySelector('form').submit();},300);</script>
</body>
</html>`;
    return c.html(html);
  })
  /**
   * GitHub App Manifest flow, step 2: receive the one-time `code` GitHub
   * sends back after the user clicks "Create GitHub App", exchange it for
   * the real credentials (id, private key, webhook secret, etc.), persist
   * them through the encrypted instance_settings layer, and redirect the
   * user STRAIGHT to the install-on-repos page on github.com.
   *
   * Chained flow: the user never sees an intermediate "ok now click here
   * to install" button. They approve create → they immediately get the
   * install chooser → they pick repos → they come back. Two clicks on
   * github.com, nothing to click in between.
   */
  .get("/github-app/callback", async (c) => {
    const access = await requireSetupAccess(c);
    if (!access.allowed) {
      return access.status === 401 ? c.text(access.message, 401) : c.text(access.message, 403);
    }
    const code = c.req.query("code");
    if (!code) return c.text("Missing code", 400);
    const manifestState = githubManifestFlowStore.consume(
      c.req.query("state"),
      getCookie(c, GITHUB_MANIFEST_FLOW_COOKIE),
    );
    if (!manifestState.ok) {
      if (manifestState.reason === "expired" || manifestState.reason === "invalid") {
        deleteCookie(c, GITHUB_MANIFEST_FLOW_COOKIE, {
          path: GITHUB_MANIFEST_FLOW_COOKIE_PATH,
          secure: shouldUseSecureCookies(),
        });
      }
      return c.text("Invalid or expired GitHub App setup state. Start the flow again.", 400);
    }
    deleteCookie(c, GITHUB_MANIFEST_FLOW_COOKIE, {
      path: GITHUB_MANIFEST_FLOW_COOKIE_PATH,
      secure: shouldUseSecureCookies(),
    });
    try {
      const data = await exchangeManifestCode(code);
      // Bypass the wizard entirely and send them to GitHub's
      // "Install on repositories" page. GitHub will bounce them back
      // to the setup_url in the manifest when they're done.
      return c.redirect(`${data.html_url}/installations/new`, 302);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      return c.text(`GitHub App creation failed: ${msg}\n\nGo back and try again.`, 500);
    }
  })
  /**
   * GitHub App Manifest flow, step 3: GitHub redirects here after the
   * owner finishes picking repos on github.com/apps/<slug>/installations/new
   * (this is the `setup_url` baked into the manifest). The URL carries
   * `installation_id` and `setup_action=install|update`.
   *
   * We dispatch back into the app: wizard users land in /setup at the
   * githubApp step (with success state), standalone flows land in
   * /admin on the Integrations tab. Since we don't track which origin
   * kicked off the flow, we check whether the instance still needs
   * setup, if yes, the user was in the wizard; if no, they were in
   * Organization Settings.
   */
  .get("/github-app/installed", async (c) => {
    const access = await requireSetupAccess(c);
    if (!access.allowed) {
      return access.status === 401 ? c.text(access.message, 401) : c.text(access.message, 403);
    }
    const origin = webOriginFromRequest(c);
    const installationId = c.req.query("installation_id") ?? "";
    const status = getSetupStatus();
    const dest = status.needsSetup
      ? `${origin}/setup?step=githubApp&installed=1${installationId ? `&installation_id=${installationId}` : ""}`
      : `${origin}/admin?tab=integrations&installed=1${installationId ? `&installation_id=${installationId}` : ""}`;
    return c.redirect(dest, 302);
  });
