/**
 * White-label branding resolver.
 *
 * Every client-facing surface (the per-project login page, the editor
 * chrome shown to client-role users, and the upcoming portal) needs to
 * answer one question: "what brand should this person see?"
 *
 * The resolver layers four sources, more specific wins:
 *
 *   project (logoUrl, brandDisplayName, brandAccentColor)
 *      \-> group (brandLogoUrl, brandDisplayName, brandAccentColor)
 *           \-> instance (INSTANCE_NAME, INSTANCE_LOGO_URL, INSTANCE_ACCENT_COLOR)
 *                \-> Quillra default
 *
 * `displayName` falls through field by field, so a project with only a
 * custom logo still picks up the group's display name, and so on.
 *
 * The `poweredBy` field is what the UI renders as the subtle footer
 * link. It points at quillra.com with a `ref=` query param so we can
 * see traffic from white-labeled instances. Operators on the managed
 * SaaS can hide it via `INSTANCE_POWERED_BY` = "off"; self-hosted
 * installs always show it because that's the deal with the FSL license.
 */

import { eq } from "drizzle-orm";
import { projectGroups, projects } from "../db/app-schema.js";
import { db } from "../db/index.js";
import { getInstanceSetting } from "./instance-settings.js";

const QUILLRA_DEFAULT_NAME = "Quillra";
const QUILLRA_DEFAULT_ACCENT = "#C1121F";

export type Brand = {
  /** Display name shown in headers, login page, and email subjects. */
  displayName: string;
  /** Optional logo URL. NULL falls back to a text-only header. */
  logoUrl: string | null;
  /** CSS hex (e.g. "#0A66C2"). Applied as a CSS variable on client surfaces. */
  accentColor: string;
  /** Optional one-line tagline shown under the logo on the portal page. */
  tagline: string | null;
  /** Subtle "Powered by Quillra" link target, or null when the operator
   *  has explicitly disabled it. */
  poweredBy: { label: string; href: string } | null;
};

function instanceBrand(): Pick<Brand, "displayName" | "logoUrl" | "accentColor"> {
  const instanceName = getInstanceSetting("INSTANCE_NAME")?.trim() || QUILLRA_DEFAULT_NAME;
  const instanceLogo = getInstanceSetting("INSTANCE_LOGO_URL")?.trim() || null;
  const instanceAccent =
    getInstanceSetting("INSTANCE_ACCENT_COLOR")?.trim() || QUILLRA_DEFAULT_ACCENT;
  return { displayName: instanceName, logoUrl: instanceLogo, accentColor: instanceAccent };
}

function poweredByLink(referer: string | null): Brand["poweredBy"] {
  const setting = getInstanceSetting("INSTANCE_POWERED_BY")?.trim().toLowerCase();
  if (setting === "off") return null;
  const params = new URLSearchParams();
  if (referer) params.set("ref", referer);
  const qs = params.toString();
  return {
    label: "Powered by Quillra",
    href: `https://www.quillra.com/${qs ? `?${qs}` : ""}`,
  };
}

/**
 * Resolve the brand for a single project. Used by the client login page
 * and the editor chrome when a client-role user is viewing.
 *
 * `referer` is the operator's public hostname (e.g. "edit.acme.com") so
 * the Powered-by link carries traffic attribution back. Pass null when
 * unknown.
 */
export async function getProjectBrand(
  projectId: string,
  referer: string | null = null,
): Promise<Brand> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const inst = instanceBrand();
  if (!project) {
    return { ...inst, tagline: null, poweredBy: poweredByLink(referer) };
  }
  let group: typeof projectGroups.$inferSelect | undefined;
  if (project.groupId) {
    [group] = await db
      .select()
      .from(projectGroups)
      .where(eq(projectGroups.id, project.groupId))
      .limit(1);
  }
  const displayName =
    project.brandDisplayName?.trim() ||
    group?.brandDisplayName?.trim() ||
    project.name ||
    inst.displayName;
  const logoUrl = project.logoUrl?.trim() || group?.brandLogoUrl?.trim() || inst.logoUrl || null;
  const accentColor =
    project.brandAccentColor?.trim() ||
    group?.brandAccentColor?.trim() ||
    inst.accentColor ||
    QUILLRA_DEFAULT_ACCENT;
  const tagline = group?.brandTagline?.trim() || null;
  return { displayName, logoUrl, accentColor, tagline, poweredBy: poweredByLink(referer) };
}

/**
 * Resolve the brand for a group as a whole (for the customer portal
 * landing page). Falls through to the instance brand for any field the
 * group hasn't explicitly set.
 */
export async function getGroupBrand(
  groupSlug: string,
  referer: string | null = null,
): Promise<{ group: typeof projectGroups.$inferSelect; brand: Brand } | null> {
  const [group] = await db
    .select()
    .from(projectGroups)
    .where(eq(projectGroups.slug, groupSlug))
    .limit(1);
  if (!group) return null;
  const inst = instanceBrand();
  const brand: Brand = {
    displayName: group.brandDisplayName?.trim() || group.name || inst.displayName,
    logoUrl: group.brandLogoUrl?.trim() || inst.logoUrl || null,
    accentColor: group.brandAccentColor?.trim() || inst.accentColor,
    tagline: group.brandTagline?.trim() || null,
    poweredBy: poweredByLink(referer),
  };
  return { group, brand };
}
