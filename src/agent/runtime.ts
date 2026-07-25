import { createHash } from "node:crypto";
import type { RelaybaseRuntime } from "../server.ts";
import { buildOperatorPromptContext, type OperatorPromptContext } from "./context.ts";
import { AgentRuntimeError, diagnosticFromRuntimeError, redactAgentText, sanitizeAgentPayload } from "./errors.ts";
import { normalizeAgentExecutionPolicy } from "./executionPolicy.ts";
import type { AgentRuntimeEvent } from "./events.ts";
import { createOperatorAgent, operatorAgentReadOnlyToolNames, operatorAgentToolNames } from "./operatorAgent.ts";
import { evaluateToolPolicy, outputGuardrail } from "./policy.ts";
import { createOpenRouterAgentProvider } from "./provider/openrouter.ts";
import { buildOperatorPromptInput } from "./prompts.ts";
import type {
  AgentConfig,
  AgentBlockedCandidate,
  AgentDiagnostic,
  AgentExecutionPolicy,
  AgentMessage,
  AgentProjectRootGrant,
  AgentRun,
  AgentSession,
  AgentThreadContextPreview,
  AgentUsage,
  TuiAgentContext
} from "./types.ts";

export interface OperatorAgentRuntimeOptions {
  runnerFactory?: OperatorAgentRunnerFactory;
  timeoutMs?: number;
  maxTurns?: number;
  segmentMaxTurns?: number;
  totalMaxTurns?: number;
  inactivityTimeoutMs?: number;
  hardRunTimeoutMs?: number;
  maxOutputTokens?: number;
  noProgressRepeatLimit?: number;
}

export interface OperatorAgentRunner {
  run(agent: unknown, input: any, options?: Record<string, unknown>): Promise<any>;
}

export type OperatorAgentRunnerFactory = (input: {
  config: AgentConfig;
  modelProvider: unknown;
}) => OperatorAgentRunner;

export interface OperatorAgentRuntimeInput {
  relaybase: RelaybaseRuntime;
  config: AgentConfig;
  session: AgentSession;
  message: AgentMessage;
  run: AgentRun;
  context: TuiAgentContext;
  projectRootGrants?: readonly AgentProjectRootGrant[];
  threadContext?: AgentThreadContextPreview;
  emit: (event: AgentRuntimeEvent) => void;
  knownSecrets?: string[];
  credential: string;
  providerAttribution?: {
    httpReferer?: string;
    title?: string;
  };
  signal?: AbortSignal;
}

export interface OperatorAgentRuntimeResult {
  status: "completed" | "failed" | "waiting_for_approval";
  assistantContent?: string;
  modelOutputProduced?: boolean;
  diagnostics: AgentDiagnostic[];
  promptContext: OperatorPromptContext;
  toolNames: string[];
  pendingApprovals?: OperatorAgentPendingApprovalRequest[];
  usage?: AgentUsage;
  blockedCandidate?: AgentBlockedCandidate;
}

export interface OperatorAgentPendingApprovalRequest {
  toolCallId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  expectedResult: string;
  risk: "low" | "medium" | "high";
  rawItem?: unknown;
}

const MODEL_DELTA_FLUSH_INTERVAL_MS = 100;
const MODEL_DELTA_MAX_CHARS = 512;

export class OperatorAgentRuntime {
  #runnerFactory?: OperatorAgentRunnerFactory;
  #options: OperatorAgentRuntimeOptions;

  constructor(options: OperatorAgentRuntimeOptions = {}) {
    this.#runnerFactory = options.runnerFactory;
    this.#options = options;
  }

  initialize(config: AgentConfig): { modelSlug: string; toolNames: string[] } {
    if (!config.provider.modelSlug) {
      throw new AgentRuntimeError("AGENT_MODEL_MISSING", "No OpenRouter model slug is configured.", {
        userAction: "Configure a model slug before initializing the Operator Agent runtime."
      });
    }
    return {
      modelSlug: config.provider.modelSlug,
      toolNames: operatorAgentToolNames()
    };
  }

