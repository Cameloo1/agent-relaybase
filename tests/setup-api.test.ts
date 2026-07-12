import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Registry } from "../src/registry.ts";
import { createRelaybaseServer } from "../src/server.ts";

test("setup detect, generic plans, and preview are read-only", async () => {
  const project = await tempProject("relaybase-setup-api-generic-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-state-"));
  await writePackageJson(project, {
    name: "generic-web",
    scripts: {
      dev: "node server.js"
    }
  });
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const events = collectEvents(hub);

    const detect = await apiRequest(port, "POST", "/__hub/api/setup/detect", { cwd: project });
    assert.equal(detect.statusCode, 200);
    assert.equal(detect.json.setup.packageManager, "npm");
    assert.equal(detect.json.setup.cwd, project);

    const plans = await apiRequest(port, "POST", "/__hub/api/setup/plans", { cwd: project });
    assert.equal(plans.statusCode, 200);
    assert.ok(
      plans.json.setup.choices.some((choice: { portStrategies: string[] }) =>
        choice.portStrategies.includes("managed_dynamic_port")
      )
    );
    assert.ok(
      plans.json.setup.choices.some((choice: { portStrategies: string[] }) =>
        choice.portStrategies.includes("env_port")
      )
    );

    const preview = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: project,
      selectedPlanId: "managed-web"
    });
    assert.equal(preview.statusCode, 200);
    assert.ok(
      preview.json.setup.fileWritePlan.writes.some((write: { path: string }) =>
        write.path.endsWith("relaybase.app.json")
      )
    );
    assert.ok(
      preview.json.setup.fileWritePlan.writes.some((write: { path: string }) =>
        write.path.endsWith(path.join(".relaybase", "setup-profile.json"))
      )
    );
    assert.equal(await exists(path.join(project, "relaybase.app.json")), false);
    assert.equal(await exists(path.join(project, ".relaybase", "setup-profile.json")), false);
    assert.deepEqual(
      events.types().filter((type) => type.startsWith("setup.")),
      ["setup.detected", "setup.plan_created", "setup.preview_created"]
    );
    events.unsubscribe();
  } finally {
    await hub.close();
  }
});

test("one-file folder registration previews, binds drift, registers, and never starts", async () => {
  const project = await tempProject("relaybase-register-one-file-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-register-one-file-state-"));
  await fs.writeFile(
    path.join(project, "Start-Dashboard.ps1"),
    "param([string]$HostName, [int]$Port)\n$listener = [System.Net.HttpListener]::new()\n",
    "utf8"
  );
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await hub.listen();
    const port = hub.address().port;
    const preview = await apiRequest(port, "POST", "/__hub/api/setup/register/preview", {
      path: project,
      mode: "folder"
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json.setup.status, "approval_required");
    assert.equal(preview.json.setup.manifestState, "missing");
    assert.equal(preview.json.setup.selectedPlan.id, "structured-argument-launch");
    assert.equal(preview.json.setup.app.launch.portBinding, "arguments");
    assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

    const noConfirmation = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/register/apply",
      { previewId: preview.json.setup.previewId },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(noConfirmation.statusCode, 428);
    assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

    const applied = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/register/apply",
      { previewId: preview.json.setup.previewId, confirm: true, confirmation: { confirmed: true } },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(applied.statusCode, 202, applied.body);
    assert.equal(applied.json.setup.status, "registered");
    assert.equal(applied.json.setup.started, false);
    const status = (await hub.runtime.processes.listStatuses()).find((item) => item.id === applied.json.setup.app.id);
    assert.equal(status?.runtime.status, "stopped");
    const manifest = JSON.parse(await fs.readFile(path.join(project, "relaybase.app.json"), "utf8"));
    assert.equal(manifest.command, undefined);
    assert.equal(manifest.launch.portBinding, "arguments");
  } finally {
    await hub.close();
  }
});

