import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDockerComposeSetup,
  classifyDockerFailure,
  detectDockerCompose,
  readDockerProfile,
  type DockerComposeDetection,
  type DockerErrorCode,
  type DockerProfile
} from "./dockerProfile.ts";
import { Registry, readManifestFile } from "./registry.ts";
import { DEFAULT_HOST, DEFAULT_PORT, getDefaultStateDir, getOrCreateSessionToken, isNodeErrno } from "./state.ts";
import type { AppManifestInput, AppRecord, AppState } from "./types.ts";
import { normalizeManifest } from "./validation.ts";

export type SetupArchitecture =
  | "managed-dynamic-port"
  | "framework-port-flag"
  | "generated-launch-wrapper"
  | "pinned-upstream-port"
  | "external-process-proxy"
  | "frontend-backend-multi-service"
  | "docker-compose-service"
  | "static-build-preview"
  | "mcp-only";

export type EnvStrategy = "runtime-injection" | "env-relaybase-file" | "guarded-env-block" | "none";

export interface RelaybaseCommandOptions {
  cwd: string;
  host: string;
  port: number;
  stateDir: string;
  json?: boolean;
}

export interface ConfigureProjectOptions extends RelaybaseCommandOptions {
  yes?: boolean;
  dryRun?: boolean;
  profile?: string;
  answersPath?: string;
  repair?: boolean;
  noStart?: boolean;
  mcpInstall?: boolean;
  envStrategy?: EnvStrategy;
  selectedPlanId?: string;
  startDaemon?: boolean;
}

export interface OpenProjectOptions extends RelaybaseCommandOptions {
  noBrowser?: boolean;
  startDaemon?: boolean;
}

export interface HealthProjectOptions extends RelaybaseCommandOptions {
  appId?: string;
}

export interface ProjectDetection {
  root: string;
  packageJsonPath?: string;
  packageName?: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "node" | "unknown";
  packageCommand: string;
  scripts: Record<string, string>;
  framework: string;
  appKind: "web" | "api" | "static" | "docker" | "mcp" | "unknown";
  envFiles: string[];
  portEnvKeys: string[];
  detectedPorts: number[];
  existingManifestPath?: string;
  dockerComposeFiles: string[];
  docker?: DockerComposeDetection;
  mcpHints: string[];
  monorepoHints: string[];
  healthCandidates: string[];
}

export interface SetupWrite {
  path: string;
  action: "create" | "update" | "skip";
  reason: string;
  preview: string;
}

export interface SetupPlan {
  id: string;
  label: string;
  architecture: SetupArchitecture;
  score: number;
  reasons: string[];
  risks: string[];
  envStrategy: EnvStrategy;
  manifest: AppManifestInput;
  writes: SetupWrite[];
  recoverySteps: string[];
}

export interface AppliedFile {
  path: string;
  action: "created" | "updated" | "unchanged" | "skipped";
}

export interface VerificationResult {
  attempted: boolean;
  daemonStarted: boolean;
  registered: boolean;
  started: boolean;
  ready: boolean;
  state?: AppState;
  url?: string;
  error?: string;
  recoveryHint?: LaunchFailureClassification;
}

export interface ConfigureProjectResult {
  detection: ProjectDetection;
  candidates: SetupPlan[];
  selectedPlan: SetupPlan;
  appliedFiles: AppliedFile[];
  recoveryAttempts: RecoveryAttempt[];
  registryApp?: AppRecord;
  verification: VerificationResult;
  reportPath?: string;
  eventsPath?: string;
}

export interface RecoveryAttempt {
  planId: string;
  architecture: SetupArchitecture;
  ready: boolean;
  error?: string;
}

export interface OpenProjectResult {
  appId: string;
  url: string;
  openedBrowser: boolean;
  registered: boolean;
  started: boolean;
  ready: boolean;
  state?: AppState;
  error?: string;
}

export interface HealthCheckResult {
  cwd: string;
  appId?: string;
  ok: boolean;
  daemon: {
    reachable: boolean;
    url: string;
    error?: string;
  };
  project: {
    configured: boolean;
    manifestPath?: string;
    launchProfilePath?: string;
    packageManager: string;
    framework: string;
    docker?: DockerProfile;
  };
  state?: AppState;
  findings: HealthFinding[];
  recommendedAction?: string;
}

export interface HealthFinding {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  repair?: string;
}

export interface LaunchFailureClassification {
  code:
    | "command-not-found"
    | "powershell-policy"
    | "corepack-spawn"
    | "port-conflict"
    | "ignored-port"
    | "health-route"
    | "dependency-missing"
    | "crash-loop"
    | "stale-process"
    | DockerErrorCode;
  message: string;
  nextArchitectures: SetupArchitecture[];
  requiresApproval: boolean;
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

interface LaunchProfile {
  version: 1;
  appId: string;
  planId: string;
  architecture: SetupArchitecture;
  manifestPath: string;
  command: string;
  envStrategy: EnvStrategy;
  createdAt: string;
  updatedAt: string;
}

const SETUP_DIR = ".relaybase";
const MANIFEST_FILE = "relaybase.app.json";
const PROFILE_FILE = "launch-profile.json";
const REPORT_FILE = "setup-report.json";
const EVENTS_DIR = "runs";
const ANSWERS_FILE = "setup.answers.json";

export function defaultCommandOptions(cwd = process.cwd()): RelaybaseCommandOptions {
  return {
    cwd: path.resolve(cwd),
    host: process.env.RELAYBASE_HOST ?? DEFAULT_HOST,
    port: Number(process.env.RELAYBASE_PORT ?? DEFAULT_PORT),
    stateDir: getDefaultStateDir()
  };
}

export async function detectProject(cwd: string): Promise<ProjectDetection> {
  const root = path.resolve(cwd);
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = await readPackageJson(packageJsonPath);
  const files = await safeReadDir(root);
  const packageManager = detectPackageManager(root, files, packageJson);
  const scripts = packageJson?.scripts ?? {};
  const deps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  const framework = detectFramework(files, deps);
  const appKind = detectAppKind(files, scripts, deps, framework);
  const existingManifestPath = (await exists(path.join(root, MANIFEST_FILE)))
    ? path.join(root, MANIFEST_FILE)
    : undefined;
  const envFiles = files
    .filter((file) => /^\.env(?:\.|$)/.test(file))
    .map((file) => path.join(root, file))
    .sort();
  const envText = await Promise.all(envFiles.map((file) => fs.readFile(file, "utf8").catch(() => "")));
  const envPortEntries = envText.flatMap((text) =>
    [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*PORT[A-Za-z0-9_]*)=(\d{1,5})\s*$/gm)].map((match) => ({
      key: match[1] ?? "",
      port: Number(match[2])
    }))
  );
  const portEnvKeys = [...new Set(envPortEntries.map((entry) => entry.key))].filter(Boolean);
  const detectedPorts = [
    ...new Set(
      envPortEntries.map((entry) => entry.port).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    )
  ];
  const dockerComposeFiles = files
    .filter((file) => /^docker-compose\.(?:ya?ml)$|^compose\.(?:ya?ml)$/.test(file))
    .map((file) => path.join(root, file));
  const docker = dockerComposeFiles.length ? await detectDockerCompose(root, dockerComposeFiles, envFiles) : undefined;
  const mcpHints = detectMcpHints(files, scripts, deps);
  const monorepoHints = detectMonorepoHints(files, packageJson);

  return {
    root,
    ...(packageJson ? { packageJsonPath } : {}),
    ...(packageJson?.name ? { packageName: packageJson.name } : {}),
    packageManager,
    packageCommand: packageCommand(packageManager),
    scripts,
    framework,
    appKind,
    envFiles,
    portEnvKeys,
    detectedPorts,
    ...(existingManifestPath ? { existingManifestPath } : {}),
    dockerComposeFiles,
    ...(docker ? { docker } : {}),
    mcpHints,
    monorepoHints,
    healthCandidates: healthCandidates(framework, appKind)
  };
}

