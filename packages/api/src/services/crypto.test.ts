import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isEncryptedV1, resetCryptoCache } from "./crypto.js";

/*
 * These tests exercise the AES-GCM wrapper in isolation. Every test that
 * encrypts must run with a deterministic key, so we set QUILLRA_ENCRYPTION_KEY
 * in beforeEach and then call resetCryptoCache() to force the module to
 * re-resolve it on the next call.
 */
const TEST_KEY = "a".repeat(64);

beforeEach(() => {
  process.env.QUILLRA_ENCRYPTION_KEY = TEST_KEY;
  resetCryptoCache();
});

describe("crypto", () => {
  describe("encryptSecret / decryptSecret", () => {
    it("round-trips plaintext through the v1 envelope", () => {
      const plain = "sk-ant-api03-xxxxxxxxxxxxxxxx";
      const cipher = encryptSecret(plain);
      expect(cipher).not.toEqual(plain);
      expect(cipher.startsWith("v1:")).toBe(true);
      expect(decryptSecret(cipher)).toEqual(plain);
    });

    it("preserves an empty string without wrapping it", () => {
      expect(encryptSecret("")).toEqual("");
      expect(decryptSecret("")).toEqual("");
    });

    it("produces a fresh IV per call, so identical inputs yield different ciphertexts", () => {
      const a = encryptSecret("same-secret");
      const b = encryptSecret("same-secret");
      expect(a).not.toEqual(b);
      expect(decryptSecret(a)).toEqual("same-secret");
      expect(decryptSecret(b)).toEqual("same-secret");
    });

    it("treats non-v1 input as legacy plaintext and returns it as-is", () => {
      expect(decryptSecret("legacy-plaintext-value")).toEqual("legacy-plaintext-value");
      expect(isEncryptedV1("legacy-plaintext-value")).toBe(false);
    });

    it("rejects a tampered auth tag", () => {
      const cipher = encryptSecret("protect-me");
      // Flip the last character of the auth tag segment.
      const parts = cipher.split(":");
      const tag = parts[3];
      const flipped = tag.charAt(0) === "A" ? `B${tag.slice(1)}` : `A${tag.slice(1)}`;
      const tampered = [parts[0], parts[1], parts[2], flipped].join(":");
      expect(() => decryptSecret(tampered)).toThrow();
    });

    it("rejects a malformed envelope", () => {
      expect(() => decryptSecret("v1:only:two")).toThrow(/Malformed/);
    });
  });

  describe("isEncryptedV1", () => {
    it("returns true for a freshly encrypted value", () => {
      expect(isEncryptedV1(encryptSecret("x"))).toBe(true);
    });

    it("returns false for plain strings and non-strings", () => {
      expect(isEncryptedV1("plain")).toBe(false);
      expect(isEncryptedV1("")).toBe(false);
      // biome-ignore lint/suspicious/noExplicitAny: testing the defensive check
      expect(isEncryptedV1(null as any)).toBe(false);
    });
  });

  describe("key resolution", () => {
    it("rejects a non-hex master key", () => {
      process.env.QUILLRA_ENCRYPTION_KEY = "not-hex-at-all!!";
      resetCryptoCache();
      expect(() => encryptSecret("x")).toThrow(/valid hex|32 bytes/);
    });

    it("rejects a hex master key of the wrong length", () => {
      process.env.QUILLRA_ENCRYPTION_KEY = "ab".repeat(16); // 32 hex chars = 16 bytes
      resetCryptoCache();
      expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    });

    it("falls back to BETTER_AUTH_SECRET when QUILLRA_ENCRYPTION_KEY is unset", () => {
      // biome-ignore lint/performance/noDelete: unsetting the env var is what we want to test
      delete process.env.QUILLRA_ENCRYPTION_KEY;
      process.env.BETTER_AUTH_SECRET = "a-session-secret-long-enough-to-key";
      resetCryptoCache();
      const cipher = encryptSecret("works");
      expect(decryptSecret(cipher)).toEqual("works");
    });

    it("throws when neither key source is set", () => {
      // biome-ignore lint/performance/noDelete: unsetting the env var is what we want to test
      delete process.env.QUILLRA_ENCRYPTION_KEY;
      // biome-ignore lint/performance/noDelete: unsetting the env var is what we want to test
      delete process.env.BETTER_AUTH_SECRET;
      resetCryptoCache();
      expect(() => encryptSecret("x")).toThrow(/QUILLRA_ENCRYPTION_KEY|BETTER_AUTH_SECRET/);
    });
  });
});