test("explicit missing manifest is strict and stale registration preview performs zero mutation", async () => {
  const project = await tempProject("relaybase-register-strict-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-register-strict-state-"));
  const manifestPath = path.join(project, "relaybase.app.json");
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await hub.listen();
    const port = hub.address().port;
    const missing = await apiRequest(port, "POST", "/__hub/api/setup/register/preview", {
      path: manifestPath,
      mode: "manifest"
    });
    assert.equal(missing.json.setup.code, "REGISTER_MANIFEST_NOT_FOUND");
    assert.equal(missing.json.setup.approval.required, false);

    await fs.writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, id: "strict-app", name: "Strict App", command: "node app.js" }, null, 2),
      "utf8"
    );
    const preview = await apiRequest(port, "POST", "/__hub/api/setup/register/preview", {
      path: manifestPath,
      mode: "manifest"
    });
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: 1, id: "strict-app", name: "Drifted", command: "node app.js" }, null, 2),
      "utf8"
    );
    const stale = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/register/apply",
      { previewId: preview.json.setup.previewId, confirm: true, confirmation: { confirmed: true } },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json.code, "REGISTER_PREVIEW_STALE");
    assert.equal(await hub.runtime.registry.get("strict-app"), undefined);
  } finally {
    await hub.close();
  }
});

test("setup plans expose Next/Vite framework wrappers and pinned upstream ports", async () => {
  const nextProject = await tempProject("relaybase-setup-api-next-");
  const viteProject = await tempProject("relaybase-setup-api-vite-");
  const astroProject = await tempProject("relaybase-setup-api-astro-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-state-"));
  await writePackageJson(nextProject, {
    name: "next-app",
    scripts: { dev: "next dev" },
    dependencies: { next: "^16.0.0" }
  });
  await writePackageJson(viteProject, {
    name: "vite-app",
    scripts: { dev: "vite" },
    devDependencies: { vite: "^6.0.0" }
  });
  await writePackageJson(astroProject, {
    name: "astro-app",
    scripts: { dev: "astro dev" },
    devDependencies: { astro: "^5.0.0" }
  });
  await fs.writeFile(path.join(viteProject, ".env"), "VITE_PORT=5173\nAPI_KEY=super-secret-value\n", "utf8");
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;

    const nextPreview = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: nextProject,
      selectedPlanId: "framework-port-flag"
    });
    assert.equal(nextPreview.statusCode, 200);
    const nextWrapper = launchWrapperPreview(nextPreview.json.setup.fileWritePlan.writes);
    assert.match(nextWrapper, /const args = \["run","dev"\]\.concat\(\["--","-H","\$HOST","-p","\$PORT"\]/);
    assert.match(nextWrapper, /"-H"/);
    assert.match(nextWrapper, /"-p"/);
    assert.ok(nextPreview.json.setup.selectedPlan.choice.portStrategies.includes("framework_port_flags"));
    assert.ok(nextPreview.json.setup.selectedPlan.choice.portStrategies.includes("generated_launch_wrapper"));

    const vitePlans = await apiRequest(port, "POST", "/__hub/api/setup/plans", { cwd: viteProject });
    assert.equal(vitePlans.statusCode, 200);
    assert.ok(
      vitePlans.json.setup.choices.some((choice: { portStrategies: string[] }) =>
        choice.portStrategies.includes("fixed_upstream_port")
      )
    );
    const vitePreview = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: viteProject,
      selectedPlanId: "framework-port-flag"
    });
    const viteWrapper = launchWrapperPreview(vitePreview.json.setup.fileWritePlan.writes);
    assert.match(viteWrapper, /const args = \["run","dev"\]\.concat\(\["--","--host","\$HOST","--port","\$PORT"\]/);
    assert.match(viteWrapper, /"--host"/);
    assert.match(viteWrapper, /"--port"/);
    assert.doesNotMatch(JSON.stringify(vitePlans.json), /super-secret-value/);
    assert.doesNotMatch(JSON.stringify(vitePreview.json), /super-secret-value/);

    const astroPreview = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: astroProject,
      selectedPlanId: "framework-port-flag"
    });
    assert.equal(astroPreview.statusCode, 200);
    const astroWrapper = launchWrapperPreview(astroPreview.json.setup.fileWritePlan.writes);
    assert.match(astroWrapper, /const args = \["run","dev"\]\.concat\(\["--","--host","\$HOST","--port","\$PORT"\]/);
    assert.match(astroWrapper, /"--host"/);
    assert.match(astroWrapper, /"--port"/);
  } finally {
    await hub.close();
  }
});

