#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseStatusLines(output = "") {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      return {
        status,
        path: normalizeGitPath(rawPath),
        raw: line
      };
    });
}

export function evaluateStatus(entries, options = {}) {
  const allowed = [];
  const unexpected = [];
  for (const entry of entries) {
    if (options.allowReports && isReportPath(entry.path)) {
      allowed.push({ ...entry, reason: "allowed report path" });
      continue;
    }
    unexpected.push(entry);
  }
  return {
    clean: unexpected.length === 0,
    allowed,
    unexpected
  };
}

export function renderCleanWorktreeResult(result) {
  const lines = [];
  lines.push(`Relaybase worktree hygiene: ${result.clean ? "clean" : "dirty"}`);
  if (result.stderr.trim()) {
    lines.push("");
    lines.push("Git diagnostics:");
    lines.push(result.stderr.trim());
  }
  if (result.allowed.length) {
    lines.push("");
    lines.push("Allowed dirty paths:");
    for (const entry of result.allowed) {
      lines.push(`  ${entry.raw} (${entry.reason})`);
    }
  }
  if (result.unexpected.length) {
    lines.push("");
    lines.push("Unexpected dirty paths:");
    for (const entry of result.unexpected) {
      lines.push(`  ${entry.raw}`);
    }
    lines.push("");
    lines.push("Resolve, stage intentionally, or run from a clean/disposable checkout before release verification.");
  }
  return lines.join("\n");
}

export function runCleanWorktree(args = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(args);
  const spawn = options.spawn ?? spawnSync;
  const result = spawn("git", ["status", "--short", "--untracked-files=all"], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const status = result.status ?? (result.error ? 1 : 0);
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr =
    typeof result.stderr === "string" ? result.stderr : result.error?.message ? `${result.error.message}\n` : "";
  const entries = parseStatusLines(stdout);
  const evaluation = evaluateStatus(entries, { allowReports: parsed.allowReports });
  const payload = {
    generatedAt: new Date().toISOString(),
    command: "git status --short --untracked-files=all",
    status,
    clean: status === 0 && evaluation.clean,
    allowReports: parsed.allowReports,
    entries,
    allowed: evaluation.allowed,
    unexpected: evaluation.unexpected,
    stderr
  };

  if (parsed.writeStatus) {
    const outputPath = path.resolve(options.cwd ?? root, parsed.writeStatus);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  if (status !== 0) {
    console.error(`Relaybase worktree hygiene: git status failed with status ${status}.`);
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
    return status;
  }

  const rendered = renderCleanWorktreeResult({
    clean: evaluation.clean,
    allowed: evaluation.allowed,
    unexpected: evaluation.unexpected,
    stderr
  });
  if (evaluation.clean) {
    console.log(rendered);
    return 0;
  }

  console.error(rendered);
  return 1;
}

function parseArgs(args) {
  const parsed = {
    allowReports: false,
    writeStatus: ""
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--allow-reports") {
      parsed.allowReports = true;
    } else if (arg === "--write-status") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--write-status requires a path.");
      }
      parsed.writeStatus = value;
      index += 1;
    } else {
      throw new Error(`Unknown clean-worktree option: ${arg}`);
    }
  }
  return parsed;
}

function normalizeGitPath(value) {
  const renamed = value.includes(" -> ") ? (value.split(" -> ").at(-1) ?? value) : value;
  return renamed.replace(/^"|"$/g, "").replace(/\\/g, "/");
}

function isReportPath(value) {
  return value === "reports" || value.startsWith("reports/");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCleanWorktree();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
