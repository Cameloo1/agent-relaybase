#!/usr/bin/env node

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  console.log("Relaybase Windows native module: skipped on non-Windows host.");
  process.exit(0);
}

const requestedArch = process.argv.find((argument) => argument.startsWith("--arch="))?.slice("--arch=".length);
const arches = process.argv.includes("--all") ? ["x64", "arm64"] : [requestedArch || process.arch];
if (arches.some((arch) => !["x64", "arm64"].includes(arch))) {
  throw new Error(`Unsupported Relaybase Windows native architecture: ${arches.join(", ")}`);
}

const npmDirectory = path.join(path.dirname(process.execPath), "node_modules", "npm");
const nodeGyp = path.join(npmDirectory, "node_modules", "node-gyp", "bin", "node-gyp.js");
if (!existsSync(nodeGyp)) {
  throw new Error(`Bundled node-gyp was not found at ${nodeGyp}`);
}

const nativeSource = path.join(root, "native", "windows-dpapi");
for (const arch of arches) {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), `relaybase-windows-native-${arch}-`));
  const nativeRoot = path.join(temporaryRoot, "windows-dpapi");
  cpSync(nativeSource, nativeRoot, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}build${path.sep}`) && !source.endsWith(`${path.sep}build`)
  });
  try {
    const build = spawnSync(process.execPath, [nodeGyp, "rebuild", `--arch=${arch}`, "--release"], {
      cwd: nativeRoot,
      encoding: "utf8",
      stdio: "inherit",
      env: {
        ...process.env,
        npm_config_arch: arch,
        npm_config_target_arch: arch
      }
    });
    if (build.status !== 0) {
      throw new Error(`Relaybase Windows native ${arch} build failed with exit code ${build.status ?? 1}.`);
    } else {
      const source = path.join(nativeRoot, "build", "Release", "relaybase_windows.node");
      const destinationDirectory = path.join(root, "dist-runtime", "native");
      const destination = path.join(destinationDirectory, `relaybase_windows-win32-${arch}.node`);
      mkdirSync(destinationDirectory, { recursive: true });
      copyFileSync(source, destination);
      console.log(`Relaybase Windows native module: ${path.relative(root, destination)}`);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