test("setup detect reports existing wrapper and setup profile artifacts", async () => {
  const project = await tempProject("relaybase-setup-api-existing-artifacts-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-state-"));
  await writePackageJson(project, {
    name: "existing-artifacts",
    scripts: { dev: "node server.js" }
  });
  await fs.mkdir(path.join(project, ".relaybase"), { recursive: true });
  await fs.writeFile(
    path.join(project, ".relaybase", "launch.cjs"),
    'const { spawn } = require("node:child_process");\nconst port = process.env.PORT;\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(project, ".relaybase", "setup-profile.json"),
    JSON.stringify({ version: 1, planId: "framework-port-flag", architecture: "framework-port-flag" }, null, 2),
    "utf8"
  );
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const detect = await apiRequest(hub.address().port, "POST", "/__hub/api/setup/detect", { cwd: project });
    assert.equal(detect.statusCode, 200);
    assert.equal(detect.json.setup.existingLaunchWrapper.kind, "launch_wrapper");
    assert.equal(detect.json.setup.existingLaunchWrapper.valid, true);
    assert.equal(detect.json.setup.existingSetupProfile.kind, "setup_profile");
    assert.equal(detect.json.setup.existingSetupProfile.planId, "framework-port-flag");
  } finally {
    await hub.close();
  }
});

test("setup apply is token and confirmation gated before writing files", async () => {
  const project = await tempProject("relaybase-setup-api-apply-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-state-"));
  await writePackageJson(project, {
    name: "apply-app",
    scripts: { dev: "node server.js" }
  });
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const events = collectEvents(hub);

    const unauthorized = await apiRequest(port, "POST", "/__hub/api/setup/apply", {
      cwd: project,
      selectedPlanId: "managed-web",
      confirm: true
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unauthorized.json.code, "UNAUTHORIZED_SETUP_APPLY");

    const unconfirmed = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/apply",
      {
        cwd: project,
        selectedPlanId: "managed-web"
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(unconfirmed.statusCode, 428);
    assert.equal(unconfirmed.json.code, "SETUP_APPLY_CONFIRMATION_REQUIRED");
    assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

    const failed = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/apply",
      {
        cwd: project,
        selectedPlanId: "missing-plan",
        confirm: true
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(failed.statusCode, 404);
    assert.equal(failed.json.code, "SETUP_PLAN_NOT_FOUND");

    const applied = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/apply",
      {
        cwd: project,
        selectedPlanId: "managed-web",
        confirm: true,
        repair: true
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(applied.statusCode, 202);
    assert.equal(applied.json.setup.registeredApp.id, "apply-app");
    assert.equal(await exists(path.join(project, "relaybase.app.json")), true);
    assert.equal(await exists(path.join(project, ".relaybase", "setup-profile.json")), true);

    const registry = new Registry(stateDir);
    await registry.load();
    assert.equal((await registry.get("apply-app"))?.id, "apply-app");
    assert.ok(events.types().includes("setup.apply_started"));
    assert.ok(events.types().includes("setup.apply_failed"));
    assert.ok(events.types().includes("setup.apply_completed"));
    assert.ok(events.types().includes("setup.repair_applied"));
    events.unsubscribe();
  } finally {
    await hub.close();
  }
});

test("setup preview and apply preserve approved command, plan, port strategy, and component metadata", async () => {
  const project = await tempProject("relaybase-setup-api-selection-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-selection-state-"));
  await writePackageJson(project, {
    name: "selection-app",
    scripts: {
      dev: "vite --host 127.0.0.1",
      build: "vite build"
    },
    devDependencies: {
      vite: "^6.0.0"
    }
  });
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const expectedCommand = process.platform === "win32" ? "npm.cmd run dev" : "npm run dev";
    const componentMetadata = {
      appId: "selection-web",
      name: "Selection Web",
      groupId: "selection",
      componentRole: "frontend",
      displayName: "Selection",
      paneLabel: "frontend",
      paneOrder: 10
    };

    const preview = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: project,
      commandHint: "npm run dev",
      selectedPlanId: "framework-port-flag",
      portStrategyHint: "generated_launch_wrapper",
      envStrategy: "runtime-injection",
      componentMetadata
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json.setup.selectedPlan.id, "framework-port-flag");
    assert.equal(preview.json.setup.selectedPlan.manifest.id, "selection-web");
    assert.equal(preview.json.setup.selectedPlan.choice.selectedCommand, expectedCommand);
    assert.equal(preview.json.setup.selectedPlan.choice.portStrategyHint, "generated_launch_wrapper");
    assert.ok(preview.json.setup.selectedPlan.choice.portStrategies.includes("generated_launch_wrapper"));
    assert.equal(preview.json.setup.selectedPlan.manifest.relaybase.componentRole, "frontend");
    assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

    const applied = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/apply",
      {
        cwd: project,
        commandHint: "npm run dev",
        selectedPlanId: "framework-port-flag",
        portStrategyHint: "generated_launch_wrapper",
        envStrategy: "runtime-injection",
        componentMetadata,
        confirm: true
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(applied.statusCode, 202);
    assert.equal(applied.json.setup.selectedPlan.id, "framework-port-flag");
    assert.equal(applied.json.setup.selectedPlan.selectedCommand, expectedCommand);

    const manifest = JSON.parse(await fs.readFile(path.join(project, "relaybase.app.json"), "utf8"));
    assert.equal(manifest.command, "node .relaybase/launch.cjs");
    assert.equal(manifest.id, "selection-web");
    assert.equal(manifest.relaybase.groupId, "selection");
    assert.equal(manifest.relaybase.componentRole, "frontend");
    assert.equal(manifest.relaybase.paneLabel, "frontend");
    const profile = JSON.parse(await fs.readFile(path.join(project, ".relaybase", "setup-profile.json"), "utf8"));
    assert.equal(profile.selectedCommand, expectedCommand);
    assert.equal(profile.portStrategy, "generated_launch_wrapper");
    const answers = JSON.parse(await fs.readFile(path.join(project, ".relaybase", "setup.answers.json"), "utf8"));
    assert.equal(answers.commandHint, expectedCommand);
    assert.equal(answers.portStrategyHint, "generated_launch_wrapper");
    assert.equal(answers.componentMetadata.componentRole, "frontend");
    const wrapper = await fs.readFile(path.join(project, ".relaybase", "launch.cjs"), "utf8");
    assert.match(wrapper, /const args = \["run","dev"\]\.concat/);
  } finally {
    await hub.close();
  }
});

