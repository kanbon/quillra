#!/usr/bin/env node
import { execSync } from "node:child_process";
/*
 * Fails if any source file contains an em-dash (U+2014).
 *
 * Project convention: English prose in comments and user-visible strings
 * uses plain ASCII punctuation so the codebase stays grep-friendly and
 * readable in terminals that have inconsistent UTF rendering.
 */
import { readFileSync } from "node:fs";

const EM_DASH = "\u2014";

const tracked = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter(
    (f) =>
      /\.(ts|tsx|js|jsx|mjs|cjs|md|mdx|json|css|html)$/.test(f) &&
      !f.endsWith("dictionaries.ts") &&
      !f.startsWith("scripts/check-em-dashes"),
  );

const hits = [];
for (const file of tracked) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!content.includes(EM_DASH)) continue;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(EM_DASH)) {
      hits.push(`${file}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}

if (hits.length > 0) {
  console.error(`Found ${hits.length} em-dash(es) in source files:`);
  for (const hit of hits) console.error(`  ${hit}`);
  console.error("\nReplace with a plain ASCII equivalent (. , : or parens).");
  process.exit(1);
}
