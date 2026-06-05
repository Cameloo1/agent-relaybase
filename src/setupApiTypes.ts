import type { AppManifestInput, AppRecord, AppComponentRole } from "./types.ts";
import type {
  HealthCandidate,
  PortBindingStrategy,
  RepairCandidate,
  RuntimeDetectionResult,
  RuntimeId,
  RuntimeMatrixSnapshot,
  SetupConfidence,
  SetupQuestion,
  StartCommandCandidate
} from "./setupRuntimeTypes.ts";

export type PortStrategy =
  | "managed_dynamic_port"
  | "fixed_upstream_port"
  | "env_port"
  | "framework_port_flags"
  | "generated_launch_wrapper"
  | "docker_compose_wrapper"
  | "explicit_host_port_flags"
  | "runtime_specific_env"
  | "compose_port_mapping"
  | "manual_custom";

export type FrameworkKind = "generic" | "next" | "vite" | "astro" | "node" | "docker_compose" | "unknown";

export type PackageManagerKind = "npm" | "pnpm" | "yarn" | "bun" | "node" | "unknown";

export interface ComponentSetupMetadata {
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

export interface SetupApprovalRisk {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  requiresApproval: boolean;
}

export interface SetupDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  detail?: unknown;
  userAction?: string;
}

export interface SetupDetectRequest {
  cwd?: string;
  currentDirectory?: string;
}

export interface ExistingManifestAnalysis {
  path: string;
  exists: boolean;
  valid: boolean;
  app?: AppRecord;
  manifest?: AppManifestInput;
  diagnostics: SetupDiagnostic[];
  error?: string;
}

export interface ExistingSetupArtifactAnalysis {
  path: string;
  exists: boolean;
  kind: "launch_wrapper" | "setup_profile";
  valid: boolean;
  planId?: string;
  architecture?: string;
  diagnostics: SetupDiagnostic[];
  error?: string;
}

export interface SetupDetectResult {
  cwd: string;
  packageManager: PackageManagerKind;
  packageCommand: string;
  framework: FrameworkKind;
  appKind: string;
  scripts: Record<string, string>;
  envFiles: string[];
  portEnvKeys: string[];
  detectedPorts: number[];
  healthCandidates: string[];
  dockerComposeFiles: string[];
  mcpHints: string[];
  monorepoHints: string[];
  existingManifest?: ExistingManifestAnalysis;
  existingLaunchWrapper?: ExistingSetupArtifactAnalysis;
  existingSetupProfile?: ExistingSetupArtifactAnalysis;
  primaryRuntime?: RuntimeDetectionResult;
  runtimeMatrix?: RuntimeMatrixSnapshot;
  diagnostics: SetupDiagnostic[];
}

export interface SetupPlanRequest {
  cwd?: string;
  currentDirectory?: string;
  selectedPlanId?: string;
  profile?: string;
  runtimePreference?: RuntimeId;
  commandHint?: string;
  portStrategyHint?: PortStrategy;
  envStrategy?: "runtime-injection" | "env-relaybase-file" | "guarded-env-block" | "none";
  mcpInstall?: boolean;
  componentMetadata?: ComponentSetupMetadata;
  components?: ComponentSetupMetadata[];
  docker?: Record<string, unknown>;
}

export interface SetupPlanChoice {
  id: string;
  label: string;
  architecture: string;
  score: number;
  framework: FrameworkKind;
  packageManager: PackageManagerKind;
  portStrategies: PortStrategy[];
  runtimeId?: RuntimeId;
  runtimeConfidence?: SetupConfidence;
  runtimeStartCommandCandidates?: StartCommandCandidate[];
  runtimePortStrategies?: PortBindingStrategy[];
  runtimeHealthCandidates?: HealthCandidate[];
  setupQuestions?: SetupQuestion[];
  repairCandidates?: RepairCandidate[];
  selectedCommand?: string;
  selectedCommandSource?: string;
  selectedCommandCandidateId?: string;
  portStrategyHint?: PortStrategy;
  reasons: string[];
  risks: string[];
  recoverySteps: string[];
  requiresInput: string[];
}

