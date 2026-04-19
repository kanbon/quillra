/**
 * Shared template shell for transactional emails that carry real content
 * (usage warnings, monthly reports, …). Renders a single `EmailBody`
 * struct to BOTH an HTML body (table-based, inline styles, Outlook 2016+
 * safe) AND a plain-text fallback generated from the same inputs so no
 * parsing/stripping is needed.
 *
 * The older invite/login emails in `email-templates.ts` predate this
 * helper. Kept in parallel so their minor styling idiosyncrasies aren't
 * disturbed; new emails should use this module.
 */
import { getOrganizationInfo } from "./instance-settings.js";

const BRAND_COLOR = "#C1121F";
const BRAND_COLOR_DARK = "#a50e19";

export type EmailBody = {
  /** "Hi Alice," */
  greeting?: string;
  /** One paragraph per entry, rendered as <p> in HTML, blank-line-separated in text. */
  paragraphs: string[];
  /** Optional data table, displayed as a zebra-striped HTML table and as
   *  a simple column-aligned plain-text grid. */
  table?: {
    headers: string[];
    rows: string[][];
    /** Rendered with a top border + bold cells, typically the "Total" row. */
    totalRow?: string[];
  };
  /** Bulletproof CTA button. Falls back to a plain link in text. */
  cta?: { label: string; url: string };
  /** "- The Acme team" sign-off. */
  signature?: string;
};

export type RenderOptions = {
  /** Shown in the <title> tag and mentioned in the text preamble. */
  title: string;
  /** Sentence Gmail et al. preview next to the subject, kept under 90 chars
   *  is ideal. Hidden from the visible body via a zero-size hidden span. */
  preheader: string;
  body: EmailBody;
  /** Defaults to the instance operator's brand info from settings. */
  brandName?: string;
  brandLogoUrl?: string | null;
};

export function renderBrandedEmail(opts: RenderOptions): { html: string; text: string } {
  const org = getOrganizationInfo();
  const brandName = opts.brandName ?? org.instanceName ?? "Quillra";
  const brandLogoUrl = opts.brandLogoUrl ?? null;
  return {
    html: renderHtml({ ...opts, brandName, brandLogoUrl }),
    text: renderText(opts),
  };
}

// ─────────────────────────── HTML ───────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtml(
  opts: RenderOptions & { brandName: string; brandLogoUrl: string | null },
): string {
  const { title, preheader, body, brandName, brandLogoUrl } = opts;
  const logoBlock = brandLogoUrl
    ? `<img src="${esc(brandLogoUrl)}" alt="${esc(brandName)}" width="56" height="56" style="display:block;border-radius:14px;object-fit:cover;border:0" />`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="56" height="56" align="center" valign="middle" bgcolor="${BRAND_COLOR}" style="width:56px;height:56px;border-radius:14px;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600;font-size:22px;line-height:56px">${esc(brandName.charAt(0).toUpperCase())}</td></tr></table>`;

  const bodyInner = renderBodyHtml(body);
  const footer = renderFooterHtml();

  // Outlook 2016+ ignores <style> and flex/grid. Every style is inline.
  // MSO conditional tables force Outlook into a 520px fixed layout and
  // prevent a 100%-wide blowout on certain Outlook for Windows versions.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="x-ua-compatible" content="IE=edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(title)}</title>
<!--[if mso]>
<style>
  table, td { font-family: "Segoe UI", Arial, Helvetica, sans-serif !important; }
</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background:#f5f5f5;-webkit-font-smoothing:antialiased;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#171717;line-height:1.55">
<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;font-size:1px;color:transparent;mso-hide:all">${esc(preheader)}</div>
<!--[if mso | IE]>
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" width="520" style="width:520px"><tr><td>
<![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f5;padding:36px 16px">
  <tr>
    <td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="width:100%;max-width:520px;background:#ffffff;border-radius:18px;border:1px solid #ececec">
        <tr>
          <td style="padding:32px 36px 12px 36px">
            ${logoBlock}
          </td>
        </tr>
        <tr>
          <td style="padding:4px 36px 32px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;color:#1f1f1f;line-height:1.55">
            ${bodyInner}
          </td>
        </tr>
        <tr>
          <td style="padding:24px 36px 28px 36px;border-top:1px solid #f1f1f1">
            ${footer}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
<!--[if mso | IE]></td></tr></table><![endif]-->
</body>
</html>`;
}

function renderBodyHtml(body: EmailBody): string {
  const parts: string[] = [];
  if (body.greeting) {
    parts.push(
      `<p style="margin:0 0 14px 0;font-size:15px;color:#1f1f1f">${esc(body.greeting)}</p>`,
    );
  }
  for (const p of body.paragraphs) {
    parts.push(
      `<p style="margin:0 0 14px 0;font-size:15px;color:#1f1f1f;line-height:1.6">${esc(p)}</p>`,
    );
  }
  if (body.table) {
    parts.push(renderTableHtml(body.table));
  }
  if (body.cta) {
    parts.push(renderCtaHtml(body.cta));
  }
  if (body.signature) {
    parts.push(
      `<p style="margin:24px 0 0 0;font-size:14px;color:#525252">${esc(body.signature)}</p>`,
    );
  }
  return parts.join("\n");
}