  async execute(input: OperatorAgentRuntimeInput): Promise<OperatorAgentRuntimeResult> {
    const knownSecrets = input.knownSecrets ?? [];
    try {
      if (!input.config.provider.modelSlug) {
        throw new AgentRuntimeError("AGENT_MODEL_MISSING", "No OpenRouter model slug is configured.", {
          userAction: "Configure a model slug before sending natural-language requests."
        });
      }

      const provider = createOpenRouterAgentProvider(input.config, input.credential, input.providerAttribution);
      const execution = this.#executionPolicy(input.config);
      const promptContext = await buildOperatorPromptContext(input.relaybase, input.context, input.threadContext);
      const { agent, toolNames } = createOperatorAgent({
        modelSlug: input.config.provider.modelSlug,
        runtime: input.relaybase,
        tuiContext: input.context,
        projectRootGrants: input.projectRootGrants,
        config: input.config,
        reasoningEffort: execution.reasoningEffort,
        maxOutputTokens: execution.maxOutputTokens,
        emit: input.emit
      });
      const runner =
        this.#runnerFactory?.({ config: input.config, modelProvider: provider.modelProvider }) ??
        new (loadRunnerConstructor())({
          modelProvider: provider.modelProvider,
          tracingDisabled: true,
          traceIncludeSensitiveData: false
        });
      const prompt = buildOperatorPromptInput({
        userMessage: input.message.content,
        context: promptContext,
        knownSecrets
      });

      input.emit({
        type: "model.request_started",
        data: {
          provider: "openrouter",
          modelSlug: input.config.provider.modelSlug,
          reasoning: {
            enabled: true,
            effort: execution.reasoningEffort
          },
          toolNames,
          promptContextIncluded: {
            stateSummary: true,
            selectedContext: true,
            currentCwd: Boolean(promptContext.currentCwd)
          }
        }
      });

      const deltaEmitter = new ModelDeltaEmitter(input.emit);
      let result: any;
      try {
        result = await this.#runBounded(
          runner,
          agent,
          prompt,
          (delta) => deltaEmitter.push(redactAgentText(delta, knownSecrets)),
          (event) => {
            deltaEmitter.flush();
            input.emit(event);
          },
          execution,
          input.signal
        );
      } finally {
        deltaEmitter.flush();
      }
      const interruptions = pendingApprovalsFromResult(result);
      if (interruptions.length) {
        const clarification = lifecycleApprovalClarification(
          interruptions,
          input.context,
          input.message.content,
          promptContext
        );
        if (clarification) {
          input.emit({ type: "diagnostic", data: clarification });
          input.emit({
            type: "clarification_needed",
            data: {
              kind: "clarification_needed",
              content: clarification.message,
              diagnostic: clarification
            }
          });
          return {
            status: "completed",
            assistantContent: clarification.message,
            diagnostics: [clarification],
            promptContext,
            toolNames,
            usage: usageFromResult(result)
          };
        }

        const blocked = interruptions
          .map((interruption) => ({
            interruption,
            decision: evaluateToolPolicy(interruption.toolName, interruption.arguments),
            configDiagnostic: toolConfigDiagnostic(input.config, interruption.toolName)
          }))
          .find((entry) => entry.configDiagnostic || entry.decision.status === "blocked");
        const blockedDiagnostic = blocked?.configDiagnostic ?? blocked?.decision.diagnostic;
        if (blockedDiagnostic) {
          input.emit({ type: "diagnostic", data: blockedDiagnostic });
          input.emit({
            type: "blocked",
            data: {
              kind: "blocked",
              content: blockedDiagnostic.message,
              diagnostic: blockedDiagnostic
            }
          });
          return {
            status: "failed",
            diagnostics: [blockedDiagnostic],
            promptContext,
            toolNames
          };
        }

        return {
          status: "waiting_for_approval",
          diagnostics: [],
          promptContext,
          toolNames,
          pendingApprovals: interruptions.map((interruption) => {
            const policy = evaluateToolPolicy(interruption.toolName, interruption.arguments).policy;
            return {
              ...interruption,
              expectedResult: policy?.expectedResult ?? "Execute approved Relaybase tool call.",
              risk: policy?.risk ?? "high"
            };
          })
        };
      }

      const output = redactAgentText(String(result.finalOutput ?? ""), knownSecrets).trim();
      if (!output) {
        throw new AgentRuntimeError("AGENT_EMPTY_RESPONSE", "Operator Agent returned an empty response.", {
          retryable: true,
          userAction: "Retry or choose another OpenRouter model."
        });
      }
      const toolResults = toolResultSummary(result);
      const outputDiagnostic = outputGuardrail(output, toolResults.count, input.message.content, toolResults.toolNames);
      if (outputDiagnostic) {
        const blockedCandidate = buildBlockedCandidate(output, outputDiagnostic.code);
        input.emit({ type: "diagnostic", data: outputDiagnostic });
        input.emit({
          type: "blocked",
          data: {
            kind: "blocked",
            content: outputDiagnostic.message,
            diagnostic: outputDiagnostic,
            candidate: candidateMetadata(blockedCandidate)
          }
        });
        return {
          status: "failed",
          modelOutputProduced: true,
          blockedCandidate,
          diagnostics: [outputDiagnostic],
          promptContext,
          toolNames
        };
      }

      input.emit({
        type: "model.completed",
        data: {
          provider: "openrouter",
          modelSlug: input.config.provider.modelSlug,
          usage: sanitizeAgentPayload(result.usage ?? result.rawResponses?.at?.(-1)?.usage, knownSecrets)
        }
      });
      input.emit({
        type: "answer",
        data: {
          kind: "answer",
          content: output
        }
      });

      return {
        status: "completed",
        assistantContent: output,
        diagnostics: [],
        promptContext,
        toolNames,
        usage: usageFromResult(result)
      };
    } catch (error) {
      const diagnostic = diagnosticFromRuntimeError(error, input.config.provider.modelSlug);
      input.emit({ type: "diagnostic", data: diagnostic });
      input.emit({
        type: "blocked",
        data: {
          kind: "blocked",
          content: diagnostic.message,
          diagnostic
        }
      });
      return {
        status: "failed",
        diagnostics: [diagnostic],
        promptContext: await buildOperatorPromptContext(input.relaybase, input.context, input.threadContext),
        toolNames: operatorAgentToolNames()
      };
    }
  }

  #executionPolicy(config: AgentConfig): AgentExecutionPolicy {
    const configured = normalizeAgentExecutionPolicy(config.execution);
    const legacyMaxTurns = this.#options.maxTurns;
    const legacyTimeoutMs = this.#options.timeoutMs;
    const segmentMaxTurns = this.#options.segmentMaxTurns ?? legacyMaxTurns ?? configured.segmentMaxTurns;
    return {
      ...configured,
      segmentMaxTurns,
      totalMaxTurns: Math.max(
        segmentMaxTurns,
        this.#options.totalMaxTurns ?? legacyMaxTurns ?? configured.totalMaxTurns
      ),
      inactivityTimeoutMs: this.#options.inactivityTimeoutMs ?? legacyTimeoutMs ?? configured.inactivityTimeoutMs,
      hardRunTimeoutMs: this.#options.hardRunTimeoutMs ?? legacyTimeoutMs ?? configured.hardRunTimeoutMs,
      maxOutputTokens: this.#options.maxOutputTokens ?? configured.maxOutputTokens,
      noProgressRepeatLimit: this.#options.noProgressRepeatLimit ?? configured.noProgressRepeatLimit
    };
  }

  async #runBounded(
    runner: OperatorAgentRunner,
    agent: unknown,
    prompt: unknown,
    emitDelta: (delta: string) => void,
    emitEvent: (event: AgentRuntimeEvent) => void,
    execution: AgentExecutionPolicy,
    externalSignal?: AbortSignal
  ): Promise<any> {
    const hardDeadline = Date.now() + execution.hardRunTimeoutMs;
    const noProgress = new NoProgressTracker(execution.noProgressRepeatLimit);
    let runInput: unknown = prompt;
    let turnCeiling = Math.min(execution.segmentMaxTurns, execution.totalMaxTurns);
    let segment = 1;

    while (true) {
      try {
        return await this.#runSegment(
          runner,
          agent,
          runInput,
          turnCeiling,
          emitDelta,
          emitEvent,
          execution.inactivityTimeoutMs,
          hardDeadline,
          execution.hardRunTimeoutMs,
          noProgress,
          externalSignal
        );
      } catch (error) {
        if (!isMaxTurnsExceededError(error)) {
          throw error;
        }
        const state = maxTurnsRunState(error);
        if (!state || turnCeiling >= execution.totalMaxTurns) {
          throw new AgentRuntimeError(
            "AGENT_TURN_LIMIT_REACHED",
            `Operator Agent reached the configured ${execution.totalMaxTurns}-turn limit before completing the request.`,
            {
              retryable: true,
              userAction:
                "Inspect the partial result, then retry or raise the bounded total-turn limit in Agent settings.",
              detail: {
                turnsUsed: turnCeiling,
                totalMaxTurns: execution.totalMaxTurns,
                segmentMaxTurns: execution.segmentMaxTurns,
                segments: segment
              }
            }
          );
        }
        const previousCeiling = turnCeiling;
        turnCeiling = Math.min(execution.totalMaxTurns, turnCeiling + execution.segmentMaxTurns);
        segment += 1;
        emitEvent({
          type: "run.continuing",
          data: {
            segment,
            turnsUsed: previousCeiling,
            nextTurnCeiling: turnCeiling,
            totalMaxTurns: execution.totalMaxTurns
          }
        });
        runInput = state;
      }
    }
  }

  async #runSegment(
    runner: OperatorAgentRunner,
    agent: unknown,
    runInput: unknown,
    maxTurns: number,
    emitDelta: (delta: string) => void,
    emitEvent: (event: AgentRuntimeEvent) => void,
    inactivityTimeoutMs: number,
    hardDeadline: number,
    hardRunTimeoutMs: number,
    noProgress: NoProgressTracker,
    externalSignal?: AbortSignal
  ): Promise<any> {
    const controller = new AbortController();
    const processing = new ModelProcessingTracker(emitEvent);
    const inactivityError = () =>
      new AgentRuntimeError("AGENT_INACTIVITY_TIMEOUT", "Operator Agent stopped producing model or tool progress.", {
        retryable: true,
        userAction:
          "Inspect the last activity, then retry or increase the bounded inactivity timeout in Agent settings.",
        detail: { inactivityTimeoutMs }
      });
    const hardTimeoutError = () =>
      new AgentRuntimeError("AGENT_HARD_DURATION_REACHED", "Operator Agent reached the configured hard run duration.", {
        retryable: true,
        userAction:
          "Inspect the partial result, then retry or increase the bounded hard run duration in Agent settings.",
        detail: { hardRunTimeoutMs }
      });
    const cancelledError = () =>
      new AgentRuntimeError("AGENT_RUN_CANCELLED", "Operator Agent run was cancelled.", {
        retryable: true,
        userAction: "Retry the run if the request is still needed."
      });
    let rejectAbort: ((error: Error) => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const rejectAndAbort = (error: Error) => {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      rejectAbort?.(error);
    };
    const onExternalAbort = () => {
      rejectAndAbort(cancelledError());
    };
    if (externalSignal?.aborted) {
      onExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    }
    let inactivityTimer: NodeJS.Timeout | undefined;
    const touchProgress = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }
      inactivityTimer = setTimeout(() => rejectAndAbort(inactivityError()), inactivityTimeoutMs);
      inactivityTimer.unref?.();
    };
    touchProgress();
    const hardTimeoutMs = Math.max(1, hardDeadline - Date.now());
    const hardTimer = setTimeout(() => rejectAndAbort(hardTimeoutError()), hardTimeoutMs);
    hardTimer.unref?.();
    try {
      processing.begin();
      const runPromise = runner.run(agent, runInput, {
        stream: true,
        maxTurns,
        signal: controller.signal
      });
      const result = await Promise.race([runPromise, abortPromise]);
      touchProgress();
      if (isAsyncIterable(result)) {
        await Promise.race([
          (async () => {
            for await (const event of result) {
              touchProgress();
              handleSdkStreamEvent(
                event,
                (delta) => {
                  touchProgress();
                  emitDelta(delta);
                },
                (runtimeEvent) => {
                  if (noProgress.observe(runtimeEvent)) {
                    throw new AgentRuntimeError(
                      "AGENT_NO_PROGRESS",
                      `Operator Agent repeated the same tool result ${noProgress.repeatCount} times without observable progress.`,
                      {
                        retryable: true,
                        userAction:
                          "Inspect the repeated tool activity, clarify the target, or retry with a different approach.",
                        detail: {
                          toolName: noProgress.toolName,
                          repeatCount: noProgress.repeatCount
                        }
                      }
                    );
                  }
                  emitEvent(runtimeEvent);
                },
                processing
              );
            }
            await result.completed;
          })(),
          abortPromise
        ]);
      }
      processing.complete();
      return result;
    } catch (error) {
      if (isMaxTurnsExceededError(error)) {
        processing.complete();
      } else {
        processing.fail();
      }
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
      throw error;
    } finally {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }
      clearTimeout(hardTimer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function buildBlockedCandidate(content: string, diagnosticCode: string): AgentBlockedCandidate {
  const inspectable = !/SECRET|CREDENTIAL|BYPASS|INJECTION/i.test(diagnosticCode);
  return {
    disposition: inspectable ? "retained_redacted" : "discarded_security",
    inspectable,
    sha256: createHash("sha256").update(content).digest("hex"),
    byteCount: Buffer.byteLength(content, "utf8"),
    diagnosticCode,
    ...(inspectable ? { content } : {})
  };
}

function candidateMetadata(candidate: AgentBlockedCandidate): Omit<AgentBlockedCandidate, "content"> {
  const { content: _content, ...metadata } = candidate;
  return metadata;
}

class ModelDeltaEmitter {
  #pending = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #emit: (event: AgentRuntimeEvent) => void;

  constructor(emit: (event: AgentRuntimeEvent) => void) {
    this.#emit = emit;
  }

  push(delta: string): void {
    if (!delta) {
      return;
    }
    this.#pending += delta;
    if (this.#pending.length >= MODEL_DELTA_MAX_CHARS) {
      this.flush();
      return;
    }
    this.#timer ??= setTimeout(() => this.flush(), MODEL_DELTA_FLUSH_INTERVAL_MS);
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (!this.#pending) {
      return;
    }
    const delta = this.#pending;
    this.#pending = "";
    this.#emit({ type: "model.delta", data: { delta } });
  }
}

function toolConfigDiagnostic(config: AgentConfig, toolName: string): AgentDiagnostic | undefined {
  if (!config.toolAllowlist.includes(toolName)) {
    return {
      id: "agent.tool.disallowed_by_config",
      severity: "error",
      code: "AGENT_TOOL_NOT_ALLOWED_BY_CONFIG",
      message: `Tool ${toolName} is not in the configured agent tool allowlist.`,
      checkedAt: new Date().toISOString(),
      userAction: "Add the tool to toolAllowlist or choose a permitted tool."
    };
  }
  const readOnlyTools = new Set(operatorAgentReadOnlyToolNames());
  if (config.approvalPolicy === "read_only_only" && !readOnlyTools.has(toolName)) {
    return {
      id: "agent.tool.read_only_only_blocked",
      severity: "error",
      code: "AGENT_READ_ONLY_POLICY_BLOCKED",
      message: `Tool ${toolName} is blocked by read-only agent policy.`,
      checkedAt: new Date().toISOString(),
      userAction: "Switch approvalPolicy to always_for_mutations before using mutation tools."
    };
  }
  return undefined;
}

function usageFromResult(result: unknown): AgentUsage {
  const rawResponses = arrayProperty(result, "rawResponses");
  const usage = valueProperty(result, "usage") ?? valueProperty(rawResponses.at(-1), "usage");
  const record = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const inputTokens = tokenCount(
    record.inputTokens ?? record.promptTokens ?? record.input_tokens ?? record.prompt_tokens
  );
  const outputTokens = tokenCount(
    record.outputTokens ?? record.completionTokens ?? record.output_tokens ?? record.completion_tokens
  );
  const reportedTotal = optionalTokenCount(record.totalTokens ?? record.total_tokens);
  const derivedTotal = inputTokens + outputTokens;
  if (!Number.isSafeInteger(derivedTotal)) {
    throw new Error("AGENT_USAGE_TOKEN_OVERFLOW");
  }
  const totalTokens = reportedTotal ?? derivedTotal;
  const estimatedCostUsd = numeric(record.estimatedCostUsd ?? record.totalCostUsd ?? record.costUsd ?? record.cost_usd);
  const providerCost = nonNegativeDecimal(record.cost ?? record.total_cost);
  const estimatedCost = nonNegativeDecimal(
    record.estimatedCostUsd ?? record.totalCostUsd ?? record.costUsd ?? record.cost_usd
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd,
    ...(providerCost !== undefined
      ? { costUsd: providerCost, costSource: "provider_reported" as const }
      : estimatedCost !== undefined
        ? { costUsd: estimatedCost, costSource: "estimated" as const }
        : { costSource: "unavailable" as const })
  };
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokenCount(value: unknown): number {
  return optionalTokenCount(value) ?? 0;
}

function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonNegativeDecimal(value: unknown): string | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? String(value) : undefined;
  }
  if (typeof value === "string" && /^\d+(?:\.\d{1,12})?$/.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

function pendingApprovalsFromResult(result: unknown): OperatorAgentPendingApprovalRequest[] {
  const rawInterruptions = arrayProperty(result, "interruptions");
  return rawInterruptions.flatMap((item, index) => {
    const toolName =
      textProperty(item, "name") ?? textProperty(item, "toolName") ?? textProperty(rawItem(item), "name");
    if (!toolName) {
      return [];
    }
    const rawArguments = valueProperty(item, "arguments") ?? valueProperty(rawItem(item), "arguments");
    return [
      {
        toolCallId:
          textProperty(rawItem(item), "callId") ?? textProperty(rawItem(item), "id") ?? `tool_call_${index + 1}`,
        toolName,
        arguments: parseArguments(rawArguments),
        expectedResult: "Execute approved Relaybase tool call.",
        risk: "high",
        rawItem: sanitizeAgentPayload(item)
      }
    ];
  });
}

function lifecycleApprovalClarification(
  interruptions: OperatorAgentPendingApprovalRequest[],
  context: TuiAgentContext,
  userMessage: string,
  promptContext: OperatorPromptContext
): AgentDiagnostic | undefined {
  for (const interruption of interruptions) {
    if (!["start_app", "stop_app", "restart_app"].includes(interruption.toolName)) {
      continue;
    }
    const role = textProperty(interruption.arguments, "componentRole");
    if (!role) {
      continue;
    }
    const selectedAppId = textProperty(context, "selectedAppId");
    const selectedGroupId = textProperty(context, "selectedGroupId");
    if (selectedAppId || selectedGroupId) {
      continue;
    }
    if (messageMentionsLifecycleTarget(userMessage, interruption.arguments)) {
      continue;
    }
    const candidates = promptContext.state.components
      .filter((component) => component.role === role)
      .map((component) => ({
        appId: component.appId,
        groupId: component.groupId,
        role: component.role,
        label: component.label,
        status: component.status
      }));
    return {
      id: "agent.lifecycle.target_ambiguous",
      severity: "warning",
      code: "AGENT_TARGET_AMBIGUOUS",
      message: `The ${interruption.toolName} request names the ${role} role but does not specify an app or group.`,
      checkedAt: new Date().toISOString(),
      userAction: "Ask the user to choose an exact app, group, or selected pane before creating a lifecycle approval.",
      detail: {
        toolName: interruption.toolName,
        role,
        candidates
      }
    };
  }
  return undefined;
}

function messageMentionsLifecycleTarget(userMessage: string, args: Record<string, unknown>): boolean {
  const normalizedMessage = normalizeText(userMessage);
  const candidates = [
    textProperty(args, "appId"),
    textProperty(args, "appName"),
    textProperty(args, "target"),
    textProperty(args, "groupId")
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.some((candidate) => targetMentioned(normalizedMessage, candidate));
}

function targetMentioned(normalizedMessage: string, candidate: string): boolean {
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedCandidate) {
    return false;
  }
  if (normalizedMessage.includes(normalizedCandidate)) {
    return true;
  }
  const words = normalizedCandidate.split(" ").filter((word) => word.length >= 3);
  return words.length > 0 && words.every((word) => normalizedMessage.includes(word));
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toolResultSummary(result: unknown): { count: number; toolNames: string[] } {
  const newItems = arrayProperty(result, "newItems");
  const toolItems = newItems.filter(
    (item) => textProperty(item, "type")?.includes("tool") && textProperty(item, "type") !== "tool_approval_item"
  );
  return {
    count: toolItems.length,
    toolNames: toolItems.flatMap((item) => {
      const raw = rawItem(item);
      const toolName = textProperty(item, "name") ?? textProperty(item, "toolName") ?? textProperty(raw, "name");
      return toolName ? [toolName] : [];
    })
  };
}

function rawItem(value: unknown): unknown {
  return valueProperty(value, "rawItem");
}

function arrayProperty(value: unknown, key: string): unknown[] {
  const nested = valueProperty(value, key);
  return Array.isArray(nested) ? nested : [];
}

function textProperty(value: unknown, key: string): string | undefined {
  const nested = valueProperty(value, key);
  return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}

function valueProperty(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { raw: value };
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

class NoProgressTracker {
  readonly limit: number;
  repeatCount = 0;
  toolName?: string;
  #lastDigest?: string;
  #argumentsByCallId = new Map<string, unknown>();

  constructor(limit: number) {
    this.limit = Math.max(2, limit);
  }

  observe(event: AgentRuntimeEvent): boolean {
    if (event.type === "tool.started") {
      const data = objectRecord(event.data);
      const callId = textProperty(data, "toolCallId");
      if (callId) {
        this.#argumentsByCallId.set(callId, data.arguments);
      }
      return false;
    }
    if (event.type !== "tool.completed" && event.type !== "tool.failed") {
      return false;
    }
    const data = objectRecord(event.data);
    const callId = textProperty(data, "toolCallId");
    const toolName = textProperty(data, "toolName") ?? "unknown";
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          toolName,
          arguments: callId ? this.#argumentsByCallId.get(callId) : undefined,
          result: sanitizeAgentPayload(data.result)
        })
      )
      .digest("hex");
    if (callId) {
      this.#argumentsByCallId.delete(callId);
    }
    if (digest === this.#lastDigest) {
      this.repeatCount += 1;
    } else {
      this.#lastDigest = digest;
      this.repeatCount = 1;
      this.toolName = toolName;
    }
    return this.repeatCount >= this.limit;
  }
}

function isMaxTurnsExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const sdk = loadOpenAIAgentsSdkRuntime();
  return (
    error instanceof sdk.MaxTurnsExceededError || (error instanceof Error && error.name === "MaxTurnsExceededError")
  );
}

