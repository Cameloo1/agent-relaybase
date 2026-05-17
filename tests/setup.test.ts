import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { classifyDockerFailure, readDockerProfile } from "../src/dockerProfile.ts";
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
import type { AppManifestInput } from "../src/types.ts";

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

test("configure dry-run uses one canonical manifest for selected plan and write preview", async () => {
  const project = await tempProject("relaybase-dry-run-canonical-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-dry-run-canonical-state-"));
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ name: "canonical-app", scripts: { start: "node server.js" } }, null, 2)
  );
  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "canonical-app",
        name: "Canonical App",
        command: "node server.js",
        cwd: ".",
        protocol: "http",
        healthUrl: "/health",
        upstreamPort: 4321
      },
      null,
      2
    )
  );

  const result = await configureProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17781,
    stateDir,
    dryRun: true,
    selectedPlanId: "managed-web"
  });

  const manifestWrite = result.selectedPlan.writes.find((write) => write.path.endsWith("relaybase.app.json"));
  assert.equal(result.selectedPlan.manifest.upstreamPort, undefined);
  assert.ok(manifestWrite);
  assert.equal(JSON.parse(manifestWrite.preview).upstreamPort, undefined);
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

test("CLI configure replays saved answers for env strategy and launch verification", async () => {
  const project = await tempProject("relaybase-cli-answers-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-cli-answers-state-"));
  await fs.writeFile(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "cli-answers-app",
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

  const result = await runRelaybaseCliJson([
    "configure",
    "--json",
    "--answers",
    "answers.json",
    "--cwd",
    project,
    "--state-dir",
    stateDir,
    "--port",
    "17780"
  ]);

  assert.equal(result.selectedPlan.id, "framework-port-flag");
  assert.equal(result.verification.attempted, false);
  assert.ok(await exists(path.join(project, ".env.relaybase")));
  assert.ok(await exists(path.join(project, ".relaybase", "launch.cjs")));
});

test("CLI list reports empty and offline registry state honestly", async () => {
  const emptyStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-list-empty-"));
  const empty = await runRelaybaseCli(["list", "--state-dir", emptyStateDir, "--port", "1"]);
  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /No apps registered/);

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-list-offline-"));
  const registry = new Registry(stateDir);
  await registry.load();
  await registry.upsertManifest({
    id: "offline-app",
    name: "Offline App",
    command: "external",
    cwd: rootDir,
    protocol: "http",
    upstreamPort: 34567
  });

  const listed = await runRelaybaseCli(["list", "--json", "--state-dir", stateDir, "--port", "1"]);
  assert.equal(listed.code, 0);
  const body = JSON.parse(listed.stdout);
  assert.equal(body.daemonReachable, false);
  assert.equal(body.runtimeKnown, false);
  assert.equal(body.summary.registered, 1);
  assert.equal(body.items[0].id, "offline-app");
  assert.equal(body.items[0].runtime, "unknown");
  assert.equal(body.items[0].readiness, "unknown");

  const filtered = await runRelaybaseCli(["list", "--running", "--state-dir", stateDir, "--port", "1"]);
  assert.notEqual(filtered.code, 0);
  assert.match(filtered.stderr, /cannot be proven/);
});

