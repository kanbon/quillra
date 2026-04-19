/**
 * AES-256-GCM secret encryption for values we store in instance_settings.
 *
 * Threat model: "attacker got a copy of data/cms.sqlite". Without the master
 * key that lives in the container env, the stored secrets are useless. This
 * does NOT defend against a compromised running process, the key is in
 * memory, and anyone with access to the container env can decrypt. That's
 * the honest trade-off for a single-box self-hosted app; enterprise
 * HSM/TPM/Vault setups are out of scope.
 *
 * On-disk format: `v1:<iv-b64url>:<ciphertext-b64url>:<authTag-b64url>`.
 * A value that doesn't start with `v1:` is treated as legacy plaintext so
 * upgrades are transparent, the instance_settings boot migration
 * re-encrypts every legacy row in place on the first start after this
 * change lands.
 *
 * Key sources, in order of precedence:
 *   1. `QUILLRA_ENCRYPTION_KEY`, 32 bytes hex-encoded (64 hex chars).
 *   2. Derived via HKDF-SHA256 from `BETTER_AUTH_SECRET`. Automatic so
 *      existing installs don't need operator action, but we log a loud
 *      warning on boot telling the owner to set `QUILLRA_ENCRYPTION_KEY`
 *      explicitly so they can rotate independently of the session secret.
 *   3. Neither set → throw on first use. We deliberately refuse to fall
 *      back to a well-known constant, because "encrypted with the same
 *      key as everyone else on the internet" is worse than plaintext
 *      (it lulls operators into a false sense of security).
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = "v1";
const HKDF_INFO = "quillra.instance_settings.v1";
const HKDF_SALT = Buffer.alloc(32); // 32 zero bytes is fine for a single-tenant HKDF

let cachedKey: Buffer | null = null;
let warnedAboutDerivedKey = false;

function resolveMasterKey(): Buffer {
  const explicit = process.env.QUILLRA_ENCRYPTION_KEY?.trim();
  if (explicit) {
    let buf: Buffer;
    try {
      buf = Buffer.from(explicit, "hex");
    } catch {
      throw new Error(
        "QUILLRA_ENCRYPTION_KEY is not valid hex. Generate one with: openssl rand -hex 32",
      );
    }
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `QUILLRA_ENCRYPTION_KEY must be ${KEY_BYTES} bytes hex-encoded (${KEY_BYTES * 2} hex chars). Generate one with: openssl rand -hex 32`,
      );
    }
    return buf;
  }

  const authSecret = process.env.BETTER_AUTH_SECRET?.trim();
  if (authSecret) {
    if (!warnedAboutDerivedKey) {
      warnedAboutDerivedKey = true;
      console.warn(
        "[crypto] QUILLRA_ENCRYPTION_KEY not set, deriving from BETTER_AUTH_SECRET. " +
          "Set QUILLRA_ENCRYPTION_KEY (32 hex bytes) to decouple secret encryption from session signing.",
      );
    }
    const derived = hkdfSync(
      "sha256",
      Buffer.from(authSecret, "utf8"),
      HKDF_SALT,
      Buffer.from(HKDF_INFO, "utf8"),
      KEY_BYTES,
    );
    return Buffer.from(derived);
  }

  throw new Error(
    "Cannot derive secret encryption key: set QUILLRA_ENCRYPTION_KEY (32 hex bytes) or BETTER_AUTH_SECRET in the environment.",
  );
}

function masterKey(): Buffer {
  if (!cachedKey) cachedKey = resolveMasterKey();
  return cachedKey;
}

/** Returns true when the stored value is in the v1 encrypted envelope. */
export function isEncryptedV1(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith(`${VERSION}:`);
}

/** Encrypt a plaintext string. Never throws on malformed input, every
 *  non-empty string is wrappable. */
export function encryptSecret(plain: string): string {
  if (plain === "") return "";
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    enc.toString("base64url"),
    tag.toString("base64url"),
  ].join(":");
}

/** Decrypt a v1-envelope value. Legacy plaintext values (no `v1:` prefix)
 *  are returned as-is so reads during the migration window keep working. */
export function decryptSecret(stored: string): string {
  if (!isEncryptedV1(stored)) return stored;
  const parts = stored.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed encrypted secret: expected v1:iv:ct:tag");
  }
  const [, ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const decipher = createDecipheriv(ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
  return dec.toString("utf8");
}

/** Force the master key cache to be re-resolved. Useful in tests and if we
 *  ever add a key-rotation endpoint at runtime. */
export function resetCryptoCache(): void {
  cachedKey = null;
  warnedAboutDerivedKey = false;
}
