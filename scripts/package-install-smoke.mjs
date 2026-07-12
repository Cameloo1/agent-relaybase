#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { targetForPlatform } from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runPackageInstallSmoke(options = {}) {
  const rootDir = options.rootDir ?? root;
  const target = targetForPlatform(options.platform ?? process.platform, options.arch ?? process.arch);
  const workspace = mkdtempSync(path.join(os.tmpdir(), "relaybase-install-smoke-"));
  const cache = path.join(workspace, "npm-cache");
  try {
    const packageDir = path.join(rootDir, "packages", `relaybase-tui-${target.goos}-${target.goarch}`);
    const platformTarball = pack(packageDir, workspace, cache);
    if (!platformTarball) return 1;
    const rootTarball = pack(rootDir, workspace, cache);
    if (!rootTarball) return 1;
    const install = runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", platformTarball, rootTarball], {
      cwd: workspace,
      cache
    });
    if (install.status !== 0) return report(install);
    const relaybase =
      process.platform === "win32"
        ? path.join(workspace, "node_modules", ".bin", "relaybase.cmd")
        : path.join(workspace, "node_modules", ".bin", "relaybase");
    const version = runExecutable(relaybase, ["--version"], workspace);
    if (version.status !== 0) return report(version);
    const expected = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
    if (version.stdout.trim() !== expected) {
      console.error(`Installed CLI version mismatch: expected ${expected}, received ${version.stdout.trim()}`);
      return 1;
    }
    const help = runExecutable(relaybase, ["--help"], workspace);
    if (help.status !== 0 || !help.stdout.includes("Launch Relaybase daemon/TUI")) {
      report(help);
      console.error("Installed CLI help did not expose the expected Relaybase start contract.");
      return 1;
    }
    console.log(`Disposable install smoke passed for ${target.goos}/${target.goarch} at version ${expected}.`);
    return 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function pack(cwd, destination, cache) {
  const result = runNpm(["pack", "--pack-destination", destination, "--json"], { cwd, cache });
  if (result.status !== 0) {
    report(result);
    return undefined;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return path.join(destination, entry.filename);
  } catch {
    console.error(`Could not parse npm pack output from ${cwd}.`);
    return undefined;
  }
}

function runNpm(args, options) {
  const npm =
    process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd"] }
      : { command: "npm", args: [] };
  return spawnSync(npm.command, [...npm.args, ...args], {
    cwd: options.cwd,
    env: { ...process.env, npm_config_cache: options.cache },
    encoding: "utf8",
    shell: false
  });
}

function runExecutable(command, args, cwd) {
  if (process.platform === "win32" && command.toLowerCase().endsWith(".cmd")) {
    return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd,
      encoding: "utf8",
      shell: false
    });
  }
  return spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
}

function report(result) {
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? result.error?.message ?? "");
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPackageInstallSmoke();
}