test("CLI list filters online daemon state and keeps status as an alias", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-list-online-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18600, portRangeEnd: 18630 });

  try {
    await hub.listen();
    await registerCliListApp(hub.runtime.registry, "running-app", "Running App");
    await registerCliListApp(hub.runtime.registry, "stopped-app", "Stopped App");
    await registerCliListApp(hub.runtime.registry, "attention-app", "Attention App", {
      preStartCommand: `"${process.execPath}" -e "process.exit(1)"`
    });

    await hub.runtime.processes.start("running-app");
    await hub.runtime.processes.start("attention-app");

    const commonArgs = ["--json", "--state-dir", stateDir, "--port", String(hub.address().port)];
    const all = await runRelaybaseCliJson(["list", ...commonArgs]);
    assert.equal(all.summary.registered, 3);
    assert.equal(all.summary.running, 1);
    assert.equal(all.summary.ready, 1);
    assert.equal(all.summary.stopped, 1);
    assert.equal(all.summary.attention, 1);
    assert.deepEqual(all.items.map((item: { id: string }) => item.id).sort(), [
      "attention-app",
      "running-app",
      "stopped-app"
    ]);

    const running = await runRelaybaseCliJson(["list", "--running", ...commonArgs]);
    assert.deepEqual(
      running.items.map((item: { id: string }) => item.id),
      ["running-app"]
    );

    const active = await runRelaybaseCliJson(["list", "--active", ...commonArgs]);
    assert.deepEqual(
      active.items.map((item: { id: string }) => item.id),
      ["running-app"]
    );

    const ready = await runRelaybaseCliJson(["list", "--ready", ...commonArgs]);
    assert.deepEqual(
      ready.items.map((item: { id: string }) => item.id),
      ["running-app"]
    );

    const attention = await runRelaybaseCliJson(["list", "--attention", ...commonArgs]);
    assert.equal(attention.items.length, 1);
    assert.equal(attention.items[0].id, "attention-app");
    assert.match(String(attention.items[0].attentionReason), /preStart hook exited/);

    const statusAlias = await runRelaybaseCliJson(["status", ...commonArgs]);
    assert.equal(statusAlias.summary.registered, all.summary.registered);
    assert.equal(statusAlias.items.length, all.items.length);

    const verbose = await runRelaybaseCli([
      "list",
      "--verbose",
      "--state-dir",
      stateDir,
      "--port",
      String(hub.address().port)
    ]);
    assert.equal(verbose.code, 0);
    assert.match(verbose.stdout, /cwd/);
    assert.match(verbose.stdout, /running-app/);
  } finally {
    await hub.runtime.processes.stop("running-app").catch(() => undefined);
    await hub.close();
  }
});

