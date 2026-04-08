import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/atoms/Button";
import { Input } from "@/components/atoms/Input";
import { Textarea } from "@/components/atoms/Textarea";
import { GitHubRepoBranchFields } from "@/components/organisms/GitHubRepoBranchFields";
import { apiJson } from "@/lib/api";
import { parseRepoFullName, repoSlugDisplay, selectLikeInputClassName } from "@/lib/github";
import { useT } from "@/i18n/i18n";

const schema = z.object({
  name: z.string().min(1, "Name required"),
  githubRepoFullName: z
    .string()
    .min(3)
    .regex(/^[\w.-]+\/[\w.-]+$/, "Format: owner/repo"),
  defaultBranch: z.string().min(1),
  previewDevCommand: z.string().max(2000).optional(),
});

type Form = z.infer<typeof schema>;

type Props = { onCreated: () => void };

export function ConnectProjectForm({ onCreated }: Props) {
  const { t } = useT();
  const [preferManualGit, setPreferManualGit] = useState(false);
  const [displayNameMode, setDisplayNameMode] = useState<"repo" | "full" | "custom">("repo");
  const seededRepo = useRef(false);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", githubRepoFullName: "", defaultBranch: "main", previewDevCommand: "" },
  });

  const repoFull = watch("githubRepoFullName");
  const branch = watch("defaultBranch");
  const nameVal = watch("name");

  const reposQ = useQuery({
    queryKey: ["github-repos"],
    queryFn: () => apiJson<{ repos: { fullName: string; defaultBranch: string }[] }>("/api/github/repos"),
    retry: false,
  });

  useEffect(() => {
    if (seededRepo.current || !reposQ.isSuccess || preferManualGit) return;
    const list = reposQ.data.repos;
    if (!list.length || repoFull) return;
    seededRepo.current = true;
    const first = list[0];
    setValue("githubRepoFullName", first.fullName);
    setValue("defaultBranch", first.defaultBranch);
    if (displayNameMode === "repo") {
      setValue("name", repoSlugDisplay(first.fullName));
    }
  }, [reposQ.isSuccess, reposQ.data, repoFull, setValue, preferManualGit, displayNameMode]);

  useEffect(() => {
    if (displayNameMode === "custom") return;
    const p = parseRepoFullName(repoFull);
    if (!p) return;
    if (displayNameMode === "repo") {
      setValue("name", p.repo);
    } else {
      setValue("name", `${p.owner} / ${p.repo}`);
    }
  }, [repoFull, displayNameMode, setValue]);

  const slug = repoFull ? repoSlugDisplay(repoFull) : "…";
  const fullPretty = repoFull ? repoFull.replace("/", " / ") : "…";

  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={handleSubmit(async (values) => {
        await apiJson("/api/projects", {
          method: "POST",
          body: JSON.stringify({
            ...values,
            previewDevCommand: values.previewDevCommand?.trim() || null,
          }),
        });
        reset();
        seededRepo.current = false;
        setPreferManualGit(false);
        setDisplayNameMode("repo");
        onCreated();
      })}
    >
      <div className="sm:col-span-2">
        <GitHubRepoBranchFields
          repoFullName={repoFull}
          branch={branch}
          disabled={isSubmitting}
          preferManual={preferManualGit}
          setPreferManual={setPreferManualGit}
          onRepoChange={(full, dbHint) => {
            setValue("githubRepoFullName", full, { shouldValidate: true });
            setValue("defaultBranch", dbHint, { shouldValidate: true });
          }}
          onBranchChange={(b) => setValue("defaultBranch", b, { shouldValidate: true })}
        />
      </div>

      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs font-medium text-neutral-600">{t("connectForm.displayName")}</label>
        <select
          className={selectLikeInputClassName()}
          value={displayNameMode}
          disabled={isSubmitting}
          onChange={(e) => setDisplayNameMode(e.target.value as "repo" | "full" | "custom")}
        >
          <option value="repo">{t("connectForm.useRepoName", { slug })}</option>
          <option value="full">{t("connectForm.useOwnerRepo", { fullPretty })}</option>
          <option value="custom">{t("connectForm.custom")}</option>
        </select>
      </div>
      <div className="sm:col-span-1">
        <label className="mb-1 block text-xs font-medium text-neutral-600">
          {displayNameMode === "custom" ? t("connectForm.customName") : t("connectForm.shownInApp")}
        </label>
        {displayNameMode === "custom" ? (
          <>
            <Input placeholder={t("connectForm.clientHomepage")} {...register("name")} />
            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
          </>
        ) : (
          <p className="flex min-h-[42px] items-center rounded-md border border-neutral-200 bg-neutral-50 px-3 text-sm text-neutral-800">
            {nameVal || "—"}
          </p>
        )}
      </div>

      {(errors.githubRepoFullName || errors.defaultBranch) && (
        <div className="sm:col-span-2 text-xs text-red-600">
          {errors.githubRepoFullName?.message ?? errors.defaultBranch?.message}
        </div>
      )}

      <div className="sm:col-span-2">
        <label className="mb-1 block text-xs font-medium text-neutral-600">
          {t("connectForm.devCommandLabel")}
        </label>
        <Textarea
          rows={2}
          placeholder={t("connectForm.devCommandPlaceholder")}
          className="font-mono text-xs"
          {...register("previewDevCommand")}
        />
        <p className="mt-1 text-xs text-neutral-500">
          {t("connectForm.devCommandHelp", { portCode: "{port}" })}
        </p>
      </div>
      <div className="flex items-end sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t("connectForm.connecting") : t("connectForm.connect")}
        </Button>
      </div>
    </form>
  );
}