function renderTableHtml(table: NonNullable<EmailBody["table"]>): string {
  const headerCells = table.headers
    .map((h, i) => {
      const align = i === 0 ? "left" : "right";
      return `<th align="${align}" style="padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#737373;border-bottom:1px solid #e5e5e5;text-align:${align}">${esc(h)}</th>`;
    })
    .join("");
  const bodyRows = table.rows
    .map((row, ri) => {
      const bg = ri % 2 === 1 ? "#fafafa" : "#ffffff";
      const cells = row
        .map((c, i) => {
          const align = i === 0 ? "left" : "right";
          return `<td align="${align}" style="padding:10px 12px;font-size:14px;color:#171717;border-bottom:1px solid #f3f3f3;text-align:${align}">${esc(c)}</td>`;
        })
        .join("");
      return `<tr bgcolor="${bg}" style="background:${bg}">${cells}</tr>`;
    })
    .join("");
  const totalRow = table.totalRow
    ? `<tr bgcolor="#ffffff" style="background:#ffffff">${table.totalRow
        .map((c, i) => {
          const align = i === 0 ? "left" : "right";
          return `<td align="${align}" style="padding:14px 12px 12px 12px;font-size:14px;font-weight:600;color:#171717;border-top:2px solid #e5e5e5;text-align:${align}">${esc(c)}</td>`;
        })
        .join("")}</tr>`
    : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin:8px 0 20px 0;border:1px solid #ececec;border-radius:10px;overflow:hidden">
<thead><tr bgcolor="#fafafa" style="background:#fafafa">${headerCells}</tr></thead>
<tbody>${bodyRows}${totalRow}</tbody>
</table>`;
}

function renderCtaHtml(cta: { label: string; url: string }): string {
  // Bulletproof button: MSO conditional VML on top, fallback `<a>` below.
  // Outlook renders the VML; every other client hides it and shows the link.
  const href = esc(cta.url);
  const label = esc(cta.label);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 24px 0">
<tr><td align="left">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:220px;" arcsize="14%" strokecolor="${BRAND_COLOR_DARK}" fillcolor="${BRAND_COLOR}">
<w:anchorlock/>
<center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;">${label}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${href}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#ffffff;background:${BRAND_COLOR};text-decoration:none;border-radius:10px;mso-hide:all">${label}</a>
<!--<![endif]-->
</td></tr></table>`;
}

function renderFooterHtml(): string {
  const org = getOrganizationInfo();
  const nameLine = org.company
    ? `${esc(org.company)}${org.operatorName ? ` · ${esc(org.operatorName)}` : ""}`
    : org.operatorName
      ? esc(org.operatorName)
      : null;
  const contactParts: string[] = [];
  if (org.email)
    contactParts.push(
      `<a href="mailto:${esc(org.email)}" style="color:#737373;text-decoration:underline">${esc(org.email)}</a>`,
    );
  if (org.website)
    contactParts.push(
      `<a href="${esc(org.website)}" style="color:#737373;text-decoration:underline">${esc(org.website.replace(/^https?:\/\//, ""))}</a>`,
    );
  const contactLine = contactParts.length > 0 ? contactParts.join(" · ") : "";

  if (!nameLine && !org.address && !contactLine) {
    return `<p style="margin:0;font-size:11px;color:#a3a3a3">Sent by Quillra</p>`;
  }

  return `
    ${nameLine ? `<p style="margin:0 0 2px 0;font-size:11px;color:#737373"><strong style="color:#525252">${nameLine}</strong></p>` : ""}
    ${org.address ? `<p style="margin:0 0 2px 0;font-size:11px;color:#a3a3a3;white-space:pre-line">${esc(org.address)}</p>` : ""}
    ${contactLine ? `<p style="margin:0;font-size:11px;color:#a3a3a3">${contactLine}</p>` : ""}
    <p style="margin:10px 0 0 0;font-size:10px;color:#d4d4d4">Sent via Quillra · ${esc(org.instanceName ?? "Quillra")}</p>
  `;
}

// ─────────────────────────── Text ───────────────────────────

function renderText(opts: RenderOptions): string {
  const { title, body } = opts;
  const lines: string[] = [];
  lines.push(title);
  lines.push("=".repeat(Math.min(title.length, 60)));
  lines.push("");
  if (body.greeting) {
    lines.push(body.greeting);
    lines.push("");
  }
  for (const p of body.paragraphs) {
    lines.push(p);
    lines.push("");
  }
  if (body.table) lines.push(renderTableText(body.table), "");
  if (body.cta) lines.push(`${body.cta.label}: ${body.cta.url}`, "");
  if (body.signature) lines.push(body.signature, "");
  lines.push(renderFooterText());
  return lines.join("\n");
}

function renderTableText(table: NonNullable<EmailBody["table"]>): string {
  const all = [table.headers, ...table.rows, ...(table.totalRow ? [table.totalRow] : [])];
  const widths = table.headers.map((_, col) =>
    Math.max(...all.map((row) => (row[col] ?? "").length)),
  );
  const formatRow = (row: string[]) =>
    row
      .map((c, i) => {
        const w = widths[i];
        return i === 0 ? c.padEnd(w, " ") : (c ?? "").padStart(w, " ");
      })
      .join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const out: string[] = [];
  out.push(formatRow(table.headers));
  out.push(sep);
  for (const row of table.rows) out.push(formatRow(row));
  if (table.totalRow) {
    out.push(sep);
    out.push(formatRow(table.totalRow));
  }
  return out.join("\n");
}

function renderFooterText(): string {
  const org = getOrganizationInfo();
  const parts: string[] = [];
  const nameLine = org.company
    ? `${org.company}${org.operatorName ? ` · ${org.operatorName}` : ""}`
    : (org.operatorName ?? null);
  if (nameLine) parts.push(nameLine);
  if (org.address) parts.push(org.address);
  const contacts: string[] = [];
  if (org.email) contacts.push(org.email);
  if (org.website) contacts.push(org.website.replace(/^https?:\/\//, ""));
  if (contacts.length > 0) parts.push(contacts.join(" · "));
  parts.push(`Sent via Quillra · ${org.instanceName ?? "Quillra"}`);
  return parts.join("\n");
}
