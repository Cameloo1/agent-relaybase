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

  const stopScript = await fs.readFile(path.join(project, ".relaybase", "scripts", "relaybase-stop.ps1"), "utf8");
  assert.match(stopScript, /docker compose/);
  assert.match(stopScript, /down", "--remove-orphans/);
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

async function runRelaybaseCliJson(args: string[]): Promise<Record<string, any>> {
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
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
      if (code !== 0) {
        reject(new Error(`relaybase CLI exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  return JSON.parse(result.stdout) as Record<string, any>;
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
