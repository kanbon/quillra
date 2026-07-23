const DEFAULT_TRUSTED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
];

type TrustedOriginEnvironment = Record<string, string | undefined>;

export function getTrustedOrigins(environment: TrustedOriginEnvironment = process.env): string[] {
  const configured = environment.TRUSTED_ORIGINS?.split(",") ?? DEFAULT_TRUSTED_ORIGINS;
  const origins = new Set<string>();
  for (const value of [environment.BETTER_AUTH_URL, ...configured]) {
    if (!value?.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
    } catch {
      /* ignore malformed configuration */
    }
  }
  return [...origins];
}

/**
 * Browsers send Origin for mutation fetches and WebSocket handshakes. Requests
 * without browser metadata remain available to server-side and CLI clients.
 */
export function isTrustedBrowserRequest(
  headers: Headers,
  environment: TrustedOriginEnvironment = process.env,
): boolean {
  const origin = headers.get("origin");
  if (!origin) return headers.get("sec-fetch-site") !== "cross-site";
  try {
    return getTrustedOrigins(environment).includes(new URL(origin).origin);
  } catch {
    return false;
  }
}
