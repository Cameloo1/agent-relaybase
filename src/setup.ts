import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  daemonHttpRequest,
  discovery,
  ensureDaemon,
  type DaemonEnsureResult,
  type RelaybaseCommandOptions
} from "./daemonLauncher.ts";
import {
  buildDockerComposeSetup,
  classifyDockerFailure,
  detectDockerCompose,
  readDockerProfile,
  type DockerComposeDetection,
  type DockerErrorCode,
  type DockerProfile,
  type DockerSetupOptions
} from "./dockerProfile.ts";
import { Registry, readManifestFile } from "./registry.ts";
import { detectRuntimeMatrix } from "./setupRuntimeAdapters.ts";
import type {
  HealthCandidate,
  PortBindingStrategy,
  RepairCandidate,
  RuntimeDetectionResult,
  RuntimeId,
  RuntimeMatrixSnapshot,
  SetupQuestion,
  StartCommandCandidate
} from "./setupRuntimeTypes.ts";
import { DEFAULT_HOST, DEFAULT_PORT, getDefaultStateDir, getOrCreateSessionToken, isNodeErrno } from "./state.ts";
import type { AppComponentRole, AppManifestInput, AppRecord, AppState } from "./types.ts";
import { normalizeManifest } from "./validation.ts";

export type { DaemonEnsureResult, RelaybaseCommandOptions } from "./daemonLauncher.ts";

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

export type NextActionOwner =
  | "daemon"
  | "manifest"
  | "app-command"
  | "backend-port"
  | "health-url"
  | "token"
  | "route"
  | "permissions";

export interface NextAction {
  owner: NextActionOwner;
  action: string;
  command?: string;
  evidence?: string;
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
  commandHint?: string;
  portStrategyHint?: string;
  componentMetadata?: SetupComponentMetadata;
  startDaemon?: boolean;
  docker?: DockerSetupOptions;
}

export interface SetupComponentMetadata {
  appId?: string;
  name?: string;
  command?: string;
  cwd?: string;
  healthUrl?: string;
  groupId?: string;
  componentRole?: AppComponentRole;
  displayName?: string;
  paneLabel?: string;
  paneOrder?: number;
}

export interface OpenProjectOptions extends RelaybaseCommandOptions {
  noBrowser?: boolean;
  startDaemon?: boolean;
}

export interface HealthProjectOptions extends RelaybaseCommandOptions {
  appId?: string;
  prove?: boolean;
  lifecycleProof?: boolean;
  startDaemon?: boolean;
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
  existingLaunchWrapperPath?: string;
  existingSetupProfilePath?: string;
  dockerComposeFiles: string[];
  docker?: DockerComposeDetection;
  mcpHints: string[];
  monorepoHints: string[];
  healthCandidates: string[];
  runtimeMatrix: RuntimeMatrixSnapshot;
  primaryRuntime?: RuntimeDetectionResult;
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
  requiresInput?: string[];
  runtimeId?: RuntimeId;
  startCommandCandidates?: StartCommandCandidate[];
  portBindingStrategies?: PortBindingStrategy[];
  runtimeHealthCandidates?: HealthCandidate[];
  setupQuestions?: SetupQuestion[];
  repairCandidates?: RepairCandidate[];
  selectedCommand?: string;
  selectedCommandSource?: "default" | "package-script" | "runtime-candidate";
  selectedCommandCandidateId?: string;
  portStrategyHint?: string;
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
  daemon?: DaemonEnsureResult;
  state?: AppState;
  url?: string;
  error?: string;
  recoveryHint?: LaunchFailureClassification;
  nextActions?: NextAction[];
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

export class SetupSelectionError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  readonly userAction?: string;

  constructor(code: string, message: string, options: { detail?: unknown; userAction?: string } = {}) {
    super(message);
    this.code = code;
    this.detail = options.detail;
    this.userAction = options.userAction;
  }
}

export interface OpenProjectResult {
  appId: string;
  url: string;
  openedBrowser: boolean;
  registered: boolean;
  started: boolean;
  ready: boolean;
  daemon?: DaemonEnsureResult;
  state?: AppState;
  error?: string;
  recoveryHint?: LaunchFailureClassification;
  nextActions?: NextAction[];
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
  proof?: ProofBundle;
  findings: HealthFinding[];
  nextActions?: NextAction[];
  recommendedAction?: string;
}

export interface ProofBundle {
  ok: boolean;
  mode: "read-only" | "lifecycle";
  lifecycleAttempted: boolean;
  artifactPath?: string;
  checks: ProofCheck[];
  logs?: { available: boolean; count: number; streamUrl?: string };
  started?: boolean;
  stopped?: boolean;
}

export interface ProofCheck {
  name: string;
  ok: boolean;
  severity: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
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
  runtimeId?: RuntimeId;
  runtimeCommandCandidates?: StartCommandCandidate[];
  runtimePortStrategies?: PortBindingStrategy[];
  runtimeHealthCandidates?: HealthCandidate[];
  setupQuestions?: SetupQuestion[];
  selectedCommand?: string;
  selectedCommandSource?: string;
  selectedCommandCandidateId?: string;
  portStrategy?: string;
  createdAt: string;
  updatedAt: string;
}

const SETUP_DIR = ".relaybase";
const MANIFEST_FILE = "relaybase.app.json";
const PROFILE_FILE = "launch-profile.json";
const SETUP_PROFILE_FILE = "setup-profile.json";
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
  const existingLaunchWrapperPath = (await exists(path.join(root, SETUP_DIR, "launch.cjs")))
    ? path.join(root, SETUP_DIR, "launch.cjs")
    : undefined;
  const existingSetupProfilePath = (await exists(path.join(root, SETUP_DIR, SETUP_PROFILE_FILE)))
    ? path.join(root, SETUP_DIR, SETUP_PROFILE_FILE)
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
  const runtimeMatrix = await detectRuntimeMatrix({
    root,
    files,
    packageJson,
    scripts,
    dependencies: deps,
    envFiles,
    portEnvKeys,
    detectedPorts,
    dockerComposeFiles
  });
  const primaryRuntime = runtimeMatrix.primaryRuntime
    ? runtimeMatrix.runtimes.find((runtime) => runtime.runtime === runtimeMatrix.primaryRuntime)
    : undefined;

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
    ...(existingLaunchWrapperPath ? { existingLaunchWrapperPath } : {}),
    ...(existingSetupProfilePath ? { existingSetupProfilePath } : {}),
    dockerComposeFiles,
    ...(docker ? { docker } : {}),
    mcpHints,
    monorepoHints,
    healthCandidates: healthCandidates(framework, appKind),
    runtimeMatrix,
    ...(primaryRuntime ? { primaryRuntime } : {})
  };
}

