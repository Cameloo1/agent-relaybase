import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppManifestInput } from "./types.ts";

export type DockerLifecycleState =
  | "docker_preflight"
  | "compose_configuring"
  | "pulling"
  | "building"
  | "creating"
  | "starting"
  | "waiting_for_containers"
  | "waiting_for_health"
  | "running"
  | "degraded"
  | "stopping"
  | "compose_down"
  | "verifying_cleanup"
  | "cleanup_failed"
  | "docker_unavailable"
  | "blocked_for_approval";

export type DockerDependencyPortPolicy = "internal-only" | "preserve-existing";

export type DockerErrorCode =
  | "docker_daemon_unavailable"
  | "docker_context_not_local"
  | "docker_permission_denied"
  | "docker_desktop_unavailable"
  | "compose_plugin_missing"
  | "compose_legacy_missing"
  | "compose_config_invalid"
  | "compose_env_missing"
  | "compose_profile_missing"
  | "dangerous_compose_config"
  | "image_pull_auth_failed"
  | "image_pull_rate_limited"
  | "image_pull_offline"
  | "build_failed"
  | "build_timeout"
  | "port_mapping_missing"
  | "port_conflict"
  | "stale_container_detected"
  | "stale_network_detected"
  | "service_exited"
  | "container_unhealthy"
  | "healthcheck_missing"
  | "route_unreachable"
  | "dependency_unhealthy"
  | "migration_failed"
  | "seed_failed"
  | "stop_timeout"
  | "cleanup_failed"
  | "stop_verification_failed"
  | "dependency_port_open"
  | "volume_cleanup_blocked"
  | "cancelled"
  | "unknown";

export interface DockerServicePort {
  raw: string;
  hostPort?: number;
  targetPort?: number;
  dynamicHost: boolean;
}

export interface DockerDangerFinding {
  code:
    | "privileged"
    | "docker_socket_mount"
    | "host_network"
    | "host_pid"
    | "host_ipc"
    | "broad_host_mount"
    | "public_bind"
    | "secret_like_env";
  severity: "warning" | "blocked";
  service?: string;
  message: string;
}

export interface DockerComposeServiceDetection {
  name: string;
  image?: string;
  build?: boolean;
  ports: DockerServicePort[];
  expose: number[];
  healthcheck: boolean;
  dependsOn: string[];
  profiles: string[];
  dangerousFindings: DockerDangerFinding[];
}

export interface DockerServiceCandidate {
  name: string;
  score: number;
  targetPort?: number;
  eligible: boolean;
  reasons: string[];
  rejectionReasons: string[];
}

export interface DockerServiceSelection {
  mode: "auto" | "explicit" | "required";
  confidence: "high" | "medium" | "low";
  reason: string;
  selectedService?: string;
  targetPort?: number;
  candidates: DockerServiceCandidate[];
}

export interface DockerComposeDetection {
  composeFiles: string[];
  envFiles: string[];
  services: DockerComposeServiceDetection[];
  serviceCandidates: DockerServiceCandidate[];
  selection: DockerServiceSelection;
  selectedService?: string;
  targetPort?: number;
  requiredServices: string[];
  optionalServices: string[];
  dependencyPorts: number[];
  dangerousFindings: DockerDangerFinding[];
  missingEnvVars: string[];
  privateImages: string[];
  hostPublishedPorts: number[];
  dynamicPublishedPorts: number[];
  suggestedProjectName: string;
}

export interface DockerProfile {
  version: 1;
  kind: "docker-compose";
  appId: string;
  generatedAt: string;
  composeProjectName: string;
  composeFiles: string[];
  overrideFile: string;
  profiles: string[];
  selectedService: string;
  targetContainerPort: number;
  healthPath: string;
  hostPortStrategy: "relaybase-assigned-port";
  dependencyPortPolicy: DockerDependencyPortPolicy;
  portExposurePolicy: "selected-service-localhost-only";
  portExposureVerification: "docker-compose-config";
  buildPolicy: "pull-build-with-approval";
  cleanupPolicy: "down-remove-orphans-keep-volumes";
  volumePolicy: "never-remove-by-default";
  migrationPolicy: "no-op-unless-approved";
  dependencyServices: string[];
  requiredServices: string[];
  optionalServices: string[];
  dependencyPorts: number[];
  serviceSelection: DockerServiceSelection;
  timingsMs: DockerTimingPolicy;
  retryBackoffMs: number[];
  lifecycleStates: DockerLifecycleState[];
  errorTaxonomy: DockerErrorCode[];
  approvals: DockerApprovalPolicy;
  artifacts: string[];
  retention: DockerRetentionPolicy;
  redactionKeys: string[];
  securityFindings: DockerDangerFinding[];
  missingEnvVars: string[];
  privateImages: string[];
}

export interface DockerTimingPolicy {
  dockerPreflight: number;
  composeConfig: number;
  pullBuild: number;
  containerStart: number;
  healthWait: number;
  routeWait: number;
  stop: number;
  cleanupVerification: number;
  portClosureWait: number;
}

export interface DockerApprovalPolicy {
  remoteContext: false;
  dangerousConfig: false;
  staleCleanup: false;
  pullBuild: false;
  startDockerDesktop: boolean;
  volumeRemoval: false;
  migrations: false;
}

export interface DockerRetentionPolicy {
  keepLastRuns: number;
  preserveFailedRuns: boolean;
  maxTotalBytes: number;
}

export interface DockerSetupWrite {
  path: string;
  action: "create" | "update" | "skip";
  reason: string;
  preview: string;
}

export interface DockerComposeSetup {
  profile: DockerProfile;
  manifest: AppManifestInput;
  writes: DockerSetupWrite[];
  reasons: string[];
  risks: string[];
  recoverySteps: string[];
}

export interface DockerSetupOptions {
  service?: string;
  targetPort?: number;
  healthPath?: string;
  startTimeoutMs?: number;
  healthTimeoutMs?: number;
  stopTimeoutMs?: number;
  dependencyPortPolicy?: DockerDependencyPortPolicy;
  composeProfiles?: string[];
  startDockerDesktop?: boolean;
}

export interface DockerFailureClassification {
  code: DockerErrorCode;
  message: string;
  phase: DockerLifecycleState | "unknown";
  retryable: boolean;
  requiresApproval: boolean;
  recommendedAction: string;
}

export const DOCKER_LIFECYCLE_STATES: DockerLifecycleState[] = [
  "docker_preflight",
  "compose_configuring",
  "pulling",
  "building",
  "creating",
  "starting",
  "waiting_for_containers",
  "waiting_for_health",
  "running",
  "degraded",
  "stopping",
  "compose_down",
  "verifying_cleanup",
  "cleanup_failed",
  "docker_unavailable",
  "blocked_for_approval"
];

