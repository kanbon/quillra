import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Textarea } from "@/components/atoms/Textarea";
import { useT } from "@/i18n/i18n";
import type { Attachment } from "@/lib/chat-store";

const CONTENT_EXTS = new Set(["txt", "md", "markdown", "html", "htm", "csv", "json", "xml", "yaml", "yml"]);

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function isContentFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml") return true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_EXTS.has(ext);
}

function isAcceptedFile(file: File): boolean {
  return isImageFile(file) || isContentFile(file);
}

type StagedFile = {
  id: string;
  file: File;
  previewUrl: string;
  /** Image preview blob URL or null for non-images */
  imageThumbUrl: string | null;
  status: "uploading" | "done" | "error";
  serverPath?: string;
  serverKind?: "image" | "content";
};

export type ChatComposerHandle = {
  /** Add files to the staging area (used by external drop targets) */
  addFiles: (files: FileList | File[]) => void;
};

type Props = {
  projectId: string;
  onSend: (text: string, attachments?: Attachment[]) => void;
  disabled?: boolean;
};

export const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer(
  { projectId, onSend, disabled },
  ref,
) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      staged.forEach((s) => {
        if (s.imageThumbUrl) URL.revokeObjectURL(s.imageThumbUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const uploadFile = useCallback(
    async (file: File) => {
      const id = crypto.randomUUID();
      const imageThumbUrl = isImageFile(file) ? URL.createObjectURL(file) : null;
      setStaged((prev) => [
        ...prev,
        { id, file, previewUrl: imageThumbUrl ?? "", imageThumbUrl, status: "uploading" },
      ]);

      try {
        const fd = new FormData();
        fd.append("files", file);
        const res = await fetch(`/api/projects/${projectId}/upload`, {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        const data = (await res.json()) as {
          items?: { path: string; originalName: string; kind?: "image" | "content" }[];
        };
        const item = data.items?.[0];
        if (!item) throw new Error("No item returned");
        setStaged((prev) =>
          prev.map((s) =>
            s.id === id
              ? { ...s, status: "done", serverPath: item.path, serverKind: item.kind ?? (s.imageThumbUrl ? "image" : "content") }
              : s,
          ),
        );
      } catch {
        setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, status: "error" } : s)));
      }
    },
    [projectId],
  );

  const removeStaged = useCallback(
    async (id: string) => {
      const item = staged.find((s) => s.id === id);
      if (!item) return;
      if (item.imageThumbUrl) URL.revokeObjectURL(item.imageThumbUrl);
      setStaged((prev) => prev.filter((s) => s.id !== id));
      if (item.serverPath) {
        try {
          await fetch(`/api/projects/${projectId}/asset-delete`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: item.serverPath }),
          });
        } catch { /* best-effort */ }
      }
    },
    [projectId, staged],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files).filter(isAcceptedFile);
      arr.forEach(uploadFile);
    },
    [uploadFile],
  );

  useImperativeHandle(ref, () => ({ addFiles }), [addFiles]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    const completed = staged.filter((s) => s.status === "done" && s.serverPath);
    const anyUploading = staged.some((s) => s.status === "uploading");
    if (anyUploading) return;
    if (!trimmed && completed.length === 0) return;

    const attachments: Attachment[] = completed.map((s) => ({
      path: s.serverPath!,
      originalName: s.file.name,
      kind: s.serverKind,
      previewUrl: s.imageThumbUrl ?? undefined,
    }));

    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    // Don't revoke object URLs — the user message bubble still references them
    setStaged([]);
    setText("");
  }, [text, staged, onSend]);

  const uploadingCount = staged.filter((s) => s.status === "uploading").length;
  const canSend = !disabled && uploadingCount === 0 && (text.trim().length > 0 || staged.some((s) => s.status === "done"));

  return (
    <div className="px-3 pb-3 pt-1">
      <div className="relative rounded-[26px] border border-neutral-200 bg-white shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-shadow focus-within:border-neutral-300 focus-within:shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        {staged.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-1 pt-3">
            {staged.map((s) => {
              const isImage = Boolean(s.imageThumbUrl);
              return isImage ? (
                <div
                  key={s.id}
                  className="group relative h-16 w-16 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50"
                >
                  <img src={s.imageThumbUrl!} alt={s.file.name} className="h-full w-full object-cover" />
                  {s.status === "uploading" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-brand" />
                    </div>
                  )}
                  {s.status === "error" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-red-500/80 text-[10px] font-medium text-white">
                      {t("composer.failed")}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removeStaged(s.id)}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/70 text-xs leading-none text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={t("composer.remove")}
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div
                  key={s.id}
                  className="group relative flex h-16 max-w-[220px] items-center gap-2.5 rounded-xl border border-neutral-200 bg-neutral-50 px-3 pr-8"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-neutral-500 ring-1 ring-neutral-200">
                    {s.status === "uploading" ? (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-brand" />
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium text-neutral-800">{s.file.name}</p>
                    <p className="text-[11px] uppercase tracking-wide text-neutral-400">
                      {s.status === "error"
                        ? t("composer.failed")
                        : (s.file.name.split(".").pop() ?? "FILE").toUpperCase()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeStaged(s.id)}
                    className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/70 text-xs leading-none text-white opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label={t("composer.remove")}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("composer.placeholder")}
          disabled={disabled}
          rows={1}
          className="block w-full resize-none border-0 bg-transparent px-5 pb-2 pt-4 text-[15px] leading-6 text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-0"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 disabled:opacity-40"
              title={t("composer.attachImages")}
              aria-label={t("composer.attachImages")}
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,text/*,.md,.markdown,.html,.htm,.csv,.json,.xml,.yaml,.yml"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>

          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-neutral-900 text-white shadow-sm transition-all hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400 disabled:shadow-none"
            title={uploadingCount > 0 ? t("composer.uploading") : t("composer.send")}
            aria-label={t("composer.send")}
          >
            {uploadingCount > 0 ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l7-7 7 7M12 5v14" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
});