test("setup command hints reject unsafe or unsupported commands before writing", async () => {
  const project = await tempProject("relaybase-setup-api-command-safety-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-command-safety-state-"));
  await writePackageJson(project, {
    name: "unsafe-command-app",
    scripts: {
      dev: "node server.js"
    }
  });
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const unsafe = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: project,
      commandHint: "npm run dev && echo owned"
    });
    assert.equal(unsafe.statusCode, 400);
    assert.equal(unsafe.json.code, "SETUP_COMMAND_HINT_UNSAFE");
    assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

    const unsupported = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: project,
      commandHint: "node arbitrary.js"
    });
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.json.code, "SETUP_COMMAND_HINT_UNSUPPORTED");

    const unconfirmedChangedCommand = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/apply",
      {
        cwd: project,
        commandHint: "npm run dev"
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(unconfirmedChangedCommand.statusCode, 428);
    assert.equal(unconfirmedChangedCommand.json.code, "SETUP_APPLY_CONFIRMATION_REQUIRED");
    assert.equal(await exists(path.join(project, "relaybase.app.json")), false);
  } finally {
    await hub.close();
  }
});

test("setup port strategy hint selects compatible plans or returns diagnostic", async () => {
  const project = await tempProject("relaybase-setup-api-port-hint-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-port-hint-state-"));
  await writePackageJson(project, {
    name: "port-hint-app",
    scripts: {
      dev: "vite"
    },
    devDependencies: {
      vite: "^6.0.0"
    }
  });
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const selectedByPort = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: project,
      portStrategyHint: "generated_launch_wrapper"
    });
    assert.equal(selectedByPort.statusCode, 200);
    assert.equal(selectedByPort.json.setup.selectedPlan.id, "framework-port-flag");
    assert.equal(selectedByPort.json.setup.selectedPlan.choice.portStrategyHint, "generated_launch_wrapper");

    const mismatch = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: project,
      selectedPlanId: "managed-web",
      portStrategyHint: "generated_launch_wrapper"
    });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json.code, "SETUP_PORT_STRATEGY_MISMATCH");
  } finally {
    await hub.close();
  }
});