export async function proposeSetupPlans(
  detection: ProjectDetection,
  options: { envStrategy?: EnvStrategy; mcpInstall?: boolean } = {}
): Promise<SetupPlan[]> {
  const existingManifest = detection.existingManifestPath
    ? await readManifestFile(detection.existingManifestPath).catch(() => undefined)
    : undefined;
  const appId = appIdFromDetection(detection, existingManifest);
  const name = appNameFromDetection(detection, existingManifest, appId);
  const startCommand = startCommandFor(detection);
  const envStrategy = options.envStrategy ?? "runtime-injection";
  const baseManifest: AppManifestInput = existingManifest ?? {
    schemaVersion: 1,
    id: appId,
    name,
    command: startCommand,
    cwd: ".",
    protocol: detection.framework === "websocket" ? "http+ws" : "http",
    healthUrl: detection.healthCandidates[0] ?? "/"
  };
  const plans: SetupPlan[] = [];

  plans.push(
    plan({
      id: "managed-web",
      label: "Managed dynamic port",
      architecture: "managed-dynamic-port",
      score: scoreManagedDynamic(detection, existingManifest),
      manifest: { ...baseManifest, command: String(baseManifest.command ?? startCommand), upstreamPort: undefined },
      detection,
      envStrategy,
      reasons: [
        "Relaybase owns lifecycle and injects PORT/HOST/RELAYBASE_* at runtime.",
        "No project env file mutation is required for apps that respect PORT."
      ],
      risks: detection.portEnvKeys.length
        ? [`Project env files already mention port keys: ${detection.portEnvKeys.join(", ")}.`]
        : [],
      recoverySteps: [
        "If the app ignores PORT, retry with a generated launch wrapper that passes framework port flags.",
        "If the health route is wrong, retry with a safer route candidate."
      ],
      extraWrites: setupWrites(detection.root, baseManifest, envStrategy, options.mcpInstall)
    })
  );

  if (detection.framework !== "unknown" || detection.scripts.dev) {
    const wrapperManifest = { ...baseManifest, command: nodeCommand(".relaybase/launch.cjs"), upstreamPort: undefined };
    plans.push(
      plan({
        id: "framework-port-flag",
        label: "Framework port flag wrapper",
        architecture: "framework-port-flag",
        score: scoreFrameworkWrapper(detection),
        manifest: wrapperManifest,
        detection,
        envStrategy,
        reasons: [
          "Generated wrapper passes Relaybase's assigned PORT through framework-specific CLI flags.",
          "This works for dev servers that do not automatically honor PORT."
        ],
        risks: ["Writes a Relaybase-owned launch wrapper under .relaybase/."],
        recoverySteps: ["If framework flags fail, fall back to pinned upstream port or external process mode."],
        extraWrites: [
          ...setupWrites(detection.root, wrapperManifest, envStrategy, options.mcpInstall),
          {
            path: path.join(detection.root, SETUP_DIR, "launch.cjs"),
            action: "create",
            reason: "Launch wrapper adapts package-manager scripts to Relaybase-assigned ports.",
            preview: launchWrapper(detection)
          }
        ]
      })
    );
  }

  const detectedPort = firstDetectedPort(detection);
  if (detectedPort) {
    plans.push(
      plan({
        id: "pinned-upstream",
        label: `Pinned upstream port ${detectedPort}`,
        architecture: "pinned-upstream-port",
        score: 55,
        manifest: { ...baseManifest, upstreamPort: detectedPort },
        detection,
        envStrategy,
        reasons: [
          "Use this when the app cannot bind a Relaybase-assigned dynamic port.",
          `Relaybase will verify and route the fixed backend port ${detectedPort}.`
        ],
        risks: ["A fixed port can conflict with stale app processes."],
        recoverySteps: ["If the port is occupied, identify the owner and ask before stopping it."],
        extraWrites: setupWrites(
          detection.root,
          { ...baseManifest, upstreamPort: detectedPort },
          envStrategy,
          options.mcpInstall
        )
      })
    );
  }

  if (detection.dockerComposeFiles.length) {
    const dockerSetup = buildDockerComposeSetup(
      detection.root,
      baseManifest,
      detection.docker ?? {
        composeFiles: detection.dockerComposeFiles,
        envFiles: detection.envFiles,
        services: [],
        requiredServices: [],
        optionalServices: [],
        dependencyPorts: [],
        dangerousFindings: [],
        missingEnvVars: [],
        privateImages: [],
        hostPublishedPorts: [],
        dynamicPublishedPorts: [],
        suggestedProjectName: `relaybase-${appId}`
      }
    );
    plans.push(
      plan({
        id: "docker-compose",
        label: "Docker Compose service",
        architecture: "docker-compose-service",
        score: detection.appKind === "docker" ? 92 : 45,
        manifest: dockerSetup.manifest,
        detection,
        envStrategy,
        reasons: dockerSetup.reasons,
        risks: dockerSetup.risks,
        recoverySteps: dockerSetup.recoverySteps,
        extraWrites: [
          ...setupWrites(detection.root, dockerSetup.manifest, envStrategy, options.mcpInstall),
          ...dockerSetup.writes
        ]
      })
    );
  }

  if (detection.appKind === "static") {
    const staticManifest = { ...baseManifest, command: nodeCommand(".relaybase/static-preview.cjs"), healthUrl: "/" };
    plans.push(
      plan({
        id: "static-preview",
        label: "Static build preview",
        architecture: "static-build-preview",
        score: 50,
        manifest: staticManifest,
        detection,
        envStrategy,
        reasons: ["Static assets are served by a Relaybase-owned preview helper on the assigned port."],
        risks: ["Only suitable for static files that do not need a framework dev server."],
        recoverySteps: [
          "If assets are built into a different folder, rerun configure and select a custom static output."
        ],
        extraWrites: [
          ...setupWrites(detection.root, staticManifest, envStrategy, options.mcpInstall),
          {
            path: path.join(detection.root, SETUP_DIR, "static-preview.cjs"),
            action: "create",
            reason: "Static preview helper binds the Relaybase-assigned PORT.",
            preview: staticPreviewServer()
          }
        ]
      })
    );
  }

  if (detection.mcpHints.length) {
    const mcpManifest = {
      ...baseManifest,
      command: "external",
      mcp: {
        enabled: true,
        children: []
      }
    };
    plans.push(
      plan({
        id: "mcp-only",
        label: "MCP/tool server only",
        architecture: "mcp-only",
        score: 40,
        manifest: mcpManifest,
        detection,
        envStrategy,
        reasons: ["MCP hints were detected; Relaybase can expose child tools through the app manifest."],
        risks: ["Child MCP tool allowlists still need exact user-approved entries."],
        recoverySteps: ["Add exact child MCP tools/resources/prompts after inspecting the server."],
        extraWrites: setupWrites(detection.root, mcpManifest, envStrategy, true)
      })
    );
  }

  plans.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return plans;
}

