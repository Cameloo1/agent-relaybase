import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const RELAYBASE_ENV_FILE_ENV = "RELAYBASE_ENV_FILE";

export interface RelaybaseEnvFileDiagnostic {
  severity: "warning" | "error";
  code: "ENV_FILE_NOT_FOUND" | "ENV_FILE_READ_FAILED" | "ENV_FILE_INVALID_LINE";
  message: string;
  line?: number;
}

export interface RelaybaseEnvFileLoadResult {
  loaded: boolean;
  path?: string;
  appliedKeys: string[];
  skippedKeys: string[];
  diagnostics: RelaybaseEnvFileDiagnostic[];
  sourceKind: "explicit_env_file" | "cwd_env_file";
  fingerprint?: string;
}

export interface RelaybaseEnvFileLoadOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  override?: boolean;
  filePath?: string;
}

export interface EnvEntry {
  key: string;
  value: string;
}

export interface ParsedEnvFile {
  entries: EnvEntry[];
  diagnostics: RelaybaseEnvFileDiagnostic[];
}

export function loadRelaybaseEnvFile(options: RelaybaseEnvFileLoadOptions = {}): RelaybaseEnvFileLoadResult {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configuredPath = options.filePath?.trim() || env[RELAYBASE_ENV_FILE_ENV]?.trim();
  const envPath = configuredPath ? path.resolve(cwd, configuredPath) : path.join(cwd, ".env");
  const explicit = Boolean(configuredPath);
  const result: RelaybaseEnvFileLoadResult = {
    loaded: false,
    path: envPath,
    appliedKeys: [],
    skippedKeys: [],
    diagnostics: [],
    sourceKind: explicit ? "explicit_env_file" : "cwd_env_file"
  };

  if (!fs.existsSync(envPath)) {
    if (explicit) {
      result.diagnostics.push({
        severity: "error",
        code: "ENV_FILE_NOT_FOUND",
        message: `${RELAYBASE_ENV_FILE_ENV} points to a missing env file.`
      });
    }
    return result;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    result.diagnostics.push({
      severity: "error",
      code: "ENV_FILE_READ_FAILED",
      message: "Relaybase could not read the configured env file."
    });
    return result;
  }

  const parsed = parseEnvFile(raw);
  result.diagnostics.push(...parsed.diagnostics);
  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return result;
  }

  for (const entry of parsed.entries) {
    if (!options.override && Object.prototype.hasOwnProperty.call(env, entry.key)) {
      result.skippedKeys.push(entry.key);
      continue;
    }
    env[entry.key] = entry.value;
    result.appliedKeys.push(entry.key);
  }

  result.loaded = true;
  result.fingerprint = createHash("sha256").update(raw).digest("hex");
  return result;
}

export function relaybaseModelSource(result: RelaybaseEnvFileLoadResult, env: NodeJS.ProcessEnv = process.env) {
  if (!env.RELAYBASE_AGENT_MODEL?.trim()) {
    return { kind: "unconfigured" as const, label: "not configured" };
  }
  if (result.appliedKeys.includes("RELAYBASE_AGENT_MODEL")) {
    return {
      kind: result.sourceKind,
      label: result.sourceKind === "explicit_env_file" ? "RELAYBASE_ENV_FILE" : ".env"
    };
  }
  return { kind: "shell_environment" as const, label: "shell environment" };
}

export function formatRelaybaseEnvFileDiagnostics(result: RelaybaseEnvFileLoadResult): string {
  const envPath = result.path ?? ".env";
  const details = result.diagnostics
    .map((diagnostic) => {
      const location = diagnostic.line === undefined ? envPath : `${envPath}:${diagnostic.line}`;
      return `${location} ${diagnostic.code}: ${diagnostic.message}`;
    })
    .join("\n");
  return `Relaybase .env loading failed.\n${details}`;
}

export function parseEnvFile(raw: string): ParsedEnvFile {
  const entries: EnvEntry[] = [];
  const diagnostics: RelaybaseEnvFileDiagnostic[] = [];
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const original = lines[index] ?? "";
    const trimmed = original.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex <= 0) {
      diagnostics.push(invalidLine(lineNumber, "Expected KEY=value syntax."));
      continue;
    }

    const key = withoutExport.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      diagnostics.push(invalidLine(lineNumber, "Environment variable name is invalid."));
      continue;
    }

    const valueResult = parseEnvValue(withoutExport.slice(equalsIndex + 1), lineNumber);
    if (valueResult.diagnostic) {
      diagnostics.push(valueResult.diagnostic);
      continue;
    }
    entries.push({ key, value: valueResult.value });
  }

  return { entries, diagnostics };
}

function parseEnvValue(
  rawValue: string,
  lineNumber: number
): { value: string; diagnostic?: RelaybaseEnvFileDiagnostic } {
  const leftTrimmed = rawValue.trimStart();
  if (!leftTrimmed) {
    return { value: "" };
  }

  const quote = leftTrimmed[0];
  if (quote === '"' || quote === "'") {
    const end = findClosingQuote(leftTrimmed, quote);
    if (end === -1) {
      return { value: "", diagnostic: invalidLine(lineNumber, "Quoted value is missing a closing quote.") };
    }
    const trailing = leftTrimmed.slice(end + 1).trim();
    if (trailing && !trailing.startsWith("#")) {
      return { value: "", diagnostic: invalidLine(lineNumber, "Unexpected characters after quoted value.") };
    }
    const value = leftTrimmed.slice(1, end);
    return { value: quote === '"' ? unescapeDoubleQuotedValue(value) : value };
  }

  return { value: stripInlineComment(leftTrimmed).trim() };
}

function findClosingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) {
      continue;
    }
    if (quote === '"' && value[index - 1] === "\\") {
      continue;
    }
    return index;
  }
  return -1;
}

function unescapeDoubleQuotedValue(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function stripInlineComment(value: string): string {
  const comment = value.match(/\s+#/);
  return comment?.index === undefined ? value : value.slice(0, comment.index);
}

function invalidLine(line: number, message: string): RelaybaseEnvFileDiagnostic {
  return {
    severity: "error",
    code: "ENV_FILE_INVALID_LINE",
    message,
    line
  };
}
