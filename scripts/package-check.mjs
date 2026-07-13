#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const platformPackageName = `@cameloo/relaybase-tui-${target.goos}-${target.goarch}`;
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const pack = runNpmPackDryRun(spawn);

  if (pack.status !== 0) {
    process.stdout.write(pack.stdout);
    process.stderr.write(pack.stderr);
    return pack.status;
  }

  const files = packFiles(pack.stdout);
  if (!files.has("dist-runtime/cli.js")) {
    console.error("Relaybase package check: compiled runtime dist-runtime/cli.js is missing from the npm tarball.");
    return 1;
  }
  if (!files.has("dist-runtime/daemonLauncher.js")) {
    console.error(
      "Relaybase package check: compiled runtime dist-runtime/daemonLauncher.js is missing from the npm tarball."
    );
    return 1;
  }
  const forbidden = [...files].filter(
    (file) =>
      file.startsWith("reports/") ||
      file.startsWith("scripts/") ||
      file.startsWith("src/") ||
      file.startsWith("tui/") ||
      file.startsWith("dist/") ||
      file.includes(".tmp-go-cache") ||
      file === "docs/relaybase-release-roadmap.md" ||
      file === "docs/tui-setup-gap-map.md" ||
      file.startsWith("bin/relaybase-tui/relaybase-tui-")
  );
  if (forbidden.length) {
    console.error(
      `Relaybase package check: forbidden source or local artifacts entered the tarball:\n${forbidden.join("\n")}`
    );
    return 1;
  }
  if (manifest.optionalDependencies?.[platformPackageName] !== manifest.version) {
    console.error(`Relaybase package check: ${platformPackageName} is not pinned to root version ${manifest.version}.`);
    return 1;
  }
  const binaryExists = exists(binaryPath);
  const lines = [
    `Relaybase package check: ${pack.filename ?? "dry-run tarball"}`,
    `Selected TUI package for ${platform}/${arch}: ${platformPackageName}`
  ];

  if (binaryExists) {
    lines.push("Prepared platform binary: present outside the root tarball.");
    console.log(lines.join("\n"));
    return 0;
  }

  lines.push("Prepared platform binary: not built in this workspace.");
  lines.push("Build it with: npm run tui:build:all && npm run package:prepare-platforms");
  lines.push("Check Go/toolchain readiness with: npm run doctor:tui");
  lines.push("Release verification can require the binary with: RELAYBASE_REQUIRE_TUI_BINARY=1 npm run package:check");

  if (requireTuiBinary) {
    console.error(lines.join("\n"));
    return 1;
  }

  lines.push(`Root package metadata is valid; strict release proof still requires ${target.binary}.`);
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
