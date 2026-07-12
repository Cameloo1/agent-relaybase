#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentPlatformBinaryPath,
  currentPlatformDevelopmentBinaryPath,
  formatMissingGoDiagnostic,
  goCommandEnv,
  requiredGoVersion
} from "./tui-go.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultArtifactRoot = path.join(root, "artifacts", "tui-verification");
const defaultReportPath = path.join(root, "reports", "release-candidate", "tui-evidence-report.md");
const eightPaneReportPath = path.join(root, "reports", "release-candidate", "tui-8pane-evidence-report.md");
const nodeStripTypesArgs = ["--experimental-strip-types"];
const fixtureDefault = "default";
const fixtureEightPane = "8pane";

export function artifactPaths(artifactRoot = defaultArtifactRoot) {
  return {
    root: artifactRoot,
    ptyTranscript: path.join(artifactRoot, "pty-transcript.txt"),
    tuiOutput: path.join(artifactRoot, "tui-output.txt"),
    stateBefore: path.join(artifactRoot, "state-before.json"),
    stateAfter: path.join(artifactRoot, "state-after.json"),
    preferencesBefore: path.join(artifactRoot, "preferences-before.json"),
    preferencesAfter: path.join(artifactRoot, "preferences-after.json"),
    metadata: path.join(artifactRoot, "metadata.json"),
    commands: path.join(artifactRoot, "commands.md"),
    bridgeUnavailable: path.join(artifactRoot, "bridge-daemon-unavailable.txt"),
    daemonUnavailable: path.join(artifactRoot, "daemon-unavailable-transcript.txt"),
    groupedPanes: path.join(artifactRoot, "grouped-panes-transcript.txt"),
    groupedEightPanes: path.join(artifactRoot, "grouped-8pane-transcript.txt"),
    slashConfirmation: path.join(artifactRoot, "slash-stop-confirmation-transcript.txt"),
    exportConfirmation: path.join(artifactRoot, "export-confirmation-transcript.txt"),
    assistantConfirmation: path.join(artifactRoot, "assistant-confirmation-transcript.txt"),
    usageMenu: path.join(artifactRoot, "usage-menu-transcript.txt")
  };
}

export function smokeFixtureDefinition(name = fixtureDefault) {
  if (name !== fixtureEightPane) {
    return {
      name: fixtureDefault,
      smokeWidth: 110,
      smokeHeight: 32,
      expectedPaneCount: 2,
      apps: [
        smokeApp("notes-web", "Notes Web", "notes", "Notes", "frontend", 10),
        smokeApp("notes-api", "Notes API", "notes", "Notes", "backend", 20)
      ]
    };
  }

  return {
    name: fixtureEightPane,
    smokeWidth: 180,
    smokeHeight: 48,
    expectedPaneCount: 8,
    apps: [
      smokeApp("notes-web", "Notes Web", "notes", "Notes", "frontend", 10),
      smokeApp("notes-api", "Notes API", "notes", "Notes", "backend", 20),
      smokeApp("shop-web", "Shop Web", "shop", "Shop", "frontend", 10),
      smokeApp("shop-api", "Shop API", "shop", "Shop", "backend", 20),
      smokeApp("admin-web", "Admin Web", "admin", "Admin", "frontend", 10),
      smokeApp("admin-api", "Admin API", "admin", "Admin", "backend", 20),
      smokeApp("blog-web", "Blog Web", "blog", "Blog", "frontend", 10),
      smokeApp("blog-api", "Blog API", "blog", "Blog", "backend", 20)
    ]
  };
}

function smokeApp(id, name, groupId, displayName, role, paneOrder) {
  return {
    id,
    name,
    groupId,
    displayName,
    role,
    paneLabel: role,
    paneOrder,
    logMessage: `${id} ${role} smoke log`
  };
}

export function evaluateSmokePrerequisites(options = {}) {
  const rootDir = options.rootDir ?? root;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const exists = options.exists ?? existsSync;
  const developmentBinaryPath = currentPlatformDevelopmentBinaryPath({ rootDir, platform, arch });
  const packageBinaryPath = currentPlatformBinaryPath({ rootDir, platform, arch });
  const binaryPath = options.binaryPath ?? (exists(developmentBinaryPath) ? developmentBinaryPath : packageBinaryPath);
  const binaryExists = exists(binaryPath);
  const goVersion = options.requiredGoVersion ?? requiredGoVersion({ goModPath: path.join(rootDir, "tui", "go.mod") });

  return {
    ok: binaryExists,
    binaryPath,
    binaryExists,
    requiredGoVersion: goVersion,
    diagnostic: binaryExists ? "" : formatMissingTuiSmokeBinaryDiagnostic({ binaryPath, requiredGoVersion: goVersion })
  };
}

export function formatMissingTuiSmokeBinaryDiagnostic(options = {}) {
  const binaryPath = options.binaryPath ?? currentPlatformBinaryPath({ rootDir: root });
  const requiredVersion = options.requiredGoVersion ?? requiredGoVersion();
  return [
    "relaybase tui smoke: relaybase-tui binary is required for real UX evidence but was not found.",
    `Expected binary: ${binaryPath}`,
    "Build the TUI with: npm run tui:build",
    "If Go is missing, resolve the toolchain first:",
    formatMissingGoDiagnostic({
      requiredVersion,
      action: "smoke evidence",
      retryScript: "npm run tui:build"
    }),
    "The smoke harness will not mark TUI launch, screenshots, confirmations, or preference evidence as passing without a real binary."
  ].join("\n");
}

