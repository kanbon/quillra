/**
 * First-run setup wizard API.
 *
 * GET  /api/setup/status  — public, returns whether the instance is
 *                           configured (so the frontend can bounce new
 *                           installs into the wizard)
 * POST /api/setup/save    — writes setting values to the DB
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
import { resetMailer } from "../services/mailer.js";
import { db } from "../db/index.js";
import { eq } from "drizzle-orm";
import { user } from "../db/auth-schema.js";

type Variables = { user: SessionUser | null };

const saveSchema = z.object({
  values: z.record(z.string().min(1).max(64), z.string().nullable()),
});

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
  });