export const DOCKER_ERROR_CODES: DockerErrorCode[] = [
  "docker_daemon_unavailable",
  "docker_context_not_local",
  "docker_permission_denied",
  "docker_desktop_unavailable",
  "compose_plugin_missing",
  "compose_legacy_missing",
  "compose_config_invalid",
  "compose_env_missing",
  "compose_profile_missing",
  "dangerous_compose_config",
  "image_pull_auth_failed",
  "image_pull_rate_limited",
  "image_pull_offline",
  "build_failed",
  "build_timeout",
  "port_mapping_missing",
  "port_conflict",
  "stale_container_detected",
  "stale_network_detected",
  "service_exited",
  "container_unhealthy",
  "healthcheck_missing",
  "route_unreachable",
  "dependency_unhealthy",
  "migration_failed",
  "seed_failed",
  "stop_timeout",
  "cleanup_failed",
  "stop_verification_failed",
  "dependency_port_open",
  "volume_cleanup_blocked",
  "cancelled",
  "unknown"
];

export const DOCKER_TIMINGS_MS: DockerTimingPolicy = {
  dockerPreflight: 10_000,
  composeConfig: 15_000,
  pullBuild: 600_000,
  containerStart: 120_000,
  healthWait: 300_000,
  routeWait: 60_000,
  stop: 60_000,
  cleanupVerification: 30_000,
  portClosureWait: 15_000
};

export const DOCKER_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000];

export const DOCKER_ARTIFACTS = [
  "docker-preflight.json",
  "compose-config.redacted.json",
  "compose-config.effective.json",
  "compose-port-exposure.json",
  "compose-services.json",
  "compose-ps.before.json",
  "compose-ps.after-start.json",
  "compose-ps.after-stop.json",
  "container-inspect.redacted.json",
  "container-health.json",
  "ports.before.json",
  "ports.after-start.json",
  "ports.after-stop.json",
  "compose-logs.<service>.log",
  "events.jsonl",
  "summary.json"
];

export const DOCKER_REDACTION_KEYS = [
  "token",
  "secret",
  "password",
  "passwd",
  "key",
  "credential",
  "auth",
  "cookie",
  "session",
  "connection_string",
  "database_url"
];

const DOCKER_PROFILE_FILE = path.join(".relaybase", "docker-profile.json");
const DOCKER_OVERRIDE_FILE = path.join(".relaybase", "docker-compose.relaybase.yml");
const PRESTART_SCRIPT = path.join(".relaybase", "scripts", "relaybase-prestart.ps1");
const START_SCRIPT = path.join(".relaybase", "scripts", "relaybase-start.ps1");
const STOP_SCRIPT = path.join(".relaybase", "scripts", "relaybase-stop.ps1");
const VERIFY_STOPPED_SCRIPT = path.join(".relaybase", "scripts", "relaybase-verify-stopped.ps1");

export async function detectDockerCompose(
  root: string,
  composeFiles: string[],
  envFiles: string[]
): Promise<DockerComposeDetection> {
  const services: DockerComposeServiceDetection[] = [];
  const dangerousFindings: DockerDangerFinding[] = [];
  const missingEnvVars = new Set<string>();
  const privateImages = new Set<string>();

  for (const file of composeFiles) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const variable of detectMissingEnvVars(text)) {
      missingEnvVars.add(variable);
    }
    const parsed = parseComposeServices(text);
    services.push(...parsed.services);
    parsed.dangerousFindings.forEach((finding) => dangerousFindings.push(finding));
  }

  for (const service of services) {
    for (const finding of service.dangerousFindings) {
      dangerousFindings.push(finding);
    }
    if (service.image && looksPrivateImage(service.image)) {
      privateImages.add(service.image);
    }
  }

  const serviceCandidates = services.map((service) => serviceCandidate(service));
  const selection = selectDockerService(serviceCandidates);
  const selectedService = selection.selectedService
    ? services.find((service) => service.name === selection.selectedService)
    : undefined;
  const targetPort = selection.targetPort;
  const hostPublishedPorts = [
    ...new Set(services.flatMap((service) => service.ports.flatMap((port) => (port.hostPort ? [port.hostPort] : []))))
  ];
  const dynamicPublishedPorts = [
    ...new Set(
      services.flatMap((service) =>
        service.ports.flatMap((port) => (port.dynamicHost && port.targetPort ? [port.targetPort] : []))
      )
    )
  ];
  const dependencyServices = services.filter((service) => service.name !== selectedService?.name);

  return {
    composeFiles,
    envFiles,
    services,
    serviceCandidates,
    selection,
    ...(selectedService ? { selectedService: selectedService.name } : {}),
    ...(targetPort ? { targetPort } : {}),
    requiredServices: [
      ...(selectedService ? [selectedService.name] : []),
      ...dependencyServices.filter((service) => service.healthcheck).map((service) => service.name)
    ],
    optionalServices: dependencyServices.filter((service) => !service.healthcheck).map((service) => service.name),
    dependencyPorts: [
      ...new Set(
        dependencyServices.flatMap((service) =>
          service.ports.flatMap((port) => (port.hostPort && port.hostPort > 0 ? [port.hostPort] : []))
        )
      )
    ],
    dangerousFindings: uniqueFindings(dangerousFindings),
    missingEnvVars: [...missingEnvVars].sort(),
    privateImages: [...privateImages].sort(),
    hostPublishedPorts,
    dynamicPublishedPorts,
    suggestedProjectName: `relaybase-${slug(path.basename(root))}`
  };
}