test("manifest inspect, validate, patch preview, and patch apply stay safe", async () => {
  const project = await tempProject("relaybase-setup-api-manifest-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-state-"));
  const manifestPath = path.join(project, "relaybase.app.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "manifest-app",
        name: "Manifest App",
        command: "npm.cmd run dev",
        cwd: ".",
        protocol: "http",
        healthUrl: "/",
        env: {
          PUBLIC_FLAG: "ok",
          SECRET_TOKEN: "super-secret-token"
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  const before = await fs.readFile(manifestPath, "utf8");
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const events = collectEvents(hub);

    const inspect = await apiRequest(port, "POST", "/__hub/api/setup/inspect-manifest", {
      cwd: project,
      manifestPath
    });
    assert.equal(inspect.statusCode, 200);
    assert.equal(inspect.json.setup.valid, true);
    assert.doesNotMatch(JSON.stringify(inspect.json), /super-secret-token/);

    const validate = await apiRequest(port, "POST", "/__hub/api/setup/validate-manifest", {
      cwd: project,
      manifestPath
    });
    assert.equal(validate.statusCode, 200);
    assert.equal(validate.json.setup.valid, true);

    const preview = await apiRequest(port, "POST", "/__hub/api/setup/patch-manifest/preview", {
      cwd: project,
      manifestPath,
      patch: {
        healthUrl: "/api/health",
        env: {
          PUBLIC_FLAG: "changed",
          API_KEY: "super-secret-key"
        },
        relaybase: {
          groupId: "manifest",
          componentRole: "frontend",
          displayName: "Manifest",
          paneLabel: "frontend",
          paneOrder: 10
        }
      }
    });
    assert.equal(preview.statusCode, 200);
    assert.match(JSON.stringify(preview.json.setup.fileWritePlan), /api\/health/);
    assert.doesNotMatch(JSON.stringify(preview.json), /super-secret-key|super-secret-token/);
    assert.equal(await fs.readFile(manifestPath, "utf8"), before);

    const traversal = await apiRequest(port, "POST", "/__hub/api/setup/patch-manifest/preview", {
      cwd: project,
      manifestPath: path.join(project, "..", "outside.app.json"),
      patch: { healthUrl: "/safe" }
    });
    assert.equal(traversal.statusCode, 400);
    assert.equal(traversal.json.code, "SETUP_PATH_OUTSIDE_PROJECT");

    const noCwdAbsolute = await apiRequest(port, "POST", "/__hub/api/setup/inspect-manifest", {
      manifestPath
    });
    assert.equal(noCwdAbsolute.statusCode, 400);
    assert.equal(noCwdAbsolute.json.code, "SETUP_PATH_OUTSIDE_PROJECT");

    const unsafeCommandPatch = await apiRequest(port, "POST", "/__hub/api/setup/patch-manifest/preview", {
      cwd: project,
      manifestPath,
      patch: { command: "node server.js | tee app.log" }
    });
    assert.equal(unsafeCommandPatch.statusCode, 400);
    assert.equal(unsafeCommandPatch.json.code, "SETUP_COMMAND_PATCH_UNSAFE");
    assert.equal(await fs.readFile(manifestPath, "utf8"), before);

    const unconfirmed = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/patch-manifest/apply",
      {
        cwd: project,
        manifestPath,
        patch: { healthUrl: "/api/health" }
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(unconfirmed.statusCode, 428);

    const applied = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/patch-manifest/apply",
      {
        cwd: project,
        manifestPath,
        patch: {
          healthUrl: "/api/health",
          relaybase: {
            groupId: "manifest",
            componentRole: "backend",
            paneLabel: "backend",
            paneOrder: 20
          }
        },
        confirm: true
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json.setup.app.healthUrl, "/api/health");
    assert.equal(applied.json.setup.app.relaybase.groupId, "manifest");
    assert.equal(applied.json.setup.app.relaybase.componentRole, "backend");
    assert.match(await fs.readFile(manifestPath, "utf8"), /api\/health/);

    const registered = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/register-manifest",
      {
        cwd: project,
        manifestPath
      },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(registered.statusCode, 201);
    assert.equal(registered.json.setup.app.id, "manifest-app");
    assert.ok(events.types().includes("setup.registered"));
    events.unsubscribe();
  } finally {
    await hub.close();
  }
});

test("setup open and prove delegate to the daemon setup engine", async () => {
  const project = await tempProject("relaybase-setup-api-open-prove-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-state-"));
  const fixture = path.resolve("tests", "fixtures", "fake-managed-app.ts");
  const hub = await createRelaybaseServer({ port: 0, stateDir, portRangeStart: 18900, portRangeEnd: 18920 });
  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "setup-open-prove-app",
        name: "Setup Open Prove App",
        command: `"${process.execPath}" --experimental-strip-types "${fixture}"`,
        cwd: path.resolve("."),
        protocol: "http",
        healthUrl: "/health"
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  try {
    await hub.listen();
    const port = hub.address().port;

    const openUnconfirmed = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/open",
      { cwd: project },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(openUnconfirmed.statusCode, 428);

    const opened = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/open",
      { cwd: project, confirm: true, noBrowser: true },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(opened.statusCode, 202);
    assert.equal(opened.json.setup.result.registered, true);
    assert.equal(opened.json.setup.result.started, true);
    assert.equal(opened.json.setup.result.ready, true);

    const proved = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/prove",
      { cwd: project, confirm: true, lifecycleProof: true },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(proved.statusCode, 202);
    assert.equal(proved.json.setup.result.proof.mode, "lifecycle");
    assert.equal(proved.json.setup.result.proof.ok, true);
    assert.equal(proved.json.setup.result.proof.started, true);
    assert.equal(proved.json.setup.result.proof.stopped, true);
  } finally {
    await hub.runtime.processes.stop("setup-open-prove-app").catch(() => undefined);
    await hub.close();
  }
});