test("configure generates a Docker Compose profile, override, lifecycle hooks, and evidence contract", async () => {
  const project = await tempProject("relaybase-docker-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-docker-state-"));
  await fs.writeFile(
    path.join(project, "compose.yaml"),
    [
      "services:",
      "  web:",
      "    build: .",
      "    ports:",
      '      - "0:3000"',
      "    healthcheck:",
      '      test: ["CMD", "node", "-e", "process.exit(0)"]',
      "    depends_on:",
      "      - db",
      "  db:",
      "    image: postgres:16",
      "    ports:",
      '      - "5432:5432"',
      ""
    ].join("\n")
  );

  const detection = await detectProject(project);
  const plans = await proposeSetupPlans(detection);
  const dockerPlan = plans.find((plan) => plan.id === "docker-compose");

  assert.equal(detection.appKind, "docker");
  assert.equal(detection.docker?.selectedService, "web");
  assert.equal(detection.docker?.targetPort, 3000);
  assert.equal(detection.docker?.dependencyPorts[0], 5432);
  assert.equal(plans[0]?.id, "docker-compose");
  assert.ok(dockerPlan);
  assert.match(String(dockerPlan.manifest.command), /relaybase-start\.ps1/);
  assert.match(String(dockerPlan.manifest.preStartCommand), /relaybase-prestart\.ps1/);
  assert.match(String(dockerPlan.manifest.stopCommand), /relaybase-stop\.ps1/);
  assert.match(String(dockerPlan.manifest.verifyStoppedCommand), /relaybase-verify-stopped\.ps1/);
  assert.ok(dockerPlan.writes.some((write) => write.path.endsWith(path.join(".relaybase", "docker-profile.json"))));
  assert.ok(
    dockerPlan.writes.some((write) => write.path.endsWith(path.join(".relaybase", "docker-compose.relaybase.yml")))
  );

  const result = await configureProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17780,
    stateDir,
    yes: true,
    noStart: true,
    selectedPlanId: "docker-compose"
  });

  assert.equal(result.selectedPlan.id, "docker-compose");
  const manifest = JSON.parse(await fs.readFile(path.join(project, "relaybase.app.json"), "utf8"));
  assert.match(manifest.command, /relaybase-start\.ps1/);
  assert.match(manifest.preStartCommand, /relaybase-prestart\.ps1/);
  assert.equal(manifest.startTimeoutMs, 600000);
  assert.ok(await exists(path.join(project, ".relaybase", "docker-profile.json")));
  assert.ok(await exists(path.join(project, ".relaybase", "docker-compose.relaybase.yml")));
  assert.ok(await exists(path.join(project, ".relaybase", "scripts", "relaybase-prestart.ps1")));
  assert.ok(await exists(path.join(project, ".relaybase", "scripts", "relaybase-start.ps1")));
  assert.ok(await exists(path.join(project, ".relaybase", "scripts", "relaybase-stop.ps1")));
  assert.ok(await exists(path.join(project, ".relaybase", "scripts", "relaybase-verify-stopped.ps1")));

  const profile = await readDockerProfile(project);
  assert.equal(profile?.kind, "docker-compose");
  assert.equal(profile?.selectedService, "web");
  assert.equal(profile?.targetContainerPort, 3000);
  assert.equal(profile?.hostPortStrategy, "relaybase-assigned-port");
  assert.equal(profile?.dependencyPortPolicy, "internal-only");
  assert.equal(profile?.portExposurePolicy, "selected-service-localhost-only");
  assert.equal(profile?.portExposureVerification, "docker-compose-config");
  assert.equal(profile?.serviceSelection.mode, "auto");
  assert.equal(profile?.serviceSelection.confidence, "high");
  assert.deepEqual(profile?.retryBackoffMs, [1000, 2000, 4000, 8000, 15000]);
  assert.equal(profile?.timingsMs.pullBuild, 600000);
  assert.ok(profile?.lifecycleStates.includes("verifying_cleanup"));
  assert.ok(profile?.errorTaxonomy.includes("cleanup_failed"));
  assert.ok(profile?.artifacts.includes("compose-ps.after-stop.json"));
  assert.ok(profile?.redactionKeys.includes("database_url"));
  assert.equal(profile?.approvals.volumeRemoval, false);

  const override = await fs.readFile(path.join(project, ".relaybase", "docker-compose.relaybase.yml"), "utf8");
  assert.match(override, /127\.0\.0\.1:\$\{PORT:-0}:3000/);
  assert.match(override, /relaybase\.compose_project/);
  assert.match(override, / {2}db:\n {4}labels:\n {6}relaybase\.dependency: "true"\n {4}ports: !reset \[\]/);

  const stopScript = await fs.readFile(path.join(project, ".relaybase", "scripts", "relaybase-stop.ps1"), "utf8");
  const startScript = await fs.readFile(path.join(project, ".relaybase", "scripts", "relaybase-start.ps1"), "utf8");
  assert.match(startScript, /Invoke-RelaybaseComposeStream/);
  assert.doesNotMatch(startScript, /Invoke-RelaybaseCompose -Profile \$profile -Args \$args \| Out-Host/);
  assert.match(stopScript, /docker compose/);
  assert.match(stopScript, /down", "--remove-orphans/);
  assert.match(stopScript, /\$timeoutSeconds = \[Math\]::Max/);
  assert.match(stopScript, /compose-config\.effective\.json/);
  assert.match(stopScript, /compose-port-exposure\.json/);
  assert.match(stopScript, /dependency_port_open/);
  assert.match(stopScript, /cleanup_failed/);
  assert.match(stopScript, /\$previousErrorActionPreference = \$ErrorActionPreference/);
  assert.match(stopScript, /\$ErrorActionPreference = "Continue"/);

  const helperScript = await fs.readFile(
    path.join(rootDir, "skills", "relaybase-dev", "scripts", "relaybase-dev.ps1"),
    "utf8"
  );
  assert.match(helperScript, /\$previousErrorActionPreference = \$ErrorActionPreference/);
  assert.match(helperScript, /\$ErrorActionPreference = "Continue"/);
});

