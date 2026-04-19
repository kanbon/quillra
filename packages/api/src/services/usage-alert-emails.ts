import { renderBrandedEmail } from "./email-template.js";
import { getOrganizationInfo } from "./instance-settings.js";
/**
 * Rendering + dispatch for the two alert emails the usage-limits
 * system can fire: a soft "warn" at first threshold crossing, and a
 * hard "cap" at first over-the-cap crossing. Both land in the operator's
 * inbox (or wherever USAGE_ALERT_EMAIL points), not the end user's —
 * the user finds out they're over via the friendly in-chat error.
 */
import { isMailerEnabled, sendEmail } from "./mailer.js";

type Who = {
  email: string;
  name: string;
  /** Which rule hit — "global default", role name, or "your override". */
  scopeDescription: string;
};

function formatUsd(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

export async function sendWarnAlert(opts: {
  to: string;
  who: Who;
  spendUsd: number;
  warnUsd: number;
  hardUsd: number | null;
  monthLabel: string;
}): Promise<void> {
  if (!isMailerEnabled()) {
    console.warn("[usage-alerts] mailer disabled — skipping warn email for", opts.who.email);
    return;
  }
  const org = getOrganizationInfo();
  const { html, text } = renderBrandedEmail({
    title: `Usage warning · ${opts.who.name}`,
    preheader: `${opts.who.name} crossed ${formatUsd(opts.warnUsd)} in ${opts.monthLabel}.`,
    body: {
      greeting: `Hi${org.operatorName ? ` ${org.operatorName.split(" ")[0]}` : ""},`,
      paragraphs: [
        `${opts.who.name} (${opts.who.email}) has just crossed the ${formatUsd(opts.warnUsd)} warning threshold for ${opts.monthLabel}. Month-to-date spend is now ${formatUsd(opts.spendUsd)}.`,
        opts.hardUsd != null
          ? `The hard cap for this user is ${formatUsd(opts.hardUsd)} — chat will be blocked automatically when they reach it.`
          : `No hard cap is set — they can keep running indefinitely. Consider adding one in Organization Settings if you'd like an automatic cut-off.`,
        `This rule came from: ${opts.who.scopeDescription}.`,
      ],
      table: {
        headers: ["Metric", "Value"],
        rows: [
          ["Month-to-date", formatUsd(opts.spendUsd)],
          ["Warning threshold", formatUsd(opts.warnUsd)],
          ["Hard cap", opts.hardUsd != null ? formatUsd(opts.hardUsd) : "Not set"],
          ["Period", opts.monthLabel],
        ],
      },
      signature: "— Quillra",
    },
  });
  await sendEmail({
    to: opts.to,
    subject: `Usage warning · ${opts.who.name} passed ${formatUsd(opts.warnUsd)}`,
    html,
    text,
  });
}

export async function sendHardCapAlert(opts: {
  to: string;
  who: Who;
  spendUsd: number;
  hardUsd: number;
  monthLabel: string;
}): Promise<void> {
  if (!isMailerEnabled()) {
    console.warn("[usage-alerts] mailer disabled — skipping cap email for", opts.who.email);
    return;
  }
  const org = getOrganizationInfo();
  const { html, text } = renderBrandedEmail({
    title: `Usage cap reached · ${opts.who.name}`,
    preheader: `${opts.who.name} hit the ${formatUsd(opts.hardUsd)} cap in ${opts.monthLabel}.`,
    body: {
      greeting: `Hi${org.operatorName ? ` ${org.operatorName.split(" ")[0]}` : ""},`,
      paragraphs: [
        `${opts.who.name} (${opts.who.email}) has reached the hard cap of ${formatUsd(opts.hardUsd)} for ${opts.monthLabel}. Further chat messages from them are blocked until ${nextMonthLabel(opts.monthLabel)}.`,
        `This rule came from: ${opts.who.scopeDescription}. Their current month-to-date spend is ${formatUsd(opts.spendUsd)}.`,
        "If they should be allowed to continue, raise the cap or remove the rule in Organization Settings → Usage.",
      ],
      table: {
        headers: ["Metric", "Value"],
        rows: [
          ["Month-to-date", formatUsd(opts.spendUsd)],
          ["Hard cap", formatUsd(opts.hardUsd)],
          ["Period", opts.monthLabel],
        ],
      },
      signature: "— Quillra",
    },
  });
  await sendEmail({
    to: opts.to,
    subject: `Usage cap reached · ${opts.who.name} blocked for ${opts.monthLabel}`,
    html,
    text,
  });
}

function nextMonthLabel(ymd: string): string {
  const [y, m] = ymd.split("-").map((n) => Number.parseInt(n, 10));
  if (!y || !m) return "next month";
  const next = new Date(y, m, 1);
  return next.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function monthLabelFromYmd(ymd: string): string {
  const [y, m] = ymd.split("-").map((n) => Number.parseInt(n, 10));
  if (!y || !m) return ymd;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
