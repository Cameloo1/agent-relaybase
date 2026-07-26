import { z } from "zod";
import { sanitizeErrorDetail } from "../apiErrors.ts";
import {
  createOpenRouterCompatibility,
  formatOpenRouterProviderError,
  loadOpenAIAgentsSdk,
  OpenRouterProviderError,
  type OpenRouterProviderOptions,
  type OpenRouterSafeConfig
} from "./openrouterProvider.ts";

export interface OpenRouterSmokeResult {
  ok: true;
  provider: "openrouter";
  safeConfig: OpenRouterSafeConfig;
  checks: {
    basicCompletion: OpenRouterSmokeCheck;
    harmlessToolCall: OpenRouterSmokeCheck;
    streaming: OpenRouterSmokeCheck;
  };
  forkRequired: false;
}

export interface OpenRouterSmokeCheck {
  status: "passed";
  evidence: string;
}

export async function runOpenRouterSmoke(options: OpenRouterProviderOptions = {}): Promise<OpenRouterSmokeResult> {
  const compatibility = createOpenRouterCompatibility(options);
  const { Runner } = loadOpenAIAgentsSdk();
  const runner = new Runner({
    modelProvider: compatibility.modelProvider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false
  });

  const basicCompletion = await smokeBasicCompletion(runner, compatibility.safeConfig.modelSlug);
  const harmlessToolCall = await smokeHarmlessToolCall(runner, compatibility.safeConfig.modelSlug);
  const streaming = await smokeStreaming(runner, compatibility.safeConfig.modelSlug);

  return {
    ok: true,
    provider: "openrouter",
    safeConfig: compatibility.safeConfig,
    checks: {
      basicCompletion,
      harmlessToolCall,
      streaming
    },
    forkRequired: false
  };
}

export function printOpenRouterSmokeResult(result: OpenRouterSmokeResult): void {
  console.log("Relaybase OpenRouter compatibility smoke");
  console.log(`provider: ${result.provider}`);
  console.log(`model: ${result.safeConfig.modelSlug}`);
  console.log(`sdk: ${result.safeConfig.sdk.package} via ${result.safeConfig.sdk.modelTransport}`);
  console.log(`fork required: ${result.forkRequired ? "yes" : "no"}`);
  for (const [name, check] of Object.entries(result.checks)) {
    console.log(`${name}: ${check.status} - ${check.evidence}`);
  }
}

export function formatOpenRouterSmokeError(error: unknown): string {
  if (error instanceof OpenRouterProviderError) {
    return formatOpenRouterProviderError(error);
  }
  const sanitized = sanitizeErrorDetail(error);
  const message =
    sanitized && typeof sanitized === "object" && "message" in sanitized
      ? String((sanitized as { message: unknown }).message)
      : String(sanitized);
  return `OPENROUTER_SMOKE_FAILED: ${message}`;
}

async function smokeBasicCompletion(runner: OpenRouterRunner, modelSlug: string): Promise<OpenRouterSmokeCheck> {
  const { Agent } = loadOpenAIAgentsSdk();
  const agent = new Agent({
    name: "Relaybase OpenRouter Basic Smoke",
    model: modelSlug,
    instructions: "Reply with the exact token relaybase_openrouter_basic_ok and no extra text."
  });
  const result = await runner.run(agent, "Return the exact token relaybase_openrouter_basic_ok.", { maxTurns: 1 });
  const output = String(result.finalOutput ?? "");
  if (!output.includes("relaybase_openrouter_basic_ok")) {
    throw new Error("OPENROUTER_BASIC_COMPLETION_FAILED: model did not return the expected smoke token.");
  }
  return {
    status: "passed",
    evidence: "model returned expected smoke token"
  };
}

async function smokeHarmlessToolCall(runner: OpenRouterRunner, modelSlug: string): Promise<OpenRouterSmokeCheck> {
  const { Agent, tool } = loadOpenAIAgentsSdk();
  let toolCallCount = 0;
  const harmlessTool = tool({
    name: "relaybase_harmless_echo",
    description: "Return the provided value for Relaybase OpenRouter compatibility testing.",
    parameters: z.object({
      value: z.string()
    }),
    execute: ({ value }: { value: string }) => {
      toolCallCount += 1;
      return `relaybase_tool_call_ok:${value}`;
    }
  });
  const agent = new Agent({
    name: "Relaybase OpenRouter Tool Smoke",
    model: modelSlug,
    instructions:
      "You must call the relaybase_harmless_echo tool exactly once with value relaybase_tool_call_ok. Do not answer without using the tool.",
    tools: [harmlessTool],
    toolUseBehavior: { stopAtToolNames: ["relaybase_harmless_echo"] }
  });
  const result = await runner.run(agent, "Use the harmless tool now.", { maxTurns: 2 });
  const output = String(result.finalOutput ?? "");
  if (toolCallCount < 1 || !output.includes("relaybase_tool_call_ok")) {
    throw new Error(
      "BLOCKED_OPENROUTER_TOOL_CALL_UNSUPPORTED: selected model did not complete the harmless function-tool call."
    );
  }
  return {
    status: "passed",
    evidence: "selected model called harmless function tool"
  };
}

async function smokeStreaming(runner: OpenRouterRunner, modelSlug: string): Promise<OpenRouterSmokeCheck> {
  const { Agent } = loadOpenAIAgentsSdk();
  const agent = new Agent({
    name: "Relaybase OpenRouter Streaming Smoke",
    model: modelSlug,
    instructions: "Reply with the exact token relaybase_openrouter_stream_ok and no extra text."
  });
  const result = await runner.run(agent, "Return the exact token relaybase_openrouter_stream_ok.", {
    stream: true,
    maxTurns: 1
  });
  let eventCount = 0;
  for await (const _event of result) {
    eventCount += 1;
  }
  await result.completed;
  const output = String(result.finalOutput ?? "");
  if (eventCount < 1 || !output.includes("relaybase_openrouter_stream_ok")) {
    throw new Error("BLOCKED_OPENROUTER_STREAMING_UNSUPPORTED: selected model did not complete streaming smoke.");
  }
  return {
    status: "passed",
    evidence: `stream completed with ${eventCount} SDK events`
  };
}

interface OpenRouterRunner {
  run(agent: unknown, input: string, options?: Record<string, unknown>): Promise<any>;
}
