/**
 * Publish flow modal for the Editor. Shows four distinct states
 * driven entirely by the publish mutation + the pre-flight status
 * fetch: reviewing (spinner), ready-with-changes (markdown summary
 * + "Publish now"), up-to-date, publishing, success, error.
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic and
 * markup were moved verbatim, no behaviour change.
 */

import { Button } from "@/components/atoms/Button";
import { Modal } from "@/components/atoms/Modal";
import { Spinner } from "@/components/atoms/Spinner";
import { useT } from "@/i18n/i18n";
import type { UseMutationResult } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";

export type PublishStatus = {
  dirty: string[];
  unpushed: number;
  hasChanges: boolean;
  summary?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  publishMut: UseMutationResult<{ ok: boolean; message: string }, Error, void, unknown>;
  publishStatus: PublishStatus | null;
  publishStatusLoading: boolean;
};

export function EditorPublishModal({
  open,
  onClose,
  publishMut,
  publishStatus,
  publishStatusLoading,
}: Props) {
  const { t } = useT();

  return (
    <Modal open={open} onClose={() => !publishMut.isPending && onClose()}>
      <h3 className="mb-1 text-lg font-semibold text-neutral-900">{t("publish.modalTitle")}</h3>

      {publishStatusLoading && (
        <div className="flex flex-col items-center py-6">
          <Spinner className="mb-3 size-5" />
          <p className="text-sm text-neutral-500">{t("publish.reviewing")}</p>
        </div>
      )}

      {publishMut.isIdle &&
        publishStatus &&
        !publishStatusLoading &&
        (publishStatus.hasChanges ? (
          <>
            {publishStatus.summary ? (
              <div className="mb-4 mt-2 text-sm leading-relaxed text-neutral-600 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mb-0.5 [&_p]:mb-1 [&_p:last-child]:mb-0">
                <ReactMarkdown>{publishStatus.summary}</ReactMarkdown>
              </div>
            ) : (
              <p className="mb-4 mt-1 text-sm text-neutral-500">{t("publish.readyDescription")}</p>
            )}
            <Button
              type="button"
              className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
              onClick={() => publishMut.mutate()}
            >
              {t("publish.publishNow")}
            </Button>
          </>
        ) : (
          <>
            <p className="mb-6 mt-2 text-sm text-neutral-500">{t("publish.upToDate")}</p>
            <Button
              type="button"
              variant="outline"
              className="w-full rounded-xl py-3 text-[15px]"
              onClick={onClose}
            >
              {t("common.close")}
            </Button>
          </>
        ))}

      {publishMut.isPending && (
        <div className="flex flex-col items-center py-8">
          <Spinner className="mb-4 size-6" />
          <p className="text-sm font-medium text-neutral-700">{t("publish.publishingHeading")}</p>
          <p className="mt-1 text-xs text-neutral-400">{t("publish.publishingSubtext")}</p>
        </div>
      )}

      {publishMut.isSuccess && (
        <>
          <div className="mb-4 mt-3 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2">
            <span className="text-green-600">&#10003;</span>
            <p className="text-sm text-green-700">{t("publish.success")}</p>
          </div>
          <Button
            type="button"
            className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
            onClick={onClose}
          >
            {t("common.done")}
          </Button>
        </>
      )}

      {publishMut.isError && (
        <>
          <p className="mb-6 mt-2 text-sm text-red-600">{t("publish.error")}</p>
          <Button
            type="button"
            className="w-full rounded-xl bg-brand py-3 text-[15px] font-semibold text-white hover:bg-brand/90"
            onClick={() => publishMut.mutate()}
          >
            {t("common.tryAgain")}
          </Button>
        </>
      )}
    </Modal>
  );
}
