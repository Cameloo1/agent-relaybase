import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { DaemonEvent } from "../src/apiTypes.ts";
import { createRelaybaseServer, type RelaybaseServer } from "../src/server.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("unregister preview is authenticated, explicit, and reports preserved evidence", async () => {
  const fixture = await unregisterFixture("preview");
  try {
    const unauthorized = await apiRequest(
      fixture.hub.address().port,
      "GET",
      `/__hub/api/apps/${fixture.appId}/unregister`
    );
    assert.equal(unauthorized.statusCode, 401);

    const previewResponse = await authenticatedRequest(
      fixture.hub,
      "GET",
      `/__hub/api/apps/${fixture.appId}/unregister`
    );
    assert.equal(previewResponse.statusCode, 200);
    const preview = JSON.parse(previewResponse.body).preview;
    assert.equal(preview.app.id, fixture.appId);
    assert.equal(preview.runtimeStatus, "stopped");
    assert.equal(preview.canUnregister, true);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.app.manifestPath, fixture.manifestPath);
    assert.deepEqual(preview.preserved, {
      projectFiles: true,
      manifest: true,
      logs: true,
      operationHistory: true
    });

    const unconfirmed = await authenticatedRequest(fixture.hub, "POST", `/__hub/api/apps/${fixture.appId}/unregister`, {
      confirm: false
    });
    assert.equal(unconfirmed.statusCode, 400);
    assert.equal(JSON.parse(unconfirmed.body).code, "APP_UNREGISTER_CONFIRMATION_REQUIRED");
    assert.ok(await fixture.hub.runtime.registry.get(fixture.appId));
  } finally {
    await fixture.hub.close();
  }
});

test("unregister fails closed for running apps and saved package references", async () => {
  const fixture = await unregisterFixture("blocked", true);
  try {
    await fixture.hub.runtime.processes.start(fixture.appId);
    const runningPreview = await authenticatedRequest(
      fixture.hub,
      "GET",
      `/__hub/api/apps/${fixture.appId}/unregister`
    );
    assert.equal(runningPreview.statusCode, 200);
    assert.equal(JSON.parse(runningPreview.body).preview.canUnregister, false);
    assert.ok(
      JSON.parse(runningPreview.body).preview.blockers.some(
        (value: { code: string }) => value.code === "APP_NOT_STOPPED"
      )
    );

    const runningApply = await authenticatedRequest(
      fixture.hub,
      "POST",
      `/__hub/api/apps/${fixture.appId}/unregister`,
      { confirm: true }
    );
    assert.equal(runningApply.statusCode, 409);
    assert.ok(await fixture.hub.runtime.registry.get(fixture.appId));
    await fixture.hub.runtime.processes.stop(fixture.appId);

    const definition = await fixture.hub.runtime.packages.createDefinition({
      name: "blocked-package",
      members: [fixture.appId]
    });
    const packagePreview = await authenticatedRequest(
      fixture.hub,
      "GET",
      `/__hub/api/apps/${fixture.appId}/unregister`
    );
    const packageBody = JSON.parse(packagePreview.body).preview;
    assert.equal(packageBody.canUnregister, false);
    assert.deepEqual(packageBody.packageReferences, [{ id: definition.id, name: definition.name }]);
    assert.ok(packageBody.blockers.some((value: { code: string }) => value.code === "PACKAGE_REFERENCE_ACTIVE"));
  } finally {
    await fixture.hub.close();
  }
});

