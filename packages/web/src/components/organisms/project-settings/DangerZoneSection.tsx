/**
 * Admin-only danger zone: single red-bordered card with the delete
 * button, plus the confirm modal that requires typing the project
 * name before enabling the final destructive action. On success the
 * project list is invalidated and the user is redirected to the
 * dashboard.
 *
 * Extracted out of packages/web/src/pages/ProjectSettings.tsx. Logic
 * and markup were moved verbatim, no behaviour change.
 */

import { Input } from "@/components/atoms/Input";
import { Modal } from "@/components/atoms/Modal";
import { useT } from "@/i18n/i18n";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

type Props = {
  projectId: string;
  projectName: string;
};

export function DangerZoneSection({ projectId, projectName }: Props) {
  const { t } = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const id = projectId;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const deleteProject = useMutation({
    mutationFn: () => apiJson(`/api/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      nav("/dashboard", { replace: true });
    },
  });

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-red-200 bg-red-50/40 shadow-sm">
        <header className="border-b border-red-200 bg-red-50/60 px-6 py-4">
          <h2 className="text-[15px] font-semibold tracking-tight text-red-900">
            {t("projectSettings.dangerZone")}
          </h2>
          <p className="mt-0.5 text-[13px] text-red-800/80">
            {t("projectSettings.dangerZoneDescription")}
          </p>
        </header>
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-red-900">
                {t("projectSettings.deleteProject")}
              </p>
              <p className="mt-1 text-[13px] text-red-800/80">
                {t("projectSettings.deleteProjectDescription")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setDeleteConfirm("");
                setDeleteOpen(true);
              }}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3.5 text-[13px] font-semibold text-red-700 transition-colors hover:bg-red-50"
            >
              {t("projectSettings.deleteButton")}
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirmation modal */}
      <Modal
        open={deleteOpen}
        onClose={() => !deleteProject.isPending && setDeleteOpen(false)}
        className="max-w-md"
      >
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-600">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-[17px] font-semibold tracking-tight text-neutral-900">
              {t("projectSettings.deleteModalTitle")}
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-neutral-600">
              {t("projectSettings.deleteModalBody")}
            </p>
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
            {t("projectSettings.deleteConfirmLabel")}{" "}
            <code className="rounded bg-neutral-100 px-1 font-mono text-[11px] text-neutral-700">
              {projectName}
            </code>
          </label>
          <Input
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            placeholder={projectName}
            disabled={deleteProject.isPending}
            autoFocus
          />
        </div>
        {deleteProject.isError && (
          <p className="mt-2 text-sm text-red-600">
            {(deleteProject.error as Error)?.message ?? t("projectSettings.deleteFailed")}
          </p>
        )}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => !deleteProject.isPending && setDeleteOpen(false)}
            disabled={deleteProject.isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => deleteProject.mutate()}
            disabled={
              deleteProject.isPending ||
              deleteConfirm.trim().toLowerCase() !== projectName.trim().toLowerCase()
            }
            className={cn(
              "inline-flex h-10 items-center gap-1.5 rounded-lg bg-red-600 px-4 text-[13px] font-semibold text-white shadow-sm transition-all",
              deleteProject.isPending ||
                deleteConfirm.trim().toLowerCase() !== projectName.trim().toLowerCase()
                ? "cursor-not-allowed opacity-50"
                : "hover:bg-red-700 hover:shadow",
            )}
          >
            {deleteProject.isPending ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                {t("projectSettings.deleteButtonLoading")}
              </>
            ) : (
              t("projectSettings.deleteButtonFinal")
            )}
          </button>
        </div>
      </Modal>
    </>
  );
}
