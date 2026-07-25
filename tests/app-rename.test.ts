import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { DaemonEvent } from "../src/apiTypes.ts";
import { createRelaybaseServer, type RelaybaseServer } from "../src/server.ts";
import type { AppManifestInput, AppRecord } from "../src/types.ts";
import { normalizeManifest } from "../src/validation.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("rename preview is authenticated, exact, validated, collision-safe, and preview-bound", async () => {
  const fixture = await renameFixture("contract");
  try {
    const unauthorized = await apiRequest(fixture.hub.address().port, "POST", renamePath(fixture.appId, "preview"), {
      name: "Notes API"
    });
    assert.equal(unauthorized.statusCode, 401);

    const extraPreviewField = await authenticatedRequest(fixture.hub, "POST", renamePath(fixture.appId, "preview"), {
      name: "Notes API",
      confirm: true
    });
    assert.equal(extraPreviewField.statusCode, 400);
    assert.equal(JSON.parse(extraPreviewField.body).code, "APP_RENAME_PREVIEW_BODY_INVALID");

    for (const name of ["", "a".repeat(81), "Notes\nAPI", "Notes\u001b[2J", "Notes\u200b"]) {
      const invalid = await authenticatedRequest(fixture.hub, "POST", renamePath(fixture.appId, "preview"), { name });
      assert.equal(invalid.statusCode, 400, JSON.stringify({ name, body: invalid.body }));
      assert.equal(JSON.parse(invalid.body).code, "APP_RENAME_NAME_INVALID");
    }

    const siblingManifestPath = path.join(fixture.project, "worker.app.json");
    const siblingManifest = manifestFor("worker", "Worker", fixture.project);
    await fs.writeFile(siblingManifestPath, `${JSON.stringify(siblingManifest, null, 2)}\n`, "utf8");
    await fixture.hub.runtime.registry.upsertManifest(siblingManifest, { manifestPath: siblingManifestPath });
    const collision = await authenticatedRequest(fixture.hub, "POST", renamePath(fixture.appId, "preview"), {
      name: "WORKER"
    });
    assert.equal(collision.statusCode, 200);
    assert.equal(JSON.parse(collision.body).preview.canRename, false);
    assert.equal(JSON.parse(collision.body).preview.blockers[0].code, "APP_RENAME_NAME_COLLISION");

    const noop = await authenticatedRequest(fixture.hub, "POST", renamePath(fixture.appId, "preview"), {
      name: fixture.oldName
    });
    assert.equal(JSON.parse(noop.body).preview.noop, true);
    assert.equal(JSON.parse(noop.body).preview.previewId, undefined);

    const previewResponse = await authenticatedRequest(fixture.hub, "POST", renamePath(fixture.appId, "preview"), {
      name: fixture.newName
    });
    assert.equal(previewResponse.statusCode, 200);
    const preview = JSON.parse(previewResponse.body).preview;
    assert.equal(preview.canRename, true);
    assert.equal(preview.app.id, fixture.appId);
    assert.equal(preview.app.currentName, fixture.oldName);
    assert.equal(preview.app.proposedName, fixture.newName);
    assert.equal(preview.manifest.displayNameBehavior, "inherited");
    assert.ok(preview.previewId);
    assert.ok(preview.manifest.sourceRevision);

    const unconfirmed = await authenticatedRequest(fixture.hub, "POST", renamePath(fixture.appId, "apply"), {
      previewId: preview.previewId,
      confirm: false
    });
    assert.equal(unconfirmed.statusCode, 400);
    assert.equal(JSON.parse(unconfirmed.body).code, "APP_RENAME_CONFIRMATION_REQUIRED");

    const independentName = await authenticatedRequest(fixture.hub, "POST", renamePath(fixture.appId, "apply"), {
      previewId: preview.previewId,
      confirm: true,
      name: "Injected"
    });
    assert.equal(independentName.statusCode, 400);
    assert.equal(JSON.parse(independentName.body).code, "APP_RENAME_APPLY_BODY_INVALID");
    assert.equal((await fixture.hub.runtime.registry.get(fixture.appId))?.name, fixture.oldName);
  } finally {
    await fixture.hub.close();
  }
});