export async function configureProject(options: ConfigureProjectOptions): Promise<ConfigureProjectResult> {
  const answers = await readSetupAnswers(options.answersPath, options.cwd);
  const envStrategy = options.envStrategy ?? answers.envStrategy;
  const detection = await detectProject(options.cwd);
  const candidates = await proposeSetupPlans(detection, {
    envStrategy,
    mcpInstall: options.mcpInstall
  });
  let selectedPlan = selectPlan(candidates, options.selectedPlanId ?? options.profile ?? answers.selectedPlanId);
  const events: Array<Record<string, unknown>> = [
    event("preflight", {
      cwd: detection.root,
      packageManager: detection.packageManager,
      framework: detection.framework
    }),
    event("plan_selected", { id: selectedPlan.id, architecture: selectedPlan.architecture })
  ];
  let appliedFiles = options.dryRun
    ? selectedPlan.writes.map((write) => ({
        path: write.path,
        action: "skipped" as const
      }))
    : await applySetupPlan(selectedPlan, {
        writeEnv: selectedPlan.envStrategy !== "runtime-injection" && selectedPlan.envStrategy !== "none"
      });

  if (!options.dryRun) {
    events.push(event("files_applied", { files: appliedFiles }));
  }

  let registryApp = options.dryRun ? undefined : await registerConfiguredManifest(selectedPlan, options.stateDir);
  if (registryApp) {
    events.push(event("registered", { id: registryApp.id, stateDir: options.stateDir }));
  }

  const noStart = options.noStart ?? answers.noStart;
  let verification =
    noStart || options.dryRun
      ? { attempted: false, daemonStarted: false, registered: Boolean(registryApp), started: false, ready: false }
      : await verifyConfiguredApp(selectedPlan, options, events);
  const recoveryAttempts: RecoveryAttempt[] = [];

  if (
    !noStart &&
    !options.dryRun &&
    verification.attempted &&
    !verification.ready &&
    verification.recoveryHint &&
    (options.repair || options.yes)
  ) {
    const recoveryHint = verification.recoveryHint;
    const retryPlans = recoveryPlans(candidates, selectedPlan, recoveryHint);
    for (const retryPlan of retryPlans) {
      await stopConfiguredApp(options, String(selectedPlan.manifest.id));
      events.push(
        event("recovery_attempt", {
          planId: retryPlan.id,
          architecture: retryPlan.architecture,
          reason: recoveryHint.code
        })
      );
      const retryAppliedFiles = await applySetupPlan(retryPlan, {
        writeEnv: retryPlan.envStrategy !== "runtime-injection" && retryPlan.envStrategy !== "none"
      });
      const retryRegistryApp = await registerConfiguredManifest(retryPlan, options.stateDir);
      const retryVerification = await verifyConfiguredApp(retryPlan, options, events);
      recoveryAttempts.push({
        planId: retryPlan.id,
        architecture: retryPlan.architecture,
        ready: retryVerification.ready,
        ...(retryVerification.error ? { error: retryVerification.error } : {})
      });
      selectedPlan = retryPlan;
      appliedFiles = retryAppliedFiles;
      registryApp = retryRegistryApp;
      verification = retryVerification;
      if (retryVerification.ready) {
        break;
      }
    }
  }

  const runTimestamp = safeTimestamp();
  const reportPath = options.dryRun ? undefined : path.join(detection.root, SETUP_DIR, REPORT_FILE);
  const eventsPath = options.dryRun
    ? undefined
    : path.join(detection.root, SETUP_DIR, EVENTS_DIR, `${runTimestamp}.jsonl`);
  const result: ConfigureProjectResult = {
    detection,
    candidates,
    selectedPlan,
    appliedFiles,
    recoveryAttempts,
    ...(registryApp ? { registryApp } : {}),
    verification,
    ...(reportPath ? { reportPath } : {}),
    ...(eventsPath ? { eventsPath } : {})
  };

  if (!options.dryRun) {
    await ensureDir(path.join(detection.root, SETUP_DIR, EVENTS_DIR));
    await writeTextAtomic(
      path.join(detection.root, SETUP_DIR, REPORT_FILE),
      `${JSON.stringify(redactResult(result), null, 2)}\n`
    );
    await writeTextAtomic(
      path.join(detection.root, SETUP_DIR, EVENTS_DIR, `${runTimestamp}.jsonl`),
      `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    );
  }

  return result;
}

export async function openProject(options: OpenProjectOptions): Promise<OpenProjectResult> {
  const profile = await readLaunchProfile(options.cwd);
  const manifestPath = profile?.manifestPath ?? path.join(options.cwd, MANIFEST_FILE);
  if (!(await exists(manifestPath))) {
    return {
      appId: "",
      url: "",
      openedBrowser: false,
      registered: false,
      started: false,
      ready: false,
      error: "This project is not configured for Relaybase. Run relaybase configure first."
    };
  }

  const app = await registerManifestPath(manifestPath, options.stateDir);
  const daemonStarted = await ensureDaemon(options, options.startDaemon !== false);
  if (!daemonStarted.reachable) {
    return {
      appId: app.id,
      url: humanUrl(app.id, options.port),
      openedBrowser: false,
      registered: true,
      started: false,
      ready: false,
      error: daemonStarted.error ?? "Relaybase daemon is not reachable."
    };
  }

  await registerViaApi(options, manifestPath).catch(() => undefined);
  const started = await mutateAppViaApi(options, app.id, "start");
  const stateResponse = await getAppStateViaApi(options, app.id);
  const state = stateResponse.state;
  const url = humanUrl(app.id, options.port);
  const ready = Boolean(state?.readiness.state === "ready" || state?.routeReachable);
  const openedBrowser = !options.noBrowser && ready ? await openBrowser(url) : false;

  return {
    appId: app.id,
    url,
    openedBrowser,
    registered: true,
    started: started.ok,
    ready,
    ...(state ? { state } : {}),
    ...(!started.ok ? { error: started.body || "Relaybase start failed." } : {})
  };
}

export async function healthProject(options: HealthProjectOptions): Promise<HealthCheckResult> {
  const detection = await detectProject(options.cwd);
  const profile = await readLaunchProfile(options.cwd);
  const dockerProfile = await readDockerProfile(detection.root);
  const manifestPath = detection.existingManifestPath ?? profile?.manifestPath;
  const daemon = await discovery(options);
  const findings: HealthFinding[] = [];
  let appId = options.appId ?? profile?.appId;
  let state: AppState | undefined;

  if (!manifestPath) {
    findings.push({
      severity: "error",
      code: "PROJECT_NOT_CONFIGURED",
      message: "No relaybase.app.json or saved Relaybase launch profile was found.",
      repair: "Run relaybase configure."
    });
  } else {
    const manifest = await readManifestFile(manifestPath).catch(() => undefined);
    if (manifest?.id && typeof manifest.id === "string") {
      appId ??= manifest.id;
    }
  }

  if (!daemon.reachable) {
    findings.push({
      severity: "warning",
      code: "DAEMON_UNREACHABLE",
      message: "Relaybase daemon is not reachable on the configured host and port.",
      repair: "Run relaybase open or relaybase configure to start and verify the project."
    });
  }

  if (daemon.reachable && appId) {
    const stateResponse = await getAppStateViaApi(options, appId);
    if (stateResponse.ok && stateResponse.state) {
      state = stateResponse.state;
      if (state.readiness.state !== "ready") {
        findings.push({
          severity: "warning",
          code: "APP_NOT_READY",
          message: state.readiness.failureReason ?? `App readiness is ${state.readiness.state}.`,
          repair: "Run relaybase configure --repair."
        });
      }
    } else {
      findings.push({
        severity: "error",
        code: "APP_STATE_UNAVAILABLE",
        message: stateResponse.error ?? "Could not read app state.",
        repair: "Run relaybase configure."
      });
    }
  }

  if (profile && manifestPath && path.resolve(profile.manifestPath) !== path.resolve(manifestPath)) {
    findings.push({
      severity: "warning",
      code: "PROFILE_MANIFEST_MISMATCH",
      message: "Saved launch profile points at a different manifest path than the project root.",
      repair: "Run relaybase configure --repair."
    });
  }

  if (detection.dockerComposeFiles.length && !dockerProfile) {
    findings.push({
      severity: "warning",
      code: "DOCKER_PROFILE_MISSING",
      message: "Compose files were detected but no Relaybase Docker profile exists.",
      repair: "Run relaybase configure and select the Docker Compose service profile."
    });
  }

  if (dockerProfile) {
    if (dockerProfile.missingEnvVars.length) {
      findings.push({
        severity: "error",
        code: "COMPOSE_ENV_MISSING",
        message: `Docker profile requires Compose env values: ${dockerProfile.missingEnvVars.join(", ")}.`,
        repair: "Set the missing env values or configure an env-file profile before launch."
      });
    }
    const blocked = dockerProfile.securityFindings.filter((finding) => finding.severity === "blocked");
    if (blocked.length) {
      findings.push({
        severity: "error",
        code: "DANGEROUS_COMPOSE_CONFIG",
        message: `Docker profile contains blocked Compose settings: ${blocked.map((finding) => finding.code).join(", ")}.`,
        repair: "Review the Compose file and approve or remove risky settings before launch."
      });
    }
  }

  const ok =
    findings.every((finding) => finding.severity !== "error") && Boolean(daemon.reachable) && Boolean(manifestPath);
  return {
    cwd: detection.root,
    ...(appId ? { appId } : {}),
    ok,
    daemon: {
      reachable: daemon.reachable,
      url: `http://${options.host}:${options.port}`,
      ...(daemon.error ? { error: daemon.error } : {})
    },
    project: {
      configured: Boolean(manifestPath),
      ...(manifestPath ? { manifestPath } : {}),
      ...(profile ? { launchProfilePath: path.join(detection.root, SETUP_DIR, PROFILE_FILE) } : {}),
      packageManager: detection.packageManager,
      framework: detection.framework,
      ...(dockerProfile ? { docker: dockerProfile } : {})
    },
    ...(state ? { state } : {}),
    findings,
    ...(ok ? {} : { recommendedAction: "Run relaybase configure --repair." })
  };
}

