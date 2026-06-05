import type { RelaybaseRuntime } from "../server.ts";
import { buildOperatorPromptContext, type OperatorPromptContext } from "./context.ts";
import { AgentRuntimeError, diagnosticFromRuntimeError, redactAgentText, sanitizeAgentPayload } from "./errors.ts";
import type { AgentRuntimeEvent } from "./events.ts";
import { createOperatorAgent, operatorAgentToolNames } from "./operatorAgent.ts";
import { evaluateToolPolicy, outputGuardrail } from "./policy.ts";
import { createOpenRouterAgentProvider } from "./provider/openrouter.ts";
import { buildOperatorPromptInput } from "./prompts.ts";
import type {
  AgentConfig,
  AgentDiagnostic,
  AgentMessage,
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
}

export interface OperatorAgentRunner {
  run(agent: unknown, input: string, options?: Record<string, unknown>): Promise<any>;
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
  threadContext?: AgentThreadContextPreview;
  emit: (event: AgentRuntimeEvent) => void;
  knownSecrets?: string[];
}

export interface OperatorAgentRuntimeResult {
  status: "completed" | "failed" | "waiting_for_approval";
  assistantContent?: string;
  diagnostics: AgentDiagnostic[];
  promptContext: OperatorPromptContext;
  toolNames: string[];
  pendingApprovals?: OperatorAgentPendingApprovalRequest[];
  usage?: AgentUsage;
}

export interface OperatorAgentPendingApprovalRequest {
  toolCallId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  expectedResult: string;
  risk: "low" | "medium" | "high";
  rawItem?: unknown;
}

export class OperatorAgentRuntime {
  #runnerFactory?: OperatorAgentRunnerFactory;
  #timeoutMs: number;
  #maxTurns: number;

  constructor(options: OperatorAgentRuntimeOptions = {}) {
    this.#runnerFactory = options.runnerFactory;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxTurns = options.maxTurns ?? 8;
  }

  initialize(config: AgentConfig): { modelSlug: string; toolNames: string[] } {
    if (!config.provider.modelSlug) {
      throw new AgentRuntimeError("AGENT_MODEL_MISSING", "No OpenRouter model slug is configured.", {
        userAction: "Configure a model slug before initializing the Operator Agent runtime."
      });
    }
    createOpenRouterAgentProvider(config);
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

      const provider = createOpenRouterAgentProvider(input.config);
      const promptContext = await buildOperatorPromptContext(input.relaybase, input.context, input.threadContext);
      const { agent, toolNames } = createOperatorAgent({
        modelSlug: input.config.provider.modelSlug,
        runtime: input.relaybase,
        tuiContext: input.context,
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
            effort: "medium"
          },
          toolNames,
          promptContextIncluded: {
            stateSummary: true,
            selectedContext: true,
            currentCwd: Boolean(promptContext.currentCwd)
          }
        }
      });

      const result = await this.#runWithTimeout(
        runner,
        agent,
        prompt,
        (delta) => {
          input.emit({
            type: "model.delta",
            data: {
              delta: redactAgentText(delta, knownSecrets)
            }
          });
        },
        (event) => input.emit(event)
      );
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
            decision: evaluateToolPolicy(interruption.toolName, interruption.arguments)
          }))
          .find((entry) => entry.decision.status === "blocked");
        if (blocked?.decision.diagnostic) {
          input.emit({ type: "diagnostic", data: blocked.decision.diagnostic });
          input.emit({
            type: "blocked",
            data: {
              kind: "blocked",
              content: blocked.decision.diagnostic.message,
              diagnostic: blocked.decision.diagnostic
            }
          });
          return {
            status: "failed",
            diagnostics: [blocked.decision.diagnostic],
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
      const outputDiagnostic = outputGuardrail(output, toolResultCount(result));
      if (outputDiagnostic) {
        input.emit({ type: "diagnostic", data: outputDiagnostic });
        input.emit({
          type: "blocked",
          data: {
            kind: "blocked",
            content: outputDiagnostic.message,
            diagnostic: outputDiagnostic
          }
        });
        return {
          status: "failed",
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

  async #runWithTimeout(
    runner: OperatorAgentRunner,
    agent: unknown,
    prompt: string,
    emitDelta: (delta: string) => void,
    emitEvent: (event: AgentRuntimeEvent) => void
  ): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const runPromise = runner.run(agent, prompt, {
        stream: true,
        maxTurns: this.#maxTurns,
        signal: controller.signal
      });
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            reject(
              new AgentRuntimeError("AGENT_PROVIDER_TIMEOUT", "Operator Agent provider request timed out.", {
                retryable: true,
                userAction: "Retry the request or choose a faster OpenRouter model."
              })
            ),
          { once: true }
        );
      });
      const result = await Promise.race([runPromise, timeoutPromise]);
      if (isAsyncIterable(result)) {
        await Promise.race([
          (async () => {
            for await (const event of result) {
              handleSdkStreamEvent(event, emitDelta, emitEvent);
            }
            await result.completed;
          })(),
          timeoutPromise
        ]);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

function usageFromResult(result: unknown): AgentUsage {
  const rawResponses = arrayProperty(result, "rawResponses");
  const usage = valueProperty(result, "usage") ?? valueProperty(rawResponses.at(-1), "usage");
  const record = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  const inputTokens = numeric(record.inputTokens ?? record.promptTokens ?? record.input_tokens ?? record.prompt_tokens);
  const outputTokens = numeric(
    record.outputTokens ?? record.completionTokens ?? record.output_tokens ?? record.completion_tokens
  );
  const totalTokens = numeric(record.totalTokens ?? record.total_tokens) || inputTokens + outputTokens;
  const estimatedCostUsd = numeric(record.estimatedCostUsd ?? record.totalCostUsd ?? record.costUsd ?? record.cost_usd);
  return { inputTokens, outputTokens, totalTokens, estimatedCostUsd };
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function toolResultCount(result: unknown): number {
  const newItems = arrayProperty(result, "newItems");
  return newItems.filter(
    (item) => textProperty(item, "type")?.includes("tool") && textProperty(item, "type") !== "tool_approval_item"
  ).length;
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

function loadRunnerConstructor(): new (options?: Record<string, unknown>) => OperatorAgentRunner {
  const sdk = loadOpenAIAgentsSdkRuntime();
  return sdk.Runner;
}

function loadOpenAIAgentsSdkRuntime(): { Runner: new (options?: Record<string, unknown>) => OperatorAgentRunner } {
  return loadOpenAIAgentsSdkRuntimeRequire("@openai/agents") as {
    Runner: new (options?: Record<string, unknown>) => OperatorAgentRunner;
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
  emitEvent: (event: AgentRuntimeEvent) => void
): void {
  const delta = extractModelDelta(event);
  if (delta) {
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
  if (name === "tool_called") {
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
