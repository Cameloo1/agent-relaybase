import type { AgentConfig } from "../types.ts";
import { createOpenRouterCompatibility, type OpenRouterCompatibility } from "../openrouterProvider.ts";

export function createOpenRouterAgentProvider(config: AgentConfig): OpenRouterCompatibility {
  return createOpenRouterCompatibility({
    apiKeyEnvVar: config.provider.apiKeySource.envVar,
    modelSlug: config.provider.modelSlug,
    httpRefererEnvVar: config.provider.httpRefererEnvVar,
    titleEnvVar: config.provider.titleEnvVar,
    timeoutMs: 60_000,
    maxRetries: 1
  });
}
