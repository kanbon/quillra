import { describe, expect, it } from "vitest";
import { humanizeToolCall } from "./agent-humanizer.js";

describe("humanizeToolCall", () => {
  describe("file operations", () => {
    it("recognises the homepage path", () => {
      expect(humanizeToolCall("Read", { file_path: "src/pages/index.astro" })).toBe(
        "Reading the homepage",
      );
      expect(humanizeToolCall("Read", { file_path: "src/pages/home.mdx" })).toBe(
        "Reading the homepage",
      );
    });

    it("names a non-homepage page by its slug", () => {
      expect(humanizeToolCall("Read", { file_path: "src/pages/about.astro" })).toBe(
        "Reading the about page",
      );
      expect(humanizeToolCall("Edit", { file_path: "src/pages/contact-us.mdx" })).toBe(
        "Updating the contact us page",
      );
    });

    it("describes a component file in friendly terms", () => {
      expect(humanizeToolCall("Edit", { file_path: "src/components/Hero.astro" })).toBe(
        "Updating the hero section",
      );
    });

    it("identifies the site's configuration", () => {
      expect(humanizeToolCall("Read", { file_path: "astro.config.mjs" })).toBe(
        "Reading the site's configuration",
      );
      expect(humanizeToolCall("Read", { file_path: "next.config.js" })).toBe(
        "Reading the site's configuration",
      );
    });

    it("identifies the site's setup from package.json", () => {
      expect(humanizeToolCall("Edit", { file_path: "package.json" })).toBe(
        "Updating the site's setup",
      );
    });

    it("falls back to a cleaned file name when nothing else matches", () => {
      expect(humanizeToolCall("Read", { file_path: "some-random_file.txt" })).toBe(
        "Reading some random file",
      );
    });

    it("uses a generic phrase when the path is missing", () => {
      expect(humanizeToolCall("Read", {})).toBe("Reading your site");
      expect(humanizeToolCall("Write", {})).toBe("Writing a new file");
    });
  });

  describe("Bash classification", () => {
    it("recognises package installs", () => {
      expect(humanizeToolCall("Bash", { command: "npm install" })).toBe("Installing packages");
      expect(humanizeToolCall("Bash", { command: "yarn install" })).toBe("Installing packages");
      expect(humanizeToolCall("Bash", { command: "pnpm install --frozen-lockfile" })).toBe(
        "Installing packages",
      );
    });

    it("recognises git operations", () => {
      expect(humanizeToolCall("Bash", { command: "git push origin main" })).toBe(
        "Publishing your site",
      );
      expect(humanizeToolCall("Bash", { command: "git status" })).toBe("Looking at recent changes");
      expect(humanizeToolCall("Bash", { command: "git add src/" })).toBe("Saving changes");
    });

    it("falls back to a generic phrase for unknown commands", () => {
      expect(humanizeToolCall("Bash", { command: "curl https://example.com | jq" })).toBe(
        "Running a setup command",
      );
    });

    it("never leaks raw command text", () => {
      const secret = "echo 'sk-ant-api03-xxxxxxxxxxxxxxxx'";
      const result = humanizeToolCall("Bash", { command: secret });
      expect(result).not.toContain("sk-ant-api03");
      expect(result).not.toContain("echo");
    });
  });

  describe("MCP and search tools", () => {
    it("describes the Quillra diagnostics MCP server in user terms", () => {
      expect(humanizeToolCall("mcp__quillra-diagnostics__get_preview_status", {})).toBe(
        "Checking your site",
      );
      expect(humanizeToolCall("mcp__quillra-diagnostics__restart_preview", {})).toBe(
        "Restarting your site",
      );
    });

    it("describes any other MCP tool generically", () => {
      expect(humanizeToolCall("mcp__some-other__whatever", {})).toBe("Checking your site");
    });

    it("describes search tools without leaking the query", () => {
      expect(humanizeToolCall("Grep", { pattern: "TODO secret" })).toBe("Searching your site");
    });
  });

  it("falls back to a safe phrase for unknown tool names", () => {
    expect(humanizeToolCall("UnknownFutureTool", {})).toBe("Working on your site");
  });
});