export function classifyLaunchFailure(input: {
  error?: string;
  lastError?: string;
  logs?: string[];
  runtimeStatus?: string;
}): LaunchFailureClassification {
  const text = [input.error, input.lastError, ...(input.logs ?? [])].filter(Boolean).join("\n").toLowerCase();
  const dockerFailure = classifyDockerFailure(text);
  if (dockerFailure.code !== "unknown") {
    return {
      code: dockerFailure.code,
      message: dockerFailure.message,
      nextArchitectures: dockerFailure.retryable
        ? ["docker-compose-service", "managed-dynamic-port"]
        : ["managed-dynamic-port", "framework-port-flag"],
      requiresApproval: dockerFailure.requiresApproval
    };
  }

  if (/corepack.*enoent|spawn corepack|corepack.*einval/.test(text)) {
    return {
      code: "corepack-spawn",
      message: "Corepack could not be spawned directly in this Windows runtime.",
      nextArchitectures: ["generated-launch-wrapper"],
      requiresApproval: false
    };
  }

  if (/spawn .*enoent|not recognized|command not found|cannot find module/.test(text)) {
    return {
      code: "command-not-found",
      message: "The launch command or runtime could not be found.",
      nextArchitectures: ["generated-launch-wrapper", "framework-port-flag"],
      requiresApproval: false
    };
  }

  if (/running scripts is disabled|ps1 cannot be loaded|execution policy/.test(text)) {
    return {
      code: "powershell-policy",
      message: "PowerShell execution policy blocked the package-manager shim.",
      nextArchitectures: ["generated-launch-wrapper"],
      requiresApproval: false
    };
  }

  if (/already in use|eaddrinuse|conflict|port .*occupied/.test(text) || input.runtimeStatus === "conflict") {
    return {
      code: "port-conflict",
      message: "The requested backend port is already occupied.",
      nextArchitectures: ["managed-dynamic-port", "framework-port-flag"],
      requiresApproval: true
    };
  }

  if (/did not become healthy|backend port is not open|route is not reachable/.test(text)) {
    return {
      code: "ignored-port",
      message: "The process started path did not prove readiness; the app may be ignoring Relaybase's assigned PORT.",
      nextArchitectures: ["framework-port-flag", "generated-launch-wrapper", "pinned-upstream-port"],
      requiresApproval: false
    };
  }

  if (/404|health|not found/.test(text)) {
    return {
      code: "health-route",
      message: "The health route may be incorrect.",
      nextArchitectures: ["managed-dynamic-port"],
      requiresApproval: false
    };
  }

  if (/cannot find package|module not found|missing dependency/.test(text)) {
    return {
      code: "dependency-missing",
      message: "The project appears to be missing dependencies.",
      nextArchitectures: ["managed-dynamic-port"],
      requiresApproval: true
    };
  }

  if (/exited with code|crash|uncaught|exception/.test(text)) {
    return {
      code: "crash-loop",
      message: "The app process exited before Relaybase could prove readiness.",
      nextArchitectures: ["generated-launch-wrapper", "pinned-upstream-port"],
      requiresApproval: false
    };
  }

  return {
    code: "unknown",
    message: "Relaybase could not classify the launch failure from the available evidence.",
    nextArchitectures: ["generated-launch-wrapper", "managed-dynamic-port"],
    requiresApproval: true
  };
}

