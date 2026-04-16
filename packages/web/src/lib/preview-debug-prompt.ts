import type { PreviewStatus } from "@/lib/use-preview-status";

/**
 * Compose the chat prompt we send on the user's behalf when they click
 * "Ask the assistant to fix it" on the preview error overlay. Phrased
 * in plain language because it ends up in the user's transcript; the
 * agent's system prompt still steers it to respond non-technically.
 */
export function buildPreviewDebugPrompt(status: PreviewStatus): string {
  const message = status.stageMessage?.trim() || "The preview stopped responding.";
  const tail = status.recentErrors.slice(-20).map((l) => l.trim()).filter(Boolean);
  const lines: string[] = [];
  lines.push("The live preview has an error.");
  lines.push("");
  lines.push(`Error: ${message}`);
  if (tail.length > 0) {
    lines.push("");
    lines.push("Recent messages from the site:");
    lines.push("");
    for (const l of tail) lines.push(l);
  }
  lines.push("");
  lines.push("Please find the cause and fix it, then confirm when the preview is working again.");
  return lines.join("\n");
}