function maxTurnsRunState(error: unknown): unknown {
  return error && typeof error === "object" && "state" in error ? (error as { state?: unknown }).state : undefined;
}

function loadRunnerConstructor(): new (options?: Record<string, unknown>) => OperatorAgentRunner {
  const sdk = loadOpenAIAgentsSdkRuntime();
  return sdk.Runner;
}

function loadOpenAIAgentsSdkRuntime(): {
  Runner: new (options?: Record<string, unknown>) => OperatorAgentRunner;
  MaxTurnsExceededError: new (message: string, state?: unknown) => Error;
} {
  return loadOpenAIAgentsSdkRuntimeRequire("@openai/agents") as {
    Runner: new (options?: Record<string, unknown>) => OperatorAgentRunner;
    MaxTurnsExceededError: new (message: string, state?: unknown) => Error;
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> & { completed?: Promise<void> } {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

function extractModelDelta(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const data = "data" in event ? (event as { data?: unknown }).data : undefined;
  if (!data || typeof data !== "object") {
    return undefined;
  }
  if ("delta" in data && typeof (data as { delta?: unknown }).delta === "string") {
    return (data as { delta: string }).delta;
  }
  return undefined;
}

function handleSdkStreamEvent(
  event: unknown,
  emitDelta: (delta: string) => void,
  emitEvent: (event: AgentRuntimeEvent) => void,
  processing: ModelProcessingTracker
): void {
  processing.observe(event);
  const delta = extractModelDelta(event);
  if (delta) {
    processing.complete();
    emitDelta(delta);
  }

  if (!event || typeof event !== "object") {
    return;
  }
  if (textProperty(event, "type") !== "run_item_stream_event") {
    return;
  }

  const name = textProperty(event, "name");
  const item = valueProperty(event, "item");
  const raw = valueProperty(item, "rawItem") ?? item;
  if (name === "handoff_requested" || name === "handoff_occurred") {
    processing.complete();
    emitEvent({
      type: name === "handoff_requested" ? "agent.handoff_started" : "agent.handoff_completed",
      data: {
        handoffId: textProperty(item, "id") ?? textProperty(raw, "id"),
        targetAgent: textProperty(item, "targetAgent") ?? textProperty(raw, "targetAgent")
      }
    });
    return;
  }
  if (name === "tool_search_called" || name === "tool_search_output_created") {
    processing.complete();
    emitEvent({
      type: name === "tool_search_called" ? "tool.search_started" : "tool.search_completed",
      data: { searchId: textProperty(item, "id") ?? textProperty(raw, "id") }
    });
    return;
  }
  if (name === "tool_called") {
    processing.complete();
    const toolName = textProperty(item, "name") ?? textProperty(raw, "name");
    if (!toolName) {
      return;
    }
    const toolCallId = textProperty(item, "callId") ?? textProperty(raw, "callId") ?? textProperty(raw, "id");
    const rawArguments = valueProperty(item, "arguments") ?? valueProperty(raw, "arguments");
    const args = parseArguments(rawArguments);
    emitEvent({
      type: "tool.call_requested",
      data: {
        ...(toolCallId ? { toolCallId } : {}),
        toolName,
        arguments: args
      }
    });
    if (evaluateToolPolicy(toolName, args).status === "allowed") {
      emitEvent({
        type: "tool.started",
        data: {
          ...(toolCallId ? { toolCallId } : {}),
          toolName,
          arguments: args
        }
      });
    }
    return;
  }

  if (name !== "tool_output") {
    return;
  }

  const toolName = textProperty(item, "name") ?? textProperty(raw, "name");
  if (!toolName) {
    return;
  }
  const toolCallId = textProperty(item, "callId") ?? textProperty(raw, "callId") ?? textProperty(raw, "id");
  const output = parseToolOutput(valueProperty(item, "output") ?? valueProperty(raw, "output"));
  const status = outputStatus(output);
  emitEvent({
    type: status === "succeeded" ? "tool.completed" : "tool.failed",
    data: {
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      result: output
    }
  });
  processing.noteToolResult();

  if (toolName === "preview_setup_writes" && status === "succeeded") {
    const data = output && typeof output === "object" ? (output as { data?: unknown }).data : undefined;
    emitEvent({
      type: "setup.plan_preview",
      data: {
        setupPlanPreview: data ?? output
      }
    });
  }
}

class ModelProcessingTracker {
  readonly #emit: (event: AgentRuntimeEvent) => void;
  #active?: { turnId: string; responseId?: string; label: string; completedLabel: string };
  #turn = 0;
  #reviewingToolResult = false;

  constructor(emit: (event: AgentRuntimeEvent) => void) {
    this.#emit = emit;
  }

  begin(): void {
    this.#start();
  }

  observe(event: unknown): void {
    if (textProperty(event, "type") !== "raw_model_stream_event") {
      return;
    }
    const data = valueProperty(event, "data");
    const eventType = textProperty(data, "type") ?? "";
    if (eventType === "response.created" || eventType === "response.in_progress") {
      this.#start(textProperty(valueProperty(data, "response"), "id") ?? textProperty(data, "response_id"));
      return;
    }
    if (eventType === "response.completed") {
      this.complete();
      return;
    }
    if (eventType === "response.failed" || eventType === "response.incomplete") {
      this.fail();
    }
  }

  noteToolResult(): void {
    this.#reviewingToolResult = true;
  }

  complete(): void {
    this.#finish("model.processing_completed");
  }

  fail(): void {
    this.#finish("model.processing_failed");
  }

  #start(responseId?: string): void {
    if (this.#active) {
      return;
    }
    this.#turn += 1;
    const label = this.#reviewingToolResult ? "Reviewing tool result" : "Thinking";
    const completedLabel = this.#reviewingToolResult ? "Reviewed tool result" : "Thought";
    this.#reviewingToolResult = false;
    this.#active = {
      turnId: String(this.#turn),
      ...(responseId ? { responseId } : {}),
      label,
      completedLabel
    };
    this.#emit({ type: "model.processing_started", data: { ...this.#active } });
  }

  #finish(type: "model.processing_completed" | "model.processing_failed"): void {
    if (!this.#active) {
      return;
    }
    this.#emit({ type, data: { ...this.#active } });
    this.#active = undefined;
  }
}

function parseToolOutput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function outputStatus(value: unknown): string | undefined {
  return value && typeof value === "object" && typeof (value as { status?: unknown }).status === "string"
    ? String((value as { status: string }).status)
    : undefined;
}

import { createRequire } from "node:module";

const loadOpenAIAgentsSdkRuntimeRequire = createRequire(import.meta.url);
