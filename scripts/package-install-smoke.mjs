#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { targetForPlatform } from "./tui-go.mjs";
import { inspectWindowsSignature, verifyAuthenticodeTrust } from "./windows-signature.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runPackageInstallSmoke(options = {}) {
  const rootDir = options.rootDir ?? root;
  const target = targetForPlatform(options.platform ?? process.platform, options.arch ?? process.arch);
  const workspace = mkdtempSync(path.join(os.tmpdir(), "relaybase-install-smoke-"));
  const cache = path.join(workspace, "npm-cache");
  try {
    let platformTarball;
    let rootTarball;
    if (options.tarballDir) {
      const candidate = releaseTarballs(path.resolve(options.tarballDir), target);
      platformTarball = candidate.platformTarball;
      rootTarball = candidate.rootTarball;
    } else {
      const packageDir = path.join(rootDir, "packages", `relaybase-tui-${target.goos}-${target.goarch}`);
      platformTarball = pack(packageDir, workspace, cache);
      if (!platformTarball) return 1;
      rootTarball = pack(rootDir, workspace, cache);
      if (!rootTarball) return 1;
    }
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
    const check = runExecutable(
      relaybase,
      [
        "check",
        "--no-daemon-start",
        "--port",
        String(40_000 + (process.pid % 20_000)),
        "--state-dir",
        path.join(workspace, "check-state"),
        "--cwd",
        workspace
      ],
      workspace,
      { timeout: 30_000 }
    );
    const checkOutput = `${check.stdout ?? ""}\n${check.stderr ?? ""}`;
    if (check.error || !checkOutput.includes("Installed TUI: ready")) {
      report(check);
      console.error("Installed relaybase check did not resolve its packaged TUI binary.");
      return 1;
    }
    if (/MODULE_NOT_FOUND|scripts[\\/]tui-go\.mjs|Cannot find module/i.test(checkOutput)) {
      report(check);
      console.error("Installed relaybase check attempted to use source-only tooling.");
      return 1;
    }
    const installedTui = path.join(
      workspace,
      "node_modules",
      "@cameloo",
      `relaybase-tui-${target.goos}-${target.goarch}`,
      "bin",
      target.binary
    );
    if (options.requireWindowsTrust) {
      if (target.goos !== "windows") {
        console.error("--require-windows-trust must run on a Windows candidate runner.");
        return 1;
      }
      const inspection = inspectWindowsSignature(installedTui);
      if (!inspection.hasAuthenticode) {
        console.error(`Installed Windows TUI is unsigned: ${inspection.reason}`);
        return 1;
      }
      const trust = verifyAuthenticodeTrust(installedTui);
      if (!trust.trusted) {
        console.error(`Installed Windows TUI signature is not trusted: ${trust.status} (${trust.statusMessage})`);
        return 1;
      }
      console.log(`Installed Windows TUI signature is trusted${trust.signer ? `: ${trust.signer}` : "."}`);
    }
    const tui = runExecutable(
      installedTui,
      [
        "--base-url",
        "http://127.0.0.1:1",
        "--state-dir",
        path.join(workspace, "tui-state"),
        "--smoke-render",
        "--smoke-width",
        "100",
        "--smoke-height",
        "30"
      ],
      workspace,
      { timeout: 30_000 }
    );
    if (tui.status !== 0 || tui.error || !/Relaybase/i.test(tui.stdout ?? "")) {
      report(tui);
      console.error("Installed platform TUI could not execute and render its packaged smoke frame.");
      return 1;
    }
    const daemonProbe = runCompiledDaemonProbe(workspace);
    if (daemonProbe.status !== 0) return report(daemonProbe);
    console.log(`Disposable install smoke passed for ${target.goos}/${target.goarch} at version ${expected}.`);
    return 0;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function releaseTarballs(directory, target) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "release-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
    throw new Error("Release candidate manifest is missing or invalid.");
  }
  const rootEntry = manifest.packages.find((entry) => entry.name === "@cameloo/relaybase");
  const platformName = `@cameloo/relaybase-tui-${target.goos}-${target.goarch}`;
  const platformEntry = manifest.packages.find((entry) => entry.name === platformName);
  if (!rootEntry || !platformEntry) {
    throw new Error(`Release candidate does not contain @cameloo/relaybase and ${platformName}.`);
  }
  return {
    rootTarball: verifiedTarball(directory, rootEntry),
    platformTarball: verifiedTarball(directory, platformEntry)
  };
}

function verifiedTarball(directory, entry) {
  if (typeof entry.file !== "string" || path.basename(entry.file) !== entry.file || !entry.file.endsWith(".tgz")) {
    throw new Error(`Release candidate contains an unsafe tarball path for ${entry.name}.`);
  }
  const tarball = path.join(directory, entry.file);
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (digest !== entry.sha256) throw new Error(`Release candidate hash mismatch: ${entry.file}`);
  return tarball;
}

function runCompiledDaemonProbe(workspace) {
  const launcherPath = path.join(
    workspace,
    "node_modules",
    "@cameloo",
    "relaybase",
    "dist-runtime",
    "daemonLauncher.js"
  );
  const stateDir = path.join(workspace, "daemon-state");
  const probePath = path.join(root, "scripts", "compiled-daemon-smoke.mjs");
  return spawnSync(process.execPath, [probePath, launcherPath, stateDir], {
    cwd: workspace,
    encoding: "utf8",
    shell: false,
    timeout: 30_000
  });
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

function runExecutable(command, args, cwd, options = {}) {
  if (process.platform === "win32" && command.toLowerCase().endsWith(".cmd")) {
    return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args], {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: options.timeout
    });
  }
  return spawnSync(command, args, { cwd, encoding: "utf8", shell: false, timeout: options.timeout });
}

function report(result) {
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? result.error?.message ?? "");
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tarballIndex = args.indexOf("--tarball-dir");
  process.exitCode = runPackageInstallSmoke({
    tarballDir: tarballIndex >= 0 ? args[tarballIndex + 1] : undefined,
    requireWindowsTrust: args.includes("--require-windows-trust")
  });
}