export function buildDockerComposeSetup(
  root: string,
  baseManifest: AppManifestInput,
  docker: DockerComposeDetection,
  options: DockerSetupOptions = {}
): DockerComposeSetup {
  const appId = String(baseManifest.id ?? slug(path.basename(root)));
  const resolved = resolveDockerSetup(docker, options);
  const timings = dockerTimings(options);
  const healthPath = String(options.healthPath ?? baseManifest.healthUrl ?? "/api/health");
  const selectedService = resolved.selectedService;
  const targetContainerPort = resolved.targetPort;
  const composeProjectName = docker.suggestedProjectName || `relaybase-${slug(appId)}`;
  const profile = dockerProfile(
    appId,
    composeProjectName,
    healthPath,
    selectedService,
    targetContainerPort,
    docker,
    root,
    timings,
    resolved.selection,
    options
  );
  const manifest: AppManifestInput = {
    ...baseManifest,
    command: psScriptCommand(START_SCRIPT),
    preStartCommand: psScriptCommand(PRESTART_SCRIPT),
    stopCommand: psScriptCommand(STOP_SCRIPT),
    verifyStoppedCommand: psScriptCommand(VERIFY_STOPPED_SCRIPT),
    preStartTimeoutMs: timings.dockerPreflight + timings.composeConfig,
    startTimeoutMs: timings.pullBuild,
    stopTimeoutMs: timings.stop,
    healthTimeoutMs: timings.healthWait,
    healthUrl: healthPath,
    upstreamPort: undefined
  };
  const writes: DockerSetupWrite[] = [
    {
      path: path.join(root, DOCKER_PROFILE_FILE),
      action: "create",
      reason:
        "Docker profile records the Compose lifecycle contract, timings, approvals, artifacts, and service selection.",
      preview: `${JSON.stringify(profile, null, 2)}\n`
    },
    {
      path: path.join(root, DOCKER_OVERRIDE_FILE),
      action: "create",
      reason:
        "Docker override injects Relaybase labels and maps Relaybase-assigned PORT to the selected service without editing app Compose files.",
      preview: dockerComposeOverride(profile)
    },
    {
      path: path.join(root, PRESTART_SCRIPT),
      action: "create",
      reason:
        "Docker prestart hook performs daemon, context, Compose config, stale container, danger, and port preflight checks.",
      preview: dockerLifecycleScript("prestart")
    },
    {
      path: path.join(root, START_SCRIPT),
      action: "create",
      reason: "Docker start hook runs Compose in the foreground so Relaybase owns logs and process lifecycle.",
      preview: dockerLifecycleScript("start")
    },
    {
      path: path.join(root, STOP_SCRIPT),
      action: "create",
      reason: "Docker stop hook runs compose down, keeps volumes, removes orphans, and verifies cleanup.",
      preview: dockerLifecycleScript("stop")
    },
    {
      path: path.join(root, VERIFY_STOPPED_SCRIPT),
      action: "create",
      reason: "Docker stop verification hook refuses fake stopped state when containers or owned ports survive.",
      preview: dockerLifecycleScript("verifyStopped")
    }
  ];

  return {
    profile,
    manifest,
    writes,
    reasons: [
      "Compose files are present; Relaybase can generate app-owned hooks while keeping Docker-specific logic out of the daemon.",
      resolved.selection.reason,
      "The generated override maps Relaybase's assigned PORT to the selected service and records Docker evidence under .relaybase/runs/.",
      "Stop success is gated on compose down, container cleanup, and owned port closure."
    ],
    risks: [
      ...(docker.missingEnvVars.length
        ? [`Compose requires env vars before config can pass: ${docker.missingEnvVars.join(", ")}.`]
        : []),
      ...(docker.dangerousFindings.length
        ? [
            `Compose contains risky settings that generated preflight will block until approved: ${docker.dangerousFindings.map((finding) => finding.code).join(", ")}.`
          ]
        : []),
      ...(docker.targetPort || options.targetPort
        ? []
        : [
            `Relaybase used target container port ${targetContainerPort}; rerun configure with --target-port if the user-facing service listens elsewhere.`
          ]),
      "Docker Desktop, registry auth, image pulls, and long builds can still block launch until the generated preflight evidence explains the failure."
    ],
    recoverySteps: [
      "If Docker is unavailable, retry a non-Docker setup architecture when the app also has package-manager scripts.",
      "If the selected service or target port is wrong, rerun configure and choose the correct Compose service/port.",
      "If cleanup fails, inspect .relaybase/runs/<run-id>/compose-ps.after-stop.json and rerun health before retrying."
    ]
  };
}

export async function readDockerProfile(root: string): Promise<DockerProfile | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, DOCKER_PROFILE_FILE), "utf8")) as DockerProfile;
  } catch {
    return undefined;
  }
}

export function classifyDockerFailure(input: string): DockerFailureClassification {
  const text = input.toLowerCase();
  if (
    /docker daemon|cannot connect.*docker|docker desktop.*not|pipe.*docker_engine|is the docker daemon running/.test(
      text
    )
  ) {
    return dockerFailure(
      "docker_daemon_unavailable",
      "docker_unavailable",
      true,
      false,
      "Start Docker Desktop or fix Docker daemon access, then retry."
    );
  }
  if (/permission denied|access is denied/.test(text)) {
    return dockerFailure(
      "docker_permission_denied",
      "docker_unavailable",
      false,
      true,
      "Fix Docker permissions or run from a shell with Docker access."
    );
  }
  if (/context.*remote|non-local docker context/.test(text)) {
    return dockerFailure(
      "docker_context_not_local",
      "blocked_for_approval",
      false,
      true,
      "Switch to a local Docker context or explicitly approve remote context use."
    );
  }
  if (/compose.*not.*(found|recognized)|not a docker command.*compose/.test(text)) {
    return dockerFailure(
      "compose_plugin_missing",
      "compose_configuring",
      false,
      false,
      "Install the Docker Compose plugin or allow legacy docker-compose fallback."
    );
  }
  if (/invalid compose|yaml|services.*must|failed to load/.test(text)) {
    return dockerFailure(
      "compose_config_invalid",
      "compose_configuring",
      false,
      false,
      "Fix the Compose file reported by docker compose config."
    );
  }
  if (/variable.*not set|required variable|missing env/.test(text)) {
    return dockerFailure(
      "compose_env_missing",
      "compose_configuring",
      false,
      false,
      "Provide the missing Compose env values or select an env-file profile."
    );
  }
  if (/unauthorized|authentication required|denied.*requested access/.test(text)) {
    return dockerFailure(
      "image_pull_auth_failed",
      "pulling",
      false,
      true,
      "Run docker login or approve an alternate image source."
    );
  }
  if (/toomanyrequests|rate limit/.test(text)) {
    return dockerFailure(
      "image_pull_rate_limited",
      "pulling",
      true,
      false,
      "Wait for registry rate limits to reset or authenticate Docker pulls."
    );
  }
  if (/network.*timeout|temporary failure|no such host|offline/.test(text)) {
    return dockerFailure(
      "image_pull_offline",
      "pulling",
      true,
      false,
      "Restore network access or run with images already present."
    );
  }
  if (/build.*failed|executor failed|failed to solve/.test(text)) {
    return dockerFailure(
      "build_failed",
      "building",
      false,
      false,
      "Inspect build logs and fix the Dockerfile or build context."
    );
  }
  if (/port.*allocated|bind.*address already in use|port is already allocated/.test(text)) {
    return dockerFailure(
      "port_conflict",
      "docker_preflight",
      false,
      true,
      "Identify the port owner; cleanup only Relaybase-owned stale containers automatically."
    );
  }
  if (/unhealthy|health.*failed/.test(text)) {
    return dockerFailure(
      "container_unhealthy",
      "waiting_for_health",
      true,
      false,
      "Inspect container health logs and dependency state."
    );
  }
  if (/route.*unreachable|connection refused|backend port is not open/.test(text)) {
    return dockerFailure(
      "route_unreachable",
      "waiting_for_health",
      true,
      false,
      "Verify host port mapping and the app health route."
    );
  }
  if (/down.*timeout|stop.*timeout/.test(text)) {
    return dockerFailure(
      "stop_timeout",
      "compose_down",
      true,
      false,
      "Retry stop once, then inspect surviving containers."
    );
  }
  if (/container.*still.*running|cleanup failed|port.*still open/.test(text)) {
    return dockerFailure(
      "cleanup_failed",
      "cleanup_failed",
      true,
      false,
      "Run health diagnostics and inspect cleanup evidence before retrying."
    );
  }
  return dockerFailure(
    "unknown",
    "unknown",
    false,
    true,
    "Inspect Docker evidence artifacts and retry with an approved recovery path."
  );
}