test("stopped rename preserves identity, packages, logs, history, and publishes a safe event", async () => {
  const fixture = await renameFixture("stopped");
  const retainedLogDir = path.join(fixture.stateDir, "logs", fixture.appId);
  const retainedLog = path.join(retainedLogDir, "retained.log");
  const events: DaemonEvent[] = [];
  const unsubscribe = fixture.hub.runtime.events.subscribe((event) => events.push(event));
  let reopened: RelaybaseServer | undefined;
  try {
    await fs.mkdir(retainedLogDir, { recursive: true });
    await fs.writeFile(retainedLog, "retained rename evidence\n", "utf8");
    fixture.hub.runtime.operations.recordEvidence({
      kind: "registration_verification",
      targetId: fixture.appId,
      correlationId: "rename-history",
      status: "succeeded",
      result: { verified: true }
    });
    const definition = await fixture.hub.runtime.packages.createDefinition({
      name: "rename-package",
      members: [fixture.appId]
    });

    const result = await renameThroughApi(fixture.hub, fixture.appId, fixture.newName);
    assert.equal(result.renamed, true);
    assert.equal(result.app.id, fixture.appId);
    assert.equal(result.app.oldName, fixture.oldName);
    assert.equal(result.app.newName, fixture.newName);
    assert.equal(result.preserved.stableAppId, fixture.appId);
    assert.equal(result.preserved.runningProcess, false);

    const manifest = JSON.parse(await fs.readFile(fixture.manifestPath, "utf8"));
    const registered = await fixture.hub.runtime.registry.get(fixture.appId);
    assert.equal(manifest.id, fixture.appId);
    assert.equal(manifest.name, fixture.newName);
    assert.equal(registered?.id, fixture.appId);
    assert.equal(registered?.name, fixture.newName);
    assert.equal(await fs.readFile(retainedLog, "utf8"), "retained rename evidence\n");
    assert.ok(fixture.hub.runtime.operations.list({ targetId: fixture.appId }).length > 0);
    assert.deepEqual(fixture.hub.runtime.packages.getDefinition(definition.id).memberAppIds, [fixture.appId]);

    const event = events.find((candidate) => candidate.type === "app.renamed");
    assert.deepEqual(event?.data, { appId: fixture.appId, oldName: fixture.oldName, newName: fixture.newName });
    assert.equal(JSON.stringify(event).includes(fixture.hub.runtime.token), false);
    assert.equal(JSON.stringify(event).includes(fixture.manifestPath), false);

    await fixture.hub.runtime.registry.upsertManifest(manifest, { manifestPath: fixture.manifestPath });
    assert.equal((await fixture.hub.runtime.registry.get(fixture.appId))?.name, fixture.newName);

    unsubscribe();
    await fixture.hub.close();
    reopened = await createRelaybaseServer({ port: 0, stateDir: fixture.stateDir });
    assert.equal((await reopened.runtime.registry.get(fixture.appId))?.name, fixture.newName);
  } finally {
    unsubscribe();
    await reopened?.close();
    await fixture.hub.close().catch(() => undefined);
  }
});

test("running rename leaves the process and route available", async () => {
  const fixture = await renameFixture("running", { managed: true });
  try {
    const beforeRuntime = await fixture.hub.runtime.processes.start(fixture.appId);
    assert.equal(beforeRuntime.status, "running");
    assert.ok(beforeRuntime.pid);

    const result = await renameThroughApi(fixture.hub, fixture.appId, fixture.newName);
    assert.equal(result.runtimeStatus, "running");
    assert.equal(result.preserved.runningProcess, true);
    const after = (await fixture.hub.runtime.processes.listStatuses()).find((item) => item.id === fixture.appId);
    assert.equal(after?.runtime.status, "running");
    assert.equal(after?.runtime.pid, beforeRuntime.pid);

    const routed = await apiRequest(fixture.hub.address().port, "GET", "/health", undefined, {
      host: `${fixture.appId}.localhost:${fixture.hub.address().port}`
    });
    assert.equal(routed.statusCode, 200);
    assert.equal((await fixture.hub.runtime.registry.get(fixture.appId))?.name, fixture.newName);
  } finally {
    await fixture.hub.runtime.processes.stop(fixture.appId).catch(() => undefined);
    await fixture.hub.close();
  }
});