test("Windows helper wrapper uses process-local policy bypass and preserves exit code", async () => {
  const wrapper = await fs.readFile(
    path.join(rootDir, "skills", "relaybase-dev", "scripts", "relaybase-dev.cmd"),
    "utf8"
  );

  assert.match(wrapper, /%~dp0relaybase-dev\.ps1/);
  assert.match(wrapper, /-NoProfile -NonInteractive -ExecutionPolicy Bypass -File/);
  assert.match(wrapper, /"%RELAYBASE_DEV_SCRIPT%" %\*/);
  assert.match(wrapper, /if not errorlevel 1/);
  assert.doesNotMatch(wrapper, /if "%ERRORLEVEL%"/);
  assert.match(wrapper, /endlocal & exit \/b %RELAYBASE_DEV_EXIT_CODE%/);
  assert.doesNotMatch(wrapper, /Set-ExecutionPolicy/i);
});

test("Windows helper wires backend ports into manifests and reports degraded routes", async () => {
  const helperScript = await fs.readFile(
    path.join(rootDir, "skills", "relaybase-dev", "scripts", "relaybase-dev.ps1"),
    "utf8"
  );

  assert.match(helperScript, /\$manifest\["upstreamPort"\] = \$BackendPort/);
  assert.match(helperScript, /routeHealth = \$routeHealth/);
  assert.match(helperScript, /degraded = \(\$routeHealth -eq "degraded"\)/);
  assert.match(helperScript, /humanRoute = \$human/);
  assert.match(helperScript, /agentRoute = \$agent/);
  assert.match(helperScript, /full requires both humanRoute and agentRoute/);
});

test("Docker setup refuses ambiguous service detection until service and target port are explicit", async () => {
  const project = await tempProject("relaybase-docker-ambiguous-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-docker-ambiguous-state-"));
  await fs.writeFile(
    path.join(project, "compose.yaml"),
    [
      "services:",
      "  web:",
      "    image: node:24",
      "    ports:",
      '      - "3000:3000"',
      "  api:",
      "    image: node:24",
      "    ports:",
      '      - "8000:8000"',
      "  redis:",
      "    image: redis:7",
      "    ports:",
      '      - "6379:6379"',
      ""
    ].join("\n")
  );

  const detection = await detectProject(project);
  assert.equal(detection.docker?.selectedService, undefined);
  assert.match(detection.docker?.selection.reason ?? "", /ambiguous/);
  assert.ok(detection.docker?.serviceCandidates.some((candidate) => candidate.name === "redis" && !candidate.eligible));

  const dryRunPlans = await proposeSetupPlans(detection);
  const dockerDryRun = dryRunPlans.find((plan) => plan.id === "docker-compose");
  assert.deepEqual(dockerDryRun?.requiresInput, ["docker.service", "docker.targetPort"]);

  await assert.rejects(
    () =>
      configureProject({
        cwd: project,
        host: "127.0.0.1",
        port: 17782,
        stateDir,
        yes: true,
        noStart: true,
        selectedPlanId: "docker-compose"
      }),
    /requires explicit input/
  );

  const configured = await configureProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17782,
    stateDir,
    yes: true,
    noStart: true,
    selectedPlanId: "docker-compose",
    docker: {
      service: "api",
      targetPort: 8000,
      healthPath: "/api/health",
      startTimeoutMs: 600000,
      healthTimeoutMs: 240000,
      stopTimeoutMs: 45000,
      dependencyPortPolicy: "internal-only",
      composeProfiles: ["dev"],
      startDockerDesktop: true
    }
  });

  assert.equal(configured.selectedPlan.id, "docker-compose");
  const profile = await readDockerProfile(project);
  assert.equal(profile?.selectedService, "api");
  assert.equal(profile?.targetContainerPort, 8000);
  assert.equal(profile?.healthPath, "/api/health");
  assert.equal(profile?.timingsMs.healthWait, 240000);
  assert.equal(profile?.timingsMs.stop, 45000);
  assert.deepEqual(profile?.profiles, ["dev"]);
  assert.equal(profile?.approvals.startDockerDesktop, true);
  assert.equal(profile?.serviceSelection.mode, "explicit");
  assert.deepEqual(profile?.dependencyServices.sort(), ["redis", "web"]);

  const override = await fs.readFile(path.join(project, ".relaybase", "docker-compose.relaybase.yml"), "utf8");
  assert.match(override, / {2}api:/);
  assert.match(override, /127\.0\.0\.1:\$\{PORT:-0}:8000/);
  assert.match(override, / {2}web:\n {4}labels:\n {6}relaybase\.dependency: "true"\n {4}ports: !reset \[\]/);
  assert.match(override, / {2}redis:\n {4}labels:\n {6}relaybase\.dependency: "true"\n {4}ports: !reset \[\]/);
});

