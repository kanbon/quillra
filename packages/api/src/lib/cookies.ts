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
