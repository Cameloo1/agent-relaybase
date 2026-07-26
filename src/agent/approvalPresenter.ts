import { getRelaybaseState } from "../appState.ts";
import type { RelaybaseRuntime } from "../server.ts";
import {
  fileWritesFromPreview,
  envKeysChanged,
  healthRouteChosen,
  manifestFieldsChanged,
  portStrategyChosen
} from "./setupPolicies.ts";
import { redactApprovalPayload } from "./redactionPolicy.ts";
import type { AgentApprovalPreview, TuiAgentContext } from "./types.ts";
import type { ToolPolicy } from "./toolPolicies.ts";

export async function buildApprovalPreview(input: {
  runtime: RelaybaseRuntime;
  policy: ToolPolicy;
  arguments: Record<string, unknown>;
  tuiContext: TuiAgentContext;
  approvalId: string;
  knownSecrets?: string[];
  previewData?: unknown;
}): Promise<AgentApprovalPreview> {
  const target = await targetSummary(input.runtime, input.arguments, input.tuiContext);
  const currentStatus = await currentStatusSummary(input.runtime, input.arguments, input.tuiContext);
  const redactedArguments = redactApprovalPayload(input.arguments, input.knownSecrets);
  const fileWrites = fileWritesFromPreview(input.previewData);
  const changedFields = manifestFieldsChanged(input.arguments);
  const envKeys = envKeysChanged(input.arguments);
  const runtime = runtimeSummary(input.previewData, input.arguments);
  const consequences = approvalConsequences(input.policy, {
    fileWrites: fileWrites.length,
    manifestFields: changedFields,
    envKeys,
    selectedCommand: runtime.selectedCommand?.preview
  });

  return {
    phase: "approval",
    action: input.policy.name,
    ...(target ? { target } : {}),
    ...(currentStatus ? { currentStatus } : {}),
    expectedResult: input.policy.expectedResult,
    risk: input.policy.risk,
    arguments: redactedArguments,
    ...(fileWrites.length ? { fileWrites: redactApprovalPayload(fileWrites, input.knownSecrets) as unknown[] } : {}),
    ...(changedFields.length ? { manifestFieldsChanged: changedFields } : {}),
    ...(envKeys.length ? { envKeysChanged: envKeys } : {}),
    ...(runtime.runtimeId ? { runtimeId: runtime.runtimeId } : {}),
    ...(runtime.runtimeLabel ? { runtimeLabel: runtime.runtimeLabel } : {}),
    ...(runtime.runtimeConfidence ? { runtimeConfidence: runtime.runtimeConfidence } : {}),
    ...(runtime.selectedCommand ? { selectedCommand: runtime.selectedCommand } : {}),
    ...((portStrategyChosen(input.arguments) ?? runtime.portStrategy)
      ? { portStrategy: portStrategyChosen(input.arguments) ?? runtime.portStrategy }
      : {}),
    ...(runtime.portStrategyCandidates.length ? { portStrategyCandidates: runtime.portStrategyCandidates } : {}),
    ...(runtime.setupQuestions.length ? { setupQuestions: runtime.setupQuestions } : {}),
    ...(healthRouteChosen(input.arguments) ? { healthRoute: healthRouteChosen(input.arguments) } : {}),
    whyApproval: consequences.whyApproval,
    willChange: consequences.willChange,
    willPreserve: consequences.willPreserve,
    willRun: consequences.willRun,
    proof: consequences.proof,
    ...(text(input.arguments.expectedRevision) ? { revision: text(input.arguments.expectedRevision) } : {}),
    ...(previewText(input.previewData, "expiresAt") ? { expiresAt: previewText(input.previewData, "expiresAt") } : {}),
    ...(previewStringArray(input.previewData, "blockers").length
      ? { blockedReasons: previewStringArray(input.previewData, "blockers") }
      : {}),
    mayIncludeSensitiveData: input.policy.sensitiveData || fileWrites.length > 0 || envKeys.length > 0,
    confirmationOptions: {
      approveEndpoint: `/__hub/api/agent/approvals/${encodeURIComponent(input.approvalId)}/approve`,
      rejectEndpoint: `/__hub/api/agent/approvals/${encodeURIComponent(input.approvalId)}/reject`,
      rejectOnEsc: true
    }
  };
}

