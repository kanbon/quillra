/**
 * Pluggable mailer for Quillra. Self-hosters pick the backend they want via
 * EMAIL_PROVIDER and the matching env vars; the rest of the app calls
 * `sendEmail()` and never has to know which provider is wired up.
 *
 * Backends:
 *   - "none"   — sending is disabled. send() resolves with { sent: false }
 *                so callers can fall back to shareable invite links etc.
 *                Default for fresh installs.
 *   - "resend" — Resend API via plain fetch (no SDK dependency). Set
 *                RESEND_API_KEY and EMAIL_FROM.
 *   - "smtp"   — placeholder; not yet implemented. Will land in a follow-up
 *                with nodemailer once we add it to the lockfile.
 */

export type MailMessage = {
  to: string | string[];
  subject: string;
  /** Plain-text body (used as fallback if html is empty too) */
  text?: string;
  /** HTML body (preferred — most modern clients use this) */
  html?: string;
  /** Optional reply-to override */
  replyTo?: string;
};

export type SendResult =
  | { sent: true; backend: string; id?: string }
  | { sent: false; backend: string; reason: string };

type Backend = "none" | "resend" | "smtp";

function getBackend(): Backend {
  const raw = (process.env.EMAIL_PROVIDER ?? "none").trim().toLowerCase();
  if (raw === "resend" || raw === "smtp" || raw === "none") return raw;
  return "none";
}

function getFrom(): string {
  return process.env.EMAIL_FROM?.trim() || "Quillra <hello@quillra.com>";
}

function asArray(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
}

/** True if email sending is configured and ready to use */
export function isMailerEnabled(): boolean {
  const backend = getBackend();
  if (backend === "none") return false;
  if (backend === "resend") return Boolean(process.env.RESEND_API_KEY?.trim());
  if (backend === "smtp") return false; // not implemented yet
  return false;
}

export function mailerStatus(): { backend: Backend; enabled: boolean; from: string } {
  return { backend: getBackend(), enabled: isMailerEnabled(), from: getFrom() };
}

async function sendViaResend(msg: MailMessage): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { sent: false, backend: "resend", reason: "RESEND_API_KEY not set" };

  const body: Record<string, unknown> = {
    from: getFrom(),
    to: asArray(msg.to),
    subject: msg.subject,
  };
  if (msg.html) body.html = msg.html;
  if (msg.text) body.text = msg.text;
  if (msg.replyTo) body.reply_to = msg.replyTo;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { sent: false, backend: "resend", reason: `Resend ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { sent: true, backend: "resend", id: data.id };
  } catch (e) {
    return { sent: false, backend: "resend", reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Send an email through the configured backend.
 *
 * The function NEVER throws — callers should branch on `result.sent` and
 * fall back to shareable links or in-app notifications when sending isn't
 * configured. This keeps the rest of the app email-optional.
 */
export async function sendEmail(msg: MailMessage): Promise<SendResult> {
  const backend = getBackend();
  if (backend === "none") {
    return { sent: false, backend, reason: "EMAIL_PROVIDER=none (sending disabled)" };
  }
  if (backend === "resend") return sendViaResend(msg);
  if (backend === "smtp") {
    return { sent: false, backend, reason: "SMTP backend not yet implemented" };
  }
  return { sent: false, backend, reason: "Unknown backend" };
}
