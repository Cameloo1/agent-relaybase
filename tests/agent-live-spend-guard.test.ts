import assert from "node:assert/strict";
import test from "node:test";
import { LiveSpendCapacityError, LiveSpendGuard } from "../src/agent/liveSpendGuard.ts";
import { resolveLivePhaseCostCeiling } from "../src/agent/liveAcceptance.ts";

test("live spend guard records unique runs and account deltas at ordered checkpoints", async () => {
  const usages = [2, 2.003, 2.006];
  const guard = new LiveSpendGuard(
    "test-key",
    0.08,
    async () => new Response(JSON.stringify({ data: { usage: usages.shift() } }), { status: 200 })
  );
  await guard.begin();
  guard.recordRun("run-1", usage("0.002"));
  guard.recordRun("run-1", usage("0.002"));
  const first = await guard.checkpoint("read-only");
  assert.equal(first.localKnownUsd, 0.002);
  assert.ok(Math.abs((first.accountDeltaUsd ?? 0) - 0.003) < 1e-9);

  guard.recordRun("run-2", usage("0.003"));
  const second = await guard.checkpoint("setup-preview");
  assert.equal(second.localKnownUsd, 0.005);
  assert.ok(Math.abs((second.accountDeltaUsd ?? 0) - 0.006) < 1e-9);
});

test("live spend guard stops when either local or account evidence exceeds the ceiling", async () => {
  const local = new LiveSpendGuard(
    "test-key",
    0.01,
    async () => new Response(JSON.stringify({ data: { usage: 1 } }), { status: 200 })
  );
  await local.begin();
  assert.throws(() => local.recordRun("run-1", usage("0.011")), /AGENT_LIVE_SPEND_LIMIT_EXCEEDED/);

  const accountUsages = [1, 1.02];
  const account = new LiveSpendGuard(
    "test-key",
    0.01,
    async () => new Response(JSON.stringify({ data: { usage: accountUsages.shift() } }), { status: 200 })
  );
  await account.begin();
  await assert.rejects(account.checkpoint("slice"), /AGENT_LIVE_SPEND_LIMIT_EXCEEDED/);
});

test("live spend guard reserves capacity before each provider request", async () => {
  const usages = [4, 4.068, 4.071];
  const guard = new LiveSpendGuard(
    "test-key",
    0.08,
    async () => new Response(JSON.stringify({ data: { usage: usages.shift() } }), { status: 200 })
  );
  await guard.begin();
  await guard.assertRequestCapacity("safe request", 0.01);
  let error: LiveSpendCapacityError | undefined;
  try {
    await guard.assertRequestCapacity("unsafe request", 0.01);
  } catch (caught) {
    assert.ok(caught instanceof LiveSpendCapacityError);
    error = caught;
  }
  assert.ok(error);
  assert.match(error.message, /AGENT_LIVE_SPEND_CAPACITY_EXHAUSTED/);
  assert.equal(error.checkpoint.label, "before:unsafe request");
  assert.ok(Math.abs((error.checkpoint.accountDeltaUsd ?? 0) - 0.071) < 1e-9);
});

function usage(costUsd: string) {
  return { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: Number(costUsd), costUsd };
}

test("live correctness ceiling defaults safely and accepts only bounded explicit overrides", () => {
  assert.equal(resolveLivePhaseCostCeiling({}), 0.08);
  assert.equal(resolveLivePhaseCostCeiling({ RELAYBASE_AGENT_LIVE_MAX_COST_USD: "0.10" }), 0.1);
  assert.throws(() => resolveLivePhaseCostCeiling({ RELAYBASE_AGENT_LIVE_MAX_COST_USD: "1.01" }), /no more than 1 USD/);
  assert.throws(
    () => resolveLivePhaseCostCeiling({ RELAYBASE_AGENT_LIVE_MAX_COST_USD: "not-a-number" }),
    /must be greater than 0/
  );
});
