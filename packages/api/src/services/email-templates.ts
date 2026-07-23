/**
 * Content helpers for invitation and passwordless login emails.
 *
 * Visual rendering lives in email-template.ts so every transactional
 * message shares one accessible, table-based brand shell.
 */
import { type EmailBrand, type RenderOptions, renderBrandedEmail } from "./email-template.js";

type RenderedEmail = ReturnType<typeof renderBrandedEmail>;

export function renderInviteEmail(opts: {
  brand: EmailBrand;
  inviterName?: string | null;
  role: string;
  acceptUrl: string;
}): RenderedEmail {
  const inviter = opts.inviterName?.trim() || "Someone";
  const action =
    opts.role === "client"
      ? "Review and edit content in a focused workspace made for clients."
      : "Join the workspace and collaborate with the team.";

  return renderBrandedEmail({
    title: `You're invited to ${opts.brand.displayName}`,
    preheader: `${inviter} invited you to ${opts.brand.displayName}.`,
    brand: opts.brand,
    body: {
      heading: "You're invited",
      paragraphs: [
        `${inviter} invited you to ${opts.brand.displayName}.`,
        action,
        "This invitation is personal to your email address.",
      ],
      cta: {
        label: "Open workspace",
        url: opts.acceptUrl,
      },
    },
  });
}

export function renderLoginCodeEmail(opts: {
  brand: EmailBrand;
  code: string;
  expiresInMinutes: number;
}): RenderedEmail {
  const renderOptions: RenderOptions = {
    title: `Your sign-in code for ${opts.brand.displayName}`,
    preheader: `Your ${opts.brand.displayName} sign-in code is ${opts.code}.`,
    brand: opts.brand,
    body: {
      heading: "Your sign-in code",
      paragraphs: [`Use this code to open ${opts.brand.displayName}.`],
      code: opts.code,
      signature: `This code expires in ${opts.expiresInMinutes} minutes. If you didn't request it, you can ignore this email.`,
    },
  };
  return renderBrandedEmail(renderOptions);
}
