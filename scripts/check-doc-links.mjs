#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function checkDocumentationLinks(options = {}) {
  const rootDir = options.rootDir ?? root;
  const files = [
    path.join(rootDir, "README.md"),
    path.join(rootDir, "SECURITY.md"),
    ...markdownFiles(path.join(rootDir, "docs"))
  ];
  const failures = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, "");
      if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const relative = raw.split("#", 1)[0];
      const target = path.resolve(path.dirname(file), decodeURIComponent(relative));
      if (!existsSync(target)) failures.push(`${path.relative(rootDir, file)} -> ${raw}`);
    }
  }
  if (failures.length) {
    console.error(["Broken local documentation links:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
    return 1;
  }
  console.log(`Documentation links verified across ${files.length} Markdown files.`);
  return 0;
}

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(target);
    return entry.isFile() && target.endsWith(".md") ? [target] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = checkDocumentationLinks();
}
