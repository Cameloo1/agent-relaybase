import type { AgentAuditEvent, AgentProvider, AgentUsageSnapshot } from "./types.ts";

const COST_SCALE = 12;
const COST_FACTOR = 10n ** BigInt(COST_SCALE);

type UsageRecord = {
  event: AgentAuditEvent;
  input: number;
  output: number;
  total: number;
  totalSource: "provider_reported" | "derived";
  costUsd: string | null;
  costSource: "provider_reported" | "estimated" | "unavailable";
};

export function activeThreadUsageSnapshot(
  sessionId: string | undefined,
  events: AgentAuditEvent[]
): AgentUsageSnapshot {
  const records = sessionId
    ? events
        .filter((event) => event.type === "agent.usage_recorded" && event.sessionId === sessionId)
        .map(normalizeUsageRecord)
        .filter((record): record is UsageRecord => record !== undefined)
        .sort((left, right) => Date.parse(left.event.at) - Date.parse(right.event.at))
    : [];
  const last = records.at(-1);
  let input = 0;
  let output = 0;
  let total = 0;
  let knownCost = 0n;
  let knownRequestCount = 0;
  let unavailableRequestCount = 0;
  const sources = new Set<"provider_reported" | "estimated">();
  for (const record of records) {
    input = safeTokenSum(input, record.input);
    output = safeTokenSum(output, record.output);
    total = safeTokenSum(total, record.total);
    if (record.costUsd === null) {
      unavailableRequestCount++;
      continue;
    }
    knownCost += decimalToScaled(record.costUsd);
    knownRequestCount++;
    if (record.costSource !== "unavailable") sources.add(record.costSource);
  }
  return {
    scope: "active-thread",
    sessionId: sessionId ?? null,
    lastRequest: last
      ? {
          runId: last.event.runId ?? "",
          modelSlug: last.event.modelSlug ?? "unknown",
          provider: (last.event.provider ?? "openrouter") as AgentProvider,
          completedAt: last.event.at,
          tokens: {
            input: last.input,
            output: last.output,
            total: last.total,
            totalSource: last.totalSource
          },
          cost: { usd: last.costUsd, source: last.costSource }
        }
      : null,
    threadTotals: {
      requestCount: records.length,
      tokens: { input, output, total },
      cost: {
        knownUsd: scaledToDecimal(knownCost),
        knownRequestCount,
        unavailableRequestCount,
        sources: [...sources].sort()
      }
    },
    updatedAt: last?.event.at ?? null
  };
}

function normalizeUsageRecord(event: AgentAuditEvent): UsageRecord | undefined {
  const data = objectValue(event.data);
  const usage = objectValue(data.usage);
  const input = tokenInteger(usage.inputTokens);
  const output = tokenInteger(usage.outputTokens);
  const providerTotal = tokenInteger(usage.totalTokens);
  if (input === undefined || output === undefined) return undefined;
  const derived = safeTokenSum(input, output);
  const total = providerTotal ?? derived;
  const explicitCost = decimalString(usage.costUsd);
  const legacyCost = decimalString(usage.estimatedCostUsd);
  const explicitSource = usage.costSource;
  const costUsd = explicitSource === "unavailable" ? null : (explicitCost ?? legacyCost);
  const costSource =
    explicitSource === "unavailable"
      ? "unavailable"
      : explicitSource === "provider_reported" || explicitSource === "estimated"
        ? explicitSource
        : explicitCost !== null
          ? "provider_reported"
          : legacyCost !== null
            ? "estimated"
            : "unavailable";
  return {
    event,
    input,
    output,
    total,
    totalSource: providerTotal === undefined ? "derived" : "provider_reported",
    costUsd,
    costSource
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function tokenInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeTokenSum(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("AGENT_USAGE_TOKEN_OVERFLOW");
  return value;
}

function decimalString(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    return normalizeDecimal(String(value));
  }
  return typeof value === "string" ? normalizeDecimal(value) : null;
}

function normalizeDecimal(value: string): string | null {
  const match = /^\+?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  if ((match[2]?.length ?? 0) > COST_SCALE) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function decimalToScaled(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const padded = (fraction + "0".repeat(COST_SCALE)).slice(0, COST_SCALE);
  return BigInt(whole) * COST_FACTOR + BigInt(padded);
}

function scaledToDecimal(value: bigint): string {
  const whole = value / COST_FACTOR;
  const fraction = (value % COST_FACTOR).toString().padStart(COST_SCALE, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