export function redactDockerText(text: string): string {
  let redacted = text;
  for (const key of DOCKER_REDACTION_KEYS) {
    const assignmentPattern = new RegExp(`(${escapeRegExp(key)}[^=:\\s]*\\s*[=:]\\s*)([^\\s"'\\n]+)`, "gi");
    redacted = redacted.replace(assignmentPattern, "$1[redacted]");
  }
  return redacted;
}

function dockerProfile(
  appId: string,
  composeProjectName: string,
  healthPath: string,
  selectedService: string,
  targetContainerPort: number,
  docker: DockerComposeDetection,
  root: string,
  timings: DockerTimingPolicy,
  serviceSelection: DockerServiceSelection,
  options: DockerSetupOptions
): DockerProfile {
  const dependencyPortPolicy = options.dependencyPortPolicy ?? "internal-only";
  const detectedDependencyServices = docker.services.filter((service) => service.name !== selectedService);
  const dependencyPorts = [
    ...new Set(
      detectedDependencyServices.flatMap((service) =>
        service.ports.flatMap((port) => (port.hostPort && port.hostPort > 0 ? [port.hostPort] : []))
      )
    )
  ];
  return {
    version: 1,
    kind: "docker-compose",
    appId,
    generatedAt: new Date().toISOString(),
    composeProjectName,
    composeFiles: docker.composeFiles.map((file) => relativePath(root, file)),
    overrideFile: relativePath(root, path.join(root, DOCKER_OVERRIDE_FILE)),
    profiles: options.composeProfiles ?? [],
    selectedService,
    targetContainerPort,
    healthPath,
    hostPortStrategy: "relaybase-assigned-port",
    dependencyPortPolicy,
    portExposurePolicy: "selected-service-localhost-only",
    portExposureVerification: "docker-compose-config",
    buildPolicy: "pull-build-with-approval",
    cleanupPolicy: "down-remove-orphans-keep-volumes",
    volumePolicy: "never-remove-by-default",
    migrationPolicy: "no-op-unless-approved",
    dependencyServices: detectedDependencyServices.map((service) => service.name),
    requiredServices: [
      selectedService,
      ...detectedDependencyServices.filter((service) => service.healthcheck).map((service) => service.name)
    ],
    optionalServices: detectedDependencyServices
      .filter((service) => !service.healthcheck)
      .map((service) => service.name),
    dependencyPorts: dependencyPortPolicy === "internal-only" ? dependencyPorts : [],
    serviceSelection,
    timingsMs: timings,
    retryBackoffMs: DOCKER_RETRY_BACKOFF_MS,
    lifecycleStates: DOCKER_LIFECYCLE_STATES,
    errorTaxonomy: DOCKER_ERROR_CODES,
    approvals: {
      remoteContext: false,
      dangerousConfig: false,
      staleCleanup: false,
      pullBuild: false,
      startDockerDesktop: options.startDockerDesktop === true,
      volumeRemoval: false,
      migrations: false
    },
    artifacts: DOCKER_ARTIFACTS,
    retention: {
      keepLastRuns: 20,
      preserveFailedRuns: true,
      maxTotalBytes: 50 * 1024 * 1024
    },
    redactionKeys: DOCKER_REDACTION_KEYS,
    securityFindings: docker.dangerousFindings,
    missingEnvVars: docker.missingEnvVars,
    privateImages: docker.privateImages
  };
}

function dockerComposeOverride(profile: DockerProfile): string {
  const lines = [
    "# Generated by Relaybase. Do not put secrets in this file.",
    "services:",
    `  ${profile.selectedService}:`,
    "    labels:",
    `      relaybase.app: ${quoteYaml(profile.appId)}`,
    `      relaybase.compose_project: ${quoteYaml(profile.composeProjectName)}`,
    "    ports:",
    `      - "127.0.0.1:\${PORT:-0}:${profile.targetContainerPort}"`,
    ""
  ];

  if (profile.dependencyPortPolicy === "internal-only") {
    for (const service of profile.dependencyServices) {
      lines.push(
        `  ${service}:`,
        "    labels:",
        `      relaybase.dependency: ${quoteYaml("true")}`,
        "    ports: !reset []",
        ""
      );
    }
  }

  return lines.join("\n");
}

function dockerLifecycleScript(kind: "prestart" | "start" | "stop" | "verifyStopped"): string {
  const action = {
    prestart: "Invoke-RelaybaseDockerPrestart",
    start: "Invoke-RelaybaseDockerStart",
    stop: "Invoke-RelaybaseDockerStop",
    verifyStopped: "Invoke-RelaybaseDockerVerifyStopped"
  }[kind];

  return `${dockerScriptCommon()}\n${action}\n`;
}