test("unregister apply rechecks lifecycle races under an exclusive target gate", async () => {
  const fixture = await unregisterFixture("race");
  let release: (() => void) | undefined;
  try {
    const initialPreview = await authenticatedRequest(
      fixture.hub,
      "GET",
      `/__hub/api/apps/${fixture.appId}/unregister`
    );
    assert.equal(JSON.parse(initialPreview.body).preview.canUnregister, true);

    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = fixture.hub.runtime.operations.enqueueLifecycle({
      operationType: "start",
      targetId: fixture.appId,
      correlationId: "unregister-race",
      run: async () => {
        await blocked;
        return { settled: true };
      },
      evaluate: () => ({ status: "succeeded" })
    });

    const racedApply = await authenticatedRequest(fixture.hub, "POST", `/__hub/api/apps/${fixture.appId}/unregister`, {
      confirm: true
    });
    assert.equal(racedApply.statusCode, 409);
    assert.equal(JSON.parse(racedApply.body).code, "APP_UNREGISTER_OPERATION_ACTIVE");
    assert.ok(await fixture.hub.runtime.registry.get(fixture.appId));
    release();
    await operation.done;
  } finally {
    release?.();
    await fixture.hub.close();
  }
});

test("successful unregister removes only registry state and publishes a safe event", async () => {
  const fixture = await unregisterFixture("success");
  const retainedLogDir = path.join(fixture.stateDir, "logs", fixture.appId);
  const retainedLog = path.join(retainedLogDir, "retained.log");
  const events: DaemonEvent[] = [];
  const unsubscribe = fixture.hub.runtime.events.subscribe((event) => events.push(event));
  try {
    await fs.mkdir(retainedLogDir, { recursive: true });
    await fs.writeFile(retainedLog, "retained evidence\n", "utf8");
    fixture.hub.runtime.operations.recordEvidence({
      kind: "registration_verification",
      targetId: fixture.appId,
      correlationId: "retained-operation",
      status: "succeeded",
      result: { verified: true }
    });

    const response = await authenticatedRequest(fixture.hub, "POST", `/__hub/api/apps/${fixture.appId}/unregister`, {
      confirm: true
    });
    assert.equal(response.statusCode, 200);
    const result = JSON.parse(response.body).result;
    assert.equal(result.unregistered, true);
    assert.equal(result.app.id, fixture.appId);
    assert.equal(await fixture.hub.runtime.registry.get(fixture.appId), undefined);
    assert.equal(await fs.readFile(fixture.manifestPath, "utf8"), "{}\n");
    assert.equal(await fs.readFile(retainedLog, "utf8"), "retained evidence\n");
    assert.ok(fixture.hub.runtime.operations.list({ targetId: fixture.appId }).length > 0);

    const event = events.find((candidate) => candidate.type === "app.unregistered");
    assert.equal(event?.appId, fixture.appId);
    assert.deepEqual((event?.data as { preserved?: unknown }).preserved, result.preserved);
    assert.equal(JSON.stringify(event).includes(fixture.hub.runtime.token), false);
  } finally {
    unsubscribe();
    await fixture.hub.close();
  }
});

async function unregisterFixture(
  name: string,
  managed = false
): Promise<{
  hub: RelaybaseServer;
  appId: string;
  stateDir: string;
  manifestPath: string;
}> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `relaybase-unregister-${name}-`));
  const project = path.join(stateDir, "project");
  const manifestPath = path.join(project, "relaybase.app.json");
  const appId = `unregister-${name}`;
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(manifestPath, "{}\n", "utf8");
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
  await hub.runtime.registry.upsertManifest(
    {
      id: appId,
      name: `Unregister ${name}`,
      command: managed ? `"${process.execPath}" --experimental-strip-types "${fixture}"` : "external",
      cwd: project,
      protocol: "http",
      ...(managed ? { healthUrl: "/health" } : {})
    },
    { manifestPath }
  );
  await hub.listen();
  return { hub, appId, stateDir, manifestPath };
}

function authenticatedRequest(
  hub: RelaybaseServer,
  method: string,
  pathName: string,
  body?: unknown
): Promise<{ statusCode: number; body: string }> {
  return apiRequest(hub.address().port, method, pathName, body, { "x-relaybase-token": hub.runtime.token });
}

function apiRequest(
  port: number,
  method: string,
  pathName: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          host: "localhost",
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
            : {}),
          ...headers
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () =>
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}
