#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function windowsResourceVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(version));
  if (!match) throw new Error(`Package version ${version} cannot be represented as Windows version metadata.`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65_535)) {
    throw new Error(`Package version ${version} exceeds Windows version metadata limits.`);
  }
  return `${parts.join(".")}.0`;
}

export function prepareWindowsVersionResources(options = {}) {
  const rootDir = options.rootDir ?? root;
  const tuiDir = path.join(rootDir, "tui");
  const input = path.join(tuiDir, "cmd", "relaybase-tui", "winres.json");
  const outputPrefix = path.join(tuiDir, "cmd", "relaybase-tui", "rsrc");
  const arches = [...new Set(options.arches ?? ["amd64", "arm64"])];
  const packageVersion = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
  const windowsVersion = windowsResourceVersion(packageVersion);
  const generated = arches.map((arch) => `${outputPrefix}_windows_${arch}.syso`);
  for (const filePath of generated) rmSync(filePath, { force: true });

  const spawn = options.spawn ?? spawnSync;
  const result = spawn(
    "go",
    [
      "tool",
      "go-winres",
      "make",
      "--in",
      input,
      "--out",
      outputPrefix,
      "--arch",
      arches.join(","),
      "--product-version",
      windowsVersion,
      "--file-version",
      windowsVersion
    ],
    {
      cwd: tuiDir,
      env: options.env ?? process.env,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (result.status !== 0 || result.error) {
    cleanup();
    const detail = result.stderr?.trim() || result.error?.message || "unknown go-winres failure";
    throw new Error(`Could not generate Windows version metadata: ${detail}`);
  }
  const missing = generated.filter((filePath) => !existsSync(filePath));
  if (missing.length > 0) {
    cleanup();
    throw new Error(`go-winres did not create expected resource files: ${missing.join(", ")}`);
  }

  return { generated, version: windowsVersion, cleanup };

  function cleanup() {
    for (const filePath of generated) rmSync(filePath, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).includes("--print-version")) {
      const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
      console.log(windowsResourceVersion(packageVersion));
      process.exit(0);
    }
    const prepared = prepareWindowsVersionResources();
    console.log(`Prepared Windows version resources ${prepared.version}: ${prepared.generated.join(", ")}`);
    prepared.cleanup();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
