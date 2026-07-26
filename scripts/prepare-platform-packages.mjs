#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { targetForPlatform, targets } from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function preparePlatformPackages(options = {}) {
  const rootDir = options.rootDir ?? root;
  const sourceDir = options.sourceDir ?? path.join(rootDir, "bin", "relaybase-tui");
  const version = rootPackageVersion(rootDir);
  const prepared = [];
  const selectedTargets = options.targets ?? targets;

  for (const target of selectedTargets) {
    const packageName = `relaybase-tui-${target.goos}-${target.goarch}`;
    const packageDir = path.join(rootDir, "packages", packageName);
    const manifestPath = path.join(packageDir, "package.json");
    const source = path.join(sourceDir, target.binary);
    const destination = path.join(packageDir, "bin", target.binary);
    if (!existsSync(manifestPath)) {
      throw new Error(`Missing platform package manifest: ${manifestPath}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.version !== version) {
      throw new Error(`${manifest.name} version ${manifest.version} does not match root version ${version}.`);
    }
    if (!existsSync(source)) {
      throw new Error(`Missing ${target.goos}/${target.goarch} TUI binary: ${source}`);
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copyFileSync(path.join(rootDir, "LICENSE"), path.join(packageDir, "LICENSE"));
    if (target.goos !== "windows") {
      chmodSync(destination, 0o755);
    }
    prepared.push({ packageDir, packageName: manifest.name, binary: destination });
  }
  return prepared;
}

function rootPackageVersion(rootDir) {
  const manifest = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("Root package version is missing.");
  }
  return manifest.version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const prepared = preparePlatformPackages({
      targets: process.argv.slice(2).includes("--current") ? [targetForPlatform()] : targets
    });
    for (const entry of prepared) {
      console.log(`Prepared ${entry.packageName}: ${path.relative(root, entry.binary)}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