test("rename rejects drift and lifecycle races and rolls the manifest back after registry failure", async () => {
  const fixture = await renameFixture("gates");
  let release: (() => void) | undefined;
  const originalAtomic = fixture.hub.runtime.registry.upsertManifestAtomic.bind(fixture.hub.runtime.registry);
  try {
    const originalContent = await fs.readFile(fixture.manifestPath, "utf8");
    const driftPreview = await renamePreview(fixture.hub, fixture.appId, fixture.newName);
    await fs.writeFile(fixture.manifestPath, `${originalContent.trimEnd()} \n`, "utf8");
    const drifted = await applyRename(fixture.hub, fixture.appId, driftPreview.previewId);
    assert.equal(drifted.statusCode, 409);
    assert.equal(JSON.parse(drifted.body).code, "APP_RENAME_PREVIEW_STALE");
    await fs.writeFile(fixture.manifestPath, originalContent, "utf8");

    const racePreview = await renamePreview(fixture.hub, fixture.appId, fixture.newName);
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = fixture.hub.runtime.operations.enqueueLifecycle({
      operationType: "start",
      targetId: fixture.appId,
      correlationId: "rename-race",
      run: async () => {
        await blocked;
        return { settled: true };
      },
      evaluate: () => ({ status: "succeeded" })
    });
    const raced = await applyRename(fixture.hub, fixture.appId, racePreview.previewId);
    assert.equal(raced.statusCode, 409);
    assert.equal(JSON.parse(raced.body).code, "APP_RENAME_OPERATION_ACTIVE");
    release();
    await operation.done;

    const rollbackPreview = await renamePreview(fixture.hub, fixture.appId, fixture.newName);
    fixture.hub.runtime.registry.upsertManifestAtomic = async () => {
      throw new Error("simulated registry persistence failure");
    };
    const failed = await applyRename(fixture.hub, fixture.appId, rollbackPreview.previewId);
    assert.equal(failed.statusCode, 500);
    assert.equal(JSON.parse(failed.body).code, "APP_RENAME_REGISTRY_WRITE_FAILED");
    assert.equal(await fs.readFile(fixture.manifestPath, "utf8"), originalContent);
    assert.equal((await fixture.hub.runtime.registry.get(fixture.appId))?.name, fixture.oldName);
    await assert.rejects(fs.access(path.join(fixture.stateDir, "app-rename-recovery.json")));
  } finally {
    fixture.hub.runtime.registry.upsertManifestAtomic = originalAtomic;
    release?.();
    await fixture.hub.close();
  }
});

test("rename deliberately updates mirrored display names and preserves distinct component labels", async () => {
  for (const scenario of [
    { suffix: "mirrored", displayName: "Rename mirrored", behavior: "updated", expected: "Renamed mirrored" },
    { suffix: "distinct", displayName: "Frontend", behavior: "preserved", expected: "Frontend" }
  ]) {
    const fixture = await renameFixture(scenario.suffix, {
      oldName: `Rename ${scenario.suffix}`,
      newName: `Renamed ${scenario.suffix}`,
      displayName: scenario.displayName
    });
    try {
      const preview = await renamePreview(fixture.hub, fixture.appId, fixture.newName);
      assert.equal(preview.manifest.displayNameBehavior, scenario.behavior);
      await applyRenameSuccess(fixture.hub, fixture.appId, preview.previewId);
      const manifest = JSON.parse(await fs.readFile(fixture.manifestPath, "utf8"));
      assert.equal(manifest.relaybase.displayName, scenario.expected);
      assert.equal(manifest.relaybase.paneLabel, "Web");
      assert.equal(manifest.relaybase.groupId, fixture.appId);
    } finally {
      await fixture.hub.close();
    }
  }
});

