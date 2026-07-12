#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentPlatformBinaryPath, targetForPlatform } from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryNpmCachePrefix = path.join(os.tmpdir(), "relaybase-package-check-");

export function runPackageCheck(args = process.argv.slice(2), options = {}) {
  const requireTuiBinary = args.includes("--require-tui-binary") || process.env.RELAYBASE_REQUIRE_TUI_BINARY === "1";
  const spawn = options.spawn ?? spawnSync;
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = targetForPlatform(platform, arch);
  const binaryPath = currentPlatformBinaryPath({ rootDir: root, platform, arch });
  const relativeBinaryPath = posixPath(path.relative(root, binaryPath));
  const pack = runNpmPackDryRun(spawn);

  if (pack.status !== 0) {
    process.stdout.write(pack.stdout);
    process.stderr.write(pack.stderr);
    return pack.status;
  }

  const files = packFiles(pack.stdout);
  const binaryExists = exists(binaryPath);
  const binaryInTarball = files.has(relativeBinaryPath);
  const lines = [
    `Relaybase package check: ${pack.filename ?? "dry-run tarball"}`,
    `Expected TUI binary for ${platform}/${arch}: ${relativeBinaryPath}`
  ];

  if (binaryExists && binaryInTarball) {
    lines.push("TUI package binary: present in workspace and npm dry-run.");
    console.log(lines.join("\n"));
    return 0;
  }

  if (binaryExists && !binaryInTarball) {
    lines.push("TUI package binary: missing from npm dry-run even though the file exists.");
    lines.push("Fix package.json files/include rules before release packaging.");
    console.error(lines.join("\n"));
    return 1;
  }

  lines.push("TUI package binary: not built in this workspace.");
  lines.push("Build it with: npm run tui:build");
  lines.push("Check Go/toolchain readiness with: npm run doctor:tui");
  lines.push("Release verification can require the binary with: RELAYBASE_REQUIRE_TUI_BINARY=1 npm run package:check");

  if (requireTuiBinary) {
    console.error(lines.join("\n"));
    return 1;
  }

  lines.push(`Package dry-run is source-only for ${target.binary} until the TUI binary is built.`);
  console.log(lines.join("\n"));
  return 0;
}

function runNpmPackDryRun(spawn) {
  const npmExecPath = process.env.npm_execpath;
  const runner = npmExecPath
    ? { command: process.execPath, args: [npmExecPath] }
    : process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd"] }
      : { command: "npm", args: [] };
  const args = [...runner.args, "pack", "--dry-run", "--json"];
  const configuredNpmCache = process.env.RELAYBASE_PACKAGE_NPM_CACHE?.trim();
  const packageCheckNpmCache = configuredNpmCache || mkdtempSync(temporaryNpmCachePrefix);
  const env = {
    ...process.env,
    npm_config_cache: packageCheckNpmCache
  };
  try {
    const result = spawn(runner.command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    return {
      status: result.status ?? (result.error ? 1 : 0),
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr:
        typeof result.stderr === "string" ? result.stderr : result.error?.message ? `${result.error.message}\n` : "",
      filename: packFilename(typeof result.stdout === "string" ? result.stdout : "")
    };
  } finally {
    if (!configuredNpmCache) {
      rmSync(packageCheckNpmCache, { recursive: true, force: true });
    }
  }
}

function packFiles(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    const files = Array.isArray(entry?.files) ? entry.files : [];
    return new Set(files.map((file) => posixPath(String(file.path))).filter(Boolean));
  } catch {
    return new Set();
  }
}

function packFilename(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return typeof entry?.filename === "string" ? entry.filename : undefined;
  } catch {
    return undefined;
  }
}

function posixPath(value) {
  return value.split(path.sep).join("/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPackageCheck();
}
