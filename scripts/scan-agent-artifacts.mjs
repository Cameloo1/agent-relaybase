#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error("Usage: node scripts/scan-agent-artifacts.mjs <path> [path...]");
  process.exit(1);
}

const skipExtensions = /\.(zip|sqlite|db|wal|shm|png|jpg|jpeg|gif|exe)$/i;
const checks = [
  ["openrouter_key", /sk-or-(?!\[redacted\])[A-Za-z0-9._-]{10,}/],
  ["bearer_token", /Bearer\s+(?!\[redacted\])[\w._~+/-]{12,}/i],
  ["auth_header", /Authorization\s*:\s*Bearer\s+(?!\[redacted\])[\w._~+/-]+/i],
  [
    "secret_assignment",
    /\b(?:OPENROUTER_API_KEY|RELAYBASE_TOKEN|password|secret|token|api[_-]?key)\s*=\s*(?!\[redacted\]|redacted|<redacted>)[^\s"',}]+/i
  ]
];

const findings = [];
const scannedFiles = [];

for (const root of roots) {
  for (const filePath of await collectFiles(root)) {
    if (skipExtensions.test(filePath)) {
      continue;
    }
    const text = await fs.readFile(filePath, "utf8").catch(() => undefined);
    if (text === undefined) {
      continue;
    }
    scannedFiles.push(filePath);
    for (const [name, pattern] of checks) {
      if (pattern.test(text)) {
        findings.push({ file: filePath, finding: name });
      }
    }
  }
}

if (findings.length) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        findings
      },
      null,
      2
    )
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "passed",
      scannedRoots: roots,
      scannedFiles: scannedFiles.length
    },
    null,
    2
  )
);

async function collectFiles(inputPath) {
  const stat = await fs.stat(inputPath).catch(() => undefined);
  if (!stat) {
    return [];
  }
  if (stat.isFile()) {
    return [inputPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    files.push(...(await collectFiles(path.join(inputPath, entry.name))));
  }
  return files;
}
