import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CONTROLLED_ENV_KEYS = ["DATABASE_URL", "QUILLRA_ENCRYPTION_KEY"] as const;
const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let openDatabase: typeof import("../db/index.js")["rawSqlite"] | null = null;
let renderInviteEmail: typeof import("./email-templates.js")["renderInviteEmail"];
let renderLoginCodeEmail: typeof import("./email-templates.js")["renderLoginCodeEmail"];
let accessibleTextColor: typeof import("./email-template.js")["accessibleTextColor"];

const brand = {
  displayName: "Northstar Studio",
  logoUrl: "https://assets.example.test/northstar.png",
  accentColor: "#1746A2",
  tagline: "Make every word count.",
};

beforeAll(async () => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-email-template-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);

  ({ renderInviteEmail, renderLoginCodeEmail } = await import("./email-templates.js"));
  ({ accessibleTextColor } = await import("./email-template.js"));
  ({ rawSqlite: openDatabase } = await import("../db/index.js"));
});

afterAll(() => {
  openDatabase?.close();
  openDatabase = null;
  for (const key of CONTROLLED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe("branded invitation email", () => {
  it("keeps the branded invitation semantics aligned in HTML and plain text", () => {
    const result = renderInviteEmail({
      brand,
      inviterName: "Mina",
      role: "client",
      acceptUrl: "https://app.example.test/invites/accept?token=invite-1",
    });

    for (const output of [result.html, result.text]) {
      expect(output).toContain("Northstar Studio");
      expect(output).toContain("Mina invited you to Northstar Studio.");
      expect(output).toContain("Review and edit content in a focused workspace made for clients.");
      expect(output).toContain("Open workspace");
      expect(output).toContain("https://app.example.test/invites/accept?token=invite-1");
    }
    expect(result.html).toContain("Make every word count.");
    expect(result.html).toContain("border-top:4px solid #1746A2");
    expect(result.html).toContain("If the button does not work");
  });

  it.each([
    "https://assets.example.test/logo.svg?size=2&theme=night",
    "http://localhost:4173/logo.png",
  ])("renders an email-safe %s logo", (logoUrl) => {
    const { html } = renderInviteEmail({
      brand: { ...brand, logoUrl },
      role: "editor",
      acceptUrl: "https://app.example.test/invite",
    });

    expect(html).toContain(`src="${logoUrl.replace("&", "&amp;")}" alt="" width="52" height="52"`);
  });

  it.each([
    ["data:image/png;base64,PHNjcmlwdD4=", "data:image/png"],
    ["javascript:alert(document.domain)", "javascript:"],
  ])("falls back to a monogram for an unsafe %s logo", (logoUrl, unsafePrefix) => {
    const { html } = renderInviteEmail({
      brand: { ...brand, displayName: "Atlas", logoUrl },
      role: "editor",
      acceptUrl: "https://app.example.test/invite",
    });

    expect(html).not.toContain(`src="${unsafePrefix}`);
    expect(html).toContain(">A</td>");
  });

  it("escapes untrusted brand, tagline, and link values in HTML", () => {
    const { html, text } = renderInviteEmail({
      brand: {
        ...brand,
        displayName: `<script>alert('brand')</script> & Co.`,
        tagline: `Build <b>better</b> & "faster"`,
        logoUrl: "https://assets.example.test/logo.svg?x=<mark>&mode=wide",
      },
      inviterName: `<img src=x onerror="alert(1)">`,
      role: "client",
      acceptUrl: `https://app.example.test/invite?next=<admin>&label="open"`,
    });

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>better</b>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(&#39;brand&#39;)&lt;/script&gt; &amp; Co.");
    expect(html).toContain("Build &lt;b&gt;better&lt;/b&gt; &amp; &quot;faster&quot;");
    expect(html).toContain('src="https://assets.example.test/logo.svg?x=%3Cmark%3E&amp;mode=wide"');
    expect(html).toContain(
      'href="https://app.example.test/invite?next=&lt;admin&gt;&amp;label=&quot;open&quot;"',
    );
    expect(text).toContain(`<script>alert('brand')</script> & Co.`);
    expect(text).toContain(`https://app.example.test/invite?next=<admin>&label="open"`);
  });

  it("uses accessible button text for both light and dark brand accents", () => {
    expect(accessibleTextColor("#FFF36B")).toBe("#171717");
    expect(accessibleTextColor("#102040")).toBe("#ffffff");

    const light = renderInviteEmail({
      brand: { ...brand, accentColor: "#FFF36B" },
      role: "editor",
      acceptUrl: "https://app.example.test/invite/light",
    });
    const dark = renderInviteEmail({
      brand: { ...brand, accentColor: "#102040" },
      role: "editor",
      acceptUrl: "https://app.example.test/invite/dark",
    });

    expect(light.html).toContain("color:#171717;background:#FFF36B");
    expect(dark.html).toContain("color:#ffffff;background:#102040");
  });

  it("falls back to the Quillra accent when the configured color is invalid", () => {
    const { html } = renderInviteEmail({
      brand: { ...brand, accentColor: "url(javascript:alert(1))" },
      role: "editor",
      acceptUrl: "https://app.example.test/invite",
    });

    expect(html).toContain("border-top:4px solid #C1121F");
    expect(html).toContain("background:#C1121F");
    expect(html).not.toContain("url(javascript:alert(1))");
  });
});

describe("branded login-code email", () => {
  it("renders the project brand, code, and expiry consistently", () => {
    const result = renderLoginCodeEmail({
      brand,
      code: "482 917",
      expiresInMinutes: 15,
    });

    for (const output of [result.html, result.text]) {
      expect(output).toContain("Northstar Studio");
      expect(output).toContain("482 917");
      expect(output).toContain("This code expires in 15 minutes.");
      expect(output).toMatch(/If you (?:didn&#39;t|didn't) request it/);
    }
    expect(result.html).toContain("Make every word count.");
    expect(result.html).toContain("border-top:4px solid #1746A2");
  });
});