export async function runTuiSmoke(args = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(args);
  const fixture = smokeFixtureDefinition(options.fixture ?? parsed.fixture);
  const artifactRoot = path.resolve(options.artifactRoot ?? parsed.artifactRoot ?? defaultArtifactRoot);
  const paths = artifactPaths(artifactRoot);
  const reportPath = reportPathForFixture(fixture.name);
  const evidence = createEvidenceState(paths, fixture);
  const commands = [];
  let tempStateDir;
  let cleanupStatus = "not started";

  await ensureArtifactDirs(paths, reportPath);
  await writeMetadata(paths, artifactRoot);

  const prerequisite = evaluateSmokePrerequisites(options);
  evidence.tooling.binaryPath = prerequisite.binaryPath;
  evidence.tooling.binaryExists = prerequisite.binaryExists;
  evidence.tooling.requiredGoVersion = prerequisite.requiredGoVersion;
  evidence.tooling.captureTools = detectCaptureTools();

  const bridgeUnavailable = await captureBridgeDaemonUnavailable(paths);
  commands.push(bridgeUnavailable.command);
  evidence.cases.bridgeDaemonUnavailable =
    bridgeUnavailable.status === 0 && transcriptHasDiagnostic(bridgeUnavailable.output) ? "passed" : "failed";

  if (!prerequisite.ok) {
    const blockedText = [
      prerequisite.diagnostic,
      "",
      "Blocked evidence cases:",
      "- direct relaybase-tui binary launch",
      "- relaybase tui bridge launch against a reachable disposable daemon",
      "- grouped frontend/backend pane render",
      "- preference persistence across TUI restarts",
      "- slash lifecycle confirmation",
      "- export confirmation",
      "- command/assistant bar confirmation",
      "- screenshot or terminal recording"
    ].join("\n");

    await writeFile(paths.ptyTranscript, blockedText, "utf8");
    await writeFile(paths.tuiOutput, blockedText, "utf8");
    await writePlaceholderJson(paths.stateBefore, { status: "not_verified", reason: "relaybase-tui binary missing" });
    await writePlaceholderJson(paths.stateAfter, { status: "not_verified", reason: "relaybase-tui binary missing" });
    await writePlaceholderJson(paths.preferencesBefore, {
      status: "not_verified",
      reason: "relaybase-tui binary missing"
    });
    await writePlaceholderJson(paths.preferencesAfter, {
      status: "not_verified",
      reason: "relaybase-tui binary missing"
    });

    evidence.verdict = "FAIL - environment/package blocker";
    evidence.notes.push(
      "No TUI UX claim is marked passing because the current-platform relaybase-tui binary is missing."
    );
    await writeCommandLog(paths.commands, commands);
    await writeEvidenceReport(evidence, paths, cleanupStatus, reportPath);
    console.error(blockedText);
    console.error(`\nWrote TUI evidence report: ${reportPath}`);
    return 1;
  }

  let hub;
  try {
    tempStateDir = await mkdtemp(path.join(os.tmpdir(), "relaybase-tui-smoke-state-"));
    hub = await startSmokeDaemon(tempStateDir);
    cleanupStatus = "daemon started";
    await seedSmokeApps(hub, fixture.apps);
    await startSmokeApps(hub, fixture.apps);
    await emitSmokeLogs(hub, fixture.apps);

    await copyJsonArtifact(paths.preferencesBefore, await seedPreferenceFile(tempStateDir, fixture.apps));
    const stateBefore = await getStateSnapshot(hub);
    await writeJson(paths.stateBefore, stateBefore);

    const directUnavailable = await launchTuiAndCapture(
      prerequisite.binaryPath,
      ["--base-url", "http://127.0.0.1:1", "--state-dir", tempStateDir, "--theme", "light", "--smoke-render"],
      {
        title: "direct relaybase-tui daemon-unavailable diagnostic",
        timeoutMs: 6000
      }
    );
    commands.push(directUnavailable.command);
    await writeFile(paths.daemonUnavailable, directUnavailable.transcript, "utf8");
    evidence.cases.daemonUnavailable = transcriptHasDiagnostic(directUnavailable.transcript) ? "passed" : "failed";

    const directLaunch = await launchTuiAndCapture(
      prerequisite.binaryPath,
      [
        "--base-url",
        baseURL(hub),
        "--state-dir",
        tempStateDir,
        "--theme",
        "light",
        "--smoke-render",
        "--smoke-width",
        String(fixture.smokeWidth),
        "--smoke-height",
        String(fixture.smokeHeight)
      ],
      {
        title:
          fixture.name === fixtureEightPane
            ? "direct relaybase-tui connected 8-pane launch"
            : "direct relaybase-tui connected launch",
        timeoutMs: 7000
      }
    );
    commands.push(directLaunch.command);
    await writeFile(paths.groupedPanes, directLaunch.transcript, "utf8");
    if (fixture.name === fixtureEightPane) {
      await writeFile(paths.groupedEightPanes, directLaunch.transcript, "utf8");
    }
    evidence.cases.directLaunch = directLaunch.launched ? "passed" : "failed";
    evidence.cases.daemonConnection = transcriptShowsConnection(directLaunch.transcript) ? "passed" : "failed";
    evidence.cases.groupedPanes = transcriptShowsGroupedPanes(directLaunch.transcript, fixture) ? "passed" : "failed";
    evidence.cases.styledOperatorShell = transcriptHasStyledOperatorShell(directLaunch.transcript, fixture)
      ? "passed"
      : "failed";
    if (fixture.name === fixtureEightPane) {
      evidence.cases.groupedEightPanes = transcriptShowsEightPaneDetails(directLaunch.transcript, fixture)
        ? "passed"
        : "failed";
    }

    const bridgeLaunch = await captureBridgeLaunch(paths, tempStateDir, hub);
    commands.push(bridgeLaunch.command);
    evidence.cases.bridgeLaunch = bridgeLaunch.launched ? "passed" : "failed";
    evidence.cases.bridgeResponsiveLayout = transcriptHasResponsiveBridgeLayout(bridgeLaunch.transcript, fixture)
      ? "passed"
      : "failed";

    const slash = await launchTuiAndCapture(
      prerequisite.binaryPath,
      [
        "--base-url",
        baseURL(hub),
        "--state-dir",
        tempStateDir,
        "--theme",
        "light",
        "--smoke-render",
        "--smoke-input",
        "/stop current"
      ],
      {
        title: "slash stop confirmation",
        timeoutMs: 8000
      }
    );
    commands.push(slash.command);
    await writeFile(paths.slashConfirmation, slash.transcript, "utf8");
    evidence.cases.slashConfirmation = transcriptShowsConfirmation(slash.transcript) ? "passed" : "failed";

    const exportConfirmation = await launchTuiAndCapture(
      prerequisite.binaryPath,
      [
        "--base-url",
        baseURL(hub),
        "--state-dir",
        tempStateDir,
        "--theme",
        "light",
        "--smoke-render",
        "--smoke-input",
        "/logs export pane"
      ],
      {
        title: "export confirmation",
        timeoutMs: 8000
      }
    );
    commands.push(exportConfirmation.command);
    await writeFile(paths.exportConfirmation, exportConfirmation.transcript, "utf8");
    evidence.cases.exportConfirmation = transcriptShowsConfirmation(exportConfirmation.transcript)
      ? "passed"
      : "failed";

    const assistantConfirmation = await launchTuiAndCapture(
      prerequisite.binaryPath,
      [
        "--base-url",
        baseURL(hub),
        "--state-dir",
        tempStateDir,
        "--theme",
        "light",
        "--smoke-render",
        "--smoke-input",
        "stop backend"
      ],
      {
        title: "assistant stop confirmation",
        timeoutMs: 8000
      }
    );
    commands.push(assistantConfirmation.command);
    await writeFile(paths.assistantConfirmation, assistantConfirmation.transcript, "utf8");
    evidence.cases.assistantConfirmation = transcriptShowsConfirmation(assistantConfirmation.transcript)
      ? "passed"
      : "failed";

    const usageMenu = await launchTuiAndCapture(
      prerequisite.binaryPath,
      [
        "--base-url",
        baseURL(hub),
        "--state-dir",
        tempStateDir,
        "--theme",
        "light",
        "--smoke-render",
        "--smoke-input",
        "/usage"
      ],
      { title: "usage menu empty state", timeoutMs: 8000 }
    );
    commands.push(usageMenu.command);
    await writeFile(paths.usageMenu, usageMenu.transcript, "utf8");
    evidence.cases.usageMenu =
      usageMenu.transcript.includes("Usage") && usageMenu.transcript.includes("No completed model usage yet.")
        ? "passed"
        : "failed";

    await copyJsonArtifact(paths.preferencesAfter, preferencePath(tempStateDir));
    evidence.cases.preferences = await preferencesSurvived(paths.preferencesBefore, paths.preferencesAfter);

    const stateAfter = await getStateSnapshot(hub);
    await writeJson(paths.stateAfter, stateAfter);
    evidence.cases.noDestructiveBeforeConfirmation = appsStillRunning(stateAfter, fixture.apps) ? "passed" : "failed";
    evidence.cases.recording = "not_available";
    evidence.notes.push(captureEvidenceNote(evidence.tooling.captureTools));
    cleanupStatus = await cleanupSmokeHub(hub, fixture.apps);
    hub = undefined;

    await writeFile(
      paths.ptyTranscript,
      [
        "Relaybase TUI smoke transcript bundle",
        "",
        directUnavailable.transcript,
        directLaunch.transcript,
        bridgeLaunch.transcript,
        slash.transcript,
        exportConfirmation.transcript,
        assistantConfirmation.transcript,
        usageMenu.transcript
      ].join("\n\n"),
      "utf8"
    );
    await writeFile(paths.tuiOutput, [directLaunch.output, bridgeLaunch.output].join("\n\n"), "utf8");

    evidence.verdict = allRequiredCasesPass(evidence.cases, fixture) ? "PASS" : "FAIL - evidence incomplete";
    await writeCommandLog(paths.commands, commands);
    await writeEvidenceReport(evidence, paths, cleanupStatus, reportPath);
    console.log(`Relaybase TUI smoke verdict: ${evidence.verdict}`);
    console.log(`Evidence report: ${reportPath}`);
    return evidence.verdict === "PASS" ? 0 : 1;
  } catch (error) {
    evidence.verdict = "FAIL - smoke harness error";
    evidence.notes.push(error instanceof Error ? error.message : String(error));
    if (hub) {
      cleanupStatus = await cleanupSmokeHub(hub, fixture.apps);
      hub = undefined;
    }
    await writeCommandLog(paths.commands, commands);
    await writeEvidenceReport(evidence, paths, cleanupStatus, reportPath);
    console.error(`Relaybase TUI smoke verdict: ${evidence.verdict}`);
    console.error(`Evidence report: ${reportPath}`);
    return 1;
  } finally {
    if (hub) {
      await cleanupSmokeHub(hub, fixture.apps);
    }
  }
}

