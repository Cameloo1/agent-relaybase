import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RelaybaseRuntime } from "../../server.ts";
import type { TuiAgentContext } from "../types.ts";

const MANIFEST_REVISION_BOUND_TOOLS = new Set([
  "register_manifest",
  "patch_manifest_fields",
  "set_health_route",
  "set_pinned_port",
  "set_component_metadata",
  "add_env_override_safe"
]);

export interface AgentApprovalStateBinding {
  schemaVersion: 1;
  kind: "manifest_revision";
  targetDigest: string;
  contentDigest: string;
}

export type AgentApprovalStateVerification =
  | { ok: true }
  | {
      ok: false;
      code: "AGENT_APPROVAL_STATE_BINDING_REQUIRED" | "AGENT_APPROVAL_STATE_STALE";
      message: string;
      userAction: string;
      detail: { failure: "missing" | "schema" | "target" | "content" | "unavailable"; mutationPerformed: false };
    };

export async function bindAgentToolApprovalState(
  toolName: string,
  input: Record<string, unknown>,
  runtime: RelaybaseRuntime,
  context: TuiAgentContext
): Promise<Record<string, unknown>> {
  if (!requiresManifestRevisionBinding(toolName, input)) {
    return input;
  }
  return {
    ...input,
    approvalStateBinding: await currentManifestRevisionBinding(toolName, input, runtime, context)
  };
}

export async function verifyAgentToolApprovalState(
  toolName: string,
  input: Record<string, unknown>,
  runtime: RelaybaseRuntime,
  context: TuiAgentContext
): Promise<AgentApprovalStateVerification> {
  if (!requiresManifestRevisionBinding(toolName, input)) {
    return { ok: true };
  }
  const binding = bindingValue(input.approvalStateBinding);
  if (!binding) {
    return bindingFailure(
      "AGENT_APPROVAL_STATE_BINDING_REQUIRED",
      "Approved manifest action is missing its immutable file revision binding.",
      "missing"
    );
  }
  if (binding.schemaVersion !== 1 || binding.kind !== "manifest_revision") {
    return bindingFailure("AGENT_APPROVAL_STATE_STALE", "Approved manifest binding has an invalid schema.", "schema");
  }
  let current: AgentApprovalStateBinding;
  try {
    current = await currentManifestRevisionBinding(toolName, input, runtime, context);
  } catch {
    return bindingFailure(
      "AGENT_APPROVAL_STATE_STALE",
      "The approved manifest target is no longer available.",
      "unavailable"
    );
  }
  if (!safeDigestEqual(binding.targetDigest, current.targetDigest)) {
    return bindingFailure("AGENT_APPROVAL_STATE_STALE", "The approved manifest target changed.", "target");
  }
  if (!safeDigestEqual(binding.contentDigest, current.contentDigest)) {
    return bindingFailure("AGENT_APPROVAL_STATE_STALE", "The approved manifest contents changed.", "content");
  }
  return { ok: true };
}

function requiresManifestRevisionBinding(toolName: string, input: Record<string, unknown>): boolean {
  return (
    MANIFEST_REVISION_BOUND_TOOLS.has(toolName) ||
    (toolName === "setup_and_start_project" && input.phase === "register_manifest")
  );
}

async function currentManifestRevisionBinding(
  toolName: string,
  input: Record<string, unknown>,
  runtime: RelaybaseRuntime,
  context: TuiAgentContext
): Promise<AgentApprovalStateBinding> {
  const manifestPath = await manifestPathForApproval(toolName, input, runtime, context);
  if (!manifestPath) {
    throw new Error("Manifest path is unavailable for approval binding.");
  }
  const canonicalPath = await fs.realpath(manifestPath);
  const content = await fs.readFile(canonicalPath);
  const pathIdentity = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  return {
    schemaVersion: 1,
    kind: "manifest_revision",
    targetDigest: sha256(pathIdentity),
    contentDigest: sha256(content)
  };
}

async function manifestPathForApproval(
  toolName: string,
  input: Record<string, unknown>,
  runtime: RelaybaseRuntime,
  context: TuiAgentContext
): Promise<string | undefined> {
  const appId = text(input.appId) ?? context.selectedAppId;
  if (appId && toolName !== "register_manifest" && toolName !== "setup_and_start_project") {
    const app = await runtime.registry.get(appId);
    if (app?.manifestPath) {
      return path.resolve(app.manifestPath);
    }
  }
  const cwd = text(input.cwd ?? input.currentDirectory) ?? context.currentCwd;
  const manifestPath = text(input.manifestPath);
  if (manifestPath) {
    return path.isAbsolute(manifestPath)
      ? path.resolve(manifestPath)
      : path.resolve(cwd ?? process.cwd(), manifestPath);
  }
  if (toolName === "setup_and_start_project" && input.phase === "register_manifest" && cwd) {
    return path.join(path.resolve(cwd), "relaybase.app.json");
  }
  return undefined;
}

function bindingValue(value: unknown): AgentApprovalStateBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const binding = value as Partial<AgentApprovalStateBinding>;
  return typeof binding.targetDigest === "string" && typeof binding.contentDigest === "string"
    ? (binding as AgentApprovalStateBinding)
    : undefined;
}

function bindingFailure(
  code: "AGENT_APPROVAL_STATE_BINDING_REQUIRED" | "AGENT_APPROVAL_STATE_STALE",
  message: string,
  failure: "missing" | "schema" | "target" | "content" | "unavailable"
): AgentApprovalStateVerification {
  return {
    ok: false,
    code,
    message,
    userAction: "Generate a fresh manifest preview, review it, and approve that exact revision before applying.",
    detail: { failure, mutationPerformed: false }
  };
}

function safeDigestEqual(left: string, right: string): boolean {
  return (
    /^[a-f0-9]{64}$/i.test(left) &&
    /^[a-f0-9]{64}$/i.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
