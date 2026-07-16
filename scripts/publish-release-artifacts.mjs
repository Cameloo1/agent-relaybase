#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { targets } from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function publishReleaseArtifacts(options = {}) {
  const directory = path.resolve(options.directory ?? path.join(root, "dist", "release"));
  const manifest = JSON.parse(readFileSync(path.join(directory, "release-manifest.json"), "utf8"));
  const spawn = options.spawn ?? spawnSync;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages) || manifest.packages.length !== 7) {
    throw new Error("Release manifest must describe the root package and six platform packages.");
  }
  const expectedNames = new Set([
    ...targets.map((target) => `@cameloo/relaybase-tui-${target.goos}-${target.goarch}`),
    "@cameloo/relaybase"
  ]);
  const actualNames = new Set(manifest.packages.map((entry) => entry?.name));
  if (actualNames.size !== expectedNames.size || [...expectedNames].some((name) => !actualNames.has(name))) {
    throw new Error("Release manifest package identities do not match the six platform packages and root package.");
  }
  const versions = new Set(manifest.packages.map((entry) => entry?.version));
  if (versions.size !== 1) throw new Error("Release manifest packages must all use the same version.");

  for (const entry of manifest.packages) {
    validateEntry(entry, directory);
    const existing = runNpm(spawn, ["view", `${entry.name}@${entry.version}`, "version", "--json"], directory);
    if (existing.status === 0) {
      const publishedVersion = String(existing.stdout ?? "")
        .replaceAll('"', "")
        .trim();
      if (publishedVersion !== entry.version) {
        throw new Error(`npm returned unexpected version for ${entry.name}@${entry.version}: ${publishedVersion}`);
      }
      console.log(`Already published: ${entry.name}@${entry.version}`);
      continue;
    }
    const lookupError = `${existing.stderr ?? ""}\n${existing.stdout ?? ""}`;
    if (!/E404|404 Not Found/i.test(lookupError)) {
      throw new Error(
        `Could not determine publication state for ${entry.name}@${entry.version}: ${lookupError.trim()}`
      );
    }
    const publish = runNpm(
      spawn,
      ["publish", path.join(directory, entry.file), "--access", "public", "--provenance"],
      directory
    );
    if (publish.status !== 0 || publish.error) {
      throw new Error(
        `Could not publish ${entry.name}@${entry.version}: ${publish.stderr?.trim() || publish.error?.message || "npm publish failed"}`
      );
    }
    process.stdout.write(publish.stdout ?? "");
  }
}

function validateEntry(entry, directory) {
  if (!entry || typeof entry.name !== "string" || typeof entry.version !== "string") {
    throw new Error("Release manifest contains an invalid package identity.");
  }
  if (typeof entry.file !== "string" || path.basename(entry.file) !== entry.file || !entry.file.endsWith(".tgz")) {
    throw new Error(`Release manifest contains an unsafe tarball path for ${entry.name}.`);
  }
  const digest = createHash("sha256")
    .update(readFileSync(path.join(directory, entry.file)))
    .digest("hex");
  if (digest !== entry.sha256) throw new Error(`Release artifact hash mismatch: ${entry.file}`);
}

function runNpm(spawn, args, cwd) {
  const npm =
    process.platform === "win32"
      ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd"] }
      : { command: "npm", args: [] };
  return spawn(npm.command, [...npm.args, ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishReleaseArtifacts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
