#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { targets } from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function prepareReleaseArtifacts(options = {}) {
  const rootDir = options.rootDir ?? root;
  const destination = path.resolve(options.destination ?? path.join(rootDir, "dist", "release"));
  const cache = options.cache ?? path.join(os.tmpdir(), `relaybase-release-pack-${process.pid}`);
  const spawn = options.spawn ?? spawnSync;
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  mkdirSync(cache, { recursive: true });
  try {
    const packageDirectories = [
      ...targets.map((target) => path.join(rootDir, "packages", `relaybase-tui-${target.goos}-${target.goarch}`)),
      rootDir
    ];
    const artifacts = packageDirectories.map((packageDir) => packPackage(packageDir, destination, cache, spawn));
    const manifest = {
      schemaVersion: 1,
      generatedFrom: "release.yml",
      packages: artifacts.map((artifact) => ({
        name: artifact.name,
        version: artifact.version,
        file: artifact.file,
        sha256: artifact.sha256
      }))
    };
    writeFileSync(path.join(destination, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(
      path.join(destination, "relaybase-release-checksums.txt"),
      `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join("\n")}\n`,
      "utf8"
    );
    return { destination, manifest };
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function packPackage(packageDir, destination, cache, spawn) {
  const npm = npmRunner();
  const result = spawn(npm.command, [...npm.args, "pack", "--pack-destination", destination, "--json"], {
    cwd: packageDir,
    env: { ...process.env, npm_config_cache: cache },
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Could not pack ${packageDir}: ${result.stderr?.trim() || result.error?.message || "npm pack failed"}`
    );
  }
  let entry;
  try {
    const parsed = JSON.parse(result.stdout);
    entry = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    throw new Error(`Could not parse npm pack output from ${packageDir}.`);
  }
  if (!entry?.filename || !entry?.name || !entry?.version) {
    throw new Error(`npm pack output from ${packageDir} omitted package identity.`);
  }
  const tarball = path.join(destination, entry.filename);
  return {
    name: entry.name,
    version: entry.version,
    file: entry.filename,
    sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex")
  };
}

function npmRunner() {
  return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd"] }
    : { command: "npm", args: [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const prepared = prepareReleaseArtifacts();
    for (const entry of prepared.manifest.packages) console.log(`Release package: ${entry.name}@${entry.version}`);
    console.log(`Release artifacts prepared in ${prepared.destination}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
