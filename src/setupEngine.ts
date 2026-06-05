export {
  configureProject,
  detectProject,
  healthProject,
  openProject,
  proposeSetupPlans,
  SetupSelectionError,
  type ConfigureProjectOptions,
  type ConfigureProjectResult,
  type EnvStrategy,
  type HealthCheckResult,
  type HealthProjectOptions,
  type OpenProjectOptions,
  type OpenProjectResult,
  type ProjectDetection,
  type SetupArchitecture,
  type SetupPlan
} from "./setup.ts";
export type {
  HealthCandidate,
  PortBindingStrategy,
  RepairCandidate,
  RuntimeAdapter,
  RuntimeDetector,
  RuntimeDetectionResult,
  RuntimeId,
  RuntimeMatrixSnapshot,
  SetupConfidence,
  SetupQuestion,
  StartCommandCandidate
} from "./setupRuntimeTypes.ts";
