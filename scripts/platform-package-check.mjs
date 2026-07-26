#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { npmPackArguments } from "./npm-pack-json.mjs";
import { targets } from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runPlatformPackageCheck(options = {}) {
  const rootDir = options.rootDir ?? root;
  const spawn = options.spawn ?? spawnSync;
  const cache = mkdtempSync(path.join(os.tmpdir(), "relaybase-platform-pack-"));
  try {
    for (const target of targets) {
      const packageDir = path.join(rootDir, "packages", `relaybase-tui-${target.goos}-${target.goarch}`);
      const binary = path.join(packageDir, "bin", target.binary);
      if (!existsSync(binary)) {
        console.error(`Missing prepared platform binary: ${binary}`);
        return 1;
      }
      const npm = npmRunner();
      const result = spawn(npm.command, [...npm.args, ...npmPackArguments({ dryRun: true })], {
        cwd: packageDir,
        env: { ...process.env, npm_config_cache: cache },
        encoding: "utf8",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (result.status !== 0) {
        process.stdout.write(result.stdout ?? "");
        process.stderr.write(result.stderr ?? result.error?.message ?? "");
        return result.status ?? 1;
      }
      const files = packFiles(result.stdout);
      if (!files.has(`bin/${target.binary}`)) {
        console.error(`Platform tarball omitted bin/${target.binary}: ${packageDir}`);
        return 1;
      }
      console.log(`Platform package ready: @cameloo/relaybase-tui-${target.goos}-${target.goarch}`);
    }
    return 0;
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function npmRunner() {
  return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd"] }
    : { command: "npm", args: [] };
}

function packFiles(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    return new Set((entry?.files ?? []).map((file) => String(file.path).replaceAll("\\", "/")));
  } catch {
    return new Set();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPlatformPackageCheck();
}
