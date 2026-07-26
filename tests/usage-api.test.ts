import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRelaybaseServer } from "../src/server.ts";

test("usage API is token gated, active-thread scoped, and returns a stable empty snapshot", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-usage-api-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await hub.listen();
    const base = `http://127.0.0.1:${hub.address().port}`;
    const unauthorized = await fetch(`${base}/__hub/api/agent/usage?scope=active-thread`);
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${base}/__hub/api/agent/usage?scope=active-thread`, {
      headers: { authorization: `Bearer ${hub.runtime.token}` }
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.agent.usage.scope, "active-thread");
    assert.equal(body.agent.usage.sessionId, null);
    assert.equal(body.agent.usage.lastRequest, null);
    assert.deepEqual(body.agent.usage.threadTotals.tokens, { input: 0, output: 0, total: 0 });
    const invalid = await fetch(`${base}/__hub/api/agent/usage?scope=account`, {
      headers: { authorization: `Bearer ${hub.runtime.token}` }
    });
    assert.equal(invalid.status, 400);
  } finally {
    await hub.close();
  }
});
