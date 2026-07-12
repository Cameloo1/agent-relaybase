import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LifecycleOperation } from "../src/apiTypes.ts";
import { handleAppPackageApiRequest } from "../src/appPackageApi.ts";
import { AppPackageService, type EnqueuePackageMemberLifecycle } from "../src/appPackageService.ts";
import { AppPackageStore } from "../src/appPackageStore.ts";
import { Registry } from "../src/registry.ts";
import type { AppRecord, AppStatusView } from "../src/types.ts";

test("app package definitions preserve ordered members and survive reopen", async () => {
  const stateDir = await tempStateDir();
  const registry = await registryWithApps(stateDir, [
    { id: "operations-dashboard", name: "Operations Dashboard" },
    { id: "credential-manager", name: "Credential Manager" }
  ]);
  const service = serviceFor(stateDir, registry);

  const definition = await service.createDefinition({
    name: "operations-stack",
    members: ["Operations Dashboard", "credential-manager"]
  });
  assert.deepEqual(definition.memberAppIds, ["operations-dashboard", "credential-manager"]);
  await service.shutdown();

  const reopened = serviceFor(stateDir, registry);
  assert.deepEqual(reopened.listDefinitions(), [definition]);
  await assert.rejects(
    () => reopened.createDefinition({ name: "OPERATIONS-STACK", members: ["credential-manager"] }),
    (error: unknown) => hasCode(error, "PACKAGE_NAME_CONFLICT")
  );
  await reopened.shutdown();
});

test("app package names reject invisible and command-flag values", async () => {
  const stateDir = await tempStateDir();
  const registry = await registryWithApps(stateDir, [{ id: "a", name: "App A" }]);
  const service = serviceFor(stateDir, registry);
  await assert.rejects(
    () => service.createDefinition({ name: "\u200b", members: ["App A"] }),
    (error: unknown) => hasCode(error, "PACKAGE_NAME_INVALID")
  );
  for (const name of ["--confirm", "confirm=true", "--dry-run", "--dryrun", "dryrun=true", "dry-run=true"]) {
    await assert.rejects(
      () => service.createDefinition({ name, members: ["App A"] }),
      (error: unknown) => hasCode(error, "PACKAGE_NAME_RESERVED")
    );
  }
  await service.shutdown();
});

test("app package store reconciles interrupted runs without relaunching", async () => {
  const stateDir = await tempStateDir();
  const store = new AppPackageStore(stateDir);
  const definition = store.createDefinition("stack", "stack", ["a", "b"]);
  const run = store.createRun(definition, [
    { ordinal: 0, appId: "a" },
    { ordinal: 1, appId: "b" }
  ]);
  store.updateRunStatus(run.id, "running");
  store.updateRunMember(run.id, 0, { state: "starting", startedAt: new Date().toISOString() });
  store.close();

  const reopened = new AppPackageStore(stateDir);
  const recovered = reopened.getRun(run.id);
  assert.equal(recovered?.status, "interrupted");
  assert.deepEqual(
    recovered?.members.map((member) => [member.state, member.retryable]),
    [
      ["interrupted", true],
      ["skipped_interrupted", true]
    ]
  );
  reopened.close();
});

test("package launch preflights every member before making lifecycle calls", async () => {
  const stateDir = await tempStateDir();
  const registry = await registryWithApps(stateDir, [
    { id: "a", name: "A" },
    { id: "b", name: "B" }
  ]);
  let calls = 0;
  const service = serviceFor(stateDir, registry, {
    enqueueLifecycle: () => {
      calls += 1;
      return succeededHandle("unexpected");
    }
  });
  const definition = await service.createDefinition({ name: "stack", members: ["A", "B"] });
  await registry.remove("b");

  const queued = service.launch(definition.id, "preflight-test");
  const run = await service.waitForRun(queued.id);
  assert.equal(calls, 0);
  assert.equal(run.status, "failed");
  assert.deepEqual(
    run.members.map((member) => member.state),
    ["skipped_preflight", "failed"]
  );
  await service.shutdown();
});

