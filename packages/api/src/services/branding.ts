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
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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

export type ProjectBrandContext = {
  brand: Brand;
  instanceBrand: Brand;
  /** The brand after removing project-level overrides. Used by settings
   * previews so "Use inherited value" is truthful before saving. */
  inheritedBrand: Brand;
};

/**
 * Most email clients reject data-URI images. Project uploads are stored that
 * way, so mail points at the public, project-scoped logo response instead.
 */
export function projectBrandForEmail(brand: Brand, projectId: string, publicOrigin: string): Brand {
  if (!brand.logoUrl?.startsWith("data:image/")) return brand;
  try {
    const logoUrl = new URL(
      `/api/clients/branding/${encodeURIComponent(projectId)}/logo`,
      publicOrigin,
    );
    return { ...brand, logoUrl: logoUrl.toString() };
  } catch {
    return { ...brand, logoUrl: null };
  }
}

export function normalizeBrandAccent(value: string | null | undefined): string {
  const candidate = value?.trim();
  return candidate && HEX_COLOR.test(candidate) ? candidate.toUpperCase() : QUILLRA_DEFAULT_ACCENT;
}

export function getInstanceBrand(referer: string | null = null): Brand {
  const instanceName = getInstanceSetting("INSTANCE_NAME")?.trim() || QUILLRA_DEFAULT_NAME;
  const instanceLogo = getInstanceSetting("INSTANCE_LOGO_URL")?.trim() || null;
  const instanceAccent = normalizeBrandAccent(getInstanceSetting("INSTANCE_ACCENT_COLOR"));
  return {
    displayName: instanceName,
    logoUrl: instanceLogo,
    accentColor: instanceAccent,
    tagline: null,
    poweredBy: poweredByLink(referer),
  };
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
  return (await getProjectBrandContext(projectId, referer)).brand;
}

export async function getProjectBrandContext(
  projectId: string,
  referer: string | null = null,
): Promise<ProjectBrandContext> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  const inst = getInstanceBrand(referer);
  if (!project) {
    return {
      brand: inst,
      instanceBrand: inst,
      inheritedBrand: inst,
    };
  }
  let group: typeof projectGroups.$inferSelect | undefined;
  if (project.groupId) {
    [group] = await db
      .select()
      .from(projectGroups)
      .where(eq(projectGroups.id, project.groupId))
      .limit(1);
  }
  const groupDisplayName = group?.brandDisplayName?.trim() || null;
  const groupLogoUrl = group?.brandLogoUrl?.trim() || null;
  const groupAccent = group?.brandAccentColor?.trim() || null;
  const inheritedBrand: Brand = {
    displayName: groupDisplayName || project.name || inst.displayName,
    logoUrl: groupLogoUrl || inst.logoUrl || null,
    accentColor: normalizeBrandAccent(groupAccent || inst.accentColor),
    tagline: group?.brandTagline?.trim() || null,
    poweredBy: inst.poweredBy,
  };
  const displayName = project.brandDisplayName?.trim() || inheritedBrand.displayName;
  const logoUrl = project.logoUrl?.trim() || inheritedBrand.logoUrl;
  const accentColor = normalizeBrandAccent(project.brandAccentColor || inheritedBrand.accentColor);
  const brand: Brand = {
    displayName,
    logoUrl,
    accentColor,
    tagline: inheritedBrand.tagline,
    poweredBy: inst.poweredBy,
  };
  return {
    brand,
    instanceBrand: inst,
    inheritedBrand,
  };
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
  const inst = getInstanceBrand(referer);
  const brand: Brand = {
    displayName: group.brandDisplayName?.trim() || group.name || inst.displayName,
    logoUrl: group.brandLogoUrl?.trim() || inst.logoUrl || null,
    accentColor: normalizeBrandAccent(group.brandAccentColor || inst.accentColor),
    tagline: group.brandTagline?.trim() || null,
    poweredBy: inst.poweredBy,
  };
  return { group, brand };
}
