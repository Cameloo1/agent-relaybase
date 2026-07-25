import type { AgentConfig } from "../types.ts";
import { createOpenRouterCompatibility, type OpenRouterCompatibility } from "../openrouterProvider.ts";

export function createOpenRouterAgentProvider(
  config: AgentConfig,
  credential: string,
  attribution: { httpReferer?: string; title?: string } = {}
): OpenRouterCompatibility {
  return createOpenRouterCompatibility({
    apiKey: credential,
    apiKeyEnvVar: config.provider.apiKeySource.envVar ?? "OPENROUTER_API_KEY",
    modelSlug: config.provider.modelSlug,
    ...(attribution.httpReferer ? { httpReferer: attribution.httpReferer } : {}),
    ...(attribution.title ? { title: attribution.title } : {}),
    httpRefererEnvVar: config.provider.httpRefererEnvVar,
    titleEnvVar: config.provider.titleEnvVar,
    timeoutMs: 60_000,
    maxRetries: 1
  });
}
