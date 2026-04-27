/**
 * Boot-time secret bootstrapping.
 *
 * Runs as a pure import-side-effect: importing this module reads or
 * creates the persistent dev secret on disk and writes it into
 * `process.env.BETTER_AUTH_SECRET` so every downstream module
 * (Better Auth, services/crypto.ts, etc.) sees a populated env var
 * for the rest of the process lifetime.
 *
 * Why a side-effect import: Better Auth captures the secret at module
 * top-level the first time `lib/auth.ts` is imported, and our crypto
 * module derives its master key from the same value. If we waited for
 * an explicit call from index.ts the auth library would already have
 * read whatever was (or wasn't) in the env. Importing this file before
 * anything that touches the secret is the simplest way to guarantee
 * order.
 *
 * Production behaviour is unchanged: when `BETTER_AUTH_SECRET` is set
 * in the environment, this file does nothing. The auto-generated path
 * is for local dev (and self-hosters who haven't set the env var yet),
 * not the recommended production setup.
 *
 * Storage: 32 random bytes, base64-encoded, written to
 * `<data-dir>/.boot-secret` with mode 0600. The data directory is
 * derived from `DATABASE_URL` (default `./data/cms.sqlite`). The file
 * is gitignored along with the rest of `data/`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function resolveDataDir(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./data/cms.sqlite";
  const filePath = rawUrl.startsWith("file:") ? rawUrl.slice("file:".length) : rawUrl;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  return path.dirname(absolute);
}

function readOrGenerate(filePath: string): { secret: string; generated: boolean } {
  if (existsSync(filePath)) {
    const stored = readFileSync(filePath, "utf8").trim();
    if (stored) return { secret: stored, generated: false };
  }
  const secret = randomBytes(32).toString("base64");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${secret}\n`, { mode: 0o600 });
  return { secret, generated: true };
}

if (!process.env.BETTER_AUTH_SECRET?.trim()) {
  const dataDir = resolveDataDir();
  const secretPath = path.join(dataDir, ".boot-secret");
  try {
    const { secret, generated } = readOrGenerate(secretPath);
    process.env.BETTER_AUTH_SECRET = secret;
    if (generated) {
      console.warn(
        `[boot-secrets] BETTER_AUTH_SECRET was not set, generated a fresh one and wrote it to ${secretPath}. This is fine for local dev. For production, set BETTER_AUTH_SECRET explicitly in the environment so the value lives outside the data volume.`,
      );
    } else {
      console.info(
        `[boot-secrets] BETTER_AUTH_SECRET was not set, loaded the persisted dev secret from ${secretPath}.`,
      );
    }
  } catch (e) {
    // Fall through with a noisy log; downstream modules will still
    // throw when they try to use the missing secret. We do NOT silently
    // assign a hardcoded placeholder, that would be the worst case
    // (every install with the same well-known signing key).
    console.error(
      "[boot-secrets] could not read or generate the dev secret. Set BETTER_AUTH_SECRET in the environment.",
      e,
    );
  }
}