function approvalConsequences(
  policy: ToolPolicy,
  input: { fileWrites: number; manifestFields: string[]; envKeys: string[]; selectedCommand?: string }
) {
  const lifecycle = policy.category === "lifecycle" || ["start_app", "stop_app", "restart_app"].includes(policy.name);
  const willChange = [
    ...(lifecycle ? ["Managed runtime process state"] : []),
    ...(input.fileWrites ? [`${input.fileWrites} approved file write(s)`] : []),
    ...(input.manifestFields.length ? [`Manifest fields: ${input.manifestFields.join(", ")}`] : []),
    ...(input.envKeys.length ? [`Environment references: ${input.envKeys.join(", ")}`] : []),
    ...(policy.category === "export" ? ["A redacted log export artifact"] : [])
  ];
  return {
    whyApproval:
      policy.category === "read" || policy.category === "tui"
        ? "This action is read-only."
        : `This ${policy.category} action can change local files, managed processes, or durable Relaybase state.`,
    willChange: willChange.length ? willChange : [policy.expectedResult],
    willPreserve: ["Stable app and package IDs", "Unrelated project files", "Existing logs and operation history"],
    willRun: [
      ...(input.selectedCommand ? [input.selectedCommand] : []),
      ...(lifecycle ? [`Daemon-owned ${policy.name.replaceAll("_", " ")} operation`] : [])
    ],
    proof: [policy.expectedResult, "Daemon returns a correlated terminal result or an inspectable failure."]
  };
}

function previewText(value: unknown, key: string): string | undefined {
  const record = objectRecord(value);
  return text(record?.[key]) ?? text(objectRecord(record?.preview)?.[key]);
}

function previewStringArray(value: unknown, key: string): string[] {
  const record = objectRecord(value);
  const direct = record?.[key] ?? objectRecord(record?.preview)?.[key];
  if (!Array.isArray(direct)) return [];
  return direct.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() ? [entry.trim()] : [];
    const item = objectRecord(entry);
    const message = text(item?.message) ?? text(item?.reason) ?? text(item?.code);
    return message ? [message] : [];
  });
}

async function targetSummary(
  runtime: RelaybaseRuntime,
  args: Record<string, unknown>,
  context: TuiAgentContext
): Promise<string | undefined> {
  const explicit =
    text(args.appId) ??
    text(args.groupId) ??
    text(args.manifestPath) ??
    text(args.cwd) ??
    text(args.currentDirectory) ??
    text(args.target) ??
    context.selectedAppId ??
    context.selectedGroupId ??
    context.currentCwd;
  if (explicit) {
    return explicit;
  }
  return undefined;
}

async function currentStatusSummary(
  runtime: RelaybaseRuntime,
  args: Record<string, unknown>,
  context: TuiAgentContext
): Promise<string | undefined> {
  const appId = text(args.appId) ?? context.selectedAppId;
  if (!appId) {
    return undefined;
  }
  try {
    const state = await getRelaybaseState(runtime);
    const app = state.apps.find((entry) => entry.id === appId);
    return app ? `${app.runtime.status}/${app.readiness.state}` : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function runtimeSummary(
  previewData: unknown,
  args: Record<string, unknown>
): {
  runtimeId?: string;
  runtimeLabel?: string;
  runtimeConfidence?: string;
  selectedCommand?: { argv?: string[]; preview?: string };
  portStrategy?: string;
  portStrategyCandidates: string[];
  setupQuestions: string[];
} {
  const choice = setupChoice(previewData);
  const runtimeId = text(choice?.runtimeId) ?? text(args.runtimePreference);
  const commandCandidates = arrayOfRecords(choice?.runtimeStartCommandCandidates);
  const primaryCommand = commandCandidates[0];
  const portStrategies = [
    ...stringArray(choice?.portStrategies),
    ...arrayOfRecords(choice?.runtimePortStrategies)
      .map((strategy) => text(strategy.id))
      .filter(Boolean)
  ] as string[];
  const setupQuestions = arrayOfRecords(choice?.setupQuestions)
    .map((question) => text(question.prompt) ?? text(question.id))
    .filter(Boolean) as string[];
  const selectedCommand =
    primaryCommand || text(args.commandHint) || text(args.command)
      ? {
          ...(stringArray(primaryCommand?.command).length ? { argv: stringArray(primaryCommand?.command) } : {}),
          ...((text(primaryCommand?.commandPreview) ?? text(args.commandHint) ?? text(args.command))
            ? { preview: text(primaryCommand?.commandPreview) ?? text(args.commandHint) ?? text(args.command) }
            : {})
        }
      : undefined;

  return {
    ...(runtimeId ? { runtimeId } : {}),
    ...(text(choice?.label) ? { runtimeLabel: text(choice?.label) } : {}),
    ...(text(choice?.runtimeConfidence) ? { runtimeConfidence: text(choice?.runtimeConfidence) } : {}),
    ...(selectedCommand ? { selectedCommand } : {}),
    ...(portStrategies[0] ? { portStrategy: portStrategies[0] } : {}),
    portStrategyCandidates: uniqueStrings(portStrategies),
    setupQuestions: uniqueStrings(setupQuestions)
  };
}

function setupChoice(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const selectedPlan = objectRecord(record.selectedPlan);
  const selectedChoice = objectRecord(selectedPlan?.choice);
  if (selectedChoice) {
    return selectedChoice;
  }
  const directChoice = objectRecord(record.choice);
  if (directChoice) {
    return directChoice;
  }
  const choices = Array.isArray(record.choices) ? record.choices : [];
  return objectRecord(choices[0]);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.flatMap((entry) => (objectRecord(entry) ? [objectRecord(entry)!] : [])) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
