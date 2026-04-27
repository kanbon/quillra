/**
 * Resolves the public-facing brand for a project: display name, logo,
 * accent color, and the optional "Powered by Quillra" attribution link.
 *
 * The shape mirrors what /api/clients/branding/:projectId returns. That
 * endpoint is intentionally public and cheap, it composes project /
 * group / instance / Quillra-default fields server-side via
 * services/branding.ts. We reuse it for the editor chrome so client-role
 * users see the same brand they saw on the sign-in page, without
 * teaching the editor about the inheritance rules.
 *
 * Defaults to a sensible fallback while loading or on error so
 * consumers never have to render a blank brand.
 */

import { apiJson } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

export type ProjectBrand = {
  id: string;
  displayName: string;
  logoUrl: string | null;
  accentColor: string;
  tagline: string | null;
  poweredBy: { label: string; href: string } | null;
};

type BrandResponse = {
  id: string;
  name: string;
  logoUrl: string | null;
  accentColor?: string | null;
  tagline?: string | null;
  poweredBy?: { label: string; href: string } | null;
};

const DEFAULT_ACCENT = "#C1121F";

export function useProjectBrand(projectId: string | undefined): {
  brand: ProjectBrand | null;
  isLoading: boolean;
} {
  const q = useQuery({
    queryKey: ["project-brand", projectId],
    enabled: Boolean(projectId),
    staleTime: 5 * 60 * 1000,
    queryFn: () => apiJson<BrandResponse>(`/api/clients/branding/${projectId}`),
  });

  const brand: ProjectBrand | null = q.data
    ? {
        id: q.data.id,
        displayName: q.data.name,
        logoUrl: q.data.logoUrl,
        accentColor: q.data.accentColor || DEFAULT_ACCENT,
        tagline: q.data.tagline ?? null,
        poweredBy: q.data.poweredBy ?? null,
      }
    : null;

  return { brand, isLoading: q.isLoading };
}
