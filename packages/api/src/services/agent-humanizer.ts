/**
 * Plain-language translator for the Claude Agent SDK's tool calls.
 *
 * Quillra shows the agent's every step in the chat transcript — Read,
 * Edit, Write, Bash, Glob, MCP diagnostics — but never in technical
 * terms. A Read of `src/pages/index.astro` becomes "Reading the
 * homepage"; an `npm install` becomes "Installing packages"; a call
 * to `mcp__quillra-diagnostics__get_preview_status` becomes "Checking
 * your site".
 *
 * The humanizer is the one place where tool names, file paths, and
 * commands can leak — everything downstream handles only the
 * human-language label. Keep the fallbacks generic and non-technical.
 */

/** Translate a file path into a phrase a non-technical customer would
 *  recognise: "the homepage", "the About page", "the Hero section",
 *  "the site's setup". Falls back to the filename-minus-extension,
 *  stripped of dashes/underscores. */
function humanFile(fp: string): string {
  const p = fp.replace(/\\/g, "/").replace(/^\.\//, "");
  // Pages
  if (/\/pages\/(index|home)\.(astro|jsx?|tsx?|md|mdx|html?)$/i.test(p)) return "the homepage";
  const pageMatch = p.match(/\/pages\/([^/]+?)\.(astro|jsx?|tsx?|md|mdx|html?)$/i);
  if (pageMatch) return `the ${pageMatch[1].replace(/[-_]/g, " ")} page`;
  if (/\/pages\/\[/.test(p)) return "a dynamic page";
  // Layouts / components
  if (/\/layouts\//i.test(p)) return "the page layout";
  const compMatch = p.match(/\/components\/([^/]+?)\.[a-z]+$/i);
  if (compMatch) return `the ${compMatch[1].replace(/[-_]/g, " ").toLowerCase()} section`;
  // Content
  if (/\/content\/.+\.(md|mdx)$/i.test(p)) {
    const slug =
      p
        .split("/")
        .pop()
        ?.replace(/\.[^.]+$/, "") ?? "";
    return slug ? `the ${slug.replace(/[-_]/g, " ")} post` : "a post";
  }
  // Config-ish
  if (p.endsWith("package.json")) return "the site's setup";
  if (/astro\.config|next\.config|vite\.config|tsconfig/.test(p)) return "the site's configuration";
  if (p.endsWith(".css") && /global|styles?/i.test(p)) return "the global styles";
  // Fallback: the file name, stripped
  const name =
    p
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? p;
  return name.replace(/[-_]/g, " ");
}

/** Classify a Bash command line. Not exhaustive — the goal is to
 *  recognise the handful the agent uses in normal flow (install,
 *  build, git) and fall back to "Running a setup command" for
 *  anything else, which is vague enough to be safe. */
function humanBash(command: string): string {
  if (/\b(npm|yarn|pnpm)\s+install\b/.test(command)) return "Installing packages";
  if (/\b(npm|yarn|pnpm)\s+(run\s+)?build\b/.test(command)) return "Building your site";
  if (/\b(astro\s+dev|npm\s+run\s+dev|next\s+dev)\b/.test(command)) return "Starting the preview";
  if (/\bastro\s+check\b/.test(command)) return "Checking your site for issues";
  if (/\bgit\s+(add|commit)\b/.test(command)) return "Saving changes";
  if (/\bgit\s+(status|diff|log|show)\b/.test(command)) return "Looking at recent changes";
  if (/\bgit\s+push\b/.test(command)) return "Publishing your site";
  if (/\bgit\s+(clone|fetch|pull)\b/.test(command)) return "Syncing with your repository";
  if (/^rm\b|\brm\s+-/.test(command)) return "Cleaning up files";
  if (/^mv\b/.test(command)) return "Moving files";
  if (/^mkdir\b/.test(command)) return "Creating a folder";
  return "Running a setup command";
}

/** Turn a (tool name, input) pair into a single plain-language line for
 *  the chat transcript. Never returns a file path, tool name, or raw
 *  command. Unknown tools fall back to "Working on your site". */
export function humanizeToolCall(toolName: string, input: Record<string, unknown>): string {
  const filePath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : null;

  switch (toolName) {
    case "Read":
      return filePath ? `Reading ${humanFile(filePath)}` : "Reading your site";
    case "Write":
      return filePath ? `Writing ${humanFile(filePath)}` : "Writing a new file";
    case "Edit":
    case "NotebookEdit":
      return filePath ? `Updating ${humanFile(filePath)}` : "Updating your site";
    case "Glob":
    case "Grep":
      return "Searching your site";
    case "WebFetch":
    case "WebSearch":
      return "Looking something up online";
    case "Bash":
      return humanBash(typeof input.command === "string" ? input.command : "");
    case "mcp__quillra-diagnostics__get_preview_status":
      return "Checking your site";
    case "mcp__quillra-diagnostics__tail_preview_logs":
      return "Looking at recent messages from your site";
    case "mcp__quillra-diagnostics__restart_preview":
      return "Restarting your site";
    default:
      if (toolName.startsWith("mcp__")) return "Checking your site";
      return "Working on your site";
  }
}
