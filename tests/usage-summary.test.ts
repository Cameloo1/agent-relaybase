import assert from "node:assert/strict";
import test from "node:test";
import { activeThreadUsageSnapshot } from "../src/agent/usageSummary.ts";
import type { AgentAuditEvent } from "../src/agent/types.ts";

function usageEvent(
  id: string,
  sessionId: string,
  at: string,
  usage: Record<string, unknown>,
  modelSlug = "openai/gpt-5.6-luna"
): AgentAuditEvent {
  return {
    id,
    sessionId,
    runId: `run-${id}`,
    at,
    type: "agent.usage_recorded",
    provider: "openrouter",
    modelSlug,
    data: { usage }
  };
}

test("active thread usage preserves exact tokens, decimal cost, provenance, and latest model", () => {
  const result = activeThreadUsageSnapshot("thread-a", [
    usageEvent("1", "thread-a", "2026-07-11T10:00:00.000Z", {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      estimatedCostUsd: 0.01
    }),
    usageEvent("other", "thread-b", "2026-07-11T11:00:00.000Z", {
      inputTokens: 999,
      outputTokens: 1,
      totalTokens: 1000,
      costUsd: "9",
      costSource: "provider_reported"
    }),
    usageEvent(
      "2",
      "thread-a",
      "2026-07-11T12:00:00.000Z",
      { inputTokens: 20, outputTokens: 7, costUsd: "0.0200001", costSource: "provider_reported" },
      "anthropic/claude-test"
    )
  ]);
  assert.equal(result.lastRequest?.modelSlug, "anthropic/claude-test");
  assert.deepEqual(result.lastRequest?.tokens, { input: 20, output: 7, total: 27, totalSource: "derived" });
  assert.deepEqual(result.threadTotals.tokens, { input: 30, output: 12, total: 42 });
  assert.equal(result.threadTotals.cost.knownUsd, "0.0300001");
  assert.deepEqual(result.threadTotals.cost.sources, ["estimated", "provider_reported"]);
});

test("active thread usage reports empty, unavailable, and ignores malformed records", () => {
  assert.equal(activeThreadUsageSnapshot(undefined, []).lastRequest, null);
  const result = activeThreadUsageSnapshot("thread-a", [
    usageEvent("bad", "thread-a", "2026-07-11T10:00:00.000Z", { inputTokens: -1, outputTokens: 1 }),
    usageEvent("ok", "thread-a", "2026-07-11T11:00:00.000Z", {
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      estimatedCostUsd: 0,
      costSource: "unavailable"
    })
  ]);
  assert.equal(result.threadTotals.requestCount, 1);
  assert.equal(result.threadTotals.cost.unavailableRequestCount, 1);
  assert.equal(result.lastRequest?.cost.source, "unavailable");
  assert.equal(result.lastRequest?.cost.usd, null);
});
