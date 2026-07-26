const AGENT_ENVIRONMENT_NAMES = new Set([
  "OPENROUTER_API_KEY",
  "OPENROUTER_HTTP_REFERER",
  "OPENROUTER_TITLE",
  "RELAYBASE_AGENT_MODEL",
  "RELAYBASE_AGENT_ENABLED",
  "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED"
]);

export function withoutAgentCredentialEnvironment(
  source: NodeJS.ProcessEnv,
  additionalCredentialNames: readonly string[] = []
): NodeJS.ProcessEnv {
  const sanitized = { ...source };
  for (const name of [...AGENT_ENVIRONMENT_NAMES, ...additionalCredentialNames]) {
    if (name) {
      delete sanitized[name];
    }
  }
  return sanitized;
}
