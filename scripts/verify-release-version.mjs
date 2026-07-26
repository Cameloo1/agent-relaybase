#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { targets } from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = readManifest(path.join(root, "package.json"));
const expectedTag = `v${rootManifest.version}`;
const currentTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;

if (currentTag && currentTag !== expectedTag) {
  fail(`Release tag ${currentTag} does not match package version ${rootManifest.version}.`);
}

for (const target of targets) {
  const manifest = readManifest(
    path.join(root, "packages", `relaybase-tui-${target.goos}-${target.goarch}`, "package.json")
  );
  if (manifest.version !== rootManifest.version) {
    fail(`${manifest.name} version ${manifest.version} does not match ${rootManifest.version}.`);
  }
  if (rootManifest.optionalDependencies?.[manifest.name] !== rootManifest.version) {
    fail(`${manifest.name} is not pinned to ${rootManifest.version} in optionalDependencies.`);
  }
}

console.log(`Release versions are aligned at ${rootManifest.version}${currentTag ? ` for ${currentTag}` : ""}.`);

function readManifest(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