test("setup diagnostics cover invalid paths, setup operations, and component metadata plans", async () => {
  const project = await tempProject("relaybase-setup-api-component-");
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-setup-api-state-"));
  await writePackageJson(project, {
    name: "component-app",
    scripts: { dev: "node server.js" }
  });
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    const events = collectEvents(hub);

    const invalid = await apiRequest(port, "POST", "/__hub/api/setup/detect", {
      cwd: path.join(project, "missing")
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json.code, "SETUP_INVALID_PATH");
    assert.equal(invalid.json.relaybaseError.code, "SETUP_INVALID_PATH");
    assert.ok(invalid.headers["x-relaybase-correlation-id"]);

    const operation = await apiRequest(port, "GET", "/__hub/api/setup/operations/missing");
    assert.equal(operation.statusCode, 404);
    assert.equal(operation.json.code, "SETUP_OPERATION_NOT_FOUND");

    const registerUnauthorized = await apiRequest(port, "POST", "/__hub/api/setup/register-manifest", {
      cwd: project,
      manifestPath: path.join(project, "relaybase.app.json")
    });
    assert.equal(registerUnauthorized.statusCode, 401);
    assert.equal(registerUnauthorized.json.code, "UNAUTHORIZED_SETUP_REGISTER");

    const openUnauthorized = await apiRequest(port, "POST", "/__hub/api/setup/open", {
      cwd: project,
      confirm: true
    });
    assert.equal(openUnauthorized.statusCode, 401);
    assert.equal(openUnauthorized.json.code, "UNAUTHORIZED_SETUP_OPEN");

    const proveUnconfirmed = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/prove",
      { cwd: project },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(proveUnconfirmed.statusCode, 428);
    assert.equal(proveUnconfirmed.json.code, "SETUP_PROVE_CONFIRMATION_REQUIRED");

    const proved = await apiRequest(
      port,
      "POST",
      "/__hub/api/setup/prove",
      { cwd: project, confirm: true },
      { "x-relaybase-token": hub.runtime.token }
    );
    assert.equal(proved.statusCode, 202);
    assert.equal(proved.json.setup.result.project.configured, false);

    const repair = await apiRequest(port, "POST", "/__hub/api/setup/repair", {
      cwd: project,
      reason: "test repair preview"
    });
    assert.equal(repair.statusCode, 200);
    assert.ok(repair.json.setup.plan.choices.length > 0);
    assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

    const componentPreview = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: project,
      selectedPlanId: "managed-web",
      componentMetadata: {
        appId: "component-backend",
        name: "Component Backend",
        groupId: "component",
        componentRole: "backend",
        displayName: "Component",
        paneLabel: "backend",
        paneOrder: 20
      }
    });
    assert.equal(componentPreview.statusCode, 200);
    assert.equal(componentPreview.json.setup.selectedPlan.manifest.id, "component-backend");
    assert.equal(componentPreview.json.setup.selectedPlan.manifest.relaybase.groupId, "component");
    assert.equal(componentPreview.json.setup.selectedPlan.manifest.relaybase.componentRole, "backend");
    assert.equal(componentPreview.json.setup.selectedPlan.manifest.relaybase.paneOrder, 20);

    const pairPreview = await apiRequest(port, "POST", "/__hub/api/setup/preview", {
      cwd: project,
      selectedPlanId: "managed-web",
      components: [
        {
          appId: "component-frontend",
          name: "Component Frontend",
          groupId: "component",
          componentRole: "frontend",
          displayName: "Component",
          paneLabel: "frontend",
          paneOrder: 10
        },
        {
          appId: "component-backend",
          name: "Component Backend",
          groupId: "component",
          componentRole: "backend",
          displayName: "Component",
          paneLabel: "backend",
          paneOrder: 20
        }
      ]
    });
    assert.equal(pairPreview.statusCode, 200);
    assert.equal(pairPreview.json.setup.componentPlans.length, 2);
    assert.deepEqual(
      pairPreview.json.setup.componentPlans.map(
        (plan: { manifest: { relaybase: { componentRole: string } } }) => plan.manifest.relaybase.componentRole
      ),
      ["frontend", "backend"]
    );
    assert.ok(
      pairPreview.json.setup.componentPlans[0].writes.some((write: { path: string }) =>
        write.path.endsWith("relaybase.component-frontend.app.json")
      )
    );
    assert.ok(
      pairPreview.json.setup.componentPlans[1].writes.some((write: { path: string }) =>
        write.path.endsWith("relaybase.component-backend.app.json")
      )
    );
    assert.ok(events.types().includes("setup.prove_started"));
    assert.ok(events.types().includes("setup.prove_completed"));
    assert.ok(events.types().includes("setup.repair_plan_created"));
    events.unsubscribe();
  } finally {
    await hub.close();
  }
});

async function tempProject(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writePackageJson(project: string, body: Record<string, unknown>): Promise<void> {
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify(body, null, 2) + "\n", "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function launchWrapperPreview(writes: Array<{ path: string; preview: string }>): string {
  return writes.find((write) => write.path.endsWith(path.join(".relaybase", "launch.cjs")))?.preview ?? "";
}

function collectEvents(hub: Awaited<ReturnType<typeof createRelaybaseServer>>): {
  types(): string[];
  unsubscribe(): void;
} {
  const types: string[] = [];
  const unsubscribe = hub.runtime.events.subscribe((event) => {
    types.push(event.type);
  });
  return {
    types: () => [...types],
    unsubscribe
  };
}

function apiRequest(
  port: number,
  method: string,
  pathName: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string; json: Record<string, any>; headers: http.IncomingHttpHeaders }> {
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
        response.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            body: bodyText,
            json: bodyText ? JSON.parse(bodyText) : {},
            headers: response.headers
          });
        });
      }
    );
    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}
