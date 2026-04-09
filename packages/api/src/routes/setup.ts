/**
 * First-run setup wizard API.
 *
 * GET  /api/setup/status                    — returns configuration status
 * POST /api/setup/save                      — writes setting values to the DB
 * GET  /api/setup/github-app/start          — emits an auto-submitting form
 *                                              that hands the user off to the
 *                                              GitHub App Manifest flow
 * GET  /api/setup/github-app/callback       — receives the manifest code back
 *                                              from GitHub, exchanges it for
 *                                              the App credentials, persists
 *                                              them, then redirects the user
 *                                              to the install-on-repos step
 *
 * Save is protected by a "bootstrap secret": on a clean install, anyone
 * can save once (needsSetup = true). After the instance is configured,
 * only the instance owner can change settings.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SessionUser } from "../lib/auth.js";
import {
  getSetupStatus,
  setInstanceSetting,
  SETTABLE_KEYS,
  type SettableKey,
} from "../services/instance-settings.js";
import { exchangeManifestCode } from "../services/github-app.js";
import { resetMailer } from "../services/mailer.js";
import { db } from "../db/index.js";
import { eq } from "drizzle-orm";
import { user } from "../db/auth-schema.js";

type Variables = { user: SessionUser | null };

const saveSchema = z.object({
  values: z.record(z.string().min(1).max(64), z.string().nullable()),
});

function originFromRequest(c: { req: { url: string; header: (k: string) => string | undefined } }): string {
  const envBase = process.env.BETTER_AUTH_URL?.replace(/\/$/, "");
  if (envBase) return envBase;
  // Fallback: compute from request. Honor X-Forwarded-Proto if present
  // so proxied setups don't emit http:// URLs when the client is on https.
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? u.host;
  return `${proto}://${host}`;
}

export const setupRouter = new Hono<{ Variables: Variables }>()
  .get("/status", async (c) => {
    return c.json(getSetupStatus());
  })
  .post("/save", async (c) => {
    const status = getSetupStatus();
    // Once setup is done, only owners can change settings
    if (!status.needsSetup) {
      const sessionUser = c.get("user");
      if (!sessionUser) return c.json({ error: "Unauthorized" }, 401);
      const [row] = await db
        .select({ instanceRole: user.instanceRole })
        .from(user)
        .where(eq(user.id, sessionUser.id))
        .limit(1);
      if (row?.instanceRole !== "owner") return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json().catch(() => null);
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    // Only allow known keys. Silently ignore anything else — no surprise writes.
    const allowed = new Set<SettableKey>(SETTABLE_KEYS);
    const writes: Array<{ key: SettableKey; value: string | null }> = [];
    for (const [k, v] of Object.entries(parsed.data.values)) {
      if (!allowed.has(k as SettableKey)) continue;
      writes.push({ key: k as SettableKey, value: v });
    }
    for (const w of writes) setInstanceSetting(w.key, w.value);

    // Mailer may have new SMTP/Resend config — reset its cached transport
    resetMailer();

    return c.json({ ok: true, status: getSetupStatus() });
  })
  /**
   * GitHub App Manifest flow — step 1: emit an HTML page with a form that
   * auto-submits to github.com/settings/apps/new with the manifest.
   *
   * This is a SERVER-RENDERED page (not JSON) because GitHub's manifest
   * flow expects a standard form POST with the manifest JSON in a hidden
   * field. We can't do this from the SPA — the SPA can only issue
   * JSON/fetch, not a form POST with navigation. So the wizard opens
   * this URL in the same tab, the page auto-submits the form, GitHub
   * renders its "Create GitHub App" preview, and the user clicks approve.
   */
  .get("/github-app/start", async (c) => {
    const status = getSetupStatus();
    // Allow during first-run setup OR for the existing owner re-running the flow
    if (!status.needsSetup) {
      const sessionUser = c.get("user");
      if (!sessionUser) return c.text("Unauthorized", 401);
      const [row] = await db
        .select({ instanceRole: user.instanceRole })
        .from(user)
        .where(eq(user.id, sessionUser.id))
        .limit(1);
      if (row?.instanceRole !== "owner") return c.text("Owner only", 403);
    }

    const origin = originFromRequest(c);
    const instanceName = (getSetupStatus().values.INSTANCE_NAME?.value ?? "Quillra").slice(0, 34);
    // GitHub App names must be globally unique; append the host as a
    // disambiguator so multiple self-hosted instances don't fight over
    // the same name in the user's App list.
    const host = new URL(origin).host;
    const appName = `${instanceName} @ ${host}`.slice(0, 34);

    const manifest = {
      name: appName,
      url: origin,
      hook_attributes: {
        url: `${origin}/api/github-app/webhook`,
        active: true,
      },
      redirect_url: `${origin}/api/setup/github-app/callback`,
      // After install GitHub redirects here so Quillra learns the
      // installation id and can immediately start using the App.
      setup_url: `${origin}/setup?step=githubApp&installed=1`,
      setup_on_update: false,
      public: false,
      default_permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
        workflows: "write",
      },
      default_events: ["push", "pull_request"],
    };
    const manifestJson = JSON.stringify(manifest).replace(/</g, "\\u003c");

    // The form posts to github.com's "new app from manifest" endpoint. A
    // tiny inline script submits it automatically so the user doesn't see
    // an intermediate page — they just click "Create GitHub App" on
    // github.com and come back.
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
  <form class="card" method="post" action="https://github.com/settings/apps/new">
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
   * GitHub App Manifest flow — step 2: receive the one-time `code` GitHub
   * sends back after the user clicks "Create GitHub App", exchange it for
   * the real credentials (id, private key, webhook secret, etc.), persist
   * them through the encrypted instance_settings layer, and redirect the
   * user into the install-on-repos step of the wizard.
   */
  .get("/github-app/callback", async (c) => {
    const code = c.req.query("code");
    if (!code) return c.text("Missing code", 400);
    try {
      const data = await exchangeManifestCode(code);
      // Redirect into the wizard with a flag so Setup.tsx knows to show
      // the "now install on your repos" sub-step.
      const origin = originFromRequest(c);
      const installUrl = `${data.html_url}/installations/new`;
      return c.redirect(
        `${origin}/setup?step=githubApp&created=1&installUrl=${encodeURIComponent(installUrl)}`,
        302,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      return c.text(
        `GitHub App creation failed: ${msg}\n\nGo back and try again.`,
        500,
      );
    }
  });
