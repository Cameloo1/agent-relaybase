import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Registry } from "../src/registry.ts";
import { createRelaybaseServer } from "../src/server.ts";
import {
  classifyLaunchFailure,
  configureProject,
  detectProject,
  healthProject,
  openProject,
  proposeSetupPlans
} from "../src/setup.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("detects package-manager, framework, env, and generates multiple setup architectures", async () => {
  const project = await tempProject("relaybase-detect-");
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "@acme/portal",
        scripts: {
          dev: "vite --host 127.0.0.1",
          build: "vite build"
        },
        devDependencies: {
          vite: "^6.0.0"
        }
      },
      null,
      2
    )
  );
  await fs.writeFile(path.join(project, "vite.config.ts"), "export default {};\n");
  await fs.writeFile(path.join(project, ".env"), "SECRET_TOKEN=do-not-touch\nVITE_PORT=5173\n");

  const detection = await detectProject(project);
  const plans = await proposeSetupPlans(detection);

  assert.equal(detection.framework, "vite");
  assert.equal(detection.packageManager, "npm");
  assert.equal(detection.packageName, "@acme/portal");
  assert.deepEqual(detection.portEnvKeys, ["VITE_PORT"]);
  assert.deepEqual(detection.detectedPorts, [5173]);
  assert.ok(plans.some((plan) => plan.architecture === "managed-dynamic-port"));
  assert.ok(plans.some((plan) => plan.architecture === "framework-port-flag"));
  assert.ok(plans.some((plan) => plan.architecture === "pinned-upstream-port"));
  assert.equal(plans[0]?.id, "framework-port-flag");
});

test("configure writes inspectable setup artifacts and registers without starting when requested", async () => {
  const project = await tempProject("relaybase-configure-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-configure-state-"));
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "sample-app",
        scripts: {
          dev: "node server.js"
        }
      },
      null,
      2
    )
  );

  const result = await configureProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17777,
    stateDir,
    yes: true,
    noStart: true
  });

  assert.equal(result.selectedPlan.id, "managed-web");
  assert.equal(result.verification.attempted, false);
  assert.ok(await exists(path.join(project, "relaybase.app.json")));
  assert.ok(await exists(path.join(project, ".relaybase", "launch-profile.json")));
  assert.ok(await exists(path.join(project, ".relaybase", "setup-report.json")));
  assert.ok(await exists(path.join(project, ".relaybase", "setup.answers.json")));
  assert.ok((await fs.readdir(path.join(project, ".relaybase", "runs"))).some((file) => file.endsWith(".jsonl")));

  const manifest = JSON.parse(await fs.readFile(path.join(project, "relaybase.app.json"), "utf8"));
  assert.equal(manifest.id, "sample-app");
  assert.equal(manifest.command, `${process.platform === "win32" ? "npm.cmd" : "npm"} run dev`);

  const registry = new Registry(stateDir);
  await registry.load();
  assert.equal((await registry.get("sample-app"))?.manifestPath, path.join(project, "relaybase.app.json"));
});

test("configure guarded env writes preserve existing secrets and remain idempotent", async () => {
  const project = await tempProject("relaybase-env-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-env-state-"));
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "env-app",
        scripts: {
          dev: "node server.js"
        }
      },
      null,
      2
    )
  );
  await fs.writeFile(path.join(project, ".env"), "SECRET_TOKEN=keep-me\n");

  for (let run = 0; run < 2; run += 1) {
    await configureProject({
      cwd: project,
      host: "127.0.0.1",
      port: 17778,
      stateDir,
      yes: true,
      noStart: true,
      envStrategy: "guarded-env-block"
    });
  }

  const env = await fs.readFile(path.join(project, ".env"), "utf8");
  assert.match(env, /SECRET_TOKEN=keep-me/);
  assert.equal((env.match(/# relaybase:start/g) ?? []).length, 1);
  assert.equal((env.match(/# relaybase:end/g) ?? []).length, 1);
});

test("configure can replay saved answers for noninteractive setup", async () => {
  const project = await tempProject("relaybase-answers-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-answers-state-"));
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "answers-app",
        scripts: {
          dev: "vite"
        },
        devDependencies: {
          vite: "^6.0.0"
        }
      },
      null,
      2
    )
  );
  await fs.writeFile(path.join(project, "vite.config.ts"), "export default {};\n");
  await fs.writeFile(
    path.join(project, "answers.json"),
    JSON.stringify(
      {
        selectedPlanId: "framework-port-flag",
        envStrategy: "env-relaybase-file",
        noStart: true
      },
      null,
      2
    )
  );

  const result = await configureProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17779,
    stateDir,
    yes: true,
    answersPath: "answers.json"
  });

  assert.equal(result.selectedPlan.id, "framework-port-flag");
  assert.equal(result.verification.attempted, false);
  assert.ok(await exists(path.join(project, ".env.relaybase")));
  assert.ok(await exists(path.join(project, ".relaybase", "launch.cjs")));
});

test("health is read-only and recommends configure for an unconfigured project", async () => {
  const project = await tempProject("relaybase-health-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-health-state-"));

  const result = await healthProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17999,
    stateDir,
    json: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.project.configured, false);
  assert.ok(result.findings.some((finding) => finding.code === "PROJECT_NOT_CONFIGURED"));
  assert.equal(await exists(path.join(project, ".relaybase")), false);
});

test("open starts a configured app through a running Relaybase daemon and proves the routed URL", async () => {
  const project = await tempProject("relaybase-open-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-open-state-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18500, portRangeEnd: 18520 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");

  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "opened-app",
        name: "Opened App",
        command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
        cwd: rootDir,
        protocol: "http",
        healthUrl: "/health"
      },
      null,
      2
    )
  );

  try {
    await hub.listen();
    const result = await openProject({
      cwd: project,
      host: "127.0.0.1",
      port: hub.address().port,
      stateDir,
      json: true,
      noBrowser: true,
      startDaemon: false
    });

    assert.equal(result.appId, "opened-app");
    assert.equal(result.registered, true);
    assert.equal(result.started, true);
    assert.equal(result.ready, true);
    assert.equal(result.state?.routeReachable, true);
    assert.equal(result.state?.readiness.state, "ready");
  } finally {
    await hub.runtime.processes.stop("opened-app").catch(() => undefined);
    await hub.close();
  }
});

test("classifies launch failures into actionable recovery architectures", () => {
  assert.deepEqual(classifyLaunchFailure({ error: "spawn corepack ENOENT" }).code, "corepack-spawn");
  assert.deepEqual(
    classifyLaunchFailure({ error: "EADDRINUSE: address already in use", runtimeStatus: "conflict" }).nextArchitectures,
    ["managed-dynamic-port", "framework-port-flag"]
  );
  assert.deepEqual(
    classifyLaunchFailure({ lastError: "App did not become healthy before the startup timeout." }).code,
    "ignored-port"
  );
});

async function tempProject(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
