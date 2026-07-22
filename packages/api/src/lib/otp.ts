import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const OTP_UPPER_BOUND = 1_000_000;

/** Generate a cryptographically secure, zero-padded six-digit code. */
export function generateOtpCode(): string {
  return randomInt(OTP_UPPER_BOUND).toString().padStart(6, "0");
}

function otpSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required to protect login codes");
  return secret;
}

function hmacCode(code: string, salt: string): string {
  return createHmac("sha256", otpSecret())
    .update(`quillra.otp.v1:${salt}:${code}`)
    .digest("base64url");
}

export function hashOtpCode(code: string): string {
  const salt = randomBytes(16).toString("base64url");
  return `v1.${salt}.${hmacCode(code, salt)}`;
}

/** Compare an entered code with a stored digest without leaking matching prefixes. */
export function otpCodeMatches(code: string, expectedHash: string): boolean {
  const [version, salt, digest] = expectedHash.split(".");
  if (version === "v1" && salt && digest) {
    const actual = Buffer.from(hmacCode(code, salt));
    const expected = Buffer.from(digest);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  // Codes issued immediately before this upgrade used an unsalted SHA-256
  // digest. Accept those for their remaining 15-minute lifetime; all newly
  // issued codes use the instance-secret HMAC envelope above.
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(createHash("sha256").update(code).digest("hex"));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
