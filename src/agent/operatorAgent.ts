import { loadOpenAIAgentsSdk } from "./openrouterProvider.ts";
import { OPERATOR_AGENT_NAME, operatorAgentInstructions } from "./prompts.ts";
import type { RelaybaseRuntime } from "../server.ts";
import type { AgentConfig, AgentProjectRootGrant, AgentRunEventType, TuiAgentContext } from "./types.ts";
import {
  createRelaybaseAgentToolRegistry,
  relaybaseAgentReadOnlyToolNames,
  relaybaseAgentToolNames
} from "./tools/index.ts";

export type OperatorAgentReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export const DEFAULT_OPERATOR_AGENT_REASONING_EFFORT: OperatorAgentReasoningEffort = "medium";

export function createOperatorAgent(input: {
  modelSlug: string;
  runtime: RelaybaseRuntime;
  tuiContext: TuiAgentContext;
  projectRootGrants?: readonly AgentProjectRootGrant[];
  config?: AgentConfig;
  reasoningEffort?: OperatorAgentReasoningEffort;
  maxOutputTokens?: number;
  emit?: (event: { type: AgentRunEventType; data: unknown }) => void;
}): {
  agent: unknown;
  toolNames: string[];
} {
  const { Agent } = loadOpenAIAgentsSdk();
  const registry = createRelaybaseAgentToolRegistry({
    runtime: input.runtime,
    tuiContext: input.tuiContext,
    projectRootGrants: input.projectRootGrants,
    config: input.config,
    emit: input.emit
  });
  const agent = new Agent({
    name: OPERATOR_AGENT_NAME,
    model: input.modelSlug,
    instructions: operatorAgentInstructions(),
    modelSettings: operatorAgentModelSettings(input.reasoningEffort, input.maxOutputTokens),
    tools: registry.sdkTools
  });
  return { agent, toolNames: registry.toolNames };
}

export function operatorAgentModelSettings(
  effort = DEFAULT_OPERATOR_AGENT_REASONING_EFFORT,
  maxOutputTokens = 4096
): Record<string, unknown> {
  return {
    maxTokens: maxOutputTokens,
    parallelToolCalls: false,
    providerData: {
      reasoning: {
        enabled: true,
        effort
      }
    }
  };
}

export function operatorAgentToolNames(): string[] {
  return relaybaseAgentToolNames();
}

export function operatorAgentReadOnlyToolNames(): string[] {
  return relaybaseAgentReadOnlyToolNames();
}