test("package launch is bounded to four, records partial success, and retries failed members only", async () => {
  const stateDir = await tempStateDir();
  const specs = Array.from({ length: 7 }, (_, index) => ({ id: `app-${index + 1}`, name: `App ${index + 1}` }));
  const registry = await registryWithApps(stateDir, specs);
  let active = 0;
  let maxActive = 0;
  let failedAppId: string | undefined = "app-3";
  const calls: string[] = [];
  const enqueueLifecycle: EnqueuePackageMemberLifecycle = ({ appId }) => {
    calls.push(appId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const operationId = `op-${calls.length}`;
    const done = new Promise<LifecycleOperation>((resolve) => {
      setTimeout(() => {
        active -= 1;
        resolve(
          appId === failedAppId
            ? failedOperation(operationId, "PORT_CONFLICT", "Port conflict")
            : succeededOperation(operationId)
        );
      }, 10);
    });
    return { operationId, operation: queuedOperation(operationId), done, deduplicated: false };
  };
  const service = serviceFor(stateDir, registry, {
    enqueueLifecycle,
    statuses: (apps) =>
      apps.map((app) =>
        statusFor(app, app.id === "app-1" ? "running" : "stopped", app.id === "app-1" ? "healthy" : "unknown")
      )
  });
  const definition = await service.createDefinition({ name: "all-apps", members: specs.map((spec) => spec.name) });

  const first = await service.waitForRun(service.launch(definition.id, "partial-test").id);
  assert.equal(first.status, "partial");
  assert.ok(maxActive <= 4, `observed ${maxActive} concurrent starts`);
  assert.equal(first.members[0]?.state, "skipped_already_running");
  assert.equal(first.members[2]?.state, "failed");
  assert.equal(calls.includes("app-1"), false);

  calls.length = 0;
  failedAppId = undefined;
  const retry = await service.waitForRun(service.retryRun(first.id, "retry-test").id);
  assert.equal(retry.status, "succeeded");
  assert.deepEqual(calls, ["app-3"]);
  assert.deepEqual(
    retry.members.map((member) => member.appId),
    ["app-3"]
  );
  await service.shutdown();
});

test("package retry refuses to overlap an active package run", async () => {
  const stateDir = await tempStateDir();
  const registry = await registryWithApps(stateDir, [{ id: "a", name: "App A" }]);
  let blockLaunch = false;
  let releaseActive!: () => void;
  const activeDone = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const service = serviceFor(stateDir, registry, {
    enqueueLifecycle: () => {
      const operationId = `op-${Math.random()}`;
      return {
        operationId,
        operation: queuedOperation(operationId),
        done: blockLaunch
          ? activeDone.then(() => succeededOperation(operationId))
          : Promise.resolve(failedOperation(operationId, "PORT_CONFLICT", "Port conflict")),
        deduplicated: false
      };
    }
  });
  const definition = await service.createDefinition({ name: "stack", members: ["App A"] });
  const failed = await service.waitForRun(service.launch(definition.id, "failed-run").id);
  assert.equal(failed.status, "failed");

  blockLaunch = true;
  const active = service.launch(definition.id, "active-run");
  await waitFor(() => service.getRun(active.id).status === "running");
  assert.throws(
    () => service.retryRun(failed.id, "retry-run"),
    (error: unknown) => hasCode(error, "PACKAGE_RUN_ACTIVE")
  );

  releaseActive();
  await service.waitForRun(active.id);
  await service.shutdown();
});

test("aborting a package run skips work not yet enqueued and never rolls back started apps", async () => {
  const stateDir = await tempStateDir();
  const registry = await registryWithApps(stateDir, [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" }
  ]);
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: string[] = [];
  const service = serviceFor(stateDir, registry, {
    concurrency: 1,
    enqueueLifecycle: ({ appId }) => {
      calls.push(appId);
      const operationId = `op-${appId}`;
      return {
        operationId,
        operation: queuedOperation(operationId),
        done: firstDone.then(() => succeededOperation(operationId)),
        deduplicated: false
      };
    }
  });
  const definition = await service.createDefinition({ name: "stack", members: ["A", "B", "C"] });
  const queued = service.launch(definition.id, "abort-test");
  await waitFor(() => calls.length === 1);
  service.abortRun(queued.id);
  releaseFirst();

  const run = await service.waitForRun(queued.id);
  assert.equal(run.status, "aborted");
  assert.deepEqual(calls, ["a"]);
  assert.deepEqual(
    run.members.map((member) => member.state),
    ["started", "skipped_aborted", "skipped_aborted"]
  );
  await service.shutdown();
});

test("app package API handler is token gated and exposes create, list, launch, run, and delete contracts", async () => {
  const stateDir = await tempStateDir();
  const registry = await registryWithApps(stateDir, [{ id: "a", name: "App A" }]);
  const service = serviceFor(stateDir, registry);
  const token = "test-token";
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    void handleAppPackageApiRequest({
      service,
      request,
      response,
      parts: url.pathname.split("/").filter(Boolean),
      correlationId: "package-api-test",
      requireToken: () => {
        if (request.headers["x-relaybase-token"] !== token) {
          const error = new Error("unauthorized") as Error & { statusCode: number };
          error.statusCode = 401;
          throw error;
        }
      }
    }).catch((error: Error & { statusCode?: number }) => {
      const payload = JSON.stringify({ code: "UNAUTHORIZED_APP_PACKAGES", error: error.message });
      response.writeHead(error.statusCode ?? 500, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      });
      response.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal((await fetch(`${baseUrl}/__hub/api/packages`)).status, 401);
    const created = await jsonRequest(baseUrl, token, "POST", "/__hub/api/packages", {
      name: "one",
      members: ["App A"]
    });
    assert.equal(created.status, 201);
    const packageId = String(created.json.package.id);
    const listed = await jsonRequest(baseUrl, token, "GET", "/__hub/api/packages");
    assert.equal(listed.json.packages.length, 1);
    const launched = await jsonRequest(baseUrl, token, "POST", `/__hub/api/packages/${packageId}/launch`);
    assert.equal(launched.status, 202);
    const runId = String(launched.json.runId);
    await service.waitForRun(runId);
    const run = await jsonRequest(baseUrl, token, "GET", `/__hub/api/package-runs/${runId}`);
    assert.equal(run.json.run.status, "succeeded");
    const deleted = await jsonRequest(baseUrl, token, "DELETE", `/__hub/api/packages/${packageId}`);
    assert.equal(deleted.json.deleted, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await service.shutdown();
  }
});

function serviceFor(
  stateDir: string,
  registry: Registry,
  options: {
    enqueueLifecycle?: EnqueuePackageMemberLifecycle;
    statuses?: (apps: AppRecord[]) => AppStatusView[];
    concurrency?: number;
  } = {}
): AppPackageService {
  return new AppPackageService({
    stateDir,
    registry,
    concurrency: options.concurrency,
    enqueueLifecycle: options.enqueueLifecycle ?? (() => succeededHandle("op-success")),
    listAppStatuses: async () => {
      const apps = await registry.list();
      return options.statuses?.(apps) ?? apps.map((app) => statusFor(app, "stopped", "unknown"));
    }
  });
}

async function registryWithApps(stateDir: string, specs: Array<{ id: string; name: string }>): Promise<Registry> {
  const registry = new Registry(stateDir);
  await registry.load();
  for (const spec of specs) {
    await registry.upsertManifest({
      id: spec.id,
      name: spec.name,
      command: "node fixture.cjs",
      cwd: stateDir,
      protocol: "http",
      env: {}
    });
  }
  return registry;
}

function statusFor(app: AppRecord, status: "running" | "stopped", health: "healthy" | "unknown"): AppStatusView {
  return {
    ...app,
    runtime: { status, health, logLines: 0 }
  };
}

function succeededHandle(operationId: string) {
  const operation = queuedOperation(operationId);
  return { operationId, operation, done: Promise.resolve(succeededOperation(operationId)), deduplicated: false };
}

function queuedOperation(operationId: string): LifecycleOperation {
  return {
    id: operationId,
    operationId,
    kind: "start",
    operationType: "start",
    target: { type: "app", id: "fixture" },
    status: "queued",
    createdAt: new Date().toISOString()
  };
}

function succeededOperation(operationId: string): LifecycleOperation {
  return { ...queuedOperation(operationId), status: "succeeded" };
}

function failedOperation(operationId: string, code: string, message: string): LifecycleOperation {
  return {
    ...queuedOperation(operationId),
    status: "failed",
    error: { code, message, retryable: true }
  };
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function tempStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "relaybase-app-packages-"));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for package execution state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function jsonRequest(
  baseUrl: string,
  token: string,
  method: string,
  requestPath: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      "x-relaybase-token": token,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { status: response.status, json: await response.json() };
}
