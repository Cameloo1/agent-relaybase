import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultAgentConfig } from "../src/agent/gateway.ts";
import { resolveOpenRouterProviderOptions } from "../src/agent/openrouterProvider.ts";
import { formatRelaybaseEnvFileDiagnostics, loadRelaybaseEnvFile, relaybaseModelSource } from "../src/envFile.ts";

test("Relaybase .env loader reads local env files without exposing values in result metadata", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-env-file-"));
  await fs.writeFile(
    path.join(project, ".env"),
    [
      "# local Relaybase agent config",
      "OPENROUTER_API_KEY=sk-or-env-file-secret",
      "RELAYBASE_AGENT_MODEL=openrouter/test-model",
      "RELAYBASE_AGENT_ENABLED=1",
      "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1",
      'OPENROUTER_TITLE="Relaybase Local"',
      "OPENROUTER_HTTP_REFERER=https://relaybase.local # local attribution"
    ].join("\n"),
    "utf8"
  );
  const env: NodeJS.ProcessEnv = {};

  const result = loadRelaybaseEnvFile({ cwd: project, env });

  assert.equal(result.loaded, true);
  assert.deepEqual(result.appliedKeys, [
    "OPENROUTER_API_KEY",
    "RELAYBASE_AGENT_MODEL",
    "RELAYBASE_AGENT_ENABLED",
    "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED",
    "OPENROUTER_TITLE",
    "OPENROUTER_HTTP_REFERER"
  ]);
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-env-file-secret");
  assert.equal(env.RELAYBASE_AGENT_MODEL, "openrouter/test-model");
  assert.equal(env.RELAYBASE_AGENT_ENABLED, "1");
  assert.equal(env.RELAYBASE_AGENT_REMOTE_MODEL_ENABLED, "1");
  assert.equal(env.OPENROUTER_TITLE, "Relaybase Local");
  assert.equal(env.OPENROUTER_HTTP_REFERER, "https://relaybase.local");
  assert.deepEqual(relaybaseModelSource(result, env), { kind: "cwd_env_file", label: ".env" });
  assert.match(result.fingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /sk-or-env-file-secret|openrouter\/test-model/);
});

test("Relaybase .env loader keeps existing shell environment values authoritative", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-env-precedence-"));
  await fs.writeFile(
    path.join(project, ".env"),
    "OPENROUTER_API_KEY=sk-or-file-secret\nRELAYBASE_AGENT_MODEL=openrouter/file-model\n",
    "utf8"
  );
  const env: NodeJS.ProcessEnv = {
    OPENROUTER_API_KEY: "sk-or-shell-secret",
    RELAYBASE_AGENT_MODEL: "openrouter/shell-model"
  };

  const result = loadRelaybaseEnvFile({ cwd: project, env });

  assert.equal(result.loaded, true);
  assert.deepEqual(result.appliedKeys, []);
  assert.deepEqual(result.skippedKeys, ["OPENROUTER_API_KEY", "RELAYBASE_AGENT_MODEL"]);
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-shell-secret");
  assert.equal(env.RELAYBASE_AGENT_MODEL, "openrouter/shell-model");
  assert.deepEqual(relaybaseModelSource(result, env), {
    kind: "shell_environment",
    label: "shell environment"
  });
});

test("Relaybase .env loader supports explicit RELAYBASE_ENV_FILE paths", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-env-explicit-"));
  await fs.writeFile(path.join(project, "relaybase.local.env"), "RELAYBASE_AGENT_MODEL=openrouter/explicit\n", "utf8");
  const env: NodeJS.ProcessEnv = {
    RELAYBASE_ENV_FILE: "relaybase.local.env"
  };

  const result = loadRelaybaseEnvFile({ cwd: project, env });

  assert.equal(result.loaded, true);
  assert.equal(env.RELAYBASE_AGENT_MODEL, "openrouter/explicit");
  assert.deepEqual(relaybaseModelSource(result, env), {
    kind: "explicit_env_file",
    label: "RELAYBASE_ENV_FILE"
  });
});

test("Relaybase .env diagnostics fail closed without printing secret-like values", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-env-invalid-"));
  await fs.writeFile(path.join(project, ".env"), "OPENROUTER_API_KEY sk-or-invalid-secret\n", "utf8");

  const result = loadRelaybaseEnvFile({ cwd: project, env: {} });
  const formatted = formatRelaybaseEnvFileDiagnostics(result);

  assert.equal(result.loaded, false);
  assert.equal(result.diagnostics[0]?.code, "ENV_FILE_INVALID_LINE");
  assert.match(formatted, /ENV_FILE_INVALID_LINE/);
  assert.doesNotMatch(formatted, /sk-or-invalid-secret/);
});

test("OpenRouter provider can resolve key and model after Relaybase loads .env", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-env-openrouter-"));
  await fs.writeFile(
    path.join(project, ".env"),
    "OPENROUTER_API_KEY=sk-or-loaded-secret\nRELAYBASE_AGENT_MODEL=openrouter/test-model\n",
    "utf8"
  );
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousModel = process.env.RELAYBASE_AGENT_MODEL;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.RELAYBASE_AGENT_MODEL;
  try {
    const loaded = loadRelaybaseEnvFile({ cwd: project });
    assert.equal(loaded.loaded, true);

    const resolved = resolveOpenRouterProviderOptions();
    assert.equal(resolved.apiKeyEnvVar, "OPENROUTER_API_KEY");
    assert.equal(resolved.modelSlug, "openrouter/test-model");
  } finally {
    restoreEnv("OPENROUTER_API_KEY", previousKey);
    restoreEnv("RELAYBASE_AGENT_MODEL", previousModel);
  }
});

test("Relaybase .env can make daemon Agent Gateway config ready without API config writes", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-env-agent-ready-"));
  await fs.writeFile(
    path.join(project, ".env"),
    [
      "OPENROUTER_API_KEY=sk-or-ready-secret",
      "RELAYBASE_AGENT_MODEL=google/gemini-3.1-flash-lite",
      "RELAYBASE_AGENT_ENABLED=1",
      "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1"
    ].join("\n"),
    "utf8"
  );
  const previous = saveEnv([
    "OPENROUTER_API_KEY",
    "RELAYBASE_AGENT_MODEL",
    "RELAYBASE_AGENT_ENABLED",
    "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED"
  ]);
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.RELAYBASE_AGENT_MODEL;
  delete process.env.RELAYBASE_AGENT_ENABLED;
  delete process.env.RELAYBASE_AGENT_REMOTE_MODEL_ENABLED;

  try {
    const loaded = loadRelaybaseEnvFile({ cwd: project });
    assert.equal(loaded.loaded, true);

    const config = defaultAgentConfig(process.env, relaybaseModelSource(loaded));
    assert.equal(config.enabled, true);
    assert.equal(config.provider.remoteModelEnabled, true);
    assert.equal(config.provider.modelSlug, "google/gemini-3.1-flash-lite");
    assert.equal(config.provider.modelSource.kind, "cwd_env_file");
    assert.equal(config.toolAllowlistMode, "all_registered");
    assert.equal(config.provider.apiKeySource.configured, true);
    assert.doesNotMatch(JSON.stringify(config), /sk-or-ready-secret/);
  } finally {
    restoreEnvValues(previous);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function saveEnv(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvValues(values: Map<string, string | undefined>): void {
  for (const [name, value] of values.entries()) {
    restoreEnv(name, value);
  }
}
