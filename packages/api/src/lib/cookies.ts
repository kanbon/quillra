/** Use Secure cookies for production mode or whenever the public URL is HTTPS. */
export function shouldUseSecureCookies(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  const publicUrl = process.env.BETTER_AUTH_URL?.trim();
  if (!publicUrl) return false;
  try {
    return new URL(publicUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Protect control-plane cookies from sibling preview subdomains. Browsers only
 * accept `__Host-` cookies when they are Secure, Path=/, and have no Domain.
 */
export function controlPlaneCookieName(baseName: string): string {
  return shouldUseSecureCookies() ? `__Host-${baseName}` : baseName;
}
