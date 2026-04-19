/**
 * Window-level paste handler so files can be pasted from anywhere on
 * the editor, not just when the composer itself is focused. Inputs
 * that aren't the composer keep their native paste behaviour so text
 * editing isn't hijacked.
 *
 * Extracted out of packages/web/src/pages/Editor.tsx. Logic moved
 * verbatim, no behaviour change.
 */

import type { ChatComposerHandle } from "@/components/organisms/ChatComposer";
import { useEffect } from "react";

export function useEditorPaste(composerRef: React.RefObject<ChatComposerHandle | null>) {
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't hijack paste when typing in inputs that aren't the composer
      if (target && target.tagName === "INPUT") return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const fileItems = items.filter(
        (i) => i.kind === "file" && (i.type.startsWith("image/") || i.type.startsWith("text/")),
      );
      if (fileItems.length === 0) return;
      e.preventDefault();
      const files = fileItems.map((i) => i.getAsFile()).filter((f): f is File => !!f);
      composerRef.current?.addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [composerRef]);
}
