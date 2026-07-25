import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRelaybaseServer } from "../src/server.ts";

test("Agent security API is authenticated, no-store, preview-bound, idempotent, and secret-free", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-security-api-"));
  const previousKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await hub.listen();
    const port = hub.address().port;
    const unauthorized = await apiRequest(port, "GET", "/__hub/api/agent/security/status");
    assert.equal(unauthorized.statusCode, 401);

    const headers = { authorization: `Bearer ${hub.runtime.token}` };
    const status = await apiRequest(port, "GET", "/__hub/api/agent/security/status", undefined, headers);
    assert.equal(status.statusCode, 200);
    assert.match(status.headers["cache-control"] ?? "", /no-store/);
    assert.equal(status.json.agent.security.state, "blocked");
    assert.ok(
      status.json.agent.security.findings.some(
        (finding: { code: string }) => finding.code === "AGENT_CREDENTIAL_MISSING"
      )
    );

    const previewResponse = await apiRequest(
      port,
      "POST",
      "/__hub/api/agent/security/repair/preview",
      { actionIds: ["route_to_provider_connect"], issueCodes: ["AGENT_CREDENTIAL_MISSING"] },
      headers
    );
    assert.equal(previewResponse.statusCode, 200);
    const preview = previewResponse.json.agent.security.repair.preview;
    assert.equal(preview.actions[0].riskClass, "manual");
    const storedPreview = await apiRequest(
      port,
      "GET",
      `/__hub/api/agent/security/repair/previews/${preview.previewId}`,
      undefined,
      headers
    );
    assert.equal(storedPreview.statusCode, 200);
    assert.equal(storedPreview.json.agent.security.repair.preview.previewId, preview.previewId);

    const applyBody = {
      previewId: preview.previewId,
      idempotencyKey: "agent-security-api-idempotency",
      confirmation: preview.confirmation.value
    };
    const applied = await apiRequest(port, "POST", "/__hub/api/agent/security/repair/apply", applyBody, headers);
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json.agent.security.repair.operation.outcome, "blocked");
    assert.equal(applied.json.agent.security.repair.operation.requiresExternalAction, true);
    const operationId = applied.json.agent.security.repair.operation.operationId;

    const replay = await apiRequest(port, "POST", "/__hub/api/agent/security/repair/apply", applyBody, headers);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json.agent.security.repair.operation.operationId, operationId);

    const operation = await apiRequest(
      port,
      "GET",
      `/__hub/api/agent/security/repair/operations/${operationId}`,
      undefined,
      headers
    );
    assert.equal(operation.statusCode, 200);
    assert.equal(operation.json.agent.security.repair.operation.outcome, "blocked");
    const latestOperation = await apiRequest(
      port,
      "GET",
      "/__hub/api/agent/security/repair/operations/latest",
      undefined,
      headers
    );
    assert.equal(latestOperation.statusCode, 200);
    assert.equal(latestOperation.json.agent.security.repair.operation.operationId, operationId);

    const rejected = await apiRequest(
      port,
      "POST",
      "/__hub/api/agent/security/repair/preview",
      { actionIds: ["sk-or-fixture-should-never-travel"] },
      headers
    );
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json.code, "AGENT_RAW_API_KEY_NOT_ALLOWED");

    const transcript = [
      status.body,
      previewResponse.body,
      storedPreview.body,
      applied.body,
      replay.body,
      operation.body,
      latestOperation.body
    ].join("\n");
    assert.doesNotMatch(transcript, /sk-or-|OPENROUTER_API_KEY=/);
  } finally {
    await hub.close();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

function apiRequest(
  port: number,
  method: string,
  requestPath: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
}> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: {
          ...headers,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": String(payload.byteLength)
              }
            : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: responseBody,
            json: responseBody ? JSON.parse(responseBody) : {}
          });
        });
      }
    );
    request.once("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}
