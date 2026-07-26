import { sanitizeErrorDetail } from "../apiErrors.ts";
import type { AgentConfig, AgentDiagnostic } from "./types.ts";
import { OpenRouterProviderError } from "./openrouterProvider.ts";

const SECRET_VALUE_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: "openrouter_api_key", pattern: /\bsk-or-[A-Za-z0-9._-]+/g },
  {
    category: "openrouter_key_url",
    pattern: /https?:\/\/openrouter\.ai\/workspaces\/[^\s,;)"']+\/keys\/[^\s,;)"']+/gi
  },
  { category: "api_key", pattern: /\bsk-[A-Za-z0-9._-]{12,}/g },
  { category: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi },
  { category: "session_value", pattern: /\b(cookie|session|authorization)(\s*[:=]\s*)([^\s;,]+)/gi },
  {
    category: "secret_assignment",
    pattern: /\b(token|secret|password|api[_-]?key|auth[_-]?token)(\s*[:=]\s*)([^\s;,]+)/gi
  },
  { category: "private_registry_token", pattern: /\/\/([^/\s:]+):_authToken=([^\s]+)/gi }
];

export interface AgentRedactionReport {
  totalReplacements: number;
  categories: Record<string, number>;
}

export class AgentRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly userAction?: string;
  readonly detail?: unknown;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; userAction?: string; detail?: unknown } = {}
  ) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.userAction = options.userAction;
    this.detail = sanitizeErrorDetail(options.detail);
  }
}

export function diagnosticsForAgentConfig(config: AgentConfig): AgentDiagnostic[] {
  const now = new Date().toISOString();
  const diagnostics: AgentDiagnostic[] = [];
  if (!config.enabled) {
    diagnostics.push({
      id: "agent.config.disabled",
      severity: "error",
      code: "AGENT_DISABLED",
      message: "Relaybase Operator Agent is disabled.",
      checkedAt: now,
      userAction: "Enable the Agent in Settings > Agent > Configuration."
    });
  }
  if (!config.provider.remoteModelEnabled) {
    diagnostics.push({
      id: "agent.config.remote_model_disabled",
      severity: "error",
      code: "AGENT_REMOTE_MODEL_DISABLED",
      message: "Relaybase Operator Agent remote model mode is disabled.",
      checkedAt: now,
      userAction: "Enable remote model access in Settings > Agent > Configuration."
    });
  }
  if (!config.provider.apiKeySource.configured) {
    diagnostics.push({
      id: "agent.config.credential_missing",
      severity: "error",
      code: "AGENT_CREDENTIAL_MISSING",
      message: "No usable OpenRouter credential is connected.",
      checkedAt: now,
      userAction: "Connect OpenRouter in Settings > Agent > Provider."
    });
  }
  if (!config.provider.modelSlug) {
    diagnostics.push({
      id: "agent.config.model_missing",
      severity: "error",
      code: "AGENT_MODEL_MISSING",
      message: "No OpenRouter model slug is configured.",
      checkedAt: now,
      userAction: "Choose a model in Settings > Agent > Configuration."
    });
  }
  return diagnostics;
}

export function diagnosticFromRuntimeError(error: unknown, modelSlug?: string): AgentDiagnostic {
  const now = new Date().toISOString();
  if (error instanceof AgentRuntimeError) {
    return {
      id: `agent.runtime.${error.code.toLowerCase()}`,
      severity: "error",
      code: error.code,
      message: redactAgentText(error.message),
      checkedAt: now,
      ...(error.userAction ? { userAction: error.userAction } : {}),
      detail: sanitizeErrorDetail({ provider: "openrouter", modelSlug: modelSlug ?? null, detail: error.detail })
    };
  }
  if (error instanceof OpenRouterProviderError) {
    return {
      id: `agent.provider.${error.code.toLowerCase()}`,
      severity: "error",
      code: error.code,
      message: redactAgentText(error.message),
      checkedAt: now,
      userAction: error.userAction,
      detail: sanitizeErrorDetail({ provider: "openrouter", modelSlug: modelSlug ?? null, detail: error.detail })
    };
  }

  const sanitized = sanitizeErrorDetail(error);
  const message =
    sanitized && typeof sanitized === "object" && "message" in sanitized
      ? String((sanitized as { message: unknown }).message)
      : String(sanitized);
  return {
    id: "agent.runtime.provider_error",
    severity: "error",
    code: "AGENT_PROVIDER_ERROR",
    message: redactAgentText(message),
    checkedAt: now,
    userAction: "Review provider configuration and retry the request.",
    detail: sanitizeErrorDetail({ provider: "openrouter", modelSlug: modelSlug ?? null })
  };
}

