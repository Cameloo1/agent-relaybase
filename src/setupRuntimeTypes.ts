export type RuntimeId =
  | "javascript-typescript"
  | "python"
  | "powershell"
  | "go"
  | "rust"
  | "java"
  | "kotlin-jvm"
  | "dotnet"
  | "ruby"
  | "php"
  | "elixir"
  | "scala"
  | "clojure"
  | "dart"
  | "native"
  | "docker-compose"
  | "procfile";

export type SetupConfidence = "high" | "medium" | "low" | "unsupported";

export interface RuntimeDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  detail?: unknown;
  userAction?: string;
}

export interface RuntimePackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

export interface RuntimeDetectionInput {
  root: string;
  files: string[];
  relativeFiles: string[];
  snippets: Record<string, string>;
  packageJson?: RuntimePackageJson;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  envFiles: string[];
  portEnvKeys: string[];
  detectedPorts: number[];
  dockerComposeFiles: string[];
}

export interface RuntimeDetector {
  id: RuntimeId;
  tier: 1 | 2;
  detect(
    input: RuntimeDetectionInput
  ): RuntimeDetectionResult | undefined | Promise<RuntimeDetectionResult | undefined>;
}

export interface RuntimeAdapter extends RuntimeDetector {
  version: number;
  plan(input: RuntimePlanInput): RuntimePlanResult | Promise<RuntimePlanResult>;
  verify(input: RuntimeVerifyInput): RuntimeVerifyObservation | Promise<RuntimeVerifyObservation>;
  repair(input: RuntimeRepairInput): RepairCandidate[] | Promise<RepairCandidate[]>;
}

export interface RuntimeVerifyInput {
  detection: RuntimeDetectionResult;
  assignedPort?: number;
  declaredHealthTarget?: string;
  successfulHealthTarget?: string;
  processStayedAlive: boolean;
}

export interface RuntimeVerifyObservation {
  adapterId: RuntimeId;
  adapterVersion: number;
  processStayedAlive: boolean;
  assignedPort?: number;
  declaredHealthTarget?: string;
  successfulHealthTarget?: string;
  healthCandidates: string[];
}

export interface RuntimePlanInput {
  detection: RuntimeDetectionResult;
  project: RuntimeDetectionInput;
}

export interface RuntimePlanResult {
  startCommandCandidates: StartCommandCandidate[];
  portStrategies: PortBindingStrategy[];
  healthCandidates: HealthCandidate[];
  questions: SetupQuestion[];
}

export interface RuntimeRepairInput {
  detection: RuntimeDetectionResult;
  reason?: string;
}

export interface RuntimeDetectionResult {
  adapterVersion: number;
  runtime: RuntimeId;
  label: string;
  tier: 1 | 2;
  confidence: SetupConfidence;
  detectionFiles: string[];
  buildToolIndicators: string[];
  serverIndicators: string[];
  startCommandCandidates: StartCommandCandidate[];
  portStrategies: PortBindingStrategy[];
  healthCandidates: HealthCandidate[];
  questions: SetupQuestion[];
  repairCandidates: RepairCandidate[];
  diagnostics: RuntimeDiagnostic[];
}

export interface StartCommandCandidate {
  id: string;
  label: string;
  command: string[];
  commandPreview: string;
  workingDirectory?: string;
  requiresTool?: string;
  confidence: SetupConfidence;
  reasons: string[];
  risks: string[];
}

export interface PortBindingStrategy {
  id:
    | "env_port"
    | "explicit_host_port_flags"
    | "framework_port_flags"
    | "generated_launch_wrapper"
    | "fixed_upstream_port"
    | "runtime_specific_env"
    | "compose_port_mapping"
    | "manual_custom";
  confidence: SetupConfidence;
  env?: Record<string, string>;
  args?: string[];
  wrapperKind?: string;
  diagnostics: RuntimeDiagnostic[];
}

export interface HealthCandidate {
  path: string;
  confidence: SetupConfidence;
  reason: string;
}

export interface SetupQuestion {
  id: string;
  prompt: string;
  required: boolean;
  choices?: Array<{ id: string; label: string; detail?: string }>;
}

export interface RepairCandidate {
  id: string;
  label: string;
  appliesTo: RuntimeId;
  previewOnly: boolean;
  approvalRequired: boolean;
  diagnostics: RuntimeDiagnostic[];
}

export interface FixtureBuilder {
  fixtureId: string;
  files: Record<string, string>;
  expectedDetection: Partial<RuntimeDetectionResult>;
}

export interface RuntimeMatrixSnapshot {
  version: 1;
  generatedAt: string;
  primaryRuntime?: RuntimeId;
  runtimes: RuntimeDetectionResult[];
  questions: SetupQuestion[];
  diagnostics: RuntimeDiagnostic[];
}