export async function proposeSetupPlans(
  detection: ProjectDetection,
  options: {
    envStrategy?: EnvStrategy;
    mcpInstall?: boolean;
    docker?: DockerSetupOptions;
    commandHint?: string;
    portStrategyHint?: string;
    componentMetadata?: SetupComponentMetadata;
  } = {}
): Promise<SetupPlan[]> {
  const existingManifest = detection.existingManifestPath
    ? await readManifestFile(detection.existingManifestPath).catch(() => undefined)
    : undefined;
  const appId = appIdFromDetection(detection, existingManifest);
  const name = appNameFromDetection(detection, existingManifest, appId);
  const commandSelection = selectSetupCommand(detection, options.commandHint ?? options.componentMetadata?.command);
  const startCommand = commandSelection.command;
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
  const selectedBaseManifest = options.componentMetadata
    ? withSetupComponentMetadata(baseManifest, options.componentMetadata)
    : baseManifest;
  const plans: SetupPlan[] = [];

  const managedManifest = {
    ...selectedBaseManifest,
    command: String(selectedBaseManifest.command ?? startCommand),
    upstreamPort: undefined
  };
  plans.push(
    plan({
      id: "managed-web",
      label: "Managed dynamic port",
      architecture: "managed-dynamic-port",
      score: scoreManagedDynamic(detection, existingManifest),
      manifest: managedManifest,
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
      commandSelection,
      portStrategyHint: options.portStrategyHint,
      extraWrites: setupWrites(detection.root, managedManifest, envStrategy, options.mcpInstall)
    })
  );

  if (detection.framework !== "unknown" || detection.scripts.dev) {
    const wrapperManifest = {
      ...selectedBaseManifest,
      command: nodeCommand(".relaybase/launch.cjs"),
      upstreamPort: undefined
    };
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
        commandSelection,
        portStrategyHint: options.portStrategyHint,
        extraWrites: [
          ...setupWrites(detection.root, wrapperManifest, envStrategy, options.mcpInstall),
          {
            path: path.join(detection.root, SETUP_DIR, "launch.cjs"),
            action: "create",
            reason: "Launch wrapper adapts package-manager scripts to Relaybase-assigned ports.",
            preview: launchWrapper(detection, commandSelection.scriptName)
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
        manifest: { ...selectedBaseManifest, upstreamPort: detectedPort },
        detection,
        envStrategy,
        reasons: [
          "Use this when the app cannot bind a Relaybase-assigned dynamic port.",
          `Relaybase will verify and route the fixed backend port ${detectedPort}.`
        ],
        risks: ["A fixed port can conflict with stale app processes."],
        recoverySteps: ["If the port is occupied, identify the owner and ask before stopping it."],
        commandSelection,
        portStrategyHint: options.portStrategyHint,
        extraWrites: setupWrites(
          detection.root,
          { ...selectedBaseManifest, upstreamPort: detectedPort },
          envStrategy,
          options.mcpInstall
        )
      })
    );
  }

  if (detection.dockerComposeFiles.length) {
    const dockerDetection =
      detection.docker ??
      ({
        composeFiles: detection.dockerComposeFiles,
        envFiles: detection.envFiles,
        services: [],
        serviceCandidates: [],
        selection: {
          mode: "required",
          confidence: "low",
          reason: "Compose files were detected but no service metadata could be parsed.",
          candidates: []
        },
        requiredServices: [],
        optionalServices: [],
        dependencyPorts: [],
        dangerousFindings: [],
        missingEnvVars: [],
        privateImages: [],
        hostPublishedPorts: [],
        dynamicPublishedPorts: [],
        suggestedProjectName: `relaybase-${appId}`
      } satisfies DockerComposeDetection);
    try {
      const dockerSetup = buildDockerComposeSetup(
        detection.root,
        selectedBaseManifest,
        dockerDetection,
        options.docker
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
          commandSelection,
          portStrategyHint: options.portStrategyHint,
          extraWrites: [
            ...setupWrites(detection.root, dockerSetup.manifest, envStrategy, options.mcpInstall),
            ...dockerSetup.writes
          ]
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Docker service selection is required.";
      plans.push(
        plan({
          id: "docker-compose",
          label: "Docker Compose service",
          architecture: "docker-compose-service",
          score: 5,
          manifest: selectedBaseManifest,
          detection,
          envStrategy,
          reasons: [
            "Compose files are present, but Relaybase will not guess the app entrypoint when service selection is ambiguous.",
            dockerDetection.selection.reason
          ],
          risks: [message],
          recoverySteps: [
            "Run relaybase configure interactively and choose the app-facing service.",
            "Or pass --service <name> --target-port <port> --health-path /api/health."
          ],
          commandSelection,
          portStrategyHint: options.portStrategyHint,
          extraWrites: setupWrites(detection.root, selectedBaseManifest, envStrategy, options.mcpInstall),
          requiresInput: ["docker.service", "docker.targetPort"]
        })
      );
    }
  }

  if (detection.appKind === "static") {
    const staticManifest = {
      ...selectedBaseManifest,
      command: nodeCommand(".relaybase/static-preview.cjs"),
      healthUrl: "/"
    };
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
        commandSelection,
        portStrategyHint: options.portStrategyHint,
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
      ...selectedBaseManifest,
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
        score: scoreMcpOnly(detection),
        manifest: mcpManifest,
        detection,
        envStrategy,
        reasons: ["MCP hints were detected; Relaybase can expose child tools through the app manifest."],
        risks: ["Child MCP tool allowlists still need exact user-approved entries."],
        recoverySteps: ["Add exact child MCP tools/resources/prompts after inspecting the server."],
        commandSelection,
        portStrategyHint: options.portStrategyHint,
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
    mcpInstall: options.mcpInstall,
    docker: options.docker ?? answers.docker,
    commandHint: options.commandHint ?? answers.commandHint,
    portStrategyHint: options.portStrategyHint ?? answers.portStrategyHint,
    componentMetadata: options.componentMetadata ?? answers.componentMetadata
  });
  let selectedPlan = selectPlan(
    candidates,
    options.selectedPlanId ?? options.profile ?? answers.selectedPlanId,
    options.portStrategyHint ?? answers.portStrategyHint
  );
  if (!options.dryRun && selectedPlan.requiresInput?.length) {
    const details = selectedPlan.risks.length ? ` ${selectedPlan.risks.join(" ")}` : "";
    throw new Error(
      `Setup plan ${selectedPlan.id} requires explicit input: ${selectedPlan.requiresInput.join(", ")}.${details} Run relaybase configure interactively or pass Docker setup flags.`
    );
  }
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
      error: "This project is not configured for Relaybase. Run relaybase configure first.",
      nextActions: [
        {
          owner: "manifest",
          action: "Create or repair relaybase.app.json before opening this project.",
          command: "relaybase configure"
        }
      ]
    };
  }

  let app: AppRecord;
  try {
    app = normalizeManifest(await readManifestFile(manifestPath), { manifestPath });
  } catch (error) {
    return {
      appId: "",
      url: "",
      openedBrowser: false,
      registered: false,
      started: false,
      ready: false,
      error: `Relaybase manifest could not be loaded: ${errorMessage(error)}`,
      nextActions: [
        {
          owner: "manifest",
          action:
            "Fix relaybase.app.json so Relaybase can load a valid app id, command, cwd, protocol, and health route.",
          evidence: manifestPath
        }
      ]
    };
  }

  const daemonStarted = await ensureDaemon(options, options.startDaemon !== false);
  if (!daemonStarted.reachable) {
    let localRegistryError: string | undefined;
    let registered = false;
    try {
      await registerManifestPath(manifestPath, options.stateDir);
      registered = true;
    } catch (error) {
      localRegistryError = errorMessage(error);
    }
    const error = [
      daemonStarted.error ?? "Relaybase daemon is not reachable.",
      localRegistryError ? `Offline registry fallback failed: ${localRegistryError}` : undefined
    ]
      .filter(Boolean)
      .join(" ");
    return {
      appId: app.id,
      url: humanUrl(app.id, options.port),
      openedBrowser: false,
      registered,
      started: false,
      ready: false,
      daemon: daemonStarted,
      error,
      nextActions: nextActionsForOpenFailure(options, {
        owner: localRegistryError ? "permissions" : "daemon",
        daemon: daemonStarted,
        localRegistryError
      })
    };
  }

  const registerResponse = await registerViaApi(options, manifestPath).catch((error: unknown) => ({
    ok: false,
    statusCode: 0,
    body: errorMessage(error)
  }));
  if (!registerResponse.ok) {
    return {
      appId: app.id,
      url: humanUrl(app.id, options.port),
      openedBrowser: false,
      registered: false,
      started: false,
      ready: false,
      daemon: daemonStarted,
      error: `Relaybase daemon registration failed (${registerResponse.statusCode}): ${registerResponse.body}`,
      nextActions: nextActionsForOpenFailure(options, {
        owner: registerResponse.statusCode === 401 ? "token" : "daemon",
        daemon: daemonStarted,
        registerResponse
      })
    };
  }

  const started = await mutateAppViaApi(options, app.id, "start").catch((error: unknown) => ({
    ok: false,
    statusCode: 0,
    body: errorMessage(error)
  }));
  const stateResponse = await getAppStateViaApi(options, app.id);
  const state = stateResponse.state;
  const url = humanUrl(app.id, options.port);
  const ready = Boolean(state?.readiness.state === "ready" || state?.routeReachable);
  const openedBrowser = !options.noBrowser && ready ? await openBrowser(url) : false;
  const recoveryHint = ready
    ? undefined
    : classifyLaunchFailure({
        error: started.body || stateResponse.error,
        lastError: state?.lastError ?? undefined,
        logs: state?.recentLogs,
        runtimeStatus: state?.runtime.status
      });
  const error = ready
    ? undefined
    : (state?.readiness.failureReason ??
      stateResponse.error ??
      started.body ??
      "Relaybase start did not prove readiness.");

  return {
    appId: app.id,
    url,
    openedBrowser,
    daemon: daemonStarted,
    registered: true,
    started: started.ok,
    ready,
    ...(state ? { state } : {}),
    ...(error ? { error } : {}),
    ...(recoveryHint ? { recoveryHint, nextActions: nextActionsFromLaunchFailure(options, recoveryHint, state) } : {})
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
  let proof: ProofBundle | undefined;

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
      if (state.routeHealth?.status === "degraded") {
        findings.push({
          severity: "warning",
          code: "ROUTE_DEGRADED",
          message: "Only one Relaybase route path is reachable; human and agent routes should both be inspectable.",
          repair:
            "Check the human .localhost route and the X-Relaybase-App header route before treating the app as fully proven."
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

  if (options.prove) {
    proof = await proveProject(options, detection.root, manifestPath, appId, dockerProfile, daemon.reachable);
    if (!proof.ok) {
      findings.push({
        severity: "error",
        code: "PROOF_FAILED",
        message: "Relaybase proof checks did not all pass.",
        repair: proof.lifecycleAttempted
          ? "Inspect the proof artifact and recent logs."
          : "Run relaybase health --prove --yes for lifecycle proof."
      });
    }
  }

  const ok =
    findings.every((finding) => finding.severity !== "error") &&
    Boolean(daemon.reachable) &&
    Boolean(manifestPath) &&
    (proof ? proof.ok : true);
  const nextActions = nextActionsFromHealthFindings(options, findings, state);
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
    ...(proof ? { proof } : {}),
    findings,
    ...(nextActions.length ? { nextActions } : {}),
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

function nextActionsForOpenFailure(
  options: RelaybaseCommandOptions,
  input: {
    owner: NextActionOwner;
    daemon?: DaemonEnsureResult;
    localRegistryError?: string;
    registerResponse?: { statusCode: number; body: string };
  }
): NextAction[] {
  const actions: NextAction[] = [];
  if (input.owner === "token") {
    actions.push({
      owner: "token",
      action:
        "Use the same Relaybase state directory and session token as the running daemon, or restart the daemon with this state directory.",
      command: `relaybase open --state-dir ${quoteArg(options.stateDir)} --json`,
      evidence: input.registerResponse?.body
    });
  } else if (input.owner === "permissions") {
    actions.push({
      owner: "permissions",
      action:
        "Fix write access to the Relaybase state directory or choose a writable state directory for offline fallback.",
      command: `relaybase open --state-dir ${quoteArg(options.stateDir)} --json`,
      evidence: input.localRegistryError
    });
  } else {
    actions.push({
      owner: "daemon",
      action: "Start or inspect the Relaybase daemon before retrying app launch.",
      command: `relaybase serve --host ${options.host} --port ${options.port} --state-dir ${quoteArg(options.stateDir)}`,
      evidence: input.daemon?.error
    });
  }

  if (input.daemon?.logPath) {
    actions.push({
      owner: "daemon",
      action: "Inspect the daemon log captured by the launcher.",
      evidence: input.daemon.logPath
    });
  }
  if (input.daemon?.pidPath) {
    actions.push({
      owner: "daemon",
      action: "Check the recorded daemon pid and metadata before killing or restarting anything.",
      evidence: input.daemon.pidPath
    });
  }
  if (input.registerResponse && input.owner !== "token") {
    actions.push({
      owner: "daemon",
      action:
        "Inspect the daemon registration response; local registry writes will not repair a live daemon that rejected registration.",
      evidence: input.registerResponse.body
    });
  }

  return uniqueNextActions(actions);
}

function nextActionsFromLaunchFailure(
  options: RelaybaseCommandOptions,
  recoveryHint: LaunchFailureClassification,
  state?: AppState
): NextAction[] {
  const owner = ownerForLaunchFailure(recoveryHint);
  const actions: NextAction[] = [
    {
      owner,
      action: recoveryHint.message,
      command: recoveryHint.requiresApproval
        ? `relaybase configure --repair --yes --cwd ${quoteArg(options.cwd)}`
        : `relaybase configure --repair --cwd ${quoteArg(options.cwd)}`
    }
  ];

  if (state?.routeHealth && state.routeHealth.status !== "full") {
    actions.push({
      owner: "route",
      action: `Route health is ${state.routeHealth.status}; verify both the human .localhost URL and the X-Relaybase-App header route.`,
      evidence: JSON.stringify({
        humanRoute: state.routeHealth.humanRoute,
        agentRoute: state.routeHealth.agentRoute
      })
    });
  }
  if (state?.backendPort && !state.backendPortOpen) {
    actions.push({
      owner: "backend-port",
      action: "Verify the configured backend port is open and owned by this app before retrying route checks.",
      evidence: String(state.backendPort)
    });
  }

  return uniqueNextActions(actions);
}

function nextActionsFromHealthFindings(
  options: RelaybaseCommandOptions,
  findings: HealthFinding[],
  state?: AppState
): NextAction[] {
  const actions = findings.flatMap((finding): NextAction[] => {
    if (!finding.repair) {
      return [];
    }
    return [
      {
        owner: ownerForFinding(finding),
        action: finding.repair,
        command: commandFromRepair(finding.repair),
        evidence: `${finding.code}: ${finding.message}`
      }
    ];
  });

  if (state?.routeHealth && state.routeHealth.status !== "full") {
    actions.push({
      owner: "route",
      action: "Treat this as degraded until both route paths pass.",
      command: `relaybase health --json --cwd ${quoteArg(options.cwd)}`,
      evidence: JSON.stringify({
        status: state.routeHealth.status,
        humanRoute: state.routeHealth.humanRoute,
        agentRoute: state.routeHealth.agentRoute
      })
    });
  }

  return uniqueNextActions(actions);
}

function ownerForLaunchFailure(recoveryHint: LaunchFailureClassification): NextActionOwner {
  if (recoveryHint.code === "health-route") {
    return "health-url";
  }
  if (
    recoveryHint.code === "ignored-port" ||
    recoveryHint.code === "port-conflict" ||
    recoveryHint.code === "stale-process"
  ) {
    return "backend-port";
  }
  if (
    recoveryHint.code === "command-not-found" ||
    recoveryHint.code === "powershell-policy" ||
    recoveryHint.code === "corepack-spawn" ||
    recoveryHint.code === "dependency-missing" ||
    recoveryHint.code === "crash-loop"
  ) {
    return "app-command";
  }
  return "app-command";
}

function ownerForFinding(finding: HealthFinding): NextActionOwner {
  if (finding.code.includes("DAEMON")) {
    return "daemon";
  }
  if (finding.code.includes("MANIFEST") || finding.code.includes("CONFIGURED") || finding.code.includes("PROFILE")) {
    return "manifest";
  }
  if (finding.code.includes("ROUTE")) {
    return "route";
  }
  if (finding.code.includes("ENV") || finding.code.includes("COMPOSE") || finding.code.includes("DOCKER")) {
    return "app-command";
  }
  return "app-command";
}

function uniqueNextActions(actions: NextAction[]): NextAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.owner}\0${action.action}\0${action.command ?? ""}\0${action.evidence ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function daemonDetails(daemon: DaemonEnsureResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(daemon).filter(([, value]) => value !== undefined));
}

function commandFromRepair(repair: string): string | undefined {
  if (!repair.startsWith("Run relaybase ")) {
    return undefined;
  }
  return repair.replace(/^Run /, "").replace(/\.$/, "");
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

async function proveProject(
  options: HealthProjectOptions,
  root: string,
  manifestPath: string | undefined,
  appId: string | undefined,
  dockerProfile: DockerProfile | undefined,
  daemonReachable: boolean
): Promise<ProofBundle> {
  const checks: ProofCheck[] = [];
  const lifecycle = options.lifecycleProof === true;
  let effectiveDaemonReachable = daemonReachable;
  let effectiveAppId = appId;
  let logs: ProofBundle["logs"];
  let started = false;
  let stopped = false;

  checks.push({
    name: "discovery",
    ok: daemonReachable,
    severity: daemonReachable ? "info" : "error",
    message: daemonReachable ? "Relaybase discovery is reachable." : "Relaybase discovery is not reachable."
  });

  if (lifecycle && !effectiveDaemonReachable) {
    const daemon = await ensureDaemon(options, options.startDaemon === true);
    effectiveDaemonReachable = daemon.reachable;
    checks.push({
      name: "daemon-start",
      ok: daemon.reachable,
      severity: daemon.reachable ? "info" : "error",
      message: daemon.reachable
        ? `Relaybase daemon ${daemon.started ? "started" : "was already reachable"}.`
        : (daemon.error ?? "Relaybase daemon could not be started."),
      details: daemonDetails(daemon)
    });
  }

  checks.push({
    name: "project-config",
    ok: Boolean(manifestPath),
    severity: manifestPath ? "info" : "error",
    message: manifestPath ? "Project has a Relaybase manifest." : "Project is missing relaybase.app.json."
  });

  if (manifestPath) {
    const manifest = await readManifestFile(manifestPath).catch(() => undefined);
    if (manifest?.id && typeof manifest.id === "string") {
      effectiveAppId = manifest.id;
    }
    checks.push({
      name: "manifest",
      ok: Boolean(manifest),
      severity: manifest ? "info" : "error",
      message: manifest ? `Manifest loaded for ${manifest.id}.` : "Manifest could not be loaded."
    });
  }

  if (dockerProfile) {
    checks.push({
      name: "docker-service-selection",
      ok: Boolean(dockerProfile.selectedService && dockerProfile.targetContainerPort),
      severity: dockerProfile.selectedService && dockerProfile.targetContainerPort ? "info" : "error",
      message: dockerProfile.selectedService
        ? `Docker target is ${dockerProfile.selectedService}:${dockerProfile.targetContainerPort}.`
        : "Docker profile is missing explicit service selection.",
      details: {
        selection: dockerProfile.serviceSelection,
        dependencyPortPolicy: dockerProfile.dependencyPortPolicy,
        timingsMs: dockerProfile.timingsMs
      }
    });
    checks.push({
      name: "docker-port-policy",
      ok: dockerProfile.dependencyPortPolicy === "internal-only",
      severity: dockerProfile.dependencyPortPolicy === "internal-only" ? "info" : "warning",
      message:
        dockerProfile.dependencyPortPolicy === "internal-only"
          ? "Dependency host ports are configured to be closed by the Relaybase override."
          : "Dependency host ports are preserved by explicit policy.",
      details: { dependencyPorts: dockerProfile.dependencyPorts }
    });
  }

  if (lifecycle && manifestPath && effectiveAppId && effectiveDaemonReachable) {
    const register = await registerViaApi(options, manifestPath);
    checks.push({
      name: "register",
      ok: register.ok,
      severity: register.ok ? "info" : "error",
      message: register.ok ? "Manifest registered through Relaybase API." : register.body,
      details: { statusCode: register.statusCode }
    });
    if (register.ok) {
      const start = await mutateAppViaApi(options, effectiveAppId, "start");
      started = start.ok;
      checks.push({
        name: "start",
        ok: start.ok,
        severity: start.ok ? "info" : "error",
        message: start.ok ? "App start completed through Relaybase." : start.body,
        details: { statusCode: start.statusCode }
      });
      const state = await getAppStateViaApi(options, effectiveAppId);
      checks.push({
        name: "routed-health",
        ok: Boolean(state.state?.readiness.state === "ready" || state.state?.routeReachable),
        severity: state.state?.readiness.state === "ready" || state.state?.routeReachable ? "info" : "error",
        message:
          state.state?.readiness.state === "ready" || state.state?.routeReachable
            ? "Routed readiness passed."
            : (state.state?.readiness.failureReason ?? state.error ?? "Routed readiness did not pass."),
        details: state.state
          ? {
              readiness: state.state.readiness,
              backendPortOpen: state.state.backendPortOpen,
              routeReachable: state.state.routeReachable
            }
          : undefined
      });
      const logResponse = await getLogsViaApi(options, effectiveAppId);
      logs = {
        available: logResponse.ok,
        count: logResponse.logs.length,
        ...(logResponse.streamUrl ? { streamUrl: logResponse.streamUrl } : {})
      };
      checks.push({
        name: "logs",
        ok: logResponse.ok,
        severity: logResponse.ok ? "info" : "warning",
        message: logResponse.ok
          ? `Log snapshot is available with ${logResponse.logs.length} line(s).`
          : (logResponse.error ?? "Log snapshot is unavailable.")
      });
      const stop = await mutateAppViaApi(options, effectiveAppId, "stop");
      stopped = stop.ok;
      checks.push({
        name: "stop",
        ok: stop.ok,
        severity: stop.ok ? "info" : "error",
        message: stop.ok ? "App stop completed through Relaybase." : stop.body,
        details: { statusCode: stop.statusCode }
      });
      const stoppedState = await getAppStateViaApi(options, effectiveAppId);
      checks.push({
        name: "stop-verification",
        ok: Boolean(stoppedState.state?.stopVerification?.ok),
        severity: stoppedState.state?.stopVerification?.ok ? "info" : "error",
        message: stoppedState.state?.stopVerification?.ok
          ? "Stop verification passed."
          : (stoppedState.state?.stopVerification?.failureReason ??
            stoppedState.error ??
            "Stop verification did not pass."),
        details: stoppedState.state
          ? {
              stopVerification: stoppedState.state.stopVerification,
              backendPortOpen: stoppedState.state.backendPortOpen
            }
          : undefined
      });
    }
  } else if (!lifecycle) {
    checks.push({
      name: "lifecycle-proof",
      ok: true,
      severity: "warning",
      message: "Lifecycle start/stop proof was skipped. Pass --yes with --prove to run it."
    });
  }

  const proof: ProofBundle = {
    ok: checks.every((check) => check.severity !== "error" || check.ok),
    mode: lifecycle ? "lifecycle" : "read-only",
    lifecycleAttempted: lifecycle,
    checks,
    ...(logs ? { logs } : {}),
    ...(lifecycle ? { started, stopped } : {})
  };
  const artifactPath = await writeProofArtifact(root, proof);
  return { ...proof, ...(artifactPath ? { artifactPath } : {}) };
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
    path.join(root, SETUP_DIR, SETUP_PROFILE_FILE),
    `${JSON.stringify(launchProfile(selectedPlan), null, 2)}\n`
  );
  await writeTextAtomic(
    path.join(root, SETUP_DIR, ANSWERS_FILE),
    `${JSON.stringify(
      {
        version: 1,
        selectedPlanId: selectedPlan.id,
        envStrategy: selectedPlan.envStrategy,
        commandHint: selectedPlan.selectedCommand,
        portStrategyHint: primaryPlanPortStrategy(selectedPlan),
        ...(selectedPlan.manifest.relaybase ? { componentMetadata: selectedPlan.manifest.relaybase } : {}),
        ...(selectedPlan.architecture === "docker-compose-service"
          ? { docker: dockerAnswersFromPlan(selectedPlan) }
          : {})
      },
      null,
      2
    )}\n`
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
  events.push(event("daemon", daemonDetails(daemon)));
  if (!daemon.reachable) {
    return {
      attempted: true,
      daemonStarted: daemon.started,
      daemon,
      registered: true,
      started: false,
      ready: false,
      error: daemon.error,
      recoveryHint: classifyLaunchFailure({ error: daemon.error }),
      nextActions: nextActionsForOpenFailure(options, { owner: "daemon", daemon })
    };
  }

  const registerResponse = await registerViaApi(options, manifestPath).catch((error: unknown) => ({
    ok: false,
    statusCode: 0,
    body: errorMessage(error)
  }));
  events.push(event("api_register", { ok: registerResponse.ok, statusCode: registerResponse.statusCode }));
  if (!registerResponse.ok) {
    return {
      attempted: true,
      daemonStarted: daemon.started,
      daemon,
      registered: false,
      started: false,
      ready: false,
      error: registerResponse.body,
      recoveryHint: classifyLaunchFailure({ error: registerResponse.body }),
      nextActions: nextActionsForOpenFailure(options, {
        owner: registerResponse.statusCode === 401 ? "token" : "daemon",
        daemon,
        registerResponse
      })
    };
  }

  const startResponse = await mutateAppViaApi(options, appId, "start").catch((error: unknown) => ({
    ok: false,
    statusCode: 0,
    body: errorMessage(error)
  }));
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
  const recoveryHint = !ready
    ? classifyLaunchFailure({
        error: startResponse.body,
        lastError: state?.lastError ?? undefined,
        logs: state?.recentLogs,
        runtimeStatus: state?.runtime.status
      })
    : undefined;
  return {
    attempted: true,
    daemonStarted: daemon.started,
    daemon,
    registered: true,
    started: startResponse.ok,
    ready,
    ...(state ? { state } : {}),
    url: humanUrl(appId, options.port),
    ...(!ready
      ? {
          error: state?.readiness.failureReason ?? startResponse.body,
          recoveryHint,
          ...(recoveryHint ? { nextActions: nextActionsFromLaunchFailure(options, recoveryHint, state) } : {})
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
  const response = await httpRequest(
    options,
    "GET",
    `/__hub/api/apps/${encodeURIComponent(id)}/state`,
    undefined,
    await getOrCreateSessionToken(options.stateDir)
  );
  if (!response.ok) {
    return { ok: false, error: response.body };
  }
  const body = safeJson(response.body) as { state?: AppState };
  return { ok: Boolean(body.state), ...(body.state ? { state: body.state } : { error: "Missing state body." }) };
}

async function getLogsViaApi(
  options: RelaybaseCommandOptions,
  id: string
): Promise<{ ok: boolean; logs: string[]; events: unknown[]; streamUrl?: string; error?: string }> {
  const response = await httpRequest(
    options,
    "GET",
    `/__hub/api/apps/${encodeURIComponent(id)}/logs`,
    undefined,
    await getOrCreateSessionToken(options.stateDir)
  );
  if (!response.ok) {
    return { ok: false, logs: [], events: [], error: response.body };
  }
  const body = safeJson(response.body) as { logs?: string[]; events?: unknown[]; streamUrl?: string };
  return {
    ok: true,
    logs: Array.isArray(body.logs) ? body.logs : [],
    events: Array.isArray(body.events) ? body.events : [],
    ...(typeof body.streamUrl === "string" ? { streamUrl: body.streamUrl } : {})
  };
}

async function writeProofArtifact(root: string, proof: ProofBundle): Promise<string | undefined> {
  try {
    const runsDir = path.join(root, SETUP_DIR, EVENTS_DIR);
    await ensureDir(runsDir);
    const artifactPath = path.join(runsDir, `${safeTimestamp()}.proof.json`);
    await writeTextAtomic(artifactPath, `${JSON.stringify(proof, null, 2)}\n`);
    return artifactPath;
  } catch {
    return undefined;
  }
}

function httpRequest(
  options: RelaybaseCommandOptions,
  method: string,
  requestPath: string,
  body?: unknown,
  token?: string
): Promise<{ ok: boolean; statusCode: number; body: string }> {
  return daemonHttpRequest(options, method, requestPath, body, token);
}

interface SetupCommandSelection {
  command: string;
  source: "default" | "package-script" | "runtime-candidate";
  scriptName?: string;
  candidateId?: string;
}

function selectSetupCommand(detection: ProjectDetection, commandHint?: string): SetupCommandSelection {
  const defaultCommand = startCommandFor(detection);
  const normalizedHint = normalizeCommandHintText(commandHint);
  if (!normalizedHint) {
    return { command: defaultCommand, source: "default" };
  }
  const packageScript = packageScriptSelection(detection, normalizedHint);
  if (packageScript) {
    return packageScript;
  }
  const runtimeCandidate = runtimeCandidateSelection(detection, normalizedHint);
  if (runtimeCandidate) {
    return runtimeCandidate;
  }
  assertSafeSetupCommandHint(normalizedHint);
  throw new SetupSelectionError(
    "SETUP_COMMAND_HINT_UNSUPPORTED",
    `Unsupported setup command hint "${normalizedHint}". Relaybase only accepts detected package-manager scripts or runtime adapter command candidates.`,
    {
      detail: {
        commandHint: normalizedHint,
        packageScripts: Object.keys(detection.scripts),
        runtimeCandidates: detection.runtimeMatrix.runtimes.flatMap((runtime) =>
          runtime.startCommandCandidates.map((candidate) => candidate.commandPreview)
        )
      },
      userAction: "Use one of the detected package scripts or runtime command candidates from the setup plan."
    }
  );
}

function normalizeCommandHintText(commandHint?: string): string | undefined {
  const normalized = typeof commandHint === "string" ? commandHint.replace(/\s+/g, " ").trim() : "";
  return normalized || undefined;
}

function assertSafeSetupCommandHint(commandHint: string): void {
  const unsafe = [
    { pattern: /&&|\|\||\|/, label: "shell chaining or pipes" },
    { pattern: /(^|[^-])(;)/, label: "command separators" },
    { pattern: /[<>]/, label: "redirection" },
    { pattern: /\$\(|`/, label: "command substitution" }
  ].find((entry) => entry.pattern.test(commandHint));
  if (unsafe) {
    throw new SetupSelectionError(
      "SETUP_COMMAND_HINT_UNSAFE",
      `Unsafe setup command hint rejected: ${unsafe.label} is not allowed.`,
      {
        detail: { commandHint },
        userAction: "Use a single detected package-manager script or runtime adapter command without shell operators."
      }
    );
  }
}

function packageScriptSelection(detection: ProjectDetection, commandHint: string): SetupCommandSelection | undefined {
  const tokens = commandHint.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) {
    return undefined;
  }
  const scriptName = packageScriptNameFromTokens(tokens);
  if (!scriptName || !Object.prototype.hasOwnProperty.call(detection.scripts, scriptName)) {
    return undefined;
  }
  return {
    command: `${detection.packageCommand} ${runToken(detection.packageManager)} ${scriptName}`,
    source: "package-script",
    scriptName,
    candidateId: `package-script:${scriptName}`
  };
}

function packageScriptNameFromTokens(tokens: string[]): string | undefined {
  const lower = tokens.map((token) => token.toLowerCase());
  if (lower[0] === "corepack" || lower[0] === "corepack.cmd") {
    if (lower.length === 4 && ["pnpm", "yarn"].includes(lower[1] ?? "") && lower[2] === "run") {
      return tokens[3];
    }
    return undefined;
  }
  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.cmd"].includes(lower[0] ?? "")) {
    if (lower.length === 3 && lower[1] === "run" && tokens[2]) {
      return tokens[2];
    }
  }
  return undefined;
}

function runtimeCandidateSelection(
  detection: ProjectDetection,
  commandHint: string
): SetupCommandSelection | undefined {
  const normalized = normalizeComparableCommand(commandHint);
  for (const runtime of detection.runtimeMatrix.runtimes) {
    for (const candidate of runtime.startCommandCandidates) {
      const previews = [candidate.commandPreview, candidate.command.join(" ")].map(normalizeComparableCommand);
      if (previews.includes(normalized)) {
        return {
          command: candidate.commandPreview,
          source: "runtime-candidate",
          candidateId: candidate.id
        };
      }
    }
  }
  return undefined;
}

function normalizeComparableCommand(command: string): string {
  return command
    .replace(/<HOST>|\$HOST/gi, "HOST")
    .replace(/<PORT>|\$PORT/gi, "PORT")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function commandCandidatesWithSelection(
  candidates: StartCommandCandidate[],
  selection?: SetupCommandSelection
): StartCommandCandidate[] {
  if (!selection || selection.source === "default") {
    return candidates;
  }
  const selectedCandidate: StartCommandCandidate = {
    id: selection.candidateId ?? "selected-command",
    label: "Selected command",
    command: selection.command.split(/\s+/).filter(Boolean),
    commandPreview: selection.command,
    confidence: "high",
    reasons: ["Selected from the approved setup command hint."],
    risks: []
  };
  const rest = candidates.filter(
    (candidate) => candidate.commandPreview !== selection.command && candidate.id !== selectedCandidate.id
  );
  return [selectedCandidate, ...rest];
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
  requiresInput?: string[];
  commandSelection?: SetupCommandSelection;
  portStrategyHint?: string;
}): SetupPlan {
  const runtime = input.detection.primaryRuntime;
  const runtimeCandidates = runtime
    ? commandCandidatesWithSelection(runtime.startCommandCandidates, input.commandSelection)
    : undefined;
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
    recoverySteps: input.recoverySteps,
    selectedCommand: input.commandSelection?.command ?? String(input.manifest.command ?? ""),
    selectedCommandSource: input.commandSelection?.source ?? "default",
    ...(input.commandSelection?.candidateId ? { selectedCommandCandidateId: input.commandSelection.candidateId } : {}),
    ...(input.portStrategyHint ? { portStrategyHint: input.portStrategyHint } : {}),
    ...(input.requiresInput ? { requiresInput: input.requiresInput } : {}),
    ...(runtime
      ? {
          runtimeId: runtime.runtime,
          startCommandCandidates: runtimeCandidates,
          portBindingStrategies: runtime.portStrategies,
          runtimeHealthCandidates: runtime.healthCandidates,
          setupQuestions: runtime.questions,
          repairCandidates: runtime.repairCandidates
        }
      : {})
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
    ...(normalized.mcp ? { mcp: normalized.mcp } : {}),
    ...(normalized.relaybase ? { relaybase: normalized.relaybase } : {})
  };
}

function withSetupComponentMetadata(manifest: AppManifestInput, metadata: SetupComponentMetadata): AppManifestInput {
  return {
    ...manifest,
    ...(metadata.appId ? { id: metadata.appId } : {}),
    ...(metadata.name ? { name: metadata.name } : {}),
    ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
    ...(metadata.healthUrl ? { healthUrl: metadata.healthUrl } : {}),
    relaybase: {
      ...(manifest.relaybase ?? {}),
      ...(metadata.groupId ? { groupId: metadata.groupId } : {}),
      ...(metadata.componentRole ? { componentRole: metadata.componentRole } : {}),
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(metadata.paneLabel ? { paneLabel: metadata.paneLabel } : {}),
      ...(metadata.paneOrder !== undefined ? { paneOrder: metadata.paneOrder } : {})
    }
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

function launchWrapper(detection: ProjectDetection, scriptHint?: string): string {
  const script = scriptHint ?? (detection.scripts.dev ? "dev" : detection.scripts.start ? "start" : "");
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

function selectPlan(candidates: SetupPlan[], id?: string, portStrategyHint?: string): SetupPlan {
  if (!candidates.length) {
    throw new Error("Relaybase could not generate any setup plans for this project.");
  }
  const selected = id
    ? candidates.find((candidate) => candidate.id === id || candidate.architecture === id)
    : portStrategyHint
      ? candidates.find((candidate) => planHonorsPortStrategy(candidate, portStrategyHint))
      : candidates[0];
  if (!selected) {
    if (portStrategyHint) {
      throw new SetupSelectionError(
        "SETUP_PORT_STRATEGY_UNAVAILABLE",
        `Setup port strategy "${portStrategyHint}" is not available.`,
        {
          detail: {
            portStrategyHint,
            available: [...new Set(candidates.flatMap((candidate) => [...planPortStrategies(candidate)]))]
          },
          userAction: "Choose one of the port strategies returned by the setup plan."
        }
      );
    }
    return candidates[0];
  }
  if (portStrategyHint && !planHonorsPortStrategy(selected, portStrategyHint)) {
    throw new SetupSelectionError(
      "SETUP_PORT_STRATEGY_MISMATCH",
      `Selected setup plan "${selected.id}" cannot honor port strategy "${portStrategyHint}".`,
      {
        detail: { selectedPlanId: selected.id, portStrategyHint, available: [...planPortStrategies(selected)] },
        userAction: "Choose a compatible setup plan or remove the port strategy hint."
      }
    );
  }
  return selected;
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
    ...(selectedPlan.selectedCommand ? { selectedCommand: selectedPlan.selectedCommand } : {}),
    ...(selectedPlan.selectedCommandSource ? { selectedCommandSource: selectedPlan.selectedCommandSource } : {}),
    ...(selectedPlan.selectedCommandCandidateId
      ? { selectedCommandCandidateId: selectedPlan.selectedCommandCandidateId }
      : {}),
    ...(primaryPlanPortStrategy(selectedPlan) ? { portStrategy: primaryPlanPortStrategy(selectedPlan) } : {}),
    ...(selectedPlan.runtimeId
      ? {
          runtimeId: selectedPlan.runtimeId,
          runtimeCommandCandidates: selectedPlan.startCommandCandidates ?? [],
          runtimePortStrategies: selectedPlan.portBindingStrategies ?? [],
          runtimeHealthCandidates: selectedPlan.runtimeHealthCandidates ?? [],
          setupQuestions: selectedPlan.setupQuestions ?? []
        }
      : {}),
    createdAt: now,
    updatedAt: now
  };
}

function primaryPlanPortStrategy(plan: SetupPlan): string | undefined {
  return plan.portStrategyHint ?? [...planPortStrategies(plan)][0];
}

function planHonorsPortStrategy(plan: SetupPlan, portStrategyHint: string): boolean {
  if (portStrategyHint === "generated_launch_wrapper" || portStrategyHint === "framework_port_flags") {
    return plan.id === "framework-port-flag" || String(plan.manifest.command ?? "").includes(".relaybase/launch.cjs");
  }
  if (portStrategyHint === "fixed_upstream_port") {
    return plan.id === "pinned-upstream" || plan.manifest.upstreamPort !== undefined;
  }
  if (portStrategyHint === "docker_compose_wrapper" || portStrategyHint === "compose_port_mapping") {
    return plan.architecture === "docker-compose-service";
  }
  if (
    portStrategyHint === "managed_dynamic_port" ||
    portStrategyHint === "env_port" ||
    portStrategyHint === "runtime_specific_env"
  ) {
    return plan.architecture === "managed-dynamic-port";
  }
  return planPortStrategies(plan).has(portStrategyHint);
}

function planPortStrategies(plan: SetupPlan): Set<string> {
  const strategies = new Set<string>();
  for (const strategy of plan.portBindingStrategies ?? []) {
    strategies.add(strategy.id);
    if (strategy.id === "framework_port_flags") {
      strategies.add("generated_launch_wrapper");
    }
  }
  if (plan.manifest.upstreamPort !== undefined) {
    strategies.add("fixed_upstream_port");
  }
  if (plan.architecture === "managed-dynamic-port") {
    strategies.add("managed_dynamic_port");
    strategies.add("env_port");
  }
  if (plan.architecture === "framework-port-flag") {
    strategies.add("framework_port_flags");
    strategies.add("generated_launch_wrapper");
  }
  if (
    plan.architecture === "generated-launch-wrapper" ||
    String(plan.manifest.command).includes(".relaybase/launch.cjs")
  ) {
    strategies.add("generated_launch_wrapper");
  }
  if (plan.architecture === "docker-compose-service") {
    strategies.add("docker_compose_wrapper");
  }
  if (!strategies.size || plan.architecture === "mcp-only" || plan.architecture === "static-build-preview") {
    strategies.add("manual_custom");
  }
  return strategies;
}

function dockerAnswersFromPlan(selectedPlan: SetupPlan): DockerSetupOptions | undefined {
  const profileWrite = selectedPlan.writes.find((write) =>
    write.path.endsWith(path.join(".relaybase", "docker-profile.json"))
  );
  if (!profileWrite) {
    return undefined;
  }
  try {
    const profile = JSON.parse(profileWrite.preview) as DockerProfile;
    return {
      service: profile.selectedService,
      targetPort: profile.targetContainerPort,
      healthPath: profile.healthPath,
      startTimeoutMs: profile.timingsMs.pullBuild,
      healthTimeoutMs: profile.timingsMs.healthWait,
      stopTimeoutMs: profile.timingsMs.stop,
      dependencyPortPolicy: profile.dependencyPortPolicy,
      composeProfiles: profile.profiles,
      startDockerDesktop: profile.approvals.startDockerDesktop
    };
  } catch {
    return undefined;
  }
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
): Promise<{
  selectedPlanId?: string;
  envStrategy?: EnvStrategy;
  noStart?: boolean;
  docker?: DockerSetupOptions;
  commandHint?: string;
  portStrategyHint?: string;
  componentMetadata?: SetupComponentMetadata;
}> {
  if (!answersPath) {
    return {};
  }
  const resolved = path.resolve(cwd, answersPath);
  const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as Record<string, unknown>;
  return {
    ...(typeof parsed.selectedPlanId === "string" ? { selectedPlanId: parsed.selectedPlanId } : {}),
    ...(isEnvStrategy(parsed.envStrategy) ? { envStrategy: parsed.envStrategy } : {}),
    ...(typeof parsed.noStart === "boolean" ? { noStart: parsed.noStart } : {}),
    ...(typeof parsed.commandHint === "string" ? { commandHint: parsed.commandHint } : {}),
    ...(typeof parsed.portStrategyHint === "string" ? { portStrategyHint: parsed.portStrategyHint } : {}),
    ...(isSetupComponentMetadata(parsed.componentMetadata) ? { componentMetadata: parsed.componentMetadata } : {}),
    ...(isDockerSetupOptions(parsed.docker) ? { docker: parsed.docker } : {})
  };
}

function isEnvStrategy(value: unknown): value is EnvStrategy {
  return (
    value === "runtime-injection" || value === "env-relaybase-file" || value === "guarded-env-block" || value === "none"
  );
}

function isDockerSetupOptions(value: unknown): value is DockerSetupOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.service === undefined || typeof candidate.service === "string") &&
    (candidate.targetPort === undefined || validPort(candidate.targetPort)) &&
    (candidate.healthPath === undefined || typeof candidate.healthPath === "string") &&
    (candidate.startTimeoutMs === undefined || validTimeout(candidate.startTimeoutMs)) &&
    (candidate.healthTimeoutMs === undefined || validTimeout(candidate.healthTimeoutMs)) &&
    (candidate.stopTimeoutMs === undefined || validTimeout(candidate.stopTimeoutMs)) &&
    (candidate.dependencyPortPolicy === undefined ||
      candidate.dependencyPortPolicy === "internal-only" ||
      candidate.dependencyPortPolicy === "preserve-existing") &&
    (candidate.composeProfiles === undefined ||
      (Array.isArray(candidate.composeProfiles) &&
        candidate.composeProfiles.every((item) => typeof item === "string"))) &&
    (candidate.startDockerDesktop === undefined || typeof candidate.startDockerDesktop === "boolean")
  );
}

function isSetupComponentMetadata(value: unknown): value is SetupComponentMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.appId === undefined || typeof candidate.appId === "string") &&
    (candidate.name === undefined || typeof candidate.name === "string") &&
    (candidate.command === undefined || typeof candidate.command === "string") &&
    (candidate.cwd === undefined || typeof candidate.cwd === "string") &&
    (candidate.healthUrl === undefined || typeof candidate.healthUrl === "string") &&
    (candidate.groupId === undefined || typeof candidate.groupId === "string") &&
    (candidate.componentRole === undefined ||
      ["frontend", "backend", "worker", "database", "service", "other"].includes(String(candidate.componentRole))) &&
    (candidate.displayName === undefined || typeof candidate.displayName === "string") &&
    (candidate.paneLabel === undefined || typeof candidate.paneLabel === "string") &&
    (candidate.paneOrder === undefined || Number.isInteger(candidate.paneOrder))
  );
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
}

function validTimeout(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 3_600_000;
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
  if (detection.appKind === "mcp" && !detection.scripts.dev && !detection.scripts.start && !existingManifest) {
    score -= 30;
  }
  return score;
}

function scoreMcpOnly(detection: ProjectDetection): number {
  if (detection.appKind === "mcp" && !detection.scripts.dev && !detection.scripts.start) {
    return 85;
  }

  if (detection.appKind === "mcp") {
    return 60;
  }

  return 40;
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
  if (detection.appKind === "unknown" && !detection.primaryRuntime) {
    return "external";
  }
  const runtimeCommand = detection.primaryRuntime?.startCommandCandidates.find(
    (candidate) => candidate.confidence === "high" || candidate.confidence === "medium"
  );
  if (runtimeCommand && !/[&|<>;$`]/.test(runtimeCommand.commandPreview)) {
    return runtimeCommand.commandPreview;
  }
  if (detection.primaryRuntime && detection.primaryRuntime.runtime !== "javascript-typescript") {
    return "external";
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
  if (appKind === "docker") {
    return ["/api/health", "/health", "/"];
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
