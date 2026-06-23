import { createHash } from "node:crypto";
import { approvalRequiredToolNames, toolPolicy, type ToolPolicy } from "./toolPolicies.ts";
import { containsSecretLikeValue, isSafeReference, isSecretLikeKey } from "./redactionPolicy.ts";
import { looksLikePathTraversal } from "./setupPolicies.ts";
import type { AgentDiagnostic } from "./types.ts";

const APPROVAL_BYPASS_PATTERN = /\b(ignore|skip|bypass|disable)\s+(all\s+)?(approval|confirmation|safety|policy)\b/i;
const EXECUTION_CLAIM_PATTERN =
  /\b(?:(?:I|I've|I have|we|we've|we have|Relaybase|the daemon|the tool|tool)\s+(?:have\s+)?(?:started|stopped|restarted|patched|wrote|created|updated|exported|opened|proved|repaired)|(?:started|stopped|restarted|patched|wrote|created|updated|exported|opened|proved|repaired)\b[\s\S]{0,80}\b(?:successfully|complete|completed|done|finished|applied))\b/i;
const PREVIEW_ONLY_WRITE_CLAIM_PATTERN =
  /\b(?:preview|dry[- ]?run|plan)\s+(?:has\s+|have\s+)?(?:wrote|written|created|updated|applied)\b|\b(?:wrote|written|created|updated|applied)\b[\s\S]{0,80}\b(?:during|in|from)\s+(?:the\s+)?(?:preview|dry[- ]?run|plan)\b/i;
