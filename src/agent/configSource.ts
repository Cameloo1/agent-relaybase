import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseEnvFile, type RelaybaseEnvFileDiagnostic } from "../envFile.ts";

const DEFAULT_STABLE_READ_ATTEMPTS = 3;
const MAX_AGENT_CONFIG_SOURCE_BYTES = 1024 * 1024;

export const AGENT_EXTERNAL_CONFIG_KEYS = [
  "RELAYBASE_AGENT_ENABLED",
  "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED",
  "RELAYBASE_AGENT_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_TITLE"
] as const;

export interface StableAgentEnvironment {
  canonicalPath: string;
  values: Readonly<Record<string, string>>;
  fingerprint: string;
  size: number;
  modifiedMs: number;
}

export class AgentConfigSourceError extends Error {
  readonly code: "AGENT_CONFIG_SOURCE_UNAVAILABLE" | "AGENT_CONFIG_SOURCE_UNSTABLE" | "AGENT_CONFIG_RELOAD_INVALID";
  readonly diagnostics?: RelaybaseEnvFileDiagnostic[];

  constructor(
    code: AgentConfigSourceError["code"],
    message: string,
    options: { diagnostics?: RelaybaseEnvFileDiagnostic[] } = {}
  ) {
    super(message);
    this.code = code;
    this.diagnostics = options.diagnostics;
  }
}

export function canonicalAgentConfigPath(filePath: string): string {
  return path.resolve(filePath);
}

export async function readStableAgentEnvironment(
  filePath: string,
  options: { attempts?: number } = {}
): Promise<StableAgentEnvironment> {
  const canonicalPath = canonicalAgentConfigPath(filePath);
  const attempts = Math.max(1, Math.min(5, options.attempts ?? DEFAULT_STABLE_READ_ATTEMPTS));
  let lastReadChanged = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let before;
    try {
      before = await fs.stat(canonicalPath);
    } catch {
      throw new AgentConfigSourceError(
        "AGENT_CONFIG_SOURCE_UNAVAILABLE",
        "The selected Agent configuration source is unavailable."
      );
    }
    if (!before.isFile() || before.size > MAX_AGENT_CONFIG_SOURCE_BYTES) {
      throw new AgentConfigSourceError(
        "AGENT_CONFIG_RELOAD_INVALID",
        "The selected Agent configuration source is not a supported bounded file."
      );
    }

    let raw: string;
    try {
      raw = await fs.readFile(canonicalPath, "utf8");
    } catch {
      throw new AgentConfigSourceError(
        "AGENT_CONFIG_SOURCE_UNAVAILABLE",
        "The selected Agent configuration source could not be read."
      );
    }

    const after = await fs.stat(canonicalPath).catch(() => undefined);
    if (!after) {
      throw new AgentConfigSourceError(
        "AGENT_CONFIG_SOURCE_UNAVAILABLE",
        "The selected Agent configuration source disappeared while it was being read."
      );
    }
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      lastReadChanged = true;
      continue;
    }

    const parsed = parseEnvFile(raw);
    if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new AgentConfigSourceError(
        "AGENT_CONFIG_RELOAD_INVALID",
        "The selected Agent configuration source is invalid.",
        { diagnostics: parsed.diagnostics }
      );
    }

    const values: Record<string, string> = {};
    for (const entry of parsed.entries) {
      if ((AGENT_EXTERNAL_CONFIG_KEYS as readonly string[]).includes(entry.key)) {
        values[entry.key] = entry.value;
      }
    }
    return {
      canonicalPath,
      values: Object.freeze(values),
      fingerprint: createHash("sha256").update(raw).digest("hex"),
      size: after.size,
      modifiedMs: after.mtimeMs
    };
  }

  throw new AgentConfigSourceError(
    "AGENT_CONFIG_SOURCE_UNSTABLE",
    lastReadChanged
      ? "The selected Agent configuration source kept changing while it was being read."
      : "The selected Agent configuration source could not be read stably."
  );
}
