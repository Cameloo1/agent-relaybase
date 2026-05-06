import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Registry } from "../src/registry.ts";
import { appIdFromHost, resolveRoute } from "../src/router.ts";
import { normalizeManifest, validateAppId } from "../src/validation.ts";

test("validates app ids", () => {
  assert.doesNotThrow(() => validateAppId("notes"));
  assert.doesNotThrow(() => validateAppId("notes-api-2"));
  assert.throws(() => validateAppId("Notes"));
  assert.throws(() => validateAppId("-notes"));
  assert.throws(() => validateAppId("notes.local"));
});

test("normalizes manifests with relative cwd and env", () => {
  const manifestPath = path.join(os.tmpdir(), "porthub-manifest", "porthub.app.json");
  const app = normalizeManifest({
    id: "notes",
    name: "Notes",
    command: "npm.cmd run dev",
    cwd: "app",
    protocol: "http",
    healthUrl: "/health",
    env: { NODE_ENV: "development" },
    upstreamPort: 18001
  }, { manifestPath, now: new Date("2026-05-06T00:00:00.000Z") });

  assert.equal(app.id, "notes");
  assert.equal(app.cwd, path.join(os.tmpdir(), "porthub-manifest", "app"));
  assert.equal(app.env.NODE_ENV, "development");
  assert.equal(app.upstreamPort, 18001);
});

test("persists registry records", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "porthub-registry-"));
  const registry = new Registry(stateDir);
  await registry.load();
  await registry.upsertManifest({
    id: "alpha",
    name: "Alpha",
    command: "node server.js",
    cwd: ".",
    protocol: "http"
  });

  const reloaded = new Registry(stateDir);
  await reloaded.load();
  assert.equal((await reloaded.get("alpha"))?.name, "Alpha");
});

test("resolves agent header before host header", () => {
  const route = resolveRoute({
    url: "/",
    headers: {
      "x-port-hub-app": "api",
      host: "human.localhost:7777"
    }
  });

  assert.deepEqual(route, { kind: "app", appId: "api", source: "header" });
});

test("resolves hub and host routes", () => {
  assert.deepEqual(resolveRoute({ url: "/__hub", headers: { host: "notes.localhost:7777" } }), { kind: "hub" });
  assert.equal(appIdFromHost("notes.localhost:7777"), "notes");
  assert.equal(appIdFromHost("localhost:7777"), undefined);
});