async function applySetupPlan(selectedPlan: SetupPlan, options: { writeEnv: boolean }): Promise<AppliedFile[]> {
  const applied: AppliedFile[] = [];
  const rollback: Array<{ path: string; existed: boolean; content?: string }> = [];

  for (const write of selectedPlan.writes) {
    if (write.reason.includes("env") && !options.writeEnv) {
      applied.push({ path: write.path, action: "skipped" });
      continue;
    }

    await ensureDir(path.dirname(write.path));
    const previous: { existed: boolean; content?: string } = await fs
      .readFile(write.path, "utf8")
      .then((content) => ({ existed: true, content }))
      .catch((error) => {
        if (isNodeErrno(error, "ENOENT")) {
          return { existed: false };
        }
        throw error;
      });
    rollback.push({ path: write.path, ...previous });
    const current = previous.existed ? (previous.content ?? "") : "";
    const next =
      write.path.endsWith(`${path.sep}.env`) && write.reason.includes("guarded")
        ? mergeRelaybaseEnvBlock(current, write.preview)
        : write.preview;
    if (current === next) {
      applied.push({ path: write.path, action: "unchanged" });
      continue;
    }

    await writeTextAtomic(write.path, next);
    applied.push({ path: write.path, action: previous.existed ? "updated" : "created" });
  }

  const root = setupRootFromPlan(selectedPlan);
  await writeTextAtomic(
    path.join(root, SETUP_DIR, "rollback.json"),
    `${JSON.stringify({ version: 1, files: rollback }, null, 2)}\n`
  );
  await writeTextAtomic(
    path.join(root, SETUP_DIR, PROFILE_FILE),
    `${JSON.stringify(launchProfile(selectedPlan), null, 2)}\n`
  );
  await writeTextAtomic(
    path.join(root, SETUP_DIR, ANSWERS_FILE),
    `${JSON.stringify({ version: 1, selectedPlanId: selectedPlan.id, envStrategy: selectedPlan.envStrategy }, null, 2)}\n`
  );
  return applied;
}

async function registerConfiguredManifest(selectedPlan: SetupPlan, stateDir: string): Promise<AppRecord> {
  const root = setupRootFromPlan(selectedPlan);
  return registerManifestPath(path.join(root, MANIFEST_FILE), stateDir);
}

async function registerManifestPath(manifestPath: string, stateDir: string): Promise<AppRecord> {
  const registry = new Registry(stateDir);
  await registry.load();
  const manifest = await readManifestFile(manifestPath);
  return registry.upsertManifest(manifest, { manifestPath });
}

async function verifyConfiguredApp(
  selectedPlan: SetupPlan,
  options: ConfigureProjectOptions,
  events: Array<Record<string, unknown>>
): Promise<VerificationResult> {
  const root = setupRootFromPlan(selectedPlan);
  const manifestPath = path.join(root, MANIFEST_FILE);
  const appId = String(selectedPlan.manifest.id);
  const daemon = await ensureDaemon(options, options.startDaemon !== false);
  events.push(event("daemon", daemon));
  if (!daemon.reachable) {
    return {
      attempted: true,
      daemonStarted: daemon.started,
      registered: true,
      started: false,
      ready: false,
      error: daemon.error,
      recoveryHint: classifyLaunchFailure({ error: daemon.error })
    };
  }

  const registerResponse = await registerViaApi(options, manifestPath);
  events.push(event("api_register", { ok: registerResponse.ok, statusCode: registerResponse.statusCode }));
  if (!registerResponse.ok) {
    return {
      attempted: true,
      daemonStarted: daemon.started,
      registered: false,
      started: false,
      ready: false,
      error: registerResponse.body,
      recoveryHint: classifyLaunchFailure({ error: registerResponse.body })
    };
  }

  const startResponse = await mutateAppViaApi(options, appId, "start");
  events.push(
    event("api_start", {
      ok: startResponse.ok,
      statusCode: startResponse.statusCode,
      body: safeJson(startResponse.body)
    })
  );
  const stateResponse = await getAppStateViaApi(options, appId);
  const state = stateResponse.state;
  const ready = Boolean(startResponse.ok && state && (state.readiness.state === "ready" || state.routeReachable));
  return {
    attempted: true,
    daemonStarted: daemon.started,
    registered: true,
    started: startResponse.ok,
    ready,
    ...(state ? { state } : {}),
    url: humanUrl(appId, options.port),
    ...(!ready
      ? {
          error: state?.readiness.failureReason ?? startResponse.body,
          recoveryHint: classifyLaunchFailure({
            error: startResponse.body,
            lastError: state?.lastError ?? undefined,
            logs: state?.recentLogs,
            runtimeStatus: state?.runtime.status
          })
        }
      : {})
  };
}