test("Docker setup validates explicit service and target port input", async () => {
  const project = await tempProject("relaybase-docker-invalid-selection-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-docker-invalid-selection-state-"));
  await fs.writeFile(
    path.join(project, "compose.yaml"),
    ["services:", "  worker:", "    image: node:24", ""].join("\n")
  );

  await assert.rejects(
    () =>
      configureProject({
        cwd: project,
        host: "127.0.0.1",
        port: 17783,
        stateDir,
        yes: true,
        noStart: true,
        selectedPlanId: "docker-compose",
        docker: { service: "missing", targetPort: 3000 }
      }),
    /was not found/
  );

  await assert.rejects(
    () =>
      configureProject({
        cwd: project,
        host: "127.0.0.1",
        port: 17783,
        stateDir,
        yes: true,
        noStart: true,
        selectedPlanId: "docker-compose",
        docker: { service: "worker" }
      }),
    /needs --target-port/
  );
});

test("skill docs prefer the Windows wrapper for direct helper actions", async () => {
  const docs = [
    "skills/relaybase-dev/SKILL.md",
    "skills/relaybase-dev/references/windows-runtime.md",
    "skills/relaybase-dev/references/relaybase-contract.md"
  ];

  for (const relativePath of docs) {
    const text = await fs.readFile(path.join(rootDir, relativePath), "utf8");
    assert.match(text, /relaybase-dev\.cmd/);
    for (const line of text.split(/\r?\n/)) {
      if (line.includes("relaybase-dev.ps1 -Action")) {
        assert.match(line, /pwsh -NoProfile -File/, `${relativePath} has a direct .ps1 helper action: ${line}`);
      }
    }
  }
});

