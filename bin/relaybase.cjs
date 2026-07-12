#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const compiledCliPath = path.resolve(__dirname, "../dist-runtime/cli.js");
const sourceCliPath = path.resolve(__dirname, "../src/cli.ts");
const installed = existsSync(compiledCliPath);
const cliPath = installed ? compiledCliPath : sourceCliPath;
const nodeArgs = installed ? [cliPath] : ["--experimental-strip-types", cliPath];
const result = spawnSync(process.execPath, [...nodeArgs, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);