const UNSUPPORTED_PORT_STRATEGY_PATTERN = /\b(assume|invent|guess)\b[\s\S]*\b(port|framework|flag)\b/i;
const SHELL_META_PATTERN = /[&|<>]|`|\$\(|;\s*\S/;

export interface PolicyDecision {
  status: "allowed" | "approval_required" | "blocked";
  policy?: ToolPolicy;
  diagnostic?: AgentDiagnostic;
}

export function evaluateToolPolicy(toolName: string, input: Record<string, unknown>): PolicyDecision {
  const policy = toolPolicy(toolName);
  if (!policy) {
    return blocked("AGENT_TOOL_NOT_ALLOWED", `Tool ${toolName} is not in the Relaybase tool allowlist.`);
  }

  const guardrail = toolInputGuardrail(toolName, input);
  if (guardrail) {
    return { status: "blocked", policy, diagnostic: guardrail };
  }

  return {
    status: policy.approvalRequired ? "approval_required" : "allowed",
    policy
  };
}

export function userMessageGuardrail(content: string): AgentDiagnostic | undefined {
  if (!APPROVAL_BYPASS_PATTERN.test(content)) {
    return undefined;
  }
  if (!/\b(start|stop|restart|write|patch|register|export|open|prove|repair)\b/i.test(content)) {
    return undefined;
  }
  return diagnostic(
    "AGENT_APPROVAL_BYPASS_BLOCKED",
    "The request attempts to bypass Relaybase approval gates.",
    "Rephrase the request without bypass instructions. Destructive actions still require explicit approval."
  );
}

export function outputGuardrail(output: string, toolResultCount: number): AgentDiagnostic | undefined {
  if (toolResultCount === 0 && EXECUTION_CLAIM_PATTERN.test(output)) {
    return diagnostic(
      "AGENT_EXECUTION_CLAIM_WITHOUT_TOOL_RESULT",
      "The model output claims an action executed without a confirmed tool result.",
      "Retry with explicit tool execution and wait for a daemon tool result before claiming completion."
    );
  }
  if (PREVIEW_ONLY_WRITE_CLAIM_PATTERN.test(output)) {
    return diagnostic(
      "AGENT_PREVIEW_CLAIMS_WRITE",
      "The model output claims files were written during a preview-only flow.",
      "Show the preview and ask for approval before saying files were written."
    );
  }
  if (UNSUPPORTED_PORT_STRATEGY_PATTERN.test(output)) {
    return diagnostic(
      "AGENT_PORT_STRATEGY_INVENTED",
      "The model output appears to invent port or framework behavior.",
      "Use Relaybase setup detection and plan output before describing port strategy support."
    );
  }
  return undefined;
}

export function stableArgumentsHash(input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(sortValue(input)))
    .digest("hex");
}

export function approvalToolNames(): string[] {
  return approvalRequiredToolNames();
}

function toolInputGuardrail(toolName: string, input: Record<string, unknown>): AgentDiagnostic | undefined {
  if (containsBypass(input)) {
    return diagnostic(
      "AGENT_TOOL_APPROVAL_BYPASS_BLOCKED",
      "Tool input attempts to bypass approval or confirmation gates.",
      "Remove bypass instructions. Relaybase will request approval when required."
    );
  }
  const pathTraversal = findPathTraversal(input);
  if (pathTraversal) {
    return diagnostic(
      "AGENT_TOOL_PATH_TRAVERSAL_BLOCKED",
      "Tool input includes path traversal.",
      "Choose an explicit project or manifest path without .. traversal.",
      { field: pathTraversal }
    );
  }
  const commandField = findUnsafeCommand(input);
  if (commandField) {
    return diagnostic(
      "AGENT_TOOL_ARBITRARY_COMMAND_BLOCKED",
      "Tool input includes shell metacharacters in a command field.",
      "Use setup detection/plans or a simple command without shell chaining.",
      { field: commandField }
    );
  }
  if (toolName === "export_logs" && input.redact === false) {
    return diagnostic(
      "AGENT_TOOL_UNREDACTED_EXPORT_BLOCKED",
      "Unredacted log export is blocked.",
      "Use the default redacted export path."
    );
  }
  const secretField = findRawSecret(input);
  if (secretField) {
    return diagnostic(
      "AGENT_TOOL_SECRET_INPUT_BLOCKED",
      "Tool input contains a raw secret-like value.",
      "Use an env:NAME reference or configure secure secret storage instead of sending raw secret values.",
      { field: secretField }
    );
  }
  return undefined;
}

function containsBypass(value: unknown): boolean {
  if (typeof value === "string") {
    return APPROVAL_BYPASS_PATTERN.test(value);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsBypass(entry));
  }
  return Object.values(value as Record<string, unknown>).some((nested) => containsBypass(nested));
}

function findPathTraversal(value: unknown, path: string[] = []): string | undefined {
  if (typeof value === "string") {
    const key = path.at(-1)?.toLowerCase() ?? "";
    return /(path|cwd|directory|manifest)/.test(key) && looksLikePathTraversal(value) ? path.join(".") : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findPathTraversal(value[index], [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const found = findPathTraversal(nested, [...path, key]);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findUnsafeCommand(value: unknown, path: string[] = []): string | undefined {
  if (typeof value === "string") {
    const key = path.at(-1)?.toLowerCase() ?? "";
    return (key === "command" || key === "commandhint") && SHELL_META_PATTERN.test(value) ? path.join(".") : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnsafeCommand(value[index], [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const found = findUnsafeCommand(nested, [...path, key]);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findRawSecret(value: unknown, path: string[] = []): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findRawSecret(value[index], [...path, String(index)]);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretLikeKey(key) && typeof nested === "string" && nested.trim() && !isSafeReference(nested)) {
      return [...path, key].join(".");
    }
    if (key.toLowerCase() === "value" && containsSecretLikeValue({ value: nested })) {
      return [...path, key].join(".");
    }
    const found = findRawSecret(nested, [...path, key]);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function blocked(code: string, message: string): PolicyDecision {
  return { status: "blocked", diagnostic: diagnostic(code, message, "Use a registered Relaybase tool and retry.") };
}

function diagnostic(code: string, message: string, userAction: string, detail?: unknown): AgentDiagnostic {
  return {
    id: `agent.policy.${code.toLowerCase()}`,
    severity: "error",
    code,
    message,
    checkedAt: new Date().toISOString(),
    userAction,
    ...(detail !== undefined ? { detail } : {})
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)])
  );
}
