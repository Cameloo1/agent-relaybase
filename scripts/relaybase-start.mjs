#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", path.join(root, "src", "cli.ts"), "start", ...args],
  {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: process.env
  }
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