function dockerScriptCommon(): string {
  return String.raw`[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Get-RelaybaseRoot {
  return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

function Get-RelaybaseDockerProfile {
  $path = Join-Path (Get-RelaybaseRoot) ".relaybase\docker-profile.json"
  if (-not (Test-Path -LiteralPath $path)) {
    throw "docker profile not found: $path"
  }
  return (Get-Content -LiteralPath $path -Raw) | ConvertFrom-Json
}

function New-RelaybaseRunDir {
  $root = Get-RelaybaseRoot
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH-mm-ssZ")
  $path = Join-Path $root ".relaybase\runs\$stamp"
  New-Item -ItemType Directory -Path $path -Force | Out-Null
  return $path
}

function Write-RelaybaseEvent {
  param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [Parameter(Mandatory = $true)][string]$Phase,
    [string]$Message,
    $Details
  )
  $event = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString("o")
    phase = $Phase
    message = $Message
    details = $Details
  }
  ($event | ConvertTo-Json -Depth 30 -Compress) | Add-Content -LiteralPath (Join-Path $RunDir "events.jsonl") -Encoding UTF8
  Write-Host "[relaybase:docker:$Phase] $Message"
}

function ConvertTo-RedactedText {
  param([string]$Text)
  $redacted = $Text
  $keys = @("token", "secret", "password", "passwd", "key", "credential", "auth", "cookie", "session", "connection_string", "database_url")
  foreach ($key in $keys) {
    $redacted = [regex]::Replace($redacted, "($key[^=:\s]*\s*[=:]\s*)([^\s]+)", '$1[redacted]', "IgnoreCase")
  }
  return $redacted
}

function Save-RelaybaseJson {
  param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [Parameter(Mandatory = $true)][string]$Name,
    $Value
  )
  $json = $Value | ConvertTo-Json -Depth 40
  [System.IO.File]::WriteAllText((Join-Path $RunDir $Name), (ConvertTo-RedactedText $json), [System.Text.UTF8Encoding]::new($false))
}

function Get-ComposeBaseArgs {
  param($Profile)
  $args = @()
  foreach ($file in @($Profile.composeFiles)) {
    $args += @("-f", (Join-Path (Get-RelaybaseRoot) $file))
  }
  if ($Profile.overrideFile) {
    $args += @("-f", (Join-Path (Get-RelaybaseRoot) ([string]$Profile.overrideFile)))
  }
  foreach ($profileName in @($Profile.profiles)) {
    $args += @("--profile", ([string]$profileName))
  }
  $args += @("-p", ([string]$Profile.composeProjectName))
  return $args
}

function Invoke-RelaybaseDocker {
  param(
    [Parameter(Mandatory = $true)][string[]]$Args,
    [int]$TimeoutMs = 30000,
    [switch]$AllowFailure
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & docker @Args 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($null -eq $code) {
    $code = 1
  }
  $result = [pscustomobject]@{
    command = "docker $($Args -join ' ')"
    exitCode = $code
    output = ($output -join [Environment]::NewLine)
    ok = ($code -eq 0)
    timeoutMs = $TimeoutMs
  }
  if ($code -ne 0 -and -not $AllowFailure) {
    throw "$($result.command) failed with exit code $code. $($result.output)"
  }
  return $result
}

function Invoke-RelaybaseDockerStream {
  param(
    [Parameter(Mandatory = $true)][string[]]$Args
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & docker @Args
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($null -eq $code) {
    $code = 1
  }
  if ($code -ne 0) {
    throw "docker $($Args -join ' ') failed with exit code $code."
  }
}

function Invoke-RelaybaseCompose {
  param(
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][string[]]$Args,
    [switch]$AllowFailure
  )
  $baseArgs = Get-ComposeBaseArgs -Profile $Profile
  return Invoke-RelaybaseDocker -Args (@("compose") + $baseArgs + $Args) -AllowFailure:$AllowFailure
}

function Invoke-RelaybaseComposeStream {
  param(
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][string[]]$Args
  )
  $baseArgs = Get-ComposeBaseArgs -Profile $Profile
  Invoke-RelaybaseDockerStream -Args (@("compose") + $baseArgs + $Args)
}

function Start-RelaybaseDockerDesktopIfApproved {
  param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [Parameter(Mandatory = $true)]$Profile
  )
  if (-not $IsWindows -and $env:OS -ne "Windows_NT") { return }
  if (-not [bool]$Profile.approvals.startDockerDesktop) { return }
  $programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  $candidates = @(
    "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe",
    "$programFilesX86\Docker\Docker\Docker Desktop.exe",
    "$env:LocalAppData\Docker\Docker Desktop.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $desktop = $candidates | Select-Object -First 1
  if (-not $desktop) { return }
  Write-RelaybaseEvent -RunDir $RunDir -Phase "docker_preflight" -Message "Starting Docker Desktop because the profile approved daemon recovery." -Details @{ path = $desktop }
  Start-Process -FilePath $desktop -WindowStyle Minimized | Out-Null
}

function Test-RelaybaseDockerDaemon {
  param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [Parameter(Mandatory = $true)]$Profile
  )
  $deadline = [DateTimeOffset]::Now.AddMilliseconds([int]$Profile.timingsMs.dockerPreflight)
  $last = $null
  while ([DateTimeOffset]::Now -lt $deadline) {
    $last = Invoke-RelaybaseDocker -Args @("info", "--format", "{{json .}}") -AllowFailure
    if ($last.ok) {
      Save-RelaybaseJson -RunDir $RunDir -Name "docker-preflight.json" -Value $last
      return $last
    }
    Start-RelaybaseDockerDesktopIfApproved -RunDir $RunDir -Profile $Profile
    Start-Sleep -Milliseconds 1000
  }
  Save-RelaybaseJson -RunDir $RunDir -Name "docker-preflight.json" -Value $last
  throw "docker_daemon_unavailable: Docker daemon did not become available within $($Profile.timingsMs.dockerPreflight)ms."
}

function Test-RelaybaseDockerContext {
  param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [Parameter(Mandatory = $true)]$Profile
  )
  $context = Invoke-RelaybaseDocker -Args @("context", "show") -AllowFailure
  Save-RelaybaseJson -RunDir $RunDir -Name "docker-context.json" -Value $context
  if ($context.ok -and $context.output -match "ssh://|tcp://|remote") {
    if (-not [bool]$Profile.approvals.remoteContext) {
      throw "docker_context_not_local: Docker context appears remote and requires approval."
    }
  }
}

function Test-RelaybaseComposeConfig {
  param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [Parameter(Mandatory = $true)]$Profile
  )
  $version = Invoke-RelaybaseDocker -Args @("compose", "version") -AllowFailure
  if (-not $version.ok) {
    throw "compose_plugin_missing: Docker Compose plugin is unavailable."
  }
  $config = Invoke-RelaybaseCompose -Profile $Profile -Args @("config") -AllowFailure
  Save-RelaybaseJson -RunDir $RunDir -Name "compose-config.redacted.json" -Value $config
  if (-not $config.ok) {
    throw "compose_config_invalid: docker compose config failed. $($config.output)"
  }
  $effective = Invoke-RelaybaseCompose -Profile $Profile -Args @("config", "--format", "json") -AllowFailure
  Save-RelaybaseJson -RunDir $RunDir -Name "compose-config.effective.json" -Value $effective
  Test-RelaybasePortExposure -RunDir $RunDir -Profile $Profile -ConfigJson $effective
  return $config
}

function Test-RelaybasePortExposure {
  param(
    [Parameter(Mandatory = $true)][string]$RunDir,
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)]$ConfigJson
  )
  $summary = [ordered]@{
    checked = $false
    selectedService = $Profile.selectedService
    targetContainerPort = $Profile.targetContainerPort
    dependencyPortPolicy = $Profile.dependencyPortPolicy
    selectedPortMapped = $false
    dependencyPublishedPorts = @()
    violations = @()
  }
  if (-not $ConfigJson.ok) {
    $summary.violations += "compose_config_json_unavailable"
    Save-RelaybaseJson -RunDir $RunDir -Name "compose-port-exposure.json" -Value $summary
    return
  }
  try {
    $config = $ConfigJson.output | ConvertFrom-Json -Depth 100
  } catch {
    $summary.violations += "compose_config_json_parse_failed"
    Save-RelaybaseJson -RunDir $RunDir -Name "compose-port-exposure.json" -Value $summary
    return
  }
  $summary.checked = $true
  foreach ($service in @($config.services.PSObject.Properties)) {
    $serviceName = [string]$service.Name
    foreach ($port in @($service.Value.ports)) {
      $target = [string]$port.target
      $published = [string]$port.published
      $hostIp = [string]$port.host_ip
      if ($serviceName -eq [string]$Profile.selectedService) {
        if ($target -eq [string]$Profile.targetContainerPort) {
          $summary.selectedPortMapped = $true
          if ($hostIp -and $hostIp -ne "127.0.0.1") {
            $summary.violations += "selected_service_not_localhost_bound"
          }
        }
      } elseif ([string]$Profile.dependencyPortPolicy -eq "internal-only" -and $published) {
        $summary.dependencyPublishedPorts += [pscustomobject]@{ service = $serviceName; target = $target; published = $published; hostIp = $hostIp }
      }
    }
  }
  if (-not $summary.selectedPortMapped) {
    $summary.violations += "selected_service_port_mapping_missing"
  }
  if (@($summary.dependencyPublishedPorts).Count -gt 0) {
    $summary.violations += "dependency_ports_published"
  }
  Save-RelaybaseJson -RunDir $RunDir -Name "compose-port-exposure.json" -Value $summary
  if ($summary.violations -contains "selected_service_port_mapping_missing") {
    throw "port_mapping_missing: selected service $($Profile.selectedService) does not publish target port $($Profile.targetContainerPort) in the effective Compose config."
  }
  if ($summary.violations -contains "dependency_ports_published") {
    throw "dependency_port_open: dependency services still publish host ports in the effective Compose config."
  }
  if ($summary.violations -contains "selected_service_not_localhost_bound") {
    throw "dangerous_compose_config: selected service is not bound to 127.0.0.1 in the effective Compose config."
  }
}

function Test-RelaybaseDangerousConfig {
  param(
    [Parameter(Mandatory = $true)]$Profile
  )
  $blocked = @($Profile.securityFindings) | Where-Object { $_.severity -eq "blocked" }
  if ($blocked.Count -gt 0 -and -not [bool]$Profile.approvals.dangerousConfig) {
    $codes = ($blocked | ForEach-Object { $_.code }) -join ", "
    throw "dangerous_compose_config: blocked Compose settings require approval: $codes"
  }
}

function Get-RelaybaseComposePs {
  param(
    [Parameter(Mandatory = $true)]$Profile,
    [switch]$AllowFailure
  )
  $result = Invoke-RelaybaseCompose -Profile $Profile -Args @("ps", "--format", "json") -AllowFailure:$AllowFailure
  return $result
}

function Test-RelaybaseTcpPort {
  param([int]$Port)
  if (-not $Port) { return $false }
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1000, $false)) {
      return $false
    }
    $client.EndConnect($async)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-RelaybaseOwnedPortsClosed {
  param(
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][string]$RunDir
  )
  $ports = @()
  if ($env:PORT) { $ports += [int]$env:PORT }
  foreach ($port in @($Profile.dependencyPorts)) { $ports += [int]$port }
  $checks = @()
  foreach ($port in ($ports | Select-Object -Unique)) {
    $open = Test-RelaybaseTcpPort -Port $port
    $checks += [pscustomobject]@{ port = $port; open = $open }
  }
  Save-RelaybaseJson -RunDir $RunDir -Name "ports.after-stop.json" -Value $checks
  $survivor = $checks | Where-Object { $_.open } | Select-Object -First 1
  if ($survivor) {
    throw "dependency_port_open: owned port $($survivor.port) is still open after stop."
  }
}

function Assert-RelaybaseCleanup {
  param(
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][string]$RunDir
  )
  $ps = Get-RelaybaseComposePs -Profile $Profile -AllowFailure
  Save-RelaybaseJson -RunDir $RunDir -Name "compose-ps.after-stop.json" -Value $ps
  if ($ps.ok -and $ps.output.Trim().Length -gt 2) {
    throw "cleanup_failed: docker compose ps still reports containers after down."
  }
  Test-RelaybaseOwnedPortsClosed -Profile $Profile -RunDir $RunDir
}

function Invoke-RelaybaseDockerPrestart {
  $profile = Get-RelaybaseDockerProfile
  $runDir = New-RelaybaseRunDir
  Write-RelaybaseEvent -RunDir $runDir -Phase "docker_preflight" -Message "Starting Docker preflight." -Details @{ project = $profile.composeProjectName }
  Test-RelaybaseDockerDaemon -RunDir $runDir -Profile $profile | Out-Null
  Test-RelaybaseDockerContext -RunDir $runDir -Profile $profile
  Test-RelaybaseDangerousConfig -Profile $profile
  Test-RelaybaseComposeConfig -RunDir $runDir -Profile $profile | Out-Null
  $ps = Get-RelaybaseComposePs -Profile $profile -AllowFailure
  Save-RelaybaseJson -RunDir $runDir -Name "compose-ps.before.json" -Value $ps
  if ($env:PORT -and (Test-RelaybaseTcpPort -Port ([int]$env:PORT))) {
    throw "port_conflict: Relaybase assigned port $env:PORT is already open before Docker start."
  }
  Save-RelaybaseJson -RunDir $runDir -Name "ports.before.json" -Value @(@{ port = $env:PORT; open = $false })
  Write-RelaybaseEvent -RunDir $runDir -Phase "compose_configuring" -Message "Docker preflight passed." -Details @{ selectedService = $profile.selectedService }
}

function Invoke-RelaybaseDockerStart {
  $profile = Get-RelaybaseDockerProfile
  $runDir = New-RelaybaseRunDir
  Write-RelaybaseEvent -RunDir $runDir -Phase "building" -Message "Starting docker compose up." -Details @{ project = $profile.composeProjectName; service = $profile.selectedService; port = $env:PORT }
  $args = @("up", "--build", "--remove-orphans")
  Invoke-RelaybaseComposeStream -Profile $profile -Args $args
}

function Invoke-RelaybaseDockerStop {
  $profile = Get-RelaybaseDockerProfile
  $runDir = New-RelaybaseRunDir
  Write-RelaybaseEvent -RunDir $runDir -Phase "stopping" -Message "Stopping Docker Compose project." -Details @{ project = $profile.composeProjectName }
  $before = Get-RelaybaseComposePs -Profile $profile -AllowFailure
  Save-RelaybaseJson -RunDir $runDir -Name "compose-ps.before-stop.json" -Value $before
  $timeoutSeconds = [Math]::Max(1, [Math]::Ceiling(([double]$profile.timingsMs.stop) / 1000))
  Invoke-RelaybaseComposeStream -Profile $profile -Args @("down", "--remove-orphans", "--timeout", "$timeoutSeconds")
  Write-RelaybaseEvent -RunDir $runDir -Phase "verifying_cleanup" -Message "Verifying Docker cleanup." -Details $null
  Assert-RelaybaseCleanup -Profile $profile -RunDir $runDir
}

function Invoke-RelaybaseDockerVerifyStopped {
  $profile = Get-RelaybaseDockerProfile
  $runDir = New-RelaybaseRunDir
  Write-RelaybaseEvent -RunDir $runDir -Phase "verifying_cleanup" -Message "Verifying Docker project is stopped." -Details @{ project = $profile.composeProjectName }
  Assert-RelaybaseCleanup -Profile $profile -RunDir $runDir
}
`;
}

