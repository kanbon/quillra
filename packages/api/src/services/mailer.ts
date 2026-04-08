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
 *   - "smtp"   — Universal SMTP via nodemailer. Works with any standard
 *                SMTP server: Postfix, Mailgun, SendGrid, AWS SES, Postmark,
 *                Gmail, Outlook, your own server, etc. Set SMTP_HOST, PORT,
 *                USER, PASSWORD, SECURE, and EMAIL_FROM.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { getInstanceSetting } from "./instance-settings.js";

export type MailMessage = {
  to: string | string[];
  subject: string;
  /** Plain-text body (used as fallback if html is empty too) */
  text?: string;
  /** HTML body (preferred — most modern clients use this) */
  html?: string;
  /** Optional reply-to override */
  replyTo?: string;
  /**
   * Optional extra headers to set on the outgoing mail. Used for things
   * like List-Unsubscribe (required by Gmail/Yahoo for bulk senders to
   * stay out of spam) and Message-ID.
   */
  headers?: Record<string, string>;
};

export type SendResult =
  | { sent: true; backend: string; id?: string }
  | { sent: false; backend: string; reason: string };

type Backend = "none" | "resend" | "smtp";

function getBackend(): Backend {
  const raw = (getInstanceSetting("EMAIL_PROVIDER") ?? "none").trim().toLowerCase();
  if (raw === "resend" || raw === "smtp" || raw === "none") return raw;
  return "none";
}

function getFrom(): string {
  return getInstanceSetting("EMAIL_FROM") || "Quillra <hello@quillra.com>";
}

function asArray(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
}

/** True if email sending is configured and ready to use */
export function isMailerEnabled(): boolean {
  const backend = getBackend();
  if (backend === "none") return false;
  if (backend === "resend") return Boolean(getInstanceSetting("RESEND_API_KEY"));
  if (backend === "smtp") return Boolean(getInstanceSetting("SMTP_HOST"));
  return false;
}

export function mailerStatus(): { backend: Backend; enabled: boolean; from: string } {
  return { backend: getBackend(), enabled: isMailerEnabled(), from: getFrom() };
}

async function sendViaResend(msg: MailMessage): Promise<SendResult> {
  const apiKey = getInstanceSetting("RESEND_API_KEY");
  if (!apiKey) return { sent: false, backend: "resend", reason: "RESEND_API_KEY not set" };

  const body: Record<string, unknown> = {
    from: getFrom(),
    to: asArray(msg.to),
    subject: msg.subject,
  };
  if (msg.html) body.html = msg.html;
  if (msg.text) body.text = msg.text;
  if (msg.replyTo) body.reply_to = msg.replyTo;
  if (msg.headers && Object.keys(msg.headers).length > 0) body.headers = msg.headers;

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
 * Lazy-initialised SMTP transporter. Re-created whenever the underlying
 * config changes so admins can reconfigure the mailer at runtime from the
 * setup wizard without restarting the container.
 */
let smtpTransport: Transporter | null = null;
let smtpTransportKey = "";

function getSmtpTransport(): Transporter | null {
  const host = getInstanceSetting("SMTP_HOST");
  if (!host) return null;
  const port = Number(getInstanceSetting("SMTP_PORT") ?? "587");
  const user = getInstanceSetting("SMTP_USER");
  const password = getInstanceSetting("SMTP_PASSWORD");
  const secure = (getInstanceSetting("SMTP_SECURE") ?? "").toLowerCase() === "true";

  const key = `${host}|${port}|${user ?? ""}|${password ? "yes" : "no"}|${secure}`;
  if (smtpTransport && smtpTransportKey === key) return smtpTransport;

  smtpTransport = nodemailer.createTransport({
    host,
    port,
    secure, // true for 465; false for 587/STARTTLS
    auth: user && password ? { user, pass: password } : undefined,
  });
  smtpTransportKey = key;
  return smtpTransport;
}

async function sendViaSmtp(msg: MailMessage): Promise<SendResult> {
  try {
    const transport = getSmtpTransport();
    if (!transport) return { sent: false, backend: "smtp", reason: "SMTP_HOST not set" };
    const info = await transport.sendMail({
      from: getFrom(),
      to: asArray(msg.to),
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      replyTo: msg.replyTo,
      headers: msg.headers,
    });
    return { sent: true, backend: "smtp", id: info.messageId };
  } catch (e) {
    return { sent: false, backend: "smtp", reason: e instanceof Error ? e.message : String(e) };
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
  if (backend === "smtp") return sendViaSmtp(msg);
  return { sent: false, backend, reason: "Unknown backend" };
}

/** Reset any cached mailer state — called after the setup wizard saves new config */
export function resetMailer(): void {
  smtpTransport = null;
  smtpTransportKey = "";
}
