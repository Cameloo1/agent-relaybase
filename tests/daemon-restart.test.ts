import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRelaybaseServer } from "../src/server.ts";

test("daemon restart API binds preview, quiesces mutations, and closes the prepared instance", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-daemon-restart-api-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  await hub.listen();
  const port = hub.address().port;

  try {
    const discovery = await request(port, "GET", "/.well-known/mcp.json");
    assert.equal(discovery.statusCode, 200);
    const discoveryBody = JSON.parse(discovery.body) as {
      daemon?: { instanceId?: string; pid?: number; startedAt?: string };
    };
    assert.equal(discoveryBody.daemon?.instanceId, hub.runtime.instanceId);
    assert.equal(discoveryBody.daemon?.pid, process.pid);
    assert.equal(discoveryBody.daemon?.startedAt, hub.runtime.startedAt);

    const unauthorized = await request(port, "GET", "/__hub/api/daemon/restart-preview");
    assert.equal(unauthorized.statusCode, 401);

    const previewResponse = await request(
      port,
      "GET",
      "/__hub/api/daemon/restart-preview",
      undefined,
      hub.runtime.token
    );
    assert.equal(previewResponse.statusCode, 200);
    const previewBody = JSON.parse(previewResponse.body) as {
      restart: {
        preview: {
          instanceId: string;
          previewId: string;
          canRestart: boolean;
          blockers: unknown[];
          runningOwnedAppIds: string[];
        };
      };
    };
    const preview = previewBody.restart.preview;
    assert.equal(preview.instanceId, hub.runtime.instanceId);
    assert.equal(preview.canRestart, true);
    assert.deepEqual(preview.blockers, []);
    assert.deepEqual(preview.runningOwnedAppIds, []);

    const stale = await request(
      port,
      "POST",
      "/__hub/api/daemon/prepare-restart",
      {
        requestId: "restart_stale",
        expectedInstanceId: "different-instance",
        previewId: preview.previewId
      },
      hub.runtime.token
    );
    assert.equal(stale.statusCode, 409);
    assert.equal((JSON.parse(stale.body) as { code: string }).code, "DAEMON_RESTART_INSTANCE_CHANGED");

    const extraField = await request(
      port,
      "POST",
      "/__hub/api/daemon/prepare-restart",
      {
        requestId: "restart_extra",
        expectedInstanceId: preview.instanceId,
        previewId: preview.previewId,
        force: true
      },
      hub.runtime.token
    );
    assert.equal(extraField.statusCode, 400);
    assert.equal((JSON.parse(extraField.body) as { code: string }).code, "DAEMON_RESTART_BODY_INVALID");

    const binding = {
      requestId: "restart_acceptance",
      expectedInstanceId: preview.instanceId,
      previewId: preview.previewId
    };
    const preparedResponse = await request(
      port,
      "POST",
      "/__hub/api/daemon/prepare-restart",
      binding,
      hub.runtime.token
    );
    assert.equal(preparedResponse.statusCode, 200);
    const preparedBody = JSON.parse(preparedResponse.body) as {
      restart: { prepared: { requestId: string; instanceId: string; restoreAppIds: string[] } };
    };
    assert.equal(preparedBody.restart.prepared.requestId, binding.requestId);
    assert.equal(preparedBody.restart.prepared.instanceId, hub.runtime.instanceId);
    assert.deepEqual(preparedBody.restart.prepared.restoreAppIds, []);

    const quiescedMutation = await request(
      port,
      "POST",
      "/__hub/api/apps/unknown/start?async=1",
      undefined,
      hub.runtime.token
    );
    assert.equal(quiescedMutation.statusCode, 503);
    assert.equal((JSON.parse(quiescedMutation.body) as { code: string }).code, "DAEMON_RESTART_QUIESCING");

    const shutdownExtraField = await request(
      port,
      "POST",
      "/__hub/api/daemon/shutdown",
      { ...binding, confirm: true, force: true },
      hub.runtime.token
    );
    assert.equal(shutdownExtraField.statusCode, 400);
    assert.equal((JSON.parse(shutdownExtraField.body) as { code: string }).code, "DAEMON_RESTART_BODY_INVALID");

    const unconfirmed = await request(port, "POST", "/__hub/api/daemon/shutdown", binding, hub.runtime.token);
    assert.equal(unconfirmed.statusCode, 400);
    assert.equal((JSON.parse(unconfirmed.body) as { code: string }).code, "DAEMON_RESTART_CONFIRMATION_REQUIRED");

    const shutdown = await request(
      port,
      "POST",
      "/__hub/api/daemon/shutdown",
      { ...binding, confirm: true },
      hub.runtime.token
    );
    assert.equal(shutdown.statusCode, 202);
    await waitForUnavailable(port);
  } finally {
    await hub.close();
  }
});

test("daemon restart preview blocks active lifecycle work without quiescing the daemon", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-daemon-restart-blocker-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  await hub.listen();
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = hub.runtime.operations.enqueueLifecycle({
    operationType: "start",
    targetId: "held-app",
    correlationId: "restart-blocker-test",
    run: async () => held,
    evaluate: () => ({ status: "succeeded" })
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const previewResponse = await request(
      hub.address().port,
      "GET",
      "/__hub/api/daemon/restart-preview",
      undefined,
      hub.runtime.token
    );
    assert.equal(previewResponse.statusCode, 200);
    const preview = (
      JSON.parse(previewResponse.body) as {
        restart: { preview: { canRestart: boolean; blockers: Array<{ kind: string; id: string }> } };
      }
    ).restart.preview;
    assert.equal(preview.canRestart, false);
    assert.deepEqual(preview.blockers, [
      {
        kind: "lifecycle_operation",
        id: operation.operationId,
        status: "running",
        detail: { operationType: "start", targetId: "held-app" }
      }
    ]);
    assert.equal(hub.runtime.restart.quiescing, false);
  } finally {
    release?.();
    await operation.done;
    await hub.close();
  }
});

function request(
  port: number,
  method: string,
  requestPath: string,
  body?: unknown,
  token?: string
): Promise<{ statusCode: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: requestPath,
        headers: {
          ...(token ? { "x-relaybase-token": token } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    outgoing.once("error", reject);
    if (payload) {
      outgoing.write(payload);
    }
    outgoing.end();
  });
}

async function waitForUnavailable(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await request(port, "GET", "/.well-known/mcp.json");
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("prepared daemon did not release its listener");
}