function parseComposeServices(text: string): {
  services: DockerComposeServiceDetection[];
  dangerousFindings: DockerDangerFinding[];
} {
  const lines = text.split(/\r?\n/);
  const services: DockerComposeServiceDetection[] = [];
  const dangerousFindings: DockerDangerFinding[] = [];
  let inServices = false;
  let current: DockerComposeServiceDetection | undefined;
  let section: "ports" | "expose" | "depends_on" | "profiles" | undefined;

  for (const line of lines) {
    const indent = line.search(/\S|$/);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (/^services:\s*$/.test(trimmed)) {
      inServices = true;
      continue;
    }
    if (inServices && indent === 0 && !/^services:\s*$/.test(trimmed)) {
      inServices = false;
      current = undefined;
      section = undefined;
    }
    if (!inServices) {
      continue;
    }
    const serviceMatch = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*$/);
    if (serviceMatch) {
      current = {
        name: serviceMatch[1] ?? "service",
        ports: [],
        expose: [],
        healthcheck: false,
        dependsOn: [],
        profiles: [],
        dangerousFindings: []
      };
      services.push(current);
      section = undefined;
      continue;
    }
    if (!current) {
      continue;
    }
    const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1] ?? "";
      const value = stripQuotes(keyMatch[2] ?? "");
      section = undefined;
      if (key === "image") {
        current.image = value;
      } else if (key === "build") {
        current.build = true;
      } else if (key === "healthcheck") {
        current.healthcheck = true;
      } else if (key === "ports") {
        section = "ports";
        current.ports.push(...parseInlinePorts(value));
      } else if (key === "expose") {
        section = "expose";
        current.expose.push(...numbers(value));
      } else if (key === "depends_on") {
        section = "depends_on";
        current.dependsOn.push(...words(value));
      } else if (key === "profiles") {
        section = "profiles";
        current.profiles.push(...words(value));
      } else if (key === "privileged" && /true/i.test(value)) {
        current.dangerousFindings.push(
          finding("privileged", "blocked", current.name, "Privileged containers require explicit approval.")
        );
      } else if (key === "network_mode" && /host/i.test(value)) {
        current.dangerousFindings.push(
          finding("host_network", "blocked", current.name, "Host networking bypasses Relaybase port ownership.")
        );
      } else if (key === "pid" && /host/i.test(value)) {
        current.dangerousFindings.push(
          finding("host_pid", "blocked", current.name, "Host PID namespace requires explicit approval.")
        );
      } else if (key === "ipc" && /host/i.test(value)) {
        current.dangerousFindings.push(
          finding("host_ipc", "blocked", current.name, "Host IPC namespace requires explicit approval.")
        );
      } else if (/environment|env/i.test(key) && /token|secret|password|credential|database_url/i.test(value)) {
        current.dangerousFindings.push(
          finding(
            "secret_like_env",
            "warning",
            current.name,
            "Compose env appears to contain secret-like values; logs will redact them."
          )
        );
      }
    } else if (trimmed.startsWith("-")) {
      const item = stripQuotes(trimmed.replace(/^-\s*/, ""));
      if (section === "ports") {
        current.ports.push(...parseInlinePorts(item));
      } else if (section === "expose") {
        current.expose.push(...numbers(item));
      } else if (section === "depends_on") {
        current.dependsOn.push(...words(item));
      } else if (section === "profiles") {
        current.profiles.push(...words(item));
      }
    }
    if (/docker\.sock/.test(trimmed)) {
      current.dangerousFindings.push(
        finding(
          "docker_socket_mount",
          "blocked",
          current.name,
          "Docker socket mounts can control the host Docker daemon."
        )
      );
    }
    if (/(^|[\s"'])\/:\/|[A-Za-z]:\\:/.test(trimmed)) {
      current.dangerousFindings.push(
        finding("broad_host_mount", "warning", current.name, "Broad host bind mounts need careful review.")
      );
    }
    if (/0\.0\.0\.0:\d/.test(trimmed)) {
      current.dangerousFindings.push(
        finding(
          "public_bind",
          "warning",
          current.name,
          "Published ports should bind to 127.0.0.1 for local Relaybase apps."
        )
      );
    }
  }

  return { services, dangerousFindings };
}

