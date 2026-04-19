/**
 * HTML email templates for the invite + client login flows.
 *
 * Kept self-contained (inline styles, no external assets) so they render
 * the same in every email client. The shared shell wraps a small content
 * block in a clean white card with a subtle accent line.
 */
import { getOrganizationInfo } from "./instance-settings.js";

const BRAND_COLOR = "#C1121F";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderOperatorFooter(): string {
  const org = getOrganizationInfo();
  // Who's operating this Quillra instance. Every email carries the
  // operator's name/company/contact so recipients know where it's
  // coming from and how to reach a human, also satisfies Impressum
  // / "sender identity" requirements in DE/AT and makes Gmail happier.
  const nameLine = org.company
    ? `${escapeHtml(org.company)}${org.operatorName ? ` · ${escapeHtml(org.operatorName)}` : ""}`
    : org.operatorName
      ? escapeHtml(org.operatorName)
      : null;
  const contactParts: string[] = [];
  if (org.email)
    contactParts.push(
      `<a href="mailto:${escapeHtml(org.email)}" style="color:#737373;text-decoration:underline">${escapeHtml(org.email)}</a>`,
    );
  if (org.website)
    contactParts.push(
      `<a href="${escapeHtml(org.website)}" style="color:#737373;text-decoration:underline">${escapeHtml(org.website.replace(/^https?:\/\//, ""))}</a>`,
    );
  const contactLine = contactParts.length > 0 ? contactParts.join(" · ") : "";

  if (!nameLine && !org.address && !contactLine) {
    return `<p style="margin:18px 0 0 0;font-size:11px;color:#a3a3a3">Sent by Quillra</p>`;
  }

  return `
    ${nameLine ? `<p style="margin:18px 0 2px 0;font-size:11px;color:#737373"><strong style="color:#525252">${nameLine}</strong></p>` : ""}
    ${org.address ? `<p style="margin:0 0 2px 0;font-size:11px;color:#a3a3a3;white-space:pre-line">${escapeHtml(org.address)}</p>` : ""}
    ${contactLine ? `<p style="margin:0 0 0 0;font-size:11px;color:#a3a3a3">${contactLine}</p>` : ""}
    <p style="margin:10px 0 0 0;font-size:10px;color:#d4d4d4">Sent via Quillra · ${escapeHtml(org.instanceName)}</p>
  `;
}

function shell(opts: {
  title: string;
  preheader: string;
  brandName: string;
  brandLogoUrl?: string | null;
  bodyHtml: string;
}): string {
  const { title, preheader, brandName, brandLogoUrl, bodyHtml } = opts;
  const logoBlock = brandLogoUrl
    ? `<img src="${escapeHtml(brandLogoUrl)}" alt="${escapeHtml(brandName)}" width="56" height="56" style="display:block;border-radius:14px;object-fit:cover" />`
    : `<div style="width:56px;height:56px;border-radius:14px;background:${BRAND_COLOR};color:#fff;display:flex;align-items:center;justify-content:center;font-family:-apple-system,system-ui,sans-serif;font-weight:600;font-size:22px">${escapeHtml(brandName.charAt(0).toUpperCase())}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#171717;line-height:1.55">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;font-size:1px;line-height:1px;overflow:hidden;mso-hide:all">${escapeHtml(preheader)}</span>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f5;padding:36px 16px">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:#ffffff;border-radius:18px;box-shadow:0 1px 3px rgba(0,0,0,0.04),0 8px 24px rgba(0,0,0,0.04);overflow:hidden">
      <tr><td style="padding:36px 36px 12px 36px">
        ${logoBlock}
      </td></tr>
      <tr><td style="padding:8px 36px 36px 36px">
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:0 36px 28px 36px;border-top:1px solid #f1f1f1">
        ${renderOperatorFooter()}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function ctaButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0">
<tr><td bgcolor="${BRAND_COLOR}" style="border-radius:10px">
<a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${escapeHtml(label)}</a>
</td></tr></table>`;
}

export function inviteEmailHtml(opts: {
  projectName: string;
  projectLogoUrl?: string | null;
  inviterName?: string | null;
  role: string;
  acceptUrl: string;
}): string {
  const { projectName, projectLogoUrl, inviterName, role, acceptUrl } = opts;
  const friendlyRole = role === "client" ? "edit content" : "collaborate";
  const inviterLine = inviterName
    ? `${escapeHtml(inviterName)} invited you to <strong>${escapeHtml(projectName)}</strong>.`
    : `You've been invited to <strong>${escapeHtml(projectName)}</strong>.`;

  const body = `
    <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#171717">You're invited</h1>
    <p style="margin:0 0 18px 0;font-size:15px;color:#525252">${inviterLine}</p>
    <p style="margin:0 0 6px 0;font-size:14px;color:#525252">Open the link below to ${escapeHtml(friendlyRole)}.</p>
    ${ctaButton(acceptUrl, `Open ${projectName}`)}
    <p style="margin:18px 0 0 0;font-size:12px;color:#a3a3a3;word-break:break-all">Or paste this link into your browser:<br><span style="color:#737373">${escapeHtml(acceptUrl)}</span></p>
  `;

  return shell({
    title: `You're invited to ${projectName}`,
    preheader: `You've been invited to edit ${projectName}`,
    brandName: projectName,
    brandLogoUrl: projectLogoUrl,
    bodyHtml: body,
  });
}

export function loginCodeEmailHtml(opts: {
  projectName: string;
  projectLogoUrl?: string | null;
  code: string;
  expiresInMinutes: number;
}): string {
  const { projectName, projectLogoUrl, code, expiresInMinutes } = opts;
  const body = `
    <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#171717">Your sign-in code</h1>
    <p style="margin:0 0 18px 0;font-size:15px;color:#525252">Use this code to open <strong>${escapeHtml(projectName)}</strong>.</p>
    <div style="margin:18px 0;padding:18px 24px;background:#fafafa;border:1px solid #e5e5e5;border-radius:12px;text-align:center">
      <div style="font-family:'SF Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;font-weight:600;letter-spacing:0.18em;color:#171717">${escapeHtml(code)}</div>
    </div>
    <p style="margin:0;font-size:13px;color:#737373">This code expires in ${expiresInMinutes} minutes. If you didn't ask for it, you can ignore this email.</p>
  `;

  return shell({
    title: `Your sign-in code for ${projectName}`,
    preheader: `Your ${projectName} sign-in code is ${code}`,
    brandName: projectName,
    brandLogoUrl: projectLogoUrl,
    bodyHtml: body,
  });
}