test("startup recovery finishes a manifest-written rename only when both hashes match", async () => {
  const fixture = await renameFixture("recovery");
  let recovered: RelaybaseServer | undefined;
  try {
    const beforeRecord = (await fixture.hub.runtime.registry.get(fixture.appId)) as AppRecord;
    const beforeContent = await fs.readFile(fixture.manifestPath, "utf8");
    const afterManifest = { ...(JSON.parse(beforeContent) as AppManifestInput), name: fixture.newName };
    const afterContent = `${JSON.stringify(afterManifest, null, 2)}\n`;
    const afterRecord = normalizeManifest(afterManifest, { manifestPath: fixture.manifestPath });
    await fs.writeFile(fixture.manifestPath, afterContent, "utf8");
    await fs.writeFile(
      path.join(fixture.stateDir, "app-rename-recovery.json"),
      `${JSON.stringify(
        {
          version: 1,
          records: [
            {
              appId: fixture.appId,
              manifestPath: fixture.manifestPath,
              oldName: fixture.oldName,
              newName: fixture.newName,
              beforeManifestHash: hashText(beforeContent),
              afterManifestHash: hashText(afterContent),
              beforeRegistryHash: hashRegistryRecord(beforeRecord),
              afterRegistryHash: hashRegistryRecord(afterRecord),
              phase: "manifest_written",
              updatedAt: new Date().toISOString()
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await fixture.hub.close();

    recovered = await createRelaybaseServer({ port: 0, stateDir: fixture.stateDir });
    assert.equal((await recovered.runtime.registry.get(fixture.appId))?.name, fixture.newName);
    assert.equal(JSON.parse(await fs.readFile(fixture.manifestPath, "utf8")).name, fixture.newName);
    await assert.rejects(fs.access(path.join(fixture.stateDir, "app-rename-recovery.json")));
  } finally {
    await recovered?.close();
    await fixture.hub.close().catch(() => undefined);
  }
});

async function renameFixture(
  suffix: string,
  options: { managed?: boolean; oldName?: string; newName?: string; displayName?: string } = {}
): Promise<{
  hub: RelaybaseServer;
  appId: string;
  oldName: string;
  newName: string;
  stateDir: string;
  project: string;
  manifestPath: string;
}> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), `relaybase-rename-${suffix}-`));
  const project = path.join(stateDir, "project");
  const manifestPath = path.join(project, "relaybase.app.json");
  const appId = `rename-${suffix}`;
  const oldName = options.oldName ?? `Rename ${suffix}`;
  const newName = options.newName ?? `Renamed ${suffix}`;
  await fs.mkdir(project, { recursive: true });
  const manifest = manifestFor(appId, oldName, project, options);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const hub = await createRelaybaseServer({
    port: 0,
    stateDir,
    portRangeStart: 19030,
    portRangeEnd: 19050
  });
  await hub.runtime.registry.upsertManifest(manifest, { manifestPath });
  await hub.listen();
  return { hub, appId, oldName, newName, stateDir, project, manifestPath };
}

function manifestFor(
  id: string,
  name: string,
  project: string,
  options: { managed?: boolean; displayName?: string } = {}
): AppManifestInput {
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
  return {
    schemaVersion: 1,
    id,
    name,
    command: options.managed ? `"${process.execPath}" --experimental-strip-types "${fixture}"` : "external",
    cwd: project,
    protocol: "http",
    ...(options.managed ? { healthUrl: "/health" } : {}),
    ...(options.displayName
      ? {
          relaybase: {
            groupId: id,
            componentRole: "frontend",
            displayName: options.displayName,
            paneLabel: "Web",
            paneOrder: 10
          }
        }
      : {})
  };
}

async function renameThroughApi(hub: RelaybaseServer, appId: string, name: string): Promise<any> {
  const preview = await renamePreview(hub, appId, name);
  return applyRenameSuccess(hub, appId, preview.previewId);
}

async function renamePreview(hub: RelaybaseServer, appId: string, name: string): Promise<any> {
  const response = await authenticatedRequest(hub, "POST", renamePath(appId, "preview"), { name });
  assert.equal(response.statusCode, 200, response.body);
  const preview = JSON.parse(response.body).preview;
  assert.equal(preview.canRename, true, response.body);
  assert.ok(preview.previewId, response.body);
  return preview;
}

async function applyRenameSuccess(hub: RelaybaseServer, appId: string, previewId: string): Promise<any> {
  const response = await applyRename(hub, appId, previewId);
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body).result;
}

function applyRename(hub: RelaybaseServer, appId: string, previewId: string) {
  return authenticatedRequest(hub, "POST", renamePath(appId, "apply"), { previewId, confirm: true });
}

function renamePath(appId: string, action: "preview" | "apply"): string {
  return `/__hub/api/apps/${encodeURIComponent(appId)}/rename/${action}`;
}

function hashRegistryRecord(app: AppRecord): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...durable } = app;
  return hashText(stableJson(durable));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
    if (payload) request.write(payload);
    request.end();
  });
}