function recoveryPlans(
  candidates: SetupPlan[],
  selectedPlan: SetupPlan,
  recoveryHint: LaunchFailureClassification
): SetupPlan[] {
  const preferred = new Set(recoveryHint.nextArchitectures);
  return candidates
    .filter((candidate) => candidate.id !== selectedPlan.id && preferred.has(candidate.architecture))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

async function stopConfiguredApp(options: RelaybaseCommandOptions, appId: string): Promise<void> {
  const daemon = await discovery(options);
  if (!daemon.reachable) {
    return;
  }
  await mutateAppViaApi(options, appId, "stop").catch(() => undefined);
}

async function ensureDaemon(
  options: RelaybaseCommandOptions,
  allowStart: boolean
): Promise<{ reachable: boolean; started: boolean; error?: string }> {
  const existing = await discovery(options);
  if (existing.reachable) {
    return { reachable: true, started: false };
  }

  if (!allowStart) {
    return { reachable: false, started: false, error: existing.error };
  }

  await ensureDir(options.stateDir);
  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.ts");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      cliPath,
      "serve",
      "--host",
      options.host,
      "--port",
      String(options.port),
      "--state-dir",
      options.stateDir
    ],
    {
      cwd: options.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const probe = await discovery(options);
    if (probe.reachable) {
      return { reachable: true, started: true };
    }
    await delay(150);
  }

  return { reachable: false, started: true, error: "Relaybase daemon did not become reachable before timeout." };
}

async function discovery(
  options: RelaybaseCommandOptions
): Promise<{ reachable: boolean; body?: Record<string, unknown>; error?: string }> {
  const response = await httpRequest(options, "GET", "/.well-known/mcp.json");
  if (!response.ok) {
    return { reachable: false, error: response.body || `HTTP ${response.statusCode}` };
  }

  return { reachable: true, body: safeJson(response.body) };
}

async function registerViaApi(
  options: RelaybaseCommandOptions,
  manifestPath: string
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  return httpRequest(
    options,
    "POST",
    "/__hub/api/apps/register",
    { manifestPath },
    await getOrCreateSessionToken(options.stateDir)
  );
}

async function mutateAppViaApi(
  options: RelaybaseCommandOptions,
  id: string,
  action: "start" | "stop" | "restart"
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  return httpRequest(
    options,
    "POST",
    `/__hub/api/apps/${encodeURIComponent(id)}/${action}`,
    undefined,
    await getOrCreateSessionToken(options.stateDir)
  );
}

async function getAppStateViaApi(
  options: RelaybaseCommandOptions,
  id: string
): Promise<{ ok: boolean; state?: AppState; error?: string }> {
  const response = await httpRequest(options, "GET", `/__hub/api/apps/${encodeURIComponent(id)}/state`);
  if (!response.ok) {
    return { ok: false, error: response.body };
  }
  const body = safeJson(response.body) as { state?: AppState };
  return { ok: Boolean(body.state), ...(body.state ? { state: body.state } : { error: "Missing state body." }) };
}