function parseArgs(args) {
  const result = { fixture: fixtureDefault };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifact-dir") {
      result.artifactRoot = args[index + 1];
      index += 1;
    } else if (arg === "--fixture") {
      result.fixture = args[index + 1] === fixtureEightPane ? fixtureEightPane : fixtureDefault;
      index += 1;
    } else if (arg === "--8pane") {
      result.fixture = fixtureEightPane;
    }
  }
  return result;
}

function createEvidenceState(paths, fixture) {
  return {
    generatedAt: new Date().toISOString(),
    verdict: "FAIL - not run",
    artifactRoot: paths.root,
    fixture: fixture.name,
    tooling: {
      binaryPath: "",
      binaryExists: false,
      requiredGoVersion: "",
      captureTools: {}
    },
    cases: {
      bridgeDaemonUnavailable: "not_run",
      daemonUnavailable: "not_run",
      directLaunch: "not_run",
      bridgeLaunch: "not_run",
      bridgeResponsiveLayout: "not_run",
      daemonConnection: "not_run",
      groupedPanes: "not_run",
      styledOperatorShell: "not_run",
      groupedEightPanes: fixture.name === fixtureEightPane ? "not_run" : "not_applicable",
      preferences: "not_run",
      slashConfirmation: "not_run",
      exportConfirmation: "not_run",
      assistantConfirmation: "not_run",
      usageMenu: "not_run",
      noDestructiveBeforeConfirmation: "not_run",
      recording: "not_run"
    },
    notes: []
  };
}