export interface FileDiff {
  path: string;
  beforeExists: boolean;
  afterExists: boolean;
  changed: boolean;
  hunks: string[];
}

export interface FileWritePreview {
  path: string;
  action: "create" | "update" | "skip";
  reason: string;
  preview: string;
  diff: FileDiff;
}

export interface FileWritePlan {
  root: string;
  writes: FileWritePreview[];
  approvalRequired: boolean;
  risks: SetupApprovalRisk[];
}

export interface SetupPlan {
  id: string;
  label: string;
  architecture: string;
  score: number;
  manifest: AppManifestInput;
  choice: SetupPlanChoice;
  writes: FileWritePreview[];
}

export interface SetupPlanPreview {
  cwd: string;
  selectedPlan: SetupPlan;
  componentPlans?: SetupPlan[];
  choices: SetupPlanChoice[];
  fileWritePlan: FileWritePlan;
  diagnostics: SetupDiagnostic[];
}

export interface SetupApplyRequest extends SetupPlanRequest {
  repair?: boolean;
  confirm?: boolean;
  confirmation?: {
    confirmed?: boolean;
    reason?: string;
  };
}

export interface SetupApplyResult {
  cwd: string;
  selectedPlan: SetupPlanChoice;
  appliedFiles: Array<{ path: string; action: "created" | "updated" | "unchanged" | "skipped" }>;
  registeredApp?: AppRecord;
  verification: unknown;
  reportPath?: string;
  eventsPath?: string;
  diagnostics: SetupDiagnostic[];
}

export interface ManifestPatchRequest {
  cwd?: string;
  manifestPath?: string;
  patch: Record<string, unknown>;
  confirm?: boolean;
  confirmation?: {
    confirmed?: boolean;
    reason?: string;
  };
}

export interface ManifestPatchPlan {
  cwd: string;
  manifestPath: string;
  manifest: AppManifestInput;
  patchedManifest: AppManifestInput;
  fileWritePlan: FileWritePlan;
  diagnostics: SetupDiagnostic[];
}

export interface ManifestPatchResult {
  cwd: string;
  manifestPath: string;
  app: AppRecord;
  file: { path: string; action: "created" | "updated" | "unchanged" };
  diagnostics: SetupDiagnostic[];
}

export interface RegisterManifestRequest {
  cwd?: string;
  manifestPath: string;
}

export interface RegisterManifestResult {
  app: AppRecord;
  manifestPath: string;
}

export interface OpenProjectRequest {
  cwd?: string;
  currentDirectory?: string;
  noBrowser?: boolean;
  confirm?: boolean;
  confirmation?: {
    confirmed?: boolean;
    reason?: string;
  };
}

export interface OpenProjectPlan {
  cwd: string;
  approvalRequired: boolean;
  risks: SetupApprovalRisk[];
}

export interface OpenProjectResult {
  plan: OpenProjectPlan;
  result: unknown;
}

export interface ProveHealthRequest {
  cwd?: string;
  currentDirectory?: string;
  appId?: string;
  lifecycleProof?: boolean;
  confirm?: boolean;
  confirmation?: {
    confirmed?: boolean;
    reason?: string;
  };
}

export interface ProveHealthResult {
  cwd: string;
  result: unknown;
}

export interface RepairSetupRequest extends SetupPlanRequest {
  reason?: string;
}

export interface RepairSetupPlan {
  cwd: string;
  choices: SetupPlanChoice[];
  previews: SetupPlanPreview[];
  runtimeMatrix?: RuntimeMatrixSnapshot;
  repairCandidates?: RepairCandidate[];
  diagnostics: SetupDiagnostic[];
}

export interface RepairSetupResult {
  plan: RepairSetupPlan;
}
