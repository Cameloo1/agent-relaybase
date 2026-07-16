#!/usr/bin/env node

import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { targets } from "./tui-go.mjs";
import { inspectWindowsSignature } from "./windows-signature.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function acceptSignedWindowsBinaries(options = {}) {
  const sourceDir = path.resolve(options.sourceDir ?? path.join(root, "dist", "signpath-signed"));
  const destinationDir = path.resolve(options.destinationDir ?? path.join(root, "bin", "relaybase-tui"));
  const files = recursiveFiles(sourceDir);
  const accepted = [];
  mkdirSync(destinationDir, { recursive: true });

  for (const target of targets.filter((entry) => entry.goos === "windows")) {
    const matches = files.filter((filePath) => path.basename(filePath) === target.binary);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one signed ${target.binary}; found ${matches.length}.`);
    }
    if (!lstatSync(matches[0]).isFile() || lstatSync(matches[0]).isSymbolicLink()) {
      throw new Error(`Signed artifact is not a regular file: ${matches[0]}`);
    }
    const sourceInspection = inspectWindowsSignature(matches[0]);
    if (!sourceInspection.hasAuthenticode) {
      throw new Error(`SignPath output is not Authenticode-signed: ${target.binary} (${sourceInspection.reason}).`);
    }
    const destination = path.join(destinationDir, target.binary);
    copyFileSync(matches[0], destination);
    const destinationInspection = inspectWindowsSignature(destination);
    if (!destinationInspection.hasAuthenticode) {
      throw new Error(`Copied Windows binary lost its Authenticode certificate table: ${target.binary}.`);
    }
    accepted.push({ source: matches[0], destination, binary: target.binary });
  }
  return accepted;
}

function recursiveFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...recursiveFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const accepted = acceptSignedWindowsBinaries({
      sourceDir: optionValue(args, "--source"),
      destinationDir: optionValue(args, "--destination")
    });
    for (const entry of accepted) console.log(`Accepted signed Windows binary: ${entry.binary}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