function reportPathForFixture(fixtureName) {
  return fixtureName === fixtureEightPane ? eightPaneReportPath : defaultReportPath;
}

async function ensureArtifactDirs(paths, reportPath) {
  await mkdir(paths.root, { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
}

async function writeMetadata(paths, artifactRoot) {
  const metadata = {
    generatedAt: new Date().toISOString(),
    cwd: root,
    artifactRoot,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    npm: runVersionCommand(npmCommand(), ["--version"]),
    go: runVersionCommand("go", ["version"])
  };
  await writeJson(paths.metadata, metadata);
}

function runVersionCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) {
    return { status: null, error: result.error.message };
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function detectCaptureTools() {
  return {
    vhs: executablePresent("vhs"),
    asciinema: executablePresent("asciinema")
  };
}

function executablePresent(command) {
  const probe = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(probe, [command], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return !result.error && result.status === 0;
}

async function captureBridgeDaemonUnavailable(paths) {
  const offlineStateDir = await mkdtemp(path.join(os.tmpdir(), "relaybase-tui-smoke-offline-"));
  const command = {
    name: "bridge daemon unavailable",
    argv: [
      process.execPath,
      ...nodeStripTypesArgs,
      path.join(root, "src", "cli.ts"),
      "tui",
      "--host",
      "127.0.0.1",
      "--port",
      "1",
      "--state-dir",
      offlineStateDir,
      "--no-daemon-start",
      "--",
      "--smoke-render"
    ],
    status: null,
    signal: null
  };
  const result = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  command.status = result.status ?? null;
  command.signal = result.signal ?? null;
  const output = [
    "$ " + command.argv.map(quoteArg).join(" "),
    "",
    "STDOUT:",
    result.stdout ?? "",
    "",
    "STDERR:",
    result.stderr ?? "",
    result.error ? `\nERROR: ${result.error.message}` : ""
  ].join("\n");
  await writeFile(paths.bridgeUnavailable, output, "utf8");
  return { command, status: result.status ?? 1, output };
}

async function startSmokeDaemon(stateDir) {
  const { createRelaybaseServer } = await import("../src/server.ts");
  const portRange = smokePortRange();
  const hub = await createRelaybaseServer({
    host: "127.0.0.1",
    port: 0,
    stateDir,
    portRangeStart: portRange.start,
    portRangeEnd: portRange.end
  });
  await hub.listen();
  return hub;
}

function smokePortRange() {
  const configured = Number(process.env.RELAYBASE_TUI_SMOKE_PORT_RANGE_START);
  if (Number.isInteger(configured) && configured > 0) {
    return { start: configured, end: configured + 63 };
  }
  const start = 20000 + (process.pid % 400) * 64;
  return { start, end: start + 63 };
}

async function cleanupSmokeHub(hub, apps = smokeFixtureDefinition().apps) {
  let cleanupErrors = 0;
  for (const app of apps) {
    try {
      await hub.runtime.processes.stop(app.id);
    } catch {
      cleanupErrors += 1;
    }
  }
  try {
    await hub.close();
    return cleanupErrors === 0 ? "daemon and fixture processes stopped" : "cleanup attempted with errors";
  } catch {
    return "cleanup attempted with errors";
  }
}

async function seedSmokeApps(hub, apps) {
  const fixture = path.join(root, "tests", "fixtures", "fake-managed-app.ts");
  const command = `"${process.execPath}" --experimental-strip-types "${fixture}"`;
  for (const app of apps) {
    await hub.runtime.registry.upsertManifest({
      id: app.id,
      name: app.name,
      command,
      cwd: root,
      protocol: "http",
      healthUrl: "/health",
      relaybase: {
        groupId: app.groupId,
        componentRole: app.role,
        displayName: app.displayName,
        paneLabel: app.paneLabel,
        paneOrder: app.paneOrder
      }
    });
  }
}

async function startSmokeApps(hub, apps) {
  for (const app of apps) {
    await hub.runtime.processes.start(app.id);
  }
}

async function emitSmokeLogs(hub, apps) {
  for (const app of apps) {
    await fetch(`${baseURL(hub)}/emit-log?message=${encodeURIComponent(app.logMessage)}`, {
      headers: { "x-relaybase-app": app.id }
    });
  }
  await hub.runtime.logStore.flush();
}

async function seedPreferenceFile(stateDir, apps = smokeFixtureDefinition().apps) {
  const filePath = preferencePath(stateDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  const order = apps.map((app) => `${app.groupId}:${app.id}:${app.role}:${app.paneLabel}`);
  const colors = {};
  const palette = ["#216869", "#8a5a00", "#9b1c31", "#6d4c3d"];
  for (const [index, paneID] of order.entries()) {
    colors[paneID] = palette[index % palette.length];
  }
  await writeJson(filePath, {
    version: 1,
    theme: "dark",
    keymap: {
      contextMenu: ["ctrl+x", "ctrl+y"]
    },
    panes: {
      pinned: order.slice(0, 1),
      hidden: ["archived:archived-web:frontend:frontend"],
      order,
      colors
    },
    assistant: {
      barColor: "#216869",
      historyRetentionDays: 30
    },
    layout: {
      lastPage: 0,
      density: "compact"
    }
  });
  return filePath;
}

async function captureBridgeLaunch(paths, stateDir, hub) {
  const capture = await launchAndCapture(
    process.execPath,
    [
      ...nodeStripTypesArgs,
      path.join(root, "src", "cli.ts"),
      "tui",
      "--host",
      "127.0.0.1",
      "--port",
      String(hub.address().port),
      "--state-dir",
      stateDir,
      "--",
      "--smoke-render",
      "--smoke-width",
      "110",
      "--smoke-height",
      "32"
    ],
    {
      title: "relaybase tui bridge launch",
      inputEvents: [{ delayMs: 2600, text: "q" }],
      timeoutMs: 30000
    }
  );
  await writeFile(path.join(paths.root, "bridge-launch-transcript.txt"), capture.transcript, "utf8");
  return capture;
}

async function launchTuiAndCapture(binaryPath, args, options) {
  if (!shouldUseGoRunSmokeLaunch(binaryPath, options)) {
    const capture = await launchAndCapture(binaryPath, args, options);
    if (!shouldRetryGoRunSmokeLaunch(binaryPath, capture)) {
      return capture;
    }
    const fallback = await launchTuiWithGoRun(args, {
      ...options,
      title: `${options.title} (go run fallback after ${capture.command.error ?? "spawn failure"})`
    });
    return {
      ...fallback,
      transcript: [capture.transcript, "", "# Retried with go run fallback", fallback.transcript].join("\n")
    };
  }

  return launchTuiWithGoRun(args, options);
}

async function launchTuiWithGoRun(args, options) {
  const env = goCommandEnv(
    {},
    {
      ...(options.env ?? process.env),
      GOCACHE: "",
      GOTMPDIR: ""
    }
  );
  await mkdir(env.GOCACHE, { recursive: true });
  await mkdir(env.GOTMPDIR, { recursive: true });
  return launchAndCapture("go", ["run", "./cmd/relaybase-tui", ...args], {
    ...options,
    cwd: path.join(root, "tui"),
    env
  });
}

function shouldRetryGoRunSmokeLaunch(binaryPath, capture) {
  if (process.platform !== "win32") {
    return false;
  }
  if (!binaryPath.includes(`${path.sep}.relaybase${path.sep}tui-dev-bin${path.sep}`)) {
    return false;
  }
  if (!existsSync(path.join(root, "tui", "go.mod"))) {
    return false;
  }
  const error = String(capture.command.error ?? "");
  return /spawn UNKNOWN|EACCES|EPERM/i.test(error);
}

function shouldUseGoRunSmokeLaunch(binaryPath, options = {}) {
  if ((options.env ?? process.env).RELAYBASE_TUI_SMOKE_GO_RUN !== "1") {
    return false;
  }
  if (process.platform !== "win32") {
    return false;
  }
  return (
    binaryPath.includes(`${path.sep}.relaybase${path.sep}tui-dev-bin${path.sep}`) &&
    existsSync(path.join(root, "tui", "go.mod"))
  );
}

function launchAndCapture(commandPath, args, options) {
  const startedAt = new Date().toISOString();
  const command = {
    name: options.title,
    argv: [commandPath, ...args],
    status: null,
    signal: null,
    startedAt,
    finishedAt: null
  };

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let errored = "";
    let settled = false;
    const timers = [];
    let child;

    try {
      child = spawn(commandPath, args, {
        cwd: options.cwd ?? root,
        env: options.env ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      errored = error instanceof Error ? error.message : String(error);
      command.error = errored;
      command.finishedAt = new Date().toISOString();
      finish();
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      errored = error.message;
      command.error = error.message;
      command.finishedAt = new Date().toISOString();
      finish();
    });
    child.once("exit", (code, signal) => {
      command.status = code;
      command.signal = signal;
      command.finishedAt = new Date().toISOString();
      finish();
    });

    for (const event of options.inputEvents ?? []) {
      timers.push(
        setTimeout(() => {
          if (!child.stdin?.destroyed) {
            child.stdin.write(event.text);
          }
        }, event.delayMs)
      );
    }

    timers.push(
      setTimeout(() => {
        if (!settled && child.exitCode === null) {
          terminateProcessTree(child);
        }
      }, options.timeoutMs ?? 8000)
    );

    function finish() {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      const output = [stdout, stderr].filter(Boolean).join("\n");
      const transcript = [
        `# ${options.title}`,
        `$ ${command.argv.map(quoteArg).join(" ")}`,
        "",
        "STDOUT:",
        stdout,
        "",
        "STDERR:",
        stderr,
        errored ? `\nERROR: ${errored}` : ""
      ].join("\n");
      resolve({
        command,
        output,
        transcript,
        launched:
          errored === "" &&
          (command.status === 0 || command.status === 130 || (command.signal === "SIGTERM" && output.trim() !== ""))
      });
    }
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function terminateProcessTree(child) {
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (!result.error && result.status === 0) {
      return;
    }
  }
  child.kill("SIGTERM");
}

async function getStateSnapshot(hub) {
  const response = await fetch(`${baseURL(hub)}/__hub/api/state`, {
    headers: { "x-relaybase-token": hub.runtime.token }
  });
  return response.json();
}

function baseURL(hub) {
  return `http://127.0.0.1:${hub.address().port}`;
}

function preferencePath(stateDir) {
  return path.join(stateDir, "tui", "preferences.json");
}

async function copyJsonArtifact(target, source) {
  try {
    const content = await readFile(source, "utf8");
    await writeFile(target, content, "utf8");
  } catch (error) {
    await writePlaceholderJson(target, {
      status: "not_verified",
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function preferencesSurvived(beforePath, afterPath) {
  try {
    const before = JSON.parse(await readFile(beforePath, "utf8"));
    const after = JSON.parse(await readFile(afterPath, "utf8"));
    return JSON.stringify(before) === JSON.stringify(after) &&
      preferenceEvidenceLooksComplete(before) &&
      preferenceEvidenceLooksComplete(after) &&
      !preferenceEvidenceContainsSecretValue(before) &&
      !preferenceEvidenceContainsSecretValue(after)
      ? "passed"
      : "failed";
  } catch {
    return "failed";
  }
}

export function preferenceEvidenceLooksComplete(preferences) {
  return (
    preferences?.version === 1 &&
    typeof preferences.theme === "string" &&
    Array.isArray(preferences.keymap?.contextMenu) &&
    preferences.keymap.contextMenu.length >= 2 &&
    Array.isArray(preferences.panes?.pinned) &&
    preferences.panes.pinned.length >= 1 &&
    Array.isArray(preferences.panes?.hidden) &&
    preferences.panes.hidden.length >= 1 &&
    Array.isArray(preferences.panes?.order) &&
    preferences.panes.order.length >= 2 &&
    preferences.panes?.colors !== undefined &&
    Object.keys(preferences.panes.colors).length >= 2 &&
    typeof preferences.assistant?.barColor === "string" &&
    Number.isInteger(preferences.assistant?.historyRetentionDays) &&
    Number.isInteger(preferences.layout?.lastPage) &&
    typeof preferences.layout?.density === "string"
  );
}

export function preferenceEvidenceContainsSecretValue(value) {
  if (typeof value === "string") {
    return preferenceSecretPattern().test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => preferenceEvidenceContainsSecretValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => preferenceEvidenceContainsSecretValue(entry));
  }
  return false;
}

function preferenceSecretPattern() {
  return /(?:token|password|passwd|secret|api[_-]?key|authorization|bearer|relaybase_token|session-token)\s*[:=]|sk-[a-z0-9]/i;
}

function appsStillRunning(state) {
  const apps = state.apps ?? [];
  const notesWeb = apps.find((app) => app.id === "notes-web");
  const notesApi = apps.find((app) => app.id === "notes-api");
  return notesWeb?.runtime?.status === "running" && notesApi?.runtime?.status === "running";
}

function transcriptHasDiagnostic(text) {
  return /daemon.*unavailable|not reachable|connection|diagnostic/i.test(stripAnsi(transcriptProcessOutput(text)));
}

function transcriptShowsConnection(text) {
  return /connected|event stream|daemon/i.test(stripAnsi(renderedTranscriptOutput(text)));
}

function transcriptShowsGroupedPanes(text, fixture = smokeFixtureDefinition()) {
  const stripped = stripAnsi(renderedTranscriptOutput(text));
  const groupNames = uniqueStrings(fixture.apps.map((app) => app.displayName));
  return (
    groupNames.every((name) => new RegExp(escapeRegExp(name), "i").test(stripped)) &&
    /frontend/i.test(stripped) &&
    /backend/i.test(stripped)
  );
}

function transcriptShowsEightPaneDetails(text, fixture) {
  const stripped = stripAnsi(renderedTranscriptOutput(text));
  if (fixture.expectedPaneCount !== 8) {
    return false;
  }
  const expectedPanes = fixture.apps.every((app) => {
    const title = `${app.displayName}: ${app.paneLabel}`;
    return (
      new RegExp(escapeRegExp(title), "i").test(stripped) &&
      new RegExp(escapeRegExp(app.logMessage), "i").test(stripped) &&
      new RegExp(`route\\s+http://${escapeRegExp(app.id)}\\.localhost`, "i").test(stripped)
    );
  });
  const runningCount = (stripped.match(/status running/gi) ?? []).length;
  const portCount = (stripped.match(/port \d+/gi) ?? []).length;
  return expectedPanes && runningCount >= 8 && portCount >= 8;
}

function transcriptShowsConfirmation(text) {
  return /confirm|preview|risk|expected/i.test(stripAnsi(renderedTranscriptOutput(text)));
}

export function transcriptHasStyledOperatorShell(text, fixture = smokeFixtureDefinition()) {
  const rendered = renderedTranscriptOutput(text);
  const plain = stripAnsi(rendered);
  const sgr = rendered.match(new RegExp(String.raw`\x1B\[[0-9;]*m`, "g")) ?? [];
  const exactLightPalette = [
    "38;2;47;33;24",
    "38;2;109;76;61",
    "38;2;125;106;95",
    "38;2;33;104;105",
    "38;2;40;122;61",
    "38;2;138;90;0",
    "38;2;155;28;49",
    "48;2;248;244;236"
  ];
  const hasExactLightPalette = exactLightPalette.every((code) => sgr.some((sequence) => sequence.includes(code)));
  const hasExactComposerDivider = rendered
    .split(/\r?\n/)
    .some(
      (line) =>
        stripAnsi(line) === "─".repeat(fixture.smokeWidth) &&
        line.includes("38;2;109;76;61") &&
        line.includes("48;2;248;244;236")
    );
  const completePaneBorders =
    (plain.match(/\u2514/g) ?? []).length >= fixture.expectedPaneCount &&
    (plain.match(/\u2518/g) ?? []).length >= fixture.expectedPaneCount;
  const truthfulAppCounts = plain.includes(
    `Apps ${fixture.expectedPaneCount} active / ${fixture.expectedPaneCount} registered`
  );
  return (
    hasExactLightPalette &&
    hasExactComposerDivider &&
    completePaneBorders &&
    truthfulAppCounts &&
    !/scroll 0\/\d+/.test(plain)
  );
}

export function transcriptHasResponsiveBridgeLayout(text, fixture = smokeFixtureDefinition()) {
  const plain = stripAnsi(renderedTranscriptOutput(text));
  const visiblePaneCount = fixture.expectedPaneCount === 8 ? 6 : fixture.expectedPaneCount;
  const completePaneBorders =
    (plain.match(/\u2514/g) ?? []).length >= visiblePaneCount &&
    (plain.match(/\u2518/g) ?? []).length >= visiblePaneCount;
  const visiblePaneDetails = fixture.apps.slice(0, visiblePaneCount).every((app) => {
    const title = `${app.displayName}: ${app.paneLabel}`;
    const visibleLogPrefix = new RegExp(`\\[stdout\\]\\s+${escapeRegExp(app.id)}`, "i");
    return new RegExp(escapeRegExp(title), "i").test(plain) && visibleLogPrefix.test(plain);
  });
  const responsivePage = fixture.expectedPaneCount !== 8 || /Page 1\/2/i.test(plain);
  return completePaneBorders && visiblePaneDetails && responsivePage && !/scroll 0\/\d+/.test(plain);
}

export function renderedTranscriptOutput(text) {
  const stdout = transcriptSections(text, "STDOUT:");
  return stdout.length ? stdout.join("\n") : text;
}

export function transcriptProcessOutput(text) {
  const stdout = transcriptSections(text, "STDOUT:");
  const stderr = transcriptSections(text, "STDERR:");
  if (!stdout.length && !stderr.length) {
    return text;
  }
  return [...stdout, ...stderr].filter((section) => section !== "").join("\n");
}

function transcriptSections(text, marker) {
  const sections = [];
  const sectionMarker = `${marker}\n`;
  let searchFrom = 0;
  for (;;) {
    const sectionStart = text.indexOf(sectionMarker, searchFrom);
    if (sectionStart === -1) {
      return sections;
    }
    const outputStart = sectionStart + sectionMarker.length;
    const nextMarker = marker === "STDOUT:" ? "\nSTDERR:" : "\nERROR:";
    const nextStart = text.indexOf(nextMarker, outputStart);
    if (nextStart === -1) {
      sections.push(text.slice(outputStart));
      return sections;
    }
    sections.push(text.slice(outputStart, nextStart));
    searchFrom = nextStart + nextMarker.length;
  }
}

function stripAnsi(text) {
  return text.replace(new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function allRequiredCasesPass(cases, fixture = smokeFixtureDefinition()) {
  const required = [
    cases.bridgeDaemonUnavailable,
    cases.daemonUnavailable,
    cases.directLaunch,
    cases.bridgeLaunch,
    cases.bridgeResponsiveLayout,
    cases.daemonConnection,
    cases.groupedPanes,
    cases.styledOperatorShell,
    cases.preferences,
    cases.slashConfirmation,
    cases.exportConfirmation,
    cases.assistantConfirmation,
    cases.usageMenu,
    cases.noDestructiveBeforeConfirmation
  ];
  if (fixture.name === fixtureEightPane) {
    required.push(cases.groupedEightPanes);
  }
  return required.every((status) => status === "passed");
}

async function writeEvidenceReport(evidence, paths, cleanupStatus, reportPath) {
  const videoCaptureStatus =
    evidence.tooling.captureTools.vhs || evidence.tooling.captureTools.asciinema
      ? "capture tool detected; no recording artifact was produced by this smoke run"
      : "not available; transcript artifacts are the captured evidence";
  const lines = [
    "# TUI Evidence Report",
    "",
    `Generated: ${evidence.generatedAt}`,
    `Verdict: ${evidence.verdict}`,
    `Fixture: ${evidence.fixture}`,
    `Artifact root: ${paths.root}`,
    `Cleanup: ${cleanupStatus}`,
    "",
    "## Tooling",
    "",
    `- Expected binary: ${evidence.tooling.binaryPath}`,
    `- Binary exists: ${evidence.tooling.binaryExists}`,
    `- Required Go version: ${evidence.tooling.requiredGoVersion}`,
    `- VHS available: ${evidence.tooling.captureTools.vhs}`,
    `- asciinema available: ${evidence.tooling.captureTools.asciinema}`,
    `- Video capture: ${videoCaptureStatus}`,
    "",
    "## Evidence Cases",
    "",
    "| Case | Status |",
    "| --- | --- |",
    ...Object.entries(evidence.cases).map(([key, value]) => `| ${key} | ${value} |`),
    "",
    "## Artifact Paths",
    "",
    `- PTY transcript: ${paths.ptyTranscript}`,
    `- TUI output: ${paths.tuiOutput}`,
    `- Metadata: ${paths.metadata}`,
    `- Command log: ${paths.commands}`,
    `- State before: ${paths.stateBefore}`,
    `- State after: ${paths.stateAfter}`,
    `- Preferences before: ${paths.preferencesBefore}`,
    `- Preferences after: ${paths.preferencesAfter}`,
    `- Bridge daemon unavailable: ${paths.bridgeUnavailable}`,
    `- Daemon unavailable transcript: ${paths.daemonUnavailable}`,
    `- Grouped 2-pane transcript: ${paths.groupedPanes}`,
    `- Grouped 8-pane transcript: ${paths.groupedEightPanes}`,
    `- Slash stop confirmation transcript: ${paths.slashConfirmation}`,
    `- Export confirmation transcript: ${paths.exportConfirmation}`,
    `- Assistant confirmation transcript: ${paths.assistantConfirmation}`,
    `- Usage menu transcript: ${paths.usageMenu}`,
    "",
    "## Notes",
    "",
    ...(evidence.notes.length ? evidence.notes.map((note) => `- ${note}`) : ["- No notes."])
  ];
  await writeFile(reportPath, lines.join("\n") + "\n", "utf8");
}

function captureEvidenceNote(captureTools) {
  if (captureTools.vhs || captureTools.asciinema) {
    return "A video capture tool was detected, but this smoke run did not produce a recording artifact; recording remains not_available and must not be reported as passed.";
  }
  return "VHS/asciinema capture tools were unavailable; recording remains not_available and terminal transcript artifacts are the captured evidence.";
}

async function writeCommandLog(commandPath, commands) {
  const lines = ["# TUI Smoke Commands", ""];
  for (const command of commands) {
    lines.push(`## ${command.name}`);
    lines.push("");
    lines.push("```text");
    lines.push(command.argv.map(quoteArg).join(" "));
    lines.push("```");
    lines.push("");
    lines.push(`- Status: ${command.status}`);
    lines.push(`- Signal: ${command.signal ?? ""}`);
    if (command.startedAt) {
      lines.push(`- Started: ${command.startedAt}`);
    }
    if (command.finishedAt) {
      lines.push(`- Finished: ${command.finishedAt}`);
    }
    lines.push("");
  }
  await writeFile(commandPath, lines.join("\n"), "utf8");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writePlaceholderJson(filePath, value) {
  await writeJson(filePath, value);
}

function quoteArg(arg) {
  if (/^[A-Za-z0-9_./:=\\-]+$/.test(arg)) {
    return arg;
  }
  return JSON.stringify(arg);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => value !== ""))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runTuiSmoke();
}
