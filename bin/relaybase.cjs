#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const cliPath = path.resolve(__dirname, "../src/cli.ts");
const result = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);