function parseInlinePorts(value: string): DockerServicePort[] {
  const values = value.startsWith("[") ? value.replace(/^\[|\]$/g, "").split(",") : [value];
  const ports: DockerServicePort[] = [];
  for (const rawValue of values.map((entry) => stripQuotes(entry.trim())).filter(Boolean)) {
    const targetMatch = rawValue.match(/target:\s*(\d+)/);
    const publishedMatch = rawValue.match(/published:\s*(\d+)/);
    if (targetMatch) {
      ports.push({
        raw: rawValue,
        targetPort: Number(targetMatch[1]),
        ...(publishedMatch ? { hostPort: Number(publishedMatch[1]) } : {}),
        dynamicHost: !publishedMatch || publishedMatch[1] === "0"
      });
      continue;
    }
    const segments = rawValue.split(":").map((segment) => segment.trim());
    const numeric = segments.flatMap((segment) => (/^\d+$/.test(segment) ? [Number(segment)] : []));
    if (!numeric.length) {
      continue;
    }
    const targetPort = numeric[numeric.length - 1];
    const hostPort = numeric.length > 1 ? numeric[numeric.length - 2] : undefined;
    ports.push({
      raw: rawValue,
      ...(hostPort ? { hostPort } : {}),
      ...(targetPort ? { targetPort } : {}),
      dynamicHost: hostPort === undefined || hostPort === 0
    });
  }
  return ports;
}

