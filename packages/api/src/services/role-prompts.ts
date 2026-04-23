/**
 * Operator-editable behavior guidance for each project role.
 *
 * The tool allow-list in agent-permissions.ts is the security boundary; this
 * file and its companion DB table hold the plain-English prompt fragment
 * that shapes how the agent talks to a user with that role. Owners edit the
 * rows from Instance Settings. If a row is missing we fall back to the
 * defaults below.
 *
 * Keep every default small and plain. These strings ship in the product and
 * end up in the agent's system prompt for every chat turn.
 */
import { eq } from "drizzle-orm";
import { rolePermissionPrompts } from "../db/app-schema.js";
import { db } from "../db/index.js";

export type RoleName = "admin" | "editor" | "client";

export const ROLE_NAMES: RoleName[] = ["admin", "editor", "client"];

export const DEFAULT_ROLE_PROMPTS: Record<RoleName, string> = {
  admin: [
    "This user is an administrator with full access to the project.",
    "Be direct and efficient. You can skip basic explanations.",
    "You may edit any file in the repo, including config and build files.",
    "Unusual or destructive changes (deleting pages, rewriting layouts, bumping frameworks) are fair game; confirm first only when the outcome is ambiguous.",
  ].join("\n"),

  editor: [
    "This user is a team member who knows the site but is not a developer.",
    "Edit content, copy, and layout freely. Match the existing style.",
    "Ask before touching build config, dependencies, or anything under a config file (astro.config, next.config, vite.config, package.json).",
    "If the user asks for something that needs developer work (new framework, new build tool, infrastructure), say so plainly and suggest they bring it to their developer.",
  ].join("\n"),

  client: [
    "This user is the site owner and is not technical at all.",
    "Use plain, friendly language. Never mention file paths, code, frameworks, or internal tools.",
    "Stick to the visible surface of the site: headlines, paragraphs, images, menu items, section ordering, colours if the theme supports it.",
    "Do not touch layout structure, page routing, or anything that requires writing code.",
    "Before you publish, confirm with a short summary of what you changed so they can approve it.",
    "If they ask for something that would need a developer (new feature, new page type, integrations), say so kindly and offer to pass it on.",
  ].join("\n"),
};

/**
 * Look up the stored prompt for a role. Returns the default when no row
 * exists, so callers never have to reason about the seed state.
 */
export async function getRolePrompt(role: RoleName): Promise<string> {
  const row = await db
    .select()
    .from(rolePermissionPrompts)
    .where(eq(rolePermissionPrompts.role, role))
    .limit(1)
    .then((rows) => rows[0]);
  return row?.prompt ?? DEFAULT_ROLE_PROMPTS[role];
}

/**
 * Return every role with its currently effective prompt and whether the
 * value has been customized away from the default. Used by the settings UI.
 */
export async function listRolePrompts(): Promise<
  {
    role: RoleName;
    prompt: string;
    isCustom: boolean;
    defaultPrompt: string;
    updatedAt: number | null;
  }[]
> {
  const rows = await db.select().from(rolePermissionPrompts);
  const byRole = new Map(rows.map((r) => [r.role as RoleName, r]));
  return ROLE_NAMES.map((role) => {
    const row = byRole.get(role);
    const defaultPrompt = DEFAULT_ROLE_PROMPTS[role];
    return {
      role,
      prompt: row?.prompt ?? defaultPrompt,
      isCustom: Boolean(row && row.prompt !== defaultPrompt),
      defaultPrompt,
      updatedAt: row ? row.updatedAt.getTime() : null,
    };
  });
}

/**
 * Write a custom prompt for a role. Empty strings and whitespace-only
 * values are rejected so the agent never runs with an empty guidance block.
 */
export async function setRolePrompt(role: RoleName, prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("Prompt must not be empty.");
  const now = new Date();
  await db
    .insert(rolePermissionPrompts)
    .values({ role, prompt: trimmed, updatedAt: now })
    .onConflictDoUpdate({
      target: rolePermissionPrompts.role,
      set: { prompt: trimmed, updatedAt: now },
    });
}

/**
 * Reset a role to the built-in default by deleting its custom row. Safe
 * to call when no custom row exists.
 */
export async function resetRolePrompt(role: RoleName): Promise<string> {
  await db.delete(rolePermissionPrompts).where(eq(rolePermissionPrompts.role, role));
  return DEFAULT_ROLE_PROMPTS[role];
}
