import type { AgentExecutionPolicy, AgentReasoningEffort } from "./types.ts";

export const DEFAULT_AGENT_EXECUTION_POLICY: AgentExecutionPolicy = Object.freeze({
  segmentMaxTurns: 8,
  totalMaxTurns: 32,
  inactivityTimeoutMs: 120_000,
  hardRunTimeoutMs: 15 * 60_000,
  maxOutputTokens: 4096,
  reasoningEffort: "medium",
  noProgressRepeatLimit: 3
});

export const AGENT_EXECUTION_LIMITS = Object.freeze({
  segmentMaxTurns: { min: 1, max: 32 },
  totalMaxTurns: { min: 1, max: 128 },
  inactivityTimeoutMs: { min: 10_000, max: 10 * 60_000 },
  hardRunTimeoutMs: { min: 30_000, max: 60 * 60_000 },
  maxOutputTokens: { min: 256, max: 32_768 },
  noProgressRepeatLimit: { min: 2, max: 10 }
});

export function normalizeAgentExecutionPolicy(
  value: unknown,
  fallback: AgentExecutionPolicy = DEFAULT_AGENT_EXECUTION_POLICY
): AgentExecutionPolicy {
  const input = objectValue(value);
  const segmentMaxTurns = boundedInteger(
    input.segmentMaxTurns,
    fallback.segmentMaxTurns,
    AGENT_EXECUTION_LIMITS.segmentMaxTurns
  );
  const totalMaxTurns = Math.max(
    segmentMaxTurns,
    boundedInteger(input.totalMaxTurns, fallback.totalMaxTurns, AGENT_EXECUTION_LIMITS.totalMaxTurns)
  );
  const inactivityTimeoutMs = boundedInteger(
    input.inactivityTimeoutMs,
    fallback.inactivityTimeoutMs,
    AGENT_EXECUTION_LIMITS.inactivityTimeoutMs
  );
  const hardRunTimeoutMs = Math.max(
    inactivityTimeoutMs,
    boundedInteger(input.hardRunTimeoutMs, fallback.hardRunTimeoutMs, AGENT_EXECUTION_LIMITS.hardRunTimeoutMs)
  );
  return {
    segmentMaxTurns,
    totalMaxTurns,
    inactivityTimeoutMs,
    hardRunTimeoutMs,
    maxOutputTokens: boundedInteger(
      input.maxOutputTokens,
      fallback.maxOutputTokens,
      AGENT_EXECUTION_LIMITS.maxOutputTokens
    ),
    reasoningEffort: reasoningEffort(input.reasoningEffort, fallback.reasoningEffort),
    noProgressRepeatLimit: boundedInteger(
      input.noProgressRepeatLimit,
      fallback.noProgressRepeatLimit,
      AGENT_EXECUTION_LIMITS.noProgressRepeatLimit
    )
  };
}

export function invalidAgentExecutionPolicy(
  value: unknown,
  fallback: AgentExecutionPolicy = DEFAULT_AGENT_EXECUTION_POLICY
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "execution must be an object.";
  }
  const input = value as Record<string, unknown>;
  for (const key of [
    "segmentMaxTurns",
    "totalMaxTurns",
    "inactivityTimeoutMs",
    "hardRunTimeoutMs",
    "maxOutputTokens",
    "noProgressRepeatLimit"
  ] as const) {
    if (input[key] === undefined) {
      continue;
    }
    const limit = AGENT_EXECUTION_LIMITS[key];
    if (!Number.isInteger(input[key]) || Number(input[key]) < limit.min || Number(input[key]) > limit.max) {
      return `${key} must be an integer between ${limit.min} and ${limit.max}.`;
    }
  }
  if (
    input.reasoningEffort !== undefined &&
    input.reasoningEffort !== "low" &&
    input.reasoningEffort !== "medium" &&
    input.reasoningEffort !== "high"
  ) {
    return 'reasoningEffort must be "low", "medium", or "high".';
  }
  const segmentMaxTurns =
    input.segmentMaxTurns === undefined ? fallback.segmentMaxTurns : Number(input.segmentMaxTurns);
  const totalMaxTurns = input.totalMaxTurns === undefined ? fallback.totalMaxTurns : Number(input.totalMaxTurns);
  if (totalMaxTurns < segmentMaxTurns) {
    return "totalMaxTurns must be greater than or equal to segmentMaxTurns.";
  }
  const inactivityTimeoutMs =
    input.inactivityTimeoutMs === undefined ? fallback.inactivityTimeoutMs : Number(input.inactivityTimeoutMs);
  const hardRunTimeoutMs =
    input.hardRunTimeoutMs === undefined ? fallback.hardRunTimeoutMs : Number(input.hardRunTimeoutMs);
  if (hardRunTimeoutMs < inactivityTimeoutMs) {
    return "hardRunTimeoutMs must be greater than or equal to inactivityTimeoutMs.";
  }
  return undefined;
}

function boundedInteger(value: unknown, fallback: number, limits: { min: number; max: number }): number {
  return Number.isInteger(value) && Number(value) >= limits.min && Number(value) <= limits.max
    ? Number(value)
    : fallback;
}

function reasoningEffort(value: unknown, fallback: AgentReasoningEffort): AgentReasoningEffort {
  return value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
