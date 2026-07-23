import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { accessibleTextColor, isHexColor, normalizeHexColor } from "@/lib/brand";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { initialsOf } from "./types";

type Group = {
  id: string;
  name: string;
  slug: string;
  brandLogoUrl: string | null;
  brandAccentColor: string | null;
  brandDisplayName: string | null;
  brandTagline: string | null;
};

type BrandValue = {
  displayName: string;
  logoUrl: string | null;
  accentColor: string;
  tagline: string | null;
};

type ProjectBrandFields = {
  brandDisplayName: string | null;
  brandAccentColor: string | null;
  groupId: string | null;
};

type Props = {
  projectId: string;
  projectName: string;
  logoUrl: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  initial: ProjectBrandFields & {
    instanceBrand: BrandValue;
    inheritedBrand: BrandValue;
  };
};

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export function BrandingSection({
  projectId,
  projectName,
  logoUrl,
  isAdmin,
  isOwner,
  initial,
}: Props) {
  const { t } = useT();
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(initial.brandDisplayName ?? "");
  const [accent, setAccent] = useState(initial.brandAccentColor ?? "");
  const [groupId, setGroupId] = useState(initial.groupId ?? "");
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [preview, setPreview] = useState<"invite" | "login">("invite");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(initial.brandDisplayName ?? "");
    setAccent(initial.brandAccentColor ?? "");
    setGroupId(initial.groupId ?? "");
    setPendingLogo(null);
    setRemoveLogo(false);
  }, [initial.brandDisplayName, initial.brandAccentColor, initial.groupId]);

  const pendingLogoUrl = useMemo(
    () => (pendingLogo ? URL.createObjectURL(pendingLogo) : null),
    [pendingLogo],
  );
  useEffect(
    () => () => {
      if (pendingLogoUrl) URL.revokeObjectURL(pendingLogoUrl);
    },
    [pendingLogoUrl],
  );

  const groupsQ = useQuery({
    queryKey: ["admin-groups"],
    enabled: isOwner,
    queryFn: () => apiJson<{ groups: Group[] }>("/api/admin/groups"),
  });
  const selectedGroup = (groupsQ.data?.groups ?? []).find((group) => group.id === groupId);
  const groupChanged = groupId !== (initial.groupId ?? "");
  const inherited: BrandValue = groupChanged
    ? {
        displayName: selectedGroup?.brandDisplayName?.trim() || projectName,
        logoUrl: selectedGroup?.brandLogoUrl?.trim() || initial.instanceBrand.logoUrl,
        accentColor: selectedGroup?.brandAccentColor?.trim() || initial.instanceBrand.accentColor,
        tagline: selectedGroup?.brandTagline?.trim() || null,
      }
    : initial.inheritedBrand;

  const effectiveName = displayName.trim() || inherited.displayName || projectName;
  const effectiveAccent = normalizeHexColor(isHexColor(accent) ? accent : inherited.accentColor);
  const effectiveLogo =
    pendingLogoUrl ?? (!removeLogo && logoUrl ? logoUrl : inherited.logoUrl || null);
  const effectiveTagline = inherited.tagline;
  const buttonText = accessibleTextColor(effectiveAccent);

  const dirty =
    displayName !== (initial.brandDisplayName ?? "") ||
    accent !== (initial.brandAccentColor ?? "") ||
    groupId !== (initial.groupId ?? "") ||
    Boolean(pendingLogo) ||
    removeLogo;

  const saveBrand = useMutation({
    mutationFn: async () => {
      const trimmedAccent = accent.trim();
      if (trimmedAccent && !isHexColor(trimmedAccent)) {
        throw new Error(t("projectSettings.brandStudio.invalidAccent"));
      }

      let logoChanged = false;
      try {
        if (pendingLogo) {
          const body = new FormData();
          body.append("file", pendingLogo);
          const response = await fetch(`/api/projects/${projectId}/logo`, {
            method: "POST",
            body,
            credentials: "include",
          });
          if (!response.ok) {
            const error = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(
              error?.error ||
                t("projectSettings.brandStudio.uploadFailed", { status: response.status }),
            );
          }
          logoChanged = true;
        } else if (removeLogo && logoUrl) {
          await apiJson(`/api/projects/${projectId}/logo`, { method: "DELETE" });
          logoChanged = true;
        }

        await apiJson(`/api/projects/${projectId}`, {
          method: "PATCH",
          body: JSON.stringify({
            brandDisplayName: displayName.trim() || null,
            brandAccentColor: trimmedAccent || null,
            groupId: isOwner ? groupId || null : initial.groupId,
          } satisfies ProjectBrandFields),
        });
      } catch (error) {
        if (logoChanged) {
          try {
            await apiJson(`/api/projects/${projectId}`, {
              method: "PATCH",
              body: JSON.stringify({ logoUrl }),
            });
          } catch {
            throw new Error(t("projectSettings.brandStudio.partialSave"));
          }
        }
        throw error;
      }
    },
    onMutate: () => {
      setFieldError(null);
      setFeedback(null);
    },
    onSuccess: async () => {
      setFeedback(t("projectSettings.brandStudio.saveSuccess"));
      setPendingLogo(null);
      setRemoveLogo(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["project", projectId] }),
        qc.invalidateQueries({ queryKey: ["project-brand", projectId] }),
        qc.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
    onError: (error: Error) => {
      setFieldError(error.message);
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
      void qc.invalidateQueries({ queryKey: ["project-brand", projectId] });
    },
  });

  function chooseLogo(file: File | undefined) {
    setFieldError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setFieldError(t("projectSettings.brandStudio.imageOnly"));
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setFieldError(t("projectSettings.brandStudio.logoTooLarge"));
      return;
    }
    setPendingLogo(file);
    setRemoveLogo(false);
    setFeedback(null);
  }

  const nameSource = displayName.trim()
    ? t("projectSettings.brandStudio.projectOverride")
    : selectedGroup?.brandDisplayName
      ? selectedGroup.name
      : t("projectSettings.brandStudio.inherited");
  const accentSource = accent.trim()
    ? t("projectSettings.brandStudio.projectOverride")
    : selectedGroup?.brandAccentColor
      ? selectedGroup.name
      : t("projectSettings.brandStudio.inherited");

  return (
    <section
      aria-labelledby="brand-studio-title"
      className="overflow-hidden rounded-[24px] border border-neutral-200 bg-white shadow-[0_18px_55px_-35px_rgba(25,25,24,0.45)]"
    >
      <header className="relative overflow-hidden bg-[#191918] px-5 py-6 text-white sm:px-7 sm:py-7">
        <div
          aria-hidden
          className="absolute -right-8 -top-16 h-44 w-44 rounded-full border-[28px] opacity-40"
          style={{ borderColor: effectiveAccent }}
        />
        <div className="relative max-w-2xl">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-white/55">
            {t("projectSettings.brandStudio.eyebrow")}
          </p>
          <h2
            id="brand-studio-title"
            className="text-[24px] font-semibold tracking-[-0.03em] sm:text-[28px]"
          >
            {t("projectSettings.brandStudio.title")}
          </h2>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-white/65 sm:text-sm">
            {t("projectSettings.brandStudio.description")}
          </p>
        </div>
      </header>

      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.08fr)_minmax(320px,0.92fr)]">
        <form
          className="min-w-0 space-y-6 p-5 sm:p-7"
          onSubmit={(event) => {
            event.preventDefault();
            saveBrand.mutate();
          }}
        >
          <fieldset disabled={!isAdmin || saveBrand.isPending} className="space-y-6">
            <legend className="sr-only">{t("projectSettings.brandStudio.legend")}</legend>

            <div>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <p className="text-[12px] font-bold uppercase tracking-[0.13em] text-neutral-500">
                  {t("projectSettings.brandStudio.logo")}
                </p>
                <span className="text-[11px] text-neutral-400">
                  {t("projectSettings.brandStudio.logoFileHint")}
                </span>
              </div>
              <div className="flex items-center gap-4 rounded-2xl border border-neutral-200 bg-neutral-50/70 p-3">
                <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
                  {effectiveLogo ? (
                    <img
                      src={effectiveLogo}
                      alt={t("projectSettings.brandStudio.logoPreviewAlt", {
                        name: effectiveName,
                      })}
                      className="h-full w-full object-contain p-1.5"
                    />
                  ) : (
                    <span className="text-xl font-bold text-neutral-400">
                      {initialsOf(effectiveName)}
                    </span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-neutral-900">
                    {pendingLogo?.name ||
                      (logoUrl && !removeLogo
                        ? t("projectSettings.brandStudio.projectLogo")
                        : t("projectSettings.brandStudio.inheritedLogo"))}
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    {t("projectSettings.brandStudio.logoBest")}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <label className="inline-flex min-h-9 cursor-pointer items-center rounded-lg border border-neutral-300 bg-white px-3 text-xs font-semibold text-neutral-700 shadow-sm transition hover:border-neutral-400 hover:bg-neutral-50 focus-within:ring-2 focus-within:ring-neutral-900 focus-within:ring-offset-2">
                      {effectiveLogo
                        ? t("projectSettings.brandStudio.replace")
                        : t("projectSettings.brandStudio.chooseLogo")}
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(event) => {
                          chooseLogo(event.target.files?.[0]);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    {(logoUrl || pendingLogo) && !removeLogo && (
                      <button
                        type="button"
                        className="min-h-9 rounded-lg px-3 text-xs font-semibold text-neutral-500 transition hover:bg-white hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900"
                        onClick={() => {
                          setPendingLogo(null);
                          setRemoveLogo(Boolean(logoUrl));
                        }}
                      >
                        {t("projectSettings.brandStudio.useInherited")}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label
                  htmlFor="brand-display-name"
                  className="text-[12px] font-bold uppercase tracking-[0.13em] text-neutral-500"
                >
                  {t("projectSettings.brandStudio.clientName")}
                </label>
                <SourceBadge label={nameSource} />
              </div>
              <Input
                id="brand-display-name"
                value={displayName}
                placeholder={inherited.displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                  setFeedback(null);
                }}
              />
              <div className="mt-1.5 flex items-start justify-between gap-3">
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  {t("projectSettings.brandStudio.clientNameHelp")}
                </p>
                {displayName && (
                  <button
                    type="button"
                    className="shrink-0 text-[11px] font-semibold text-neutral-500 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900"
                    onClick={() => setDisplayName("")}
                  >
                    {t("projectSettings.brandStudio.inherit")}
                  </button>
                )}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label
                  htmlFor="brand-accent"
                  className="text-[12px] font-bold uppercase tracking-[0.13em] text-neutral-500"
                >
                  {t("projectSettings.brandStudio.accent")}
                </label>
                <SourceBadge label={accentSource} />
              </div>
              <div className="grid grid-cols-[48px_minmax(0,1fr)] gap-2">
                <label
                  className="relative flex h-10 cursor-pointer items-center justify-center overflow-hidden rounded-lg border border-neutral-300 bg-white focus-within:ring-2 focus-within:ring-neutral-900 focus-within:ring-offset-2"
                  style={{ backgroundColor: effectiveAccent }}
                  title={t("projectSettings.brandStudio.chooseAccent")}
                >
                  <span className="sr-only">{t("projectSettings.brandStudio.chooseAccent")}</span>
                  <input
                    type="color"
                    value={effectiveAccent}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                    onChange={(event) => {
                      setAccent(event.target.value.toUpperCase());
                      setFeedback(null);
                    }}
                  />
                </label>
                <Input
                  id="brand-accent"
                  value={accent}
                  placeholder={inherited.accentColor}
                  className="font-mono uppercase"
                  aria-invalid={Boolean(fieldError && accent && !isHexColor(accent))}
                  onChange={(event) => {
                    setAccent(event.target.value);
                    setFieldError(null);
                    setFeedback(null);
                  }}
                />
              </div>
              <div className="mt-1.5 flex items-start justify-between gap-3">
                <p className="text-[11px] leading-relaxed text-neutral-500">
                  {t("projectSettings.brandStudio.accentHelp")}
                </p>
                {accent && (
                  <button
                    type="button"
                    className="shrink-0 text-[11px] font-semibold text-neutral-500 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900"
                    onClick={() => {
                      setAccent("");
                      setFieldError(null);
                    }}
                  >
                    {t("projectSettings.brandStudio.inherit")}
                  </button>
                )}
              </div>
            </div>

            {isOwner && (
              <div>
                <label
                  htmlFor="brand-group"
                  className="mb-1.5 block text-[12px] font-bold uppercase tracking-[0.13em] text-neutral-500"
                >
                  {t("projectSettings.brandStudio.group")}
                </label>
                <select
                  id="brand-group"
                  value={groupId}
                  onChange={(event) => {
                    setGroupId(event.target.value);
                    setFeedback(null);
                  }}
                  className="h-10 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-900 outline-none transition focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/10"
                >
                  <option value="">{t("projectSettings.brandStudio.noGroup")}</option>
                  {(groupsQ.data?.groups ?? []).map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] text-neutral-500">
                  {t("projectSettings.brandStudio.groupHelp")}
                </p>
                {groupsQ.isError && (
                  <p className="mt-1 text-[11px] text-red-600">
                    {t("projectSettings.brandStudio.groupLoadError")}
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <div className="border-t border-neutral-200 pt-5">
            <output aria-live="polite" className="mb-3 block min-h-5 text-[12px] text-neutral-500">
              {fieldError ? <span className="text-red-600">{fieldError}</span> : feedback}
            </output>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[11px] leading-relaxed text-neutral-400">
                {t("projectSettings.brandStudio.operatorFooter")}
              </p>
              {isAdmin && (
                <Button type="submit" disabled={!dirty || saveBrand.isPending} className="min-w-28">
                  {saveBrand.isPending
                    ? t("projectSettings.brandStudio.saving")
                    : t("projectSettings.brandStudio.save")}
                </Button>
              )}
            </div>
          </div>
        </form>

        <div className="min-w-0 border-t border-neutral-200 bg-[#f3f0e9] p-5 sm:p-7 lg:border-l lg:border-t-0">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-neutral-500">
                {t("projectSettings.brandStudio.touchpoints")}
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {t("projectSettings.brandStudio.livePreview")}
              </p>
            </div>
            <fieldset className="flex rounded-lg border border-neutral-300/80 bg-white/70 p-1">
              <legend className="sr-only">{t("projectSettings.brandStudio.previewGroup")}</legend>
              {(["invite", "login"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={preview === mode}
                  className={`min-h-8 rounded-md px-2.5 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 ${
                    preview === mode
                      ? "bg-neutral-900 text-white shadow-sm"
                      : "text-neutral-500 hover:text-neutral-900"
                  }`}
                  onClick={() => setPreview(mode)}
                >
                  {mode === "invite"
                    ? t("projectSettings.brandStudio.invite")
                    : t("projectSettings.brandStudio.signIn")}
                </button>
              ))}
            </fieldset>
          </div>

          <div className="relative mx-auto max-w-[390px] py-4 sm:py-7 lg:sticky lg:top-6">
            <div
              aria-hidden
              className="absolute inset-x-4 bottom-0 top-8 rotate-[1.5deg] rounded-[22px] border border-neutral-300/60 bg-[#e8e4dc]"
            />
            <div
              aria-label={`${t(
                preview === "invite"
                  ? "projectSettings.brandStudio.invitationEmail"
                  : "projectSettings.brandStudio.clientSignIn",
              )}: ${effectiveName}`}
              className="relative overflow-hidden rounded-[20px] border border-neutral-200 bg-white shadow-[0_22px_45px_-22px_rgba(25,25,24,0.4)]"
              style={{ borderTop: `4px solid ${effectiveAccent}` }}
            >
              <div className="flex items-center gap-3 border-b border-neutral-100 px-5 py-4">
                <BrandMark logoUrl={effectiveLogo} name={effectiveName} accent={effectiveAccent} />
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-bold text-neutral-900">{effectiveName}</p>
                  {effectiveTagline && (
                    <p className="truncate text-[10px] text-neutral-500">{effectiveTagline}</p>
                  )}
                </div>
              </div>

              {preview === "invite" ? (
                <div className="px-5 py-6">
                  <p className="text-[19px] font-bold tracking-[-0.025em] text-neutral-900">
                    {t("projectSettings.brandStudio.invitedTitle")}
                  </p>
                  <p className="mt-2 text-[12px] leading-relaxed text-neutral-500">
                    {t("projectSettings.brandStudio.invitedCopy", { name: effectiveName })}
                  </p>
                  <div
                    className="mt-5 inline-flex min-h-10 items-center rounded-lg px-4 text-[12px] font-bold shadow-sm"
                    style={{ backgroundColor: effectiveAccent, color: buttonText }}
                  >
                    {t("projectSettings.brandStudio.openWorkspace")}
                  </div>
                  <div className="mt-6 border-t border-neutral-100 pt-4">
                    <p className="text-[9px] leading-relaxed text-neutral-400">
                      {t("projectSettings.brandStudio.emailFooter")}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="px-5 py-6 text-center">
                  <p className="text-[19px] font-bold tracking-[-0.025em] text-neutral-900">
                    {t("projectSettings.brandStudio.welcomeBack")}
                  </p>
                  <p className="mt-2 text-[11px] text-neutral-500">
                    {t("projectSettings.brandStudio.loginCopy")}
                  </p>
                  <div className="mt-5 h-10 rounded-lg border border-neutral-200 bg-neutral-50 px-3 text-left text-[11px] leading-10 text-neutral-400">
                    {t("projectSettings.brandStudio.emailPlaceholder")}
                  </div>
                  <div
                    className="mt-2 flex min-h-10 items-center justify-center rounded-lg px-4 text-[12px] font-bold shadow-sm"
                    style={{ backgroundColor: effectiveAccent, color: buttonText }}
                  >
                    {t("projectSettings.brandStudio.sendCode")}
                  </div>
                  <p className="mt-5 text-[9px] text-neutral-400">
                    {t("projectSettings.brandStudio.secureAccess")}
                  </p>
                </div>
              )}
            </div>
            <p className="relative mt-4 text-center text-[10px] leading-relaxed text-neutral-500">
              {t("projectSettings.brandStudio.precedence")}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function SourceBadge({ label }: { label: string }) {
  return (
    <span className="max-w-[150px] truncate rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[10px] font-semibold text-neutral-500">
      {label}
    </span>
  );
}

function BrandMark({
  logoUrl,
  name,
  accent,
}: {
  logoUrl: string | null;
  name: string;
  accent: string;
}) {
  return (
    <div
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-neutral-200 bg-white text-sm font-bold shadow-sm"
      style={{ color: accessibleTextColor(accent), backgroundColor: logoUrl ? "#ffffff" : accent }}
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" className="h-full w-full object-contain p-1" />
      ) : (
        initialsOf(name)
      )}
    </div>
  );
}
