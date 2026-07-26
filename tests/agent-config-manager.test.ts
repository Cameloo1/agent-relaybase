import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentConfigManager, AgentConfigResolutionError } from "../src/agent/configManager.ts";
import { defaultAgentConfig } from "../src/agent/gateway.ts";
import { loadRelaybaseEnvFile, relaybaseModelSource } from "../src/envFile.ts";

const INITIAL_SECRET = "sk-or-fixture-config-initial";
const ROTATED_SECRET = "sk-or-fixture-config-rotated";

test("Agent config manager reloads one stable external revision and pins existing run snapshots", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-config-manager-"));
  const envPath = path.join(project, "agent.env");
  await writeFixtureEnvironment(envPath, "openrouter/fixture-one", INITIAL_SECRET);
  const environment: NodeJS.ProcessEnv = {};
  const loaded = loadRelaybaseEnvFile({ cwd: project, env: environment, filePath: envPath });
  const manager = new AgentConfigManager({
    initialConfig: defaultAgentConfig(environment, relaybaseModelSource(loaded, environment)),
    environment: {
      envFilePath: loaded.path,
      envFileFingerprint: loaded.fingerprint,
      envFileAppliedKeys: loaded.appliedKeys,
      envFileSkippedKeys: loaded.skippedKeys,
      envFileSourceKind: loaded.sourceKind
    },
    shellEnvironment: environment
  });

  const initial = manager.getSafeState();
  assert.equal(initial.readiness, "ready");
  assert.equal(initial.provider.modelSlug, "openrouter/fixture-one");
  assert.equal(initial.provider.apiKeySource.configured, true);
  assert.equal(initial.source?.label, "RELAYBASE_ENV_FILE");
  assert.doesNotMatch(JSON.stringify(initial), new RegExp(INITIAL_SECRET));

  const pinned = await manager.resolveForNewRun();
  await writeFixtureEnvironment(envPath, "openrouter/fixture-two", ROTATED_SECRET);
  const firstReload = manager.reload();
  const collapsedReload = manager.reload();
  assert.equal(firstReload, collapsedReload);
  const reload = await firstReload;
  assert.equal(reload.status, "applied");
  assert.ok(reload.changedFields.includes("modelSlug"));
  assert.ok(reload.changedFields.includes("credential"));
  assert.notEqual(reload.oldRevisionId, reload.newRevisionId);

  const next = await manager.resolveForNewRun();
  try {
    assert.equal(pinned.config.provider.modelSlug, "openrouter/fixture-one");
    assert.equal(pinned.credentialLease.value(), INITIAL_SECRET);
    assert.equal(next.config.provider.modelSlug, "openrouter/fixture-two");
    assert.equal(next.credentialLease.value(), ROTATED_SECRET);
    assert.notEqual(next.revisionId, pinned.revisionId);
  } finally {
    pinned.credentialLease.dispose();
    next.credentialLease.dispose();
  }
});

test("Agent config manager blocks invalid or removed external secrets without replacing last-known-good config", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-config-invalid-"));
  const envPath = path.join(project, "agent.env");
  await writeFixtureEnvironment(envPath, "openrouter/fixture-safe", INITIAL_SECRET);
  const environment: NodeJS.ProcessEnv = {};
  const loaded = loadRelaybaseEnvFile({ cwd: project, env: environment, filePath: envPath });
  const manager = new AgentConfigManager({
    initialConfig: defaultAgentConfig(environment, relaybaseModelSource(loaded, environment)),
    environment: {
      envFilePath: loaded.path,
      envFileFingerprint: loaded.fingerprint,
      envFileAppliedKeys: loaded.appliedKeys,
      envFileSkippedKeys: loaded.skippedKeys,
      envFileSourceKind: loaded.sourceKind
    },
    shellEnvironment: environment
  });
  const revision = manager.getSafeState().revision?.id;

  await fs.writeFile(envPath, 'RELAYBASE_AGENT_MODEL="unterminated\n', "utf8");
  const invalid = await manager.reload({ force: true });
  assert.equal(invalid.status, "blocked");
  assert.equal(invalid.newRevisionId, revision);
  assert.equal(manager.getSafeState().source?.health, "invalid");
  assert.equal(manager.activeConfig().provider.modelSlug, "openrouter/fixture-safe");

  await fs.writeFile(
    envPath,
    [
      "RELAYBASE_AGENT_MODEL=openrouter/fixture-safe",
      "RELAYBASE_AGENT_ENABLED=1",
      "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1"
    ].join("\n"),
    "utf8"
  );
  const removed = await manager.reload({ force: true });
  assert.equal(removed.status, "applied");
  assert.ok(removed.changedFields.includes("credential"));
  await assert.rejects(
    manager.resolveForNewRun(),
    (error: unknown) =>
      error instanceof AgentConfigResolutionError && error.diagnostic.code === "AGENT_CREDENTIAL_MISSING"
  );
});

test("Agent config manager keeps shell-owned credentials as an immutable startup snapshot", async () => {
  const environment: NodeJS.ProcessEnv = {
    RELAYBASE_AGENT_ENABLED: "1",
    RELAYBASE_AGENT_REMOTE_MODEL_ENABLED: "1",
    RELAYBASE_AGENT_MODEL: "openrouter/startup-model",
    OPENROUTER_API_KEY: INITIAL_SECRET
  };
  const manager = new AgentConfigManager({
    initialConfig: defaultAgentConfig(environment),
    shellEnvironment: environment
  });
  environment.OPENROUTER_API_KEY = ROTATED_SECRET;
  environment.RELAYBASE_AGENT_MODEL = "openrouter/changed-after-startup";

  const resolved = await manager.resolveForNewRun();
  try {
    assert.equal(resolved.credentialLease.value(), INITIAL_SECRET);
    assert.equal(resolved.config.provider.modelSlug, "openrouter/startup-model");
  } finally {
    resolved.credentialLease.dispose();
  }
});

async function writeFixtureEnvironment(filePath: string, model: string, credential: string): Promise<void> {
  await fs.writeFile(
    filePath,
    [
      `RELAYBASE_AGENT_MODEL=${model}`,
      "RELAYBASE_AGENT_ENABLED=1",
      "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1",
      `OPENROUTER_API_KEY=${credential}`,
      "OPENROUTER_TITLE=Relaybase fixture"
    ].join("\n"),
    "utf8"
  );
}
