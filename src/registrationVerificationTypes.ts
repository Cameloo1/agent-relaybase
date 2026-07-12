import type { AppRecord } from "./types.ts";

export type RegistrationVerificationMode = "quick" | "none";

export interface RegistrationVerificationPolicy {
  mode: RegistrationVerificationMode;
  startupBudgetMs: number;
  probeTimeoutMs: number;
  stopBudgetMs: number;
  closureBudgetMs: number;
  candidateHealthProbeLimit: number;
}

export const DEFAULT_REGISTRATION_VERIFICATION_POLICY: Readonly<RegistrationVerificationPolicy> = Object.freeze({
  mode: "quick",
  startupBudgetMs: 8000,
  probeTimeoutMs: 1000,
  stopBudgetMs: 5000,
  closureBudgetMs: 3000,
  candidateHealthProbeLimit: 3
});

export type RegistrationVerificationStatus =
  | "not_requested"
  | "preflight_failed"
  | "starting"
  | "healthy"
  | "failed"
  | "cleanup_failed"
  | "verified";

export type RegistrationVerificationFailureCode =
  | "REGISTER_VERIFY_CWD_MISSING"
  | "REGISTER_VERIFY_COMMAND_NOT_FOUND"
  | "REGISTER_VERIFY_DEPENDENCY_MISSING"
  | "REGISTER_VERIFY_PORT_CONFLICT"
  | "REGISTER_VERIFY_PORT_IGNORED"
  | "REGISTER_VERIFY_HEALTH_ROUTE"
  | "REGISTER_VERIFY_EARLY_EXIT"
  | "REGISTER_VERIFY_TIMEOUT"
  | "REGISTER_VERIFY_PERMISSION"
  | "REGISTER_VERIFY_STOP_FAILED"
  | "REGISTER_VERIFY_PORT_STILL_OPEN"
  | "REGISTER_VERIFY_UNSUPPORTED";

export interface RegistrationVerificationFailure {
  code: RegistrationVerificationFailureCode;
  boundary: "preflight" | "start" | "health" | "stop" | "closure";
  message: string;
  recommendedAction: string;
  processRunning: boolean;
  backendPortOpen: boolean | null;
  retryable: boolean;
  logExcerpt: string[];
}

export type RegistrationRepairKind = "health_route" | "dynamic_binding" | "pinned_port" | "manual_launch";

export interface RegistrationRepairOption {
  id: string;
  kind: RegistrationRepairKind;
  label: string;
  recommended: boolean;
  previewOnly: true;
  approvalRequired: true;
  patch?: Record<string, unknown>;
  structuredInputRequired?: Array<"executable" | "arguments" | "portBinding" | "healthRoute">;
  reason: string;
}

export interface RegistrationVerificationResult {
  attempted: boolean;
  reused?: boolean;
  status: RegistrationVerificationStatus;
  attemptId?: string;
  assignedPort?: number;
  startedAt?: string;
  healthyAt?: string;
  stoppedAt?: string;
  durationMs?: number;
  health?: {
    declaredTarget?: string;
    successfulTarget?: string;
    statusCode?: number;
  };
  stop?: {
    ok: boolean;
    portClosureVerified: boolean;
    backendPortOpen: boolean | null;
  };
  failure?: RegistrationVerificationFailure;
  repairs: RegistrationRepairOption[];
}

export interface RegistrationProofIdentity {
  manifestRevision: string;
  launchPlanDigest: string;
  policyDigest: string;
  adapterId: string;
  adapterVersion: number;
  relaybaseVersion: string;
}

export interface RegistrationVerificationRequest {
  app: AppRecord;
  previewId: string;
  manifestRevision: string;
  policy: RegistrationVerificationPolicy;
  healthCandidates: string[];
  selectedRepairId?: string;
  signal?: AbortSignal;
}

export type RegisteredVerificationState =
  | "registered_unverified"
  | "registered_verifying"
  | "registered_verified"
  | "registered_verification_failed"
  | "registered_cleanup_failed";
