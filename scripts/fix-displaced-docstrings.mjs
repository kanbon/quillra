#!/usr/bin/env node
import { execSync } from "node:child_process";
/*
 * One-shot cleanup: Biome's organizeImports pushes imports to the top of
 * each file, but doesn't know to keep the leading JSDoc block above them.
 * When a file had `/** ... *\/` then imports, the import sorter happily
 * placed imports above the block. This script finds those cases and moves
 * the stray docblock back to the very top of the file.
 *
 * Only touches files where a /** block appears strictly between the first
 * and last import statements.
 */
import { readFileSync, writeFileSync } from "node:fs";

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f));

let fixed = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const importLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^import /.test(lines[i])) importLines.push(i);
  }
  if (importLines.length < 2) continue;

  const firstImport = importLines[0];
  const lastImport = importLines[importLines.length - 1];

  let docStart = -1;
  let docEnd = -1;
  for (let i = firstImport + 1; i < lastImport; i++) {
    if (/^\/\*\*/.test(lines[i])) {
      docStart = i;
      for (let j = i; j < lines.length; j++) {
        if (/\*\//.test(lines[j])) {
          docEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (docStart === -1 || docEnd === -1) continue;

  const docBlock = lines.slice(docStart, docEnd + 1);
  const before = lines.slice(0, docStart);
  const after = lines.slice(docEnd + 1);
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  while (after.length && after[0].trim() === "") after.shift();

  const newLines = [...docBlock, "", ...before, ...after];
  writeFileSync(file, newLines.join("\n"));
  fixed++;
}

console.info(`Fixed ${fixed} files.`);