function resolveDockerSetup(
  docker: DockerComposeDetection,
  options: DockerSetupOptions
): { selectedService: string; targetPort: number; selection: DockerServiceSelection } {
  if (options.service) {
    const service = docker.services.find((candidate) => candidate.name === options.service);
    if (!service) {
      throw new Error(
        `Docker service "${options.service}" was not found. Available services: ${docker.services.map((item) => item.name).join(", ") || "none"}.`
      );
    }
    const targetPort = options.targetPort ?? selectTargetPort(service);
    if (!targetPort) {
      throw new Error(
        `Docker service "${options.service}" needs --target-port because no HTTP target port was detected.`
      );
    }
    return {
      selectedService: service.name,
      targetPort,
      selection: {
        mode: "explicit",
        confidence: "high",
        reason: `Selected ${service.name}:${targetPort} from explicit setup input.`,
        selectedService: service.name,
        targetPort,
        candidates: docker.serviceCandidates
      }
    };
  }

  if (docker.selectedService && docker.targetPort) {
    return {
      selectedService: docker.selectedService,
      targetPort: docker.targetPort,
      selection: docker.selection
    };
  }

  throw new Error(
    "Docker service selection required. Pass --service <name> and --target-port <port>, or use the interactive configure flow."
  );
}

function dockerTimings(options: DockerSetupOptions): DockerTimingPolicy {
  return {
    ...DOCKER_TIMINGS_MS,
    ...(validTimeout(options.startTimeoutMs) ? { pullBuild: Number(options.startTimeoutMs) } : {}),
    ...(validTimeout(options.healthTimeoutMs) ? { healthWait: Number(options.healthTimeoutMs) } : {}),
    ...(validTimeout(options.stopTimeoutMs) ? { stop: Number(options.stopTimeoutMs) } : {})
  };
}

function validTimeout(value: number | undefined): boolean {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 3_600_000;
}

function selectDockerService(candidates: DockerServiceCandidate[]): DockerServiceSelection {
  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const eligible = ranked.filter((candidate) => candidate.eligible);
  const top = eligible[0];
  const second = eligible[1];
  if (!top) {
    return {
      mode: "required",
      confidence: "low",
      reason: "No Compose service looked like a safe HTTP app entrypoint; explicit service selection is required.",
      candidates
    };
  }
  if (top.score < 100) {
    return {
      mode: "required",
      confidence: "medium",
      reason: `Best candidate ${top.name} scored ${top.score}, below Relaybase's automatic-selection threshold.`,
      candidates
    };
  }
  if (second && top.score - second.score < 25) {
    return {
      mode: "required",
      confidence: "medium",
      reason: `Compose service selection is ambiguous between ${top.name} and ${second.name}; explicit service selection is required.`,
      candidates
    };
  }
  return {
    mode: "auto",
    confidence: "high",
    reason: `Selected ${top.name}:${top.targetPort} because it is the only high-confidence HTTP entrypoint.`,
    selectedService: top.name,
    targetPort: top.targetPort,
    candidates
  };
}

function serviceCandidate(service: DockerComposeServiceDetection): DockerServiceCandidate {
  const reasons: string[] = [];
  const rejectionReasons: string[] = [];
  const targetPort = selectTargetPort(service);
  const score = scoreService(service);

  if (service.ports.length) {
    reasons.push("publishes at least one port");
  }
  if (service.expose.length) {
    reasons.push("exposes an internal port");
  }
  if (service.healthcheck) {
    reasons.push("declares a Compose healthcheck");
  }
  if (/web|app|front|frontend|ui|api|server/i.test(service.name)) {
    reasons.push("service name looks app-facing");
  }
  if (isInfrastructureService(service.name)) {
    rejectionReasons.push("service name looks like infrastructure, storage, cache, queue, or worker");
  }
  if (!targetPort) {
    rejectionReasons.push("no HTTP target port was detected");
  }

  return {
    name: service.name,
    score,
    ...(targetPort ? { targetPort } : {}),
    eligible: Boolean(targetPort) && !isInfrastructureService(service.name),
    reasons,
    rejectionReasons
  };
}

function scoreService(service: DockerComposeServiceDetection): number {
  let score = 0;
  if (service.ports.length) {
    score += 80;
  }
  if (service.expose.length) {
    score += 30;
  }
  if (service.healthcheck) {
    score += 25;
  }
  if (/web|app|front|frontend|ui|api|server/i.test(service.name)) {
    score += 20;
  }
  if (isInfrastructureService(service.name)) {
    score -= 40;
  }
  return score;
}

function isInfrastructureService(name: string): boolean {
  return /db|database|postgres|mysql|mariadb|mongo|redis|cache|minio|s3|worker|queue|cron|job|search|elastic|opensearch/i.test(
    name
  );
}

function selectTargetPort(service: DockerComposeServiceDetection): number | undefined {
  return service.ports.find((port) => port.targetPort)?.targetPort ?? service.expose[0];
}

function detectMissingEnvVars(text: string): string[] {
  const required = [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?|:\?)[^}]*}/g)].map((match) => match[1] ?? "");
  return [...new Set(required.filter(Boolean))].sort();
}

function looksPrivateImage(image: string): boolean {
  const registry = image.split("/")[0] ?? "";
  return image.includes("/") && (registry.includes(".") || registry.includes(":"));
}

function finding(
  code: DockerDangerFinding["code"],
  severity: DockerDangerFinding["severity"],
  service: string | undefined,
  message: string
): DockerDangerFinding {
  return { code, severity, ...(service ? { service } : {}), message };
}

function uniqueFindings(findings: DockerDangerFinding[]): DockerDangerFinding[] {
  const seen = new Set<string>();
  return findings.filter((item) => {
    const key = `${item.code}:${item.service ?? ""}:${item.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function numbers(value: string): number[] {
  return [...value.matchAll(/\d+/g)].map((match) => Number(match[0])).filter((number) => number > 0 && number <= 65535);
}

function words(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+/)
    .map(stripQuotes)
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "app"
  );
}

function quoteYaml(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function relativePath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function psScriptCommand(scriptPath: string): string {
  return `.${path.sep}${scriptPath.split(path.sep).join(path.sep)}`;
}

function dockerFailure(
  code: DockerErrorCode,
  phase: DockerFailureClassification["phase"],
  retryable: boolean,
  requiresApproval: boolean,
  recommendedAction: string
): DockerFailureClassification {
  return {
    code,
    phase,
    retryable,
    requiresApproval,
    recommendedAction,
    message: code.replace(/_/g, " ")
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
