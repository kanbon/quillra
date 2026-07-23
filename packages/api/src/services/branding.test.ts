import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const CONTROLLED_ENV_KEYS = [
  "DATABASE_URL",
  "QUILLRA_ENCRYPTION_KEY",
  "INSTANCE_NAME",
  "INSTANCE_LOGO_URL",
  "INSTANCE_ACCENT_COLOR",
  "INSTANCE_POWERED_BY",
] as const;
const originalEnv = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));

let tempDirectory: string;
let rawSqlite: typeof import("../db/index.js")["rawSqlite"];
let getProjectBrandContext: typeof import("./branding.js")["getProjectBrandContext"];
let normalizeBrandAccent: typeof import("./branding.js")["normalizeBrandAccent"];
let projectBrandForEmail: typeof import("./branding.js")["projectBrandForEmail"];

beforeAll(async () => {
  tempDirectory = mkdtempSync(path.join(tmpdir(), "quillra-branding-"));
  process.env.DATABASE_URL = `file:${path.join(tempDirectory, "cms.sqlite")}`;
  process.env.QUILLRA_ENCRYPTION_KEY = "a".repeat(64);
  process.env.INSTANCE_NAME = "Operator Brand";
  process.env.INSTANCE_LOGO_URL = "https://operator.example.test/logo.svg";
  process.env.INSTANCE_ACCENT_COLOR = "#556677";
  process.env.INSTANCE_POWERED_BY = "on";

  ({ getProjectBrandContext, normalizeBrandAccent, projectBrandForEmail } = await import(
    "./branding.js"
  ));
  ({ rawSqlite } = await import("../db/index.js"));
});

afterEach(() => {
  rawSqlite.prepare("DELETE FROM projects").run();
  rawSqlite.prepare("DELETE FROM project_groups").run();
});

afterAll(() => {
  rawSqlite.close();
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

describe("brand helpers", () => {
  it("normalizes valid hex colors and rejects unsafe or malformed accents", () => {
    expect(normalizeBrandAccent("  #a1b2c3  ")).toBe("#A1B2C3");
    expect(normalizeBrandAccent("#12345")).toBe("#C1121F");
    expect(normalizeBrandAccent("rgb(1, 2, 3)")).toBe("#C1121F");
    expect(normalizeBrandAccent("url(javascript:alert(1))")).toBe("#C1121F");
    expect(normalizeBrandAccent(null)).toBe("#C1121F");
  });

  it("turns an uploaded data-URI logo into an email-safe public URL", () => {
    const emailBrand = projectBrandForEmail(
      {
        displayName: "Northstar",
        logoUrl: "data:image/png;base64,iVBORw0KGgo=",
        accentColor: "#123456",
        tagline: null,
        poweredBy: null,
      },
      "project/unsafe",
      "https://edit.example.test",
    );

    expect(emailBrand.logoUrl).toBe(
      "https://edit.example.test/api/clients/branding/project%2Funsafe/logo",
    );
  });

  it("resolves project identity over the inherited group brand field by field", async () => {
    rawSqlite
      .prepare(
        `INSERT INTO project_groups
          (id, name, slug, brand_logo_url, brand_accent_color, brand_display_name, brand_tagline)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "group-1",
        "Internal group",
        "northstar",
        "https://assets.example.test/group-logo.svg",
        "#aabbcc",
        "Northstar Group",
        "Words that move people.",
      );
    rawSqlite
      .prepare(
        `INSERT INTO projects
          (id, name, github_repo_full_name, brand_display_name, brand_accent_color, group_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "project-1",
        "Internal project",
        "acme/project",
        "Northstar Campaign",
        "#102030",
        "group-1",
      );

    const context = await getProjectBrandContext("project-1", "editor.example.test");

    expect(context.brand).toMatchObject({
      displayName: "Northstar Campaign",
      logoUrl: "https://assets.example.test/group-logo.svg",
      accentColor: "#102030",
      tagline: "Words that move people.",
    });
    expect(context.inheritedBrand).toMatchObject({
      displayName: "Northstar Group",
      logoUrl: "https://assets.example.test/group-logo.svg",
      accentColor: "#AABBCC",
      tagline: "Words that move people.",
    });
  });
});
