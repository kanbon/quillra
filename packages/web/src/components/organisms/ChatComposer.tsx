import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/atoms/Button";
import { Textarea } from "@/components/atoms/Textarea";
import type { Attachment } from "@/lib/chat-store";

type Form = { content: string };

type StagedFile = {
  id: string;
  file: File;
  previewUrl: string;
  status: "uploading" | "done" | "error";
  serverPath?: string;
};

type Props = {
  projectId: string;
  onSend: (text: string, attachments?: Attachment[]) => void;
  disabled?: boolean;
};

export function ChatComposer({ projectId, onSend, disabled }: Props) {
  const {
    register,
    handleSubmit,
    reset,
  } = useForm<Form>({ defaultValues: { content: "" } });

  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      staged.forEach((s) => URL.revokeObjectURL(s.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadFile = useCallback(
    async (file: File) => {
      const id = crypto.randomUUID();
      const previewUrl = URL.createObjectURL(file);
      setStaged((prev) => [...prev, { id, file, previewUrl, status: "uploading" }]);

      try {
        const fd = new FormData();
        fd.append("files", file);
        const res = await fetch(`/api/projects/${projectId}/upload`, {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        const data = (await res.json()) as { items?: { path: string; originalName: string }[] };
        const item = data.items?.[0];
        if (!item) throw new Error("No item returned");
        setStaged((prev) =>
          prev.map((s) => (s.id === id ? { ...s, status: "done", serverPath: item.path } : s)),
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
      URL.revokeObjectURL(item.previewUrl);
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

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
      arr.forEach(uploadFile);
    },
    [uploadFile],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageItems = items.filter((i) => i.type.startsWith("image/"));
      if (imageItems.length === 0) return;
      e.preventDefault();
      const files = imageItems.map((i) => i.getAsFile()).filter((f): f is File => !!f);
      handleFiles(files);
    },
    [handleFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  const submit = handleSubmit((v) => {
    const text = v.content.trim();
    const completed = staged.filter((s) => s.status === "done" && s.serverPath);
    const anyUploading = staged.some((s) => s.status === "uploading");
    if (anyUploading) return;
    if (!text && completed.length === 0) return;

    const attachments: Attachment[] = completed.map((s) => ({
      path: s.serverPath!,
      originalName: s.file.name,
      previewUrl: s.previewUrl,
    }));

    onSend(text, attachments.length > 0 ? attachments : undefined);
    // Don't revoke object URLs — the user message bubble still references them
    setStaged([]);
    reset();
  });

  const uploadingCount = staged.filter((s) => s.status === "uploading").length;
  const sendDisabled = disabled || uploadingCount > 0;

  return (
    <form
      className="relative flex flex-col gap-2 border-t border-neutral-200 bg-white p-3"
      onSubmit={submit}
      onPaste={handlePaste}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand/5 backdrop-blur-sm">
          <p className="text-sm font-medium text-brand">Drop images to attach</p>
        </div>
      )}

      {staged.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {staged.map((s) => (
            <div
              key={s.id}
              className="group relative h-20 w-20 overflow-hidden rounded-md border border-neutral-200 bg-neutral-50"
            >
              <img
                src={s.previewUrl}
                alt={s.file.name}
                className="h-full w-full object-cover"
              />
              {s.status === "uploading" && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/70">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-brand" />
                </div>
              )}
              {s.status === "error" && (
                <div className="absolute inset-0 flex items-center justify-center bg-red-500/80 text-[10px] font-medium text-white">
                  Failed
                </div>
              )}
              <button
                type="button"
                onClick={() => removeStaged(s.id)}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/70 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <Textarea
        {...register("content")}
        placeholder="Ask Quillra to edit your site… (paste or drop images to attach)"
        disabled={disabled}
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-800 disabled:opacity-50"
          disabled={disabled}
          title="Attach images"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
          Attach
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button type="submit" disabled={sendDisabled}>
          {uploadingCount > 0 ? "Uploading…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