test(
  "Windows helper wrapper runs preflight through the checked-in cmd shim",
  { skip: process.platform !== "win32" },
  async () => {
    const wrapperPath = path.join(rootDir, "skills", "relaybase-dev", "scripts", "relaybase-dev.cmd");
    const result = await runCommand("cmd.exe", ["/d", "/c", wrapperPath, "-Action", "preflight"], {
      timeoutMs: 30_000
    });

    assert.equal(result.code, 0, `STDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    const body = JSON.parse(result.stdout) as { action?: string };
    assert.equal(body.action, "preflight");
  }
);

test("Docker health diagnostics flag missing profiles, dangerous config, and required Compose env", async () => {
  const project = await tempProject("relaybase-docker-danger-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-docker-danger-state-"));
  await fs.writeFile(
    path.join(project, "docker-compose.yml"),
    [
      "services:",
      "  app:",
      "    image: ghcr.io/acme/private-app:latest",
      "    privileged: true",
      "    network_mode: host",
      "    environment:",
      "      DATABASE_URL: ${DATABASE_URL:?required}",
      "    volumes:",
      '      - "/var/run/docker.sock:/var/run/docker.sock"',
      "    ports:",
      '      - "0.0.0.0:8080:80"',
      ""
    ].join("\n")
  );

  const unconfigured = await healthProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17998,
    stateDir,
    json: true
  });
  assert.ok(unconfigured.findings.some((finding) => finding.code === "DOCKER_PROFILE_MISSING"));

  await configureProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17781,
    stateDir,
    yes: true,
    noStart: true,
    selectedPlanId: "docker-compose"
  });

  const profile = await readDockerProfile(project);
  assert.deepEqual(profile?.missingEnvVars, ["DATABASE_URL"]);
  assert.deepEqual(profile?.privateImages, ["ghcr.io/acme/private-app:latest"]);
  assert.ok(
    profile?.securityFindings.some((finding) => finding.code === "privileged" && finding.severity === "blocked")
  );
  assert.ok(profile?.securityFindings.some((finding) => finding.code === "docker_socket_mount"));
  assert.ok(profile?.securityFindings.some((finding) => finding.code === "host_network"));
  assert.ok(profile?.securityFindings.some((finding) => finding.code === "public_bind"));

  const health = await healthProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17997,
    stateDir,
    json: true
  });
  assert.ok(health.findings.some((finding) => finding.code === "COMPOSE_ENV_MISSING"));
  assert.ok(health.findings.some((finding) => finding.code === "DANGEROUS_COMPOSE_CONFIG"));

  assert.equal(classifyDockerFailure("Cannot connect to the Docker daemon").code, "docker_daemon_unavailable");
  assert.equal(
    classifyDockerFailure("denied: requested access to the resource is denied").code,
    "image_pull_auth_failed"
  );
  assert.equal(classifyDockerFailure("port is already allocated").code, "port_conflict");
  assert.equal(
    classifyLaunchFailure({ error: "docker compose config failed because variable DATABASE_URL is not set" }).code,
    "compose_env_missing"
  );
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
  assert.ok(
    result.nextActions?.some((action) => action.owner === "manifest" && action.command === "relaybase configure")
  );
  assert.ok(result.nextActions?.some((action) => action.owner === "daemon"));
  assert.equal(await exists(path.join(project, ".relaybase")), false);
});

test("open reports invalid manifests as manifest-owned next actions", async () => {
  const project = await tempProject("relaybase-open-invalid-manifest-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-open-invalid-manifest-state-"));
  await fs.writeFile(path.join(project, "relaybase.app.json"), "{ not-json", "utf8");

  const result = await openProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17996,
    stateDir,
    json: true,
    noBrowser: true,
    startDaemon: false
  });

  assert.equal(result.registered, false);
  assert.equal(result.started, false);
  assert.match(result.error ?? "", /manifest could not be loaded/i);
  assert.equal(result.nextActions?.[0]?.owner, "manifest");
});

test("open reports daemon token mismatch without falling back to local registry writes", async () => {
  const project = await tempProject("relaybase-open-token-mismatch-");
  const daemonStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-open-token-daemon-state-"));
  const cliStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-open-token-cli-state-"));
  const hub = await createRelaybaseServer({
    port: 0,
    stateDir: daemonStateDir,
    portRangeStart: 18590,
    portRangeEnd: 18600
  });

  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "token-mismatch-app",
        name: "Token Mismatch App",
        command: "node missing.js",
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
      stateDir: cliStateDir,
      json: true,
      noBrowser: true,
      startDaemon: false
    });

    assert.equal(result.registered, false);
    assert.equal(result.started, false);
    assert.match(result.error ?? "", /401/);
    assert.equal(result.nextActions?.[0]?.owner, "token");
    assert.equal(await exists(path.join(cliStateDir, "registry.json")), false);
  } finally {
    await hub.close();
  }
});

test("open reports daemon and permission evidence when offline registry fallback cannot write", async () => {
  const project = await tempProject("relaybase-open-state-blocked-");
  const stateDir = path.join(project, "relaybase-state-file");
  await fs.writeFile(stateDir, "not a directory", "utf8");
  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "blocked-state-app",
        name: "Blocked State App",
        command: "node missing.js",
        cwd: rootDir,
        protocol: "http",
        healthUrl: "/health"
      },
      null,
      2
    )
  );

  const result = await openProject({
    cwd: project,
    host: "127.0.0.1",
    port: 17996,
    stateDir,
    json: true,
    noBrowser: true
  });

  assert.equal(result.ready, false);
  assert.equal(result.registered, false);
  assert.match(result.daemon?.error ?? "", /state\/log setup failed/i);
  assert.match(result.error ?? "", /Offline registry fallback failed/);
  assert.ok(result.nextActions?.some((action) => action.owner === "permissions"));
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

test("open registers through a reachable daemon before reading local registry state", async () => {
  const project = await tempProject("relaybase-open-daemon-first-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-open-daemon-first-state-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18560, portRangeEnd: 18580 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");

  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "daemon-first-app",
        name: "Daemon First App",
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
    await fs.writeFile(path.join(stateDir, "registry.json"), "{ this is not readable registry json", "utf8");
    const result = await openProject({
      cwd: project,
      host: "127.0.0.1",
      port: hub.address().port,
      stateDir,
      json: true,
      noBrowser: true,
      startDaemon: false
    });

    assert.equal(result.appId, "daemon-first-app");
    assert.equal(result.registered, true);
    assert.equal(result.started, true);
    assert.equal(result.ready, true);
    assert.equal(result.daemon?.started, false);
    assert.equal(result.state?.routeHealth?.status, "full");
  } finally {
    await hub.runtime.processes.stop("daemon-first-app").catch(() => undefined);
    await hub.close();
  }
});

test("open returns app-command next actions when the launch command is missing", async () => {
  const project = await tempProject("relaybase-open-missing-command-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-open-missing-command-state-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18610, portRangeEnd: 18620 });

  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "missing-command-app",
        name: "Missing Command App",
        command: "definitely-not-a-real-relaybase-command",
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

    assert.equal(result.registered, true);
    assert.equal(result.started, false);
    assert.equal(result.ready, false);
    assert.equal(result.recoveryHint?.code, "command-not-found");
    assert.ok(result.nextActions?.some((action) => action.owner === "app-command"));
  } finally {
    await hub.runtime.processes.stop("missing-command-app").catch(() => undefined);
    await hub.close();
  }
});

test("health prove writes a lifecycle proof bundle with routed health, logs, stop, and port closure checks", async () => {
  const project = await tempProject("relaybase-health-prove-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-health-prove-state-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18530, portRangeEnd: 18550 });
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");

  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "proved-app",
        name: "Proved App",
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
    const result = await healthProject({
      cwd: project,
      host: "127.0.0.1",
      port: hub.address().port,
      stateDir,
      json: true,
      prove: true,
      lifecycleProof: true,
      startDaemon: false
    });

    assert.equal(result.proof?.mode, "lifecycle");
    assert.equal(result.proof?.ok, true);
    assert.equal(result.proof?.started, true);
    assert.equal(result.proof?.stopped, true);
    assert.ok(result.proof?.checks.some((check) => check.name === "routed-health" && check.ok));
    assert.ok(result.proof?.checks.some((check) => check.name === "logs" && check.ok));
    assert.ok(result.proof?.checks.some((check) => check.name === "stop-verification" && check.ok));
    assert.ok(result.proof?.artifactPath);
    assert.ok(await exists(result.proof?.artifactPath ?? ""));
  } finally {
    await hub.runtime.processes.stop("proved-app").catch(() => undefined);
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

async function registerCliListApp(
  registry: Registry,
  id: string,
  name: string,
  overrides: Partial<AppManifestInput> = {}
): Promise<void> {
  const fixture = path.join(rootDir, "tests", "fixtures", "fake-managed-app.ts");
  await registry.upsertManifest({
    id,
    name,
    command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
    cwd: rootDir,
    protocol: "http",
    healthUrl: "/health",
    ...overrides
  });
}

async function runRelaybaseCliJson(args: string[]): Promise<Record<string, any>> {
  const result = await runRelaybaseCli(args);
  if (result.code !== 0) {
    throw new Error(`relaybase CLI exited ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return JSON.parse(result.stdout) as Record<string, any>;
}

function runRelaybaseCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", path.join(rootDir, "src", "cli.ts"), ...args],
      {
        cwd: rootDir,
        windowsHide: true
      }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`relaybase CLI timed out: ${args.join(" ")}`));
    }, 30_000);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out: ${args.join(" ")}`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

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