function httpRequest(
  options: RelaybaseCommandOptions,
  method: string,
  requestPath: string,
  body?: unknown,
  token?: string
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: options.host,
        port: options.port,
        path: requestPath,
        method,
        timeout: 2000,
        headers: {
          host: "localhost",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(token ? { "x-relaybase-token": token } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const statusCode = response.statusCode ?? 500;
          resolve({
            ok: statusCode >= 200 && statusCode < 300,
            statusCode,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.once("timeout", () => {
      request.destroy();
      resolve({ ok: false, statusCode: 0, body: "Relaybase server is not reachable." });
    });
    request.once("error", (error) => resolve({ ok: false, statusCode: 0, body: error.message }));
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function plan(input: {
  id: string;
  label: string;
  architecture: SetupArchitecture;
  score: number;
  manifest: AppManifestInput;
  detection: ProjectDetection;
  envStrategy: EnvStrategy;
  reasons: string[];
  risks: string[];
  recoverySteps: string[];
  extraWrites: SetupWrite[];
}): SetupPlan {
  return {
    id: input.id,
    label: input.label,
    architecture: input.architecture,
    score: input.score,
    reasons: input.reasons,
    risks: input.risks,
    envStrategy: input.envStrategy,
    manifest: input.manifest,
    writes: input.extraWrites,
    recoverySteps: input.recoverySteps
  };
}

function setupWrites(
  root: string,
  manifest: AppManifestInput,
  envStrategy: EnvStrategy,
  mcpInstall?: boolean
): SetupWrite[] {
  const writes: SetupWrite[] = [
    {
      path: path.join(root, MANIFEST_FILE),
      action: "create",
      reason: "Relaybase app manifest is the inspectable lifecycle contract.",
      preview: `${JSON.stringify(manifestForDisk(root, manifest), null, 2)}\n`
    }
  ];

  if (envStrategy === "env-relaybase-file") {
    writes.push({
      path: path.join(root, ".env.relaybase"),
      action: "create",
      reason: "env relaybase file stores Relaybase-owned runtime hints without touching secrets.",
      preview: relaybaseEnvBlock(manifest)
    });
  } else if (envStrategy === "guarded-env-block") {
    writes.push({
      path: path.join(root, ".env"),
      action: "update",
      reason: "env guarded block is limited to Relaybase-owned keys.",
      preview: relaybaseEnvBlock(manifest)
    });
  }

  if (mcpInstall) {
    writes.push({
      path: path.join(root, SETUP_DIR, "mcp.json"),
      action: "create",
      reason: "MCP client config for agents that choose Relaybase setup through MCP.",
      preview: `${JSON.stringify(
        {
          mcpServers: {
            relaybase: {
              command: "npx",
              args: ["@cameloo/relaybase", "mcp"]
            }
          }
        },
        null,
        2
      )}\n`
    });
  }

  return writes;
}

function manifestForDisk(root: string, manifest: AppManifestInput): AppManifestInput {
  const normalized = normalizeManifest(manifest, { manifestPath: path.join(root, MANIFEST_FILE) });
  return {
    ...(normalized.schemaVersion ? { schemaVersion: normalized.schemaVersion } : {}),
    id: normalized.id,
    name: normalized.name,
    command: normalized.command,
    cwd: ".",
    protocol: normalized.protocol,
    ...(normalized.healthUrl ? { healthUrl: normalized.healthUrl } : {}),
    ...(Object.keys(normalized.env).length ? { env: normalized.env } : {}),
    ...(normalized.upstreamPort ? { upstreamPort: normalized.upstreamPort } : {}),
    ...(normalized.preStartCommand ? { preStartCommand: normalized.preStartCommand } : {}),
    ...(normalized.stopCommand ? { stopCommand: normalized.stopCommand } : {}),
    ...(normalized.verifyStoppedCommand ? { verifyStoppedCommand: normalized.verifyStoppedCommand } : {}),
    ...(normalized.preStartTimeoutMs !== undefined ? { preStartTimeoutMs: normalized.preStartTimeoutMs } : {}),
    ...(normalized.startTimeoutMs !== undefined ? { startTimeoutMs: normalized.startTimeoutMs } : {}),
    ...(normalized.stopTimeoutMs !== undefined ? { stopTimeoutMs: normalized.stopTimeoutMs } : {}),
    ...(normalized.healthTimeoutMs !== undefined ? { healthTimeoutMs: normalized.healthTimeoutMs } : {}),
    ...(normalized.mcp ? { mcp: normalized.mcp } : {})
  };
}

function relaybaseEnvBlock(manifest: AppManifestInput): string {
  const appId = String(manifest.id ?? "app");
  return [
    "# relaybase:start",
    `RELAYBASE_APP_ID=${appId}`,
    `RELAYBASE_BASE_URL=http://${appId}.localhost:${DEFAULT_PORT}`,
    "# PORT is assigned by Relaybase at runtime unless this project uses a pinned upstreamPort.",
    "# relaybase:end",
    ""
  ].join(os.EOL);
}

function mergeRelaybaseEnvBlock(current: string, block: string): string {
  const normalized = current.trimEnd();
  const pattern = /(?:^|\r?\n)# relaybase:start[\s\S]*?# relaybase:end(?:\r?\n)?/;
  if (pattern.test(current)) {
    return current.replace(pattern, `${os.EOL}${block}`.replace(/^\r?\n/, "")).trimEnd() + os.EOL;
  }
  return `${normalized}${normalized ? os.EOL.repeat(2) : ""}${block}`;
}

function launchWrapper(detection: ProjectDetection): string {
  const script = detection.scripts.dev ? "dev" : detection.scripts.start ? "start" : "";
  const wrapper = wrapperCommand(detection.packageManager);
  const baseArgs = [...wrapper.args, ...packageManagerArgs(detection.packageManager, script)];
  const frameworkArgs = frameworkPortArgs(detection.framework);
  return `#!/usr/bin/env node
const { spawn } = require("node:child_process");

const port = process.env.PORT || "3000";
const host = process.env.HOST || "127.0.0.1";
const command = ${JSON.stringify(wrapper.command)};
const args = ${JSON.stringify(baseArgs)}.concat(${JSON.stringify(frameworkArgs)}.map((arg) => arg.replace("$PORT", port).replace("$HOST", host)));

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: false,
  windowsHide: true
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
child.on("error", (error) => {
  console.error("[relaybase] launch wrapper failed:", error.message);
  process.exit(1);
});
`;
}

function wrapperCommand(packageManager: ProjectDetection["packageManager"]): { command: string; args: string[] } {
  if (packageManager === "pnpm") {
    return process.platform === "win32"
      ? { command: "corepack.cmd", args: ["pnpm"] }
      : { command: "corepack", args: ["pnpm"] };
  }
  if (packageManager === "yarn") {
    return process.platform === "win32"
      ? { command: "corepack.cmd", args: ["yarn"] }
      : { command: "corepack", args: ["yarn"] };
  }
  if (packageManager === "bun") {
    return { command: "bun", args: [] };
  }
  if (packageManager === "node") {
    return { command: "node", args: [] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
}

function staticPreviewServer(): string {
  return `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const candidates = ["dist", "build", "public", "."];
const staticRoot = candidates.map((candidate) => path.join(root, candidate)).find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || root;
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const server = http.createServer((request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
  const filePath = path.join(staticRoot, urlPath === "/" ? "index.html" : urlPath);
  const safePath = filePath.startsWith(staticRoot) ? filePath : path.join(staticRoot, "index.html");
  fs.readFile(safePath, (error, body) => {
    if (error) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200);
    response.end(body);
  });
});

server.listen(port, host, () => {
  console.log("[relaybase] static preview listening on " + host + ":" + port + " from " + staticRoot);
});
`;
}

function selectPlan(candidates: SetupPlan[], id?: string): SetupPlan {
  if (!candidates.length) {
    throw new Error("Relaybase could not generate any setup plans for this project.");
  }
  if (!id) {
    return candidates[0];
  }
  return candidates.find((candidate) => candidate.id === id || candidate.architecture === id) ?? candidates[0];
}

function launchProfile(selectedPlan: SetupPlan): LaunchProfile {
  const root = setupRootFromPlan(selectedPlan);
  const now = new Date().toISOString();
  return {
    version: 1,
    appId: String(selectedPlan.manifest.id),
    planId: selectedPlan.id,
    architecture: selectedPlan.architecture,
    manifestPath: path.join(root, MANIFEST_FILE),
    command: String(selectedPlan.manifest.command),
    envStrategy: selectedPlan.envStrategy,
    createdAt: now,
    updatedAt: now
  };
}

async function readLaunchProfile(cwd: string): Promise<LaunchProfile | undefined> {
  const profilePath = path.join(cwd, SETUP_DIR, PROFILE_FILE);
  try {
    return JSON.parse(await fs.readFile(profilePath, "utf8")) as LaunchProfile;
  } catch (error) {
    if (isNodeErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function readSetupAnswers(
  answersPath: string | undefined,
  cwd: string
): Promise<{ selectedPlanId?: string; envStrategy?: EnvStrategy; noStart?: boolean }> {
  if (!answersPath) {
    return {};
  }
  const resolved = path.resolve(cwd, answersPath);
  const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as Record<string, unknown>;
  return {
    ...(typeof parsed.selectedPlanId === "string" ? { selectedPlanId: parsed.selectedPlanId } : {}),
    ...(isEnvStrategy(parsed.envStrategy) ? { envStrategy: parsed.envStrategy } : {}),
    ...(typeof parsed.noStart === "boolean" ? { noStart: parsed.noStart } : {})
  };
}

function isEnvStrategy(value: unknown): value is EnvStrategy {
  return (
    value === "runtime-injection" || value === "env-relaybase-file" || value === "guarded-env-block" || value === "none"
  );
}

function setupRootFromPlan(selectedPlan: SetupPlan): string {
  const manifestWrite = selectedPlan.writes.find((write) => path.basename(write.path) === MANIFEST_FILE);
  return manifestWrite ? path.dirname(manifestWrite.path) : process.cwd();
}

function scoreManagedDynamic(detection: ProjectDetection, existingManifest: AppManifestInput | undefined): number {
  let score = existingManifest ? 95 : 80;
  if (detection.framework === "next" || detection.framework === "vite") {
    score += 5;
  }
  if (detection.portEnvKeys.length) {
    score -= 10;
  }
  if (!detection.scripts.dev && !detection.scripts.start && !existingManifest) {
    score -= 25;
  }
  return score;
}

function scoreFrameworkWrapper(detection: ProjectDetection): number {
  let score = 70;
  if (detection.framework === "vite" || detection.framework === "next") {
    score += 10;
  }
  if (detection.portEnvKeys.length) {
    score += 5;
  }
  return score;
}

function startCommandFor(detection: ProjectDetection): string {
  if (detection.scripts.dev) {
    return `${detection.packageCommand} ${runToken(detection.packageManager)} dev`;
  }
  if (detection.scripts.start) {
    return `${detection.packageCommand} ${runToken(detection.packageManager)} start`;
  }
  if (detection.appKind === "static") {
    return nodeCommand(".relaybase/static-preview.cjs");
  }
  return "node server.js";
}

function packageManagerArgs(packageManager: ProjectDetection["packageManager"], script: string): string[] {
  if (!script) {
    return [];
  }
  if (packageManager === "pnpm" || packageManager === "yarn" || packageManager === "bun") {
    return ["run", script];
  }
  return ["run", script];
}

function frameworkPortArgs(framework: string): string[] {
  if (framework === "next") {
    return ["--", "-H", "$HOST", "-p", "$PORT"];
  }
  if (framework === "vite" || framework === "astro" || framework === "sveltekit") {
    return ["--", "--host", "$HOST", "--port", "$PORT"];
  }
  return ["--", "--host", "$HOST", "--port", "$PORT"];
}

function runToken(packageManager: ProjectDetection["packageManager"]): string {
  return packageManager === "pnpm" || packageManager === "yarn" || packageManager === "bun" ? "run" : "run";
}

function packageCommand(packageManager: ProjectDetection["packageManager"]): string {
  if (packageManager === "pnpm") {
    return process.platform === "win32" ? "corepack.cmd pnpm" : "corepack pnpm";
  }
  if (packageManager === "yarn") {
    return process.platform === "win32" ? "corepack.cmd yarn" : "corepack yarn";
  }
  if (packageManager === "bun") {
    return "bun";
  }
  if (packageManager === "node") {
    return "node";
  }
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function detectPackageManager(
  root: string,
  files: string[],
  packageJson?: PackageJson
): ProjectDetection["packageManager"] {
  if (packageJson?.packageManager?.startsWith("pnpm")) {
    return "pnpm";
  }
  if (packageJson?.packageManager?.startsWith("yarn")) {
    return "yarn";
  }
  if (packageJson?.packageManager?.startsWith("bun")) {
    return "bun";
  }
  if (files.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (files.includes("yarn.lock")) {
    return "yarn";
  }
  if (files.includes("bun.lockb") || files.includes("bun.lock")) {
    return "bun";
  }
  if (files.includes("package-lock.json") || packageJson) {
    return "npm";
  }
  if (files.some((file) => file.endsWith(".js") || file.endsWith(".cjs") || file.endsWith(".mjs"))) {
    return "node";
  }
  void root;
  return "unknown";
}

function detectFramework(files: string[], deps: Record<string, string>): string {
  if (
    deps.next ||
    files.includes("next.config.js") ||
    files.includes("next.config.mjs") ||
    files.includes("next.config.ts")
  ) {
    return "next";
  }
  if (
    deps.vite ||
    files.includes("vite.config.js") ||
    files.includes("vite.config.ts") ||
    files.includes("vite.config.mjs")
  ) {
    return "vite";
  }
  if (deps.astro || files.includes("astro.config.mjs")) {
    return "astro";
  }
  if (deps["@sveltejs/kit"] || files.includes("svelte.config.js")) {
    return "sveltekit";
  }
  if (deps.express || deps.fastify || files.includes("server.js") || files.includes("server.ts")) {
    return "node-http";
  }
  if (files.includes("index.html")) {
    return "static";
  }
  return "unknown";
}

function detectAppKind(
  files: string[],
  scripts: Record<string, string>,
  deps: Record<string, string>,
  framework: string
): ProjectDetection["appKind"] {
  if (files.some((file) => /^docker-compose\.(?:ya?ml)$|^compose\.(?:ya?ml)$/.test(file))) {
    return "docker";
  }
  if (deps["@modelcontextprotocol/sdk"] || Object.keys(scripts).some((script) => script.includes("mcp"))) {
    return "mcp";
  }
  if (framework === "static") {
    return "static";
  }
  if (framework === "node-http") {
    return "api";
  }
  if (framework !== "unknown") {
    return "web";
  }
  return "unknown";
}

function detectMcpHints(files: string[], scripts: Record<string, string>, deps: Record<string, string>): string[] {
  const hints: string[] = [];
  if (deps["@modelcontextprotocol/sdk"]) {
    hints.push("@modelcontextprotocol/sdk dependency");
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (/mcp/i.test(name) || /mcp/i.test(command)) {
      hints.push(`script:${name}`);
    }
  }
  if (files.some((file) => /mcp/i.test(file))) {
    hints.push("mcp-named file");
  }
  return hints;
}

function detectMonorepoHints(files: string[], packageJson?: PackageJson): string[] {
  const hints: string[] = [];
  if (packageJson?.workspaces) {
    hints.push("package.json workspaces");
  }
  if (files.includes("pnpm-workspace.yaml")) {
    hints.push("pnpm-workspace.yaml");
  }
  if (files.includes("turbo.json")) {
    hints.push("turbo.json");
  }
  if (files.includes("nx.json")) {
    hints.push("nx.json");
  }
  return hints;
}

function healthCandidates(framework: string, appKind: ProjectDetection["appKind"]): string[] {
  if (appKind === "api") {
    return ["/health", "/api/health", "/"];
  }
  if (framework === "next") {
    return ["/", "/api/health"];
  }
  return ["/", "/health", "/api/health"];
}

function firstDetectedPort(detection: ProjectDetection): number | undefined {
  return detection.detectedPorts[0];
}

function appIdFromDetection(detection: ProjectDetection, existing?: AppManifestInput): string {
  if (typeof existing?.id === "string") {
    return existing.id;
  }
  const raw = detection.packageName
    ? (detection.packageName.split("/").pop() ?? detection.packageName)
    : path.basename(detection.root);
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "app"
  );
}

function appNameFromDetection(
  detection: ProjectDetection,
  existing: AppManifestInput | undefined,
  appId: string
): string {
  if (typeof existing?.name === "string") {
    return existing.name;
  }
  if (detection.packageName) {
    return detection.packageName;
  }
  return appId
    .split("-")
    .map((word) => (word ? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}` : word))
    .join(" ");
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageJson;
  } catch (error) {
    if (isNodeErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function safeReadDir(root: string): Promise<string[]> {
  try {
    return await fs.readdir(root);
  } catch {
    return [];
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, filePath);
}

function nodeCommand(scriptPath: string): string {
  return `node ${scriptPath}`;
}

function humanUrl(appId: string, port: number): string {
  return `http://${appId}.localhost:${port}`;
}

async function openBrowser(url: string): Promise<boolean> {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function event(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    type,
    at: new Date().toISOString(),
    ...data
  };
}

function safeTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactResult(result: ConfigureProjectResult): ConfigureProjectResult {
  return JSON.parse(
    JSON.stringify(result, (key, value) => (/token|secret|password|key/i.test(key) ? "[redacted]" : value))
  ) as ConfigureProjectResult;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