export function redactAgentText(value: string, knownSecrets: string[] = []): string {
  return redactAgentTextWithReport(value, knownSecrets).text;
}

export function redactAgentTextWithReport(
  value: string,
  knownSecrets: string[] = []
): { text: string; report: AgentRedactionReport } {
  let output = String(sanitizeErrorDetail(value));
  const report = emptyRedactionReport();
  for (const secret of knownSecrets) {
    if (secret) {
      const count = output.split(secret).length - 1;
      addRedactionCount(report, "known_secret", count);
      output = output.split(secret).join("[redacted]");
    }
  }
  output = output.replace(
    /\b[A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key|auth[_-]?token)[A-Za-z0-9_.-]*(\s*[:=]\s*)([^\s;,]+)/gi,
    (match: string, separator: string) => {
      addRedactionCount(report, "secret_assignment", 1);
      const key = match.slice(0, match.indexOf(separator));
      return `${key}${separator}[redacted]`;
    }
  );
  for (const { category, pattern } of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (match: string, key?: unknown, separator?: unknown) => {
      addRedactionCount(report, category, 1);
      if (
        (category === "session_value" || category === "secret_assignment") &&
        typeof key === "string" &&
        typeof separator === "string"
      ) {
        return `${key}${separator}[redacted]`;
      }
      if (/^Bearer\s/i.test(match)) {
        return "Bearer [redacted]";
      }
      if (match.includes(":_authToken=")) {
        return match.replace(/:_authToken=.*/i, ":_authToken=[redacted]");
      }
      return "[redacted]";
    });
    pattern.lastIndex = 0;
  }
  return { text: output, report };
}

export function sanitizeAgentPayload<T>(value: T, knownSecrets: string[] = []): T {
  return sanitizeAgentPayloadWithReport(value, knownSecrets).value;
}

export function sanitizeAgentPayloadWithReport<T>(
  value: T,
  knownSecrets: string[] = []
): { value: T; report: AgentRedactionReport } {
  const sanitized = sanitizeErrorDetail(value);
  const report = emptyRedactionReport();
  return { value: redactKnownSecrets(sanitized, knownSecrets, 0, report) as T, report };
}

function redactKnownSecrets(
  value: unknown,
  knownSecrets: string[],
  depth: number,
  report: AgentRedactionReport
): unknown {
  if (value === undefined || value === null || depth > 8) {
    return value;
  }
  if (typeof value === "string") {
    const redacted = redactAgentTextWithReport(value, knownSecrets);
    mergeRedactionReport(report, redacted.report);
    return redacted.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactKnownSecrets(item, knownSecrets, depth + 1, report));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        redactKnownSecrets(nested, knownSecrets, depth + 1, report)
      ])
    );
  }
  return value;
}

export function emptyRedactionReport(): AgentRedactionReport {
  return { totalReplacements: 0, categories: {} };
}

export function mergeRedactionReport(target: AgentRedactionReport, source: AgentRedactionReport): AgentRedactionReport {
  target.totalReplacements += source.totalReplacements;
  for (const [category, count] of Object.entries(source.categories)) {
    target.categories[category] = (target.categories[category] ?? 0) + count;
  }
  return target;
}

function addRedactionCount(report: AgentRedactionReport, category: string, count: number): void {
  if (count <= 0) {
    return;
  }
  report.totalReplacements += count;
  report.categories[category] = (report.categories[category] ?? 0) + count;
}
