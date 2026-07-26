import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentConfigManager } from "../src/agent/configManager.ts";
import type { CredentialDescriptor, CredentialStore, StoredCredential } from "../src/agent/credentialStore.ts";
import { AgentGatewayService, defaultAgentConfig } from "../src/agent/gateway.ts";
import {
  OpenRouterConnectionManager,
  type OpenRouterConnectionAttemptState
} from "../src/agent/openrouterConnection.ts";

const OLD_SECRET = "sk-or-fixture-provider-old";
const NEW_SECRET = "sk-or-fixture-provider-new";

test("OpenRouter PKCE connection validates and activates a protected credential without exposing it", async () => {
  const store = new FixtureCredentialStore();
  const configManager = fixtureConfigManager(store);
  const requests: Array<{ url: string; body?: string; authorization?: string }> = [];
  const connection = new OpenRouterConnectionManager({
    configManager,
    attemptTtlMs: 5_000,
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        body: typeof init?.body === "string" ? init.body : undefined,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined
      });
      if (url.endsWith("/api/v1/auth/keys")) {
        return Response.json({ key: NEW_SECRET });
      }
      return Response.json({
        data: {
          label: "Relaybase fixture key",
          limit: 5,
          limit_remaining: 4.5,
          limit_reset: "monthly",
          expires_at: "2026-12-01T00:00:00.000Z"
        }
      });
    }
  });

  try {
    const attempt = await connection.start("connect");
    assert.equal(attempt.status, "waiting_for_browser");
    assert.match(attempt.authorizationUrl ?? "", /^https:\/\/openrouter\.ai\/auth\?/);
    assert.doesNotMatch(JSON.stringify(attempt), new RegExp(NEW_SECRET));
    const callback = callbackUrl(attempt);
    callback.searchParams.set("code", "fixture-authorization-code");
    assert.equal(await get(callback), 200);

    const completed = await waitForTerminal(connection, attempt.attemptId);
    assert.equal(completed.status, "connected");
    assert.equal(completed.authorizationUrl, undefined);
    assert.doesNotMatch(JSON.stringify(completed), new RegExp(NEW_SECRET));
    const exchange = requests.find((request) => request.url.endsWith("/api/v1/auth/keys"));
    assert.match(exchange?.body ?? "", /"code_verifier":"[^"]+"/);
    assert.match(exchange?.body ?? "", /"code_challenge_method":"S256"/);
    const exchangePayload = JSON.parse(exchange?.body ?? "{}") as { code_verifier?: string };
    const authorization = new URL(attempt.authorizationUrl ?? "");
    assert.equal(
      authorization.searchParams.get("code_challenge"),
      createHash("sha256")
        .update(exchangePayload.code_verifier ?? "")
        .digest("base64url")
    );
    const validation = requests.find((request) => request.url.endsWith("/api/v1/key"));
    assert.equal(validation?.authorization, `Bearer ${NEW_SECRET}`);

    const safe = configManager.getSafeState();
    assert.equal(safe.credential?.connection, "connected");
    assert.equal(safe.credential?.protection, "windows-dpapi-current-user");
    assert.equal(safe.credential?.keyLabel, "Relaybase fixture key");
    assert.equal(safe.credential?.limitUsd, 5);
    assert.doesNotMatch(JSON.stringify(safe), new RegExp(NEW_SECRET));
  } finally {
    connection.close();
  }
});

test("OpenRouter replacement preserves the old credential after callback state mismatch", async () => {
  const store = new FixtureCredentialStore();
  const configManager = fixtureConfigManager(store);
  const old = Buffer.from(OLD_SECRET);
  await configManager.storeManagedCredential(old);
  old.fill(0);
  const oldCredentialID = configManager.getSafeState().credential?.credentialId;
  const connection = new OpenRouterConnectionManager({
    configManager,
    attemptTtlMs: 5_000,
    fetch: async () => {
      throw new Error("provider fetch must not run for a rejected callback");
    }
  });

  try {
    const attempt = await connection.start("replace");
    const callback = callbackUrl(attempt);
    callback.searchParams.set("state", "mismatched-state");
    callback.searchParams.set("code", "must-not-be-used");
    assert.equal(await get(callback), 400);
    const completed = connection.status(attempt.attemptId);
    assert.equal(completed?.status, "failed");
    assert.equal(completed?.diagnostic?.code, "AGENT_PROVIDER_CONNECTION_STATE_MISMATCH");
    assert.equal(configManager.getSafeState().credential?.credentialId, oldCredentialID);
    assert.equal(store.read(oldCredentialID ?? ""), OLD_SECRET);
  } finally {
    connection.close();
  }
});

test("managed credential replacement preserves the old reference when durable readback fails", async () => {
  const store = new FixtureCredentialStore();
  const configManager = fixtureConfigManager(store);
  const old = Buffer.from(OLD_SECRET);
  await configManager.storeManagedCredential(old);
  old.fill(0);
  const oldCredentialID = configManager.getSafeState().credential?.credentialId;

  store.corruptNextReadback();
  const candidate = Buffer.from(NEW_SECRET);
  try {
    await assert.rejects(configManager.storeManagedCredential(candidate), /durable readback verification/);
  } finally {
    candidate.fill(0);
  }
  assert.equal(configManager.getSafeState().credential?.credentialId, oldCredentialID);
  assert.equal(store.read(oldCredentialID ?? ""), OLD_SECRET);
});

test("OpenRouter validation outage stores candidate as unverified and blocks remote runs", async () => {
  const store = new FixtureCredentialStore();
  const configManager = fixtureConfigManager(store);
  const connection = new OpenRouterConnectionManager({
    configManager,
    attemptTtlMs: 5_000,
    fetch: async (input) => {
      if (String(input).endsWith("/api/v1/auth/keys")) {
        return Response.json({ key: NEW_SECRET });
      }
      throw new Error("fixture provider unavailable");
    }
  });

  try {
    const attempt = await connection.start();
    const callback = callbackUrl(attempt);
    callback.searchParams.set("code", "fixture-code");
    assert.equal(await get(callback), 200);
    const completed = await waitForTerminal(connection, attempt.attemptId);
    assert.equal(completed.status, "connected_unverified");
    assert.equal(configManager.getSafeState().credential?.connection, "connected_unverified");
    await assert.rejects(configManager.resolveForNewRun(), /has not been validated/);
  } finally {
    connection.close();
  }
});

test("an unverified managed credential remains unverified across config-manager restart recovery", async () => {
  const store = new FixtureCredentialStore();
  const first = fixtureConfigManager(store);
  const secret = Buffer.from(NEW_SECRET);
  await first.storeManagedCredential(secret, { verified: false });
  secret.fill(0);

  const restarted = new AgentConfigManager({
    initialConfig: first.activeConfig(),
    shellEnvironment: {},
    credentialStore: store,
    managedCredentialState: first.managedCredentialPersistenceState()
  });
  await restarted.refreshManagedCredentialState();
  assert.equal(restarted.getSafeState().credential?.connection, "connected_unverified");
  await assert.rejects(restarted.resolveForNewRun(), /has not been validated/);
  const metadata = await restarted.validateManagedCredential(async (credential) => {
    assert.equal(credential, NEW_SECRET);
    return { limitUsd: 3, limitRemainingUsd: 2.5, limitReset: "monthly" };
  });
  assert.equal(metadata.limitUsd, 3);
  assert.equal(restarted.getSafeState().credential?.connection, "connected");
  assert.equal(restarted.managedCredentialPersistenceState()?.verified, true);
});

test("Agent config status silently recovers a persisted DPAPI credential on its first read", async () => {
  await withAgentControlEnvironment({}, async () => {
    await withPersistedManagedCredentialGateway(async (gateway) => {
      assert.equal(gateway.getConfig().credential?.connection, "disconnected");
      const status = await gateway.getConfigStatus();
      assert.equal(status.enabled, true);
      assert.equal(status.provider.remoteModelEnabled, true);
      assert.equal(status.credential?.connection, "connected");
      assert.equal(status.provider.apiKeySource.configured, true);
      assert.equal(status.readiness, "ready");
      assert.doesNotMatch(JSON.stringify(status), new RegExp(NEW_SECRET));
    });
  });
});

test("Agent config status recovers a persisted credential without bypassing explicit disabled controls", async () => {
  await withAgentControlEnvironment(
    {
      RELAYBASE_AGENT_ENABLED: "0",
      RELAYBASE_AGENT_REMOTE_MODEL_ENABLED: "0"
    },
    async () => {
      await withPersistedManagedCredentialGateway(async (gateway) => {
        assert.equal(gateway.getConfig().credential?.connection, "disconnected");
        const status = await gateway.getConfigStatus();
        assert.equal(status.enabled, false);
        assert.equal(status.provider.remoteModelEnabled, false);
        assert.equal(status.credential?.connection, "connected");
        assert.equal(status.provider.apiKeySource.configured, true);
        assert.equal(status.readiness, "disabled");
        assert.doesNotMatch(JSON.stringify(status), new RegExp(NEW_SECRET));
      });
    }
  );
});

test("Agent provider browser launch uses only the safe authorization URL and a scrubbed child environment", async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = NEW_SECRET;
  let openedUrl = "";
  let openedEnv: NodeJS.ProcessEnv = {};
  const gateway = new AgentGatewayService({
    openExternalUrl: (url, env) => {
      openedUrl = url;
      openedEnv = env;
      return true;
    }
  });
  try {
    const attempt = await gateway.connectOpenRouter("connect", { openBrowser: true });
    assert.equal(attempt.browserOpen, "opened");
    assert.match(openedUrl, /^https:\/\/openrouter\.ai\/auth\?/);
    assert.equal(openedEnv.OPENROUTER_API_KEY, undefined);
    assert.doesNotMatch(JSON.stringify({ attempt, openedEnv }), new RegExp(NEW_SECRET));
  } finally {
    await gateway.close();
    if (previous === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previous;
    }
  }
});

test("a missing managed credential fails closed and updates safe status after the next run boundary", async () => {
  const store = new FixtureCredentialStore();
  const configManager = fixtureConfigManager(store);
  const secret = Buffer.from(NEW_SECRET);
  const descriptor = await configManager.storeManagedCredential(secret);
  secret.fill(0);
  store.drop(descriptor.credentialId);

  await assert.rejects(configManager.resolveForNewRun(), /managed OpenRouter credential is unavailable/);
  const safe = configManager.getSafeState();
  assert.equal(safe.credential?.connection, "disconnected");
  assert.equal(safe.readiness, "needs_configuration");
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(NEW_SECRET));
});

test("OpenRouter connection expiration closes the callback and clears the authorization URL", async () => {
  const connection = new OpenRouterConnectionManager({
    configManager: fixtureConfigManager(new FixtureCredentialStore()),
    attemptTtlMs: 20,
    fetch: async () => {
      throw new Error("provider fetch must not run for an expired attempt");
    }
  });
  try {
    const attempt = await connection.start();
    const expired = await waitForTerminal(connection, attempt.attemptId);
    assert.equal(expired.status, "expired");
    assert.equal(expired.authorizationUrl, undefined);
    await assert.rejects(get(callbackUrl(attempt)));
  } finally {
    connection.close();
  }
});

test("oversized OpenRouter responses fail with a safe diagnostic and no credential activation", async () => {
  const configManager = fixtureConfigManager(new FixtureCredentialStore());
  const connection = new OpenRouterConnectionManager({
    configManager,
    attemptTtlMs: 5_000,
    fetch: async () => new Response(JSON.stringify({ key: "x".repeat(70 * 1024) }))
  });
  try {
    const attempt = await connection.start();
    const callback = callbackUrl(attempt);
    callback.searchParams.set("code", "fixture-code");
    assert.equal(await get(callback), 200);
    const completed = await waitForTerminal(connection, attempt.attemptId);
    assert.equal(completed.status, "failed");
    assert.equal(completed.diagnostic?.code, "AGENT_PROVIDER_RESPONSE_TOO_LARGE");
    assert.equal(configManager.getSafeState().credential?.connection, "disconnected");
    assert.doesNotMatch(JSON.stringify(completed), /x{100}/);
  } finally {
    connection.close();
  }
});

function fixtureConfigManager(store: CredentialStore): AgentConfigManager {
  return new AgentConfigManager({
    initialConfig: defaultAgentConfig({
      RELAYBASE_AGENT_ENABLED: "1",
      RELAYBASE_AGENT_REMOTE_MODEL_ENABLED: "1",
      RELAYBASE_AGENT_MODEL: "openrouter/fixture"
    }),
    shellEnvironment: {},
    credentialStore: store
  });
}

async function withPersistedManagedCredentialGateway(
  callback: (gateway: AgentGatewayService) => Promise<void>
): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-status-recovery-"));
  const store = new FixtureCredentialStore();
  const secret = Buffer.from(NEW_SECRET);
  const stored = await store.put("openrouter", secret);
  secret.fill(0);
  await fs.mkdir(path.join(stateDir, "agent"), { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "agent", "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      provider: {
        modelSlug: "openrouter/test-model",
        apiKeySourceType: "managed_windows_dpapi",
        credentialId: stored.credentialId,
        credentialState: {
          verified: true,
          lastValidatedAt: "2026-07-24T00:00:00.000Z"
        },
        remoteModelEnabled: true
      }
    }),
    "utf8"
  );
  const gateway = new AgentGatewayService({ stateDir, credentialStore: store });
  try {
    await callback(gateway);
  } finally {
    await gateway.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function withAgentControlEnvironment(values: NodeJS.ProcessEnv, callback: () => Promise<void>): Promise<void> {
  const names = ["RELAYBASE_AGENT_ENABLED", "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED", "RELAYBASE_AGENT_MODEL"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    const value = values[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    await callback();
  } finally {
    for (const [name, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function callbackUrl(attempt: OpenRouterConnectionAttemptState): URL {
  const authorization = new URL(attempt.authorizationUrl ?? "");
  return new URL(authorization.searchParams.get("callback_url") ?? "");
}

async function waitForTerminal(
  connection: OpenRouterConnectionManager,
  attemptID: string
): Promise<OpenRouterConnectionAttemptState> {
  for (let count = 0; count < 100; count += 1) {
    const state = connection.status(attemptID);
    if (state && ["connected", "connected_unverified", "cancelled", "expired", "failed"].includes(state.status)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture connection did not reach a terminal state");
}

function get(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
  });
}

class FixtureCredentialStore implements CredentialStore {
  #values = new Map<string, Buffer>();
  #counter = 0;
  #corruptNextRead = false;

  available(): boolean {
    return true;
  }

  protectionMode(): "windows-dpapi-current-user" {
    return "windows-dpapi-current-user";
  }

  async put(_provider: "openrouter", secret: Buffer): Promise<CredentialDescriptor> {
    const credentialId = `00000000-0000-4000-8000-${String(++this.#counter).padStart(12, "0")}`;
    this.#values.set(credentialId, Buffer.from(secret));
    return descriptor(credentialId);
  }

  async get(credentialId: string): Promise<StoredCredential> {
    const secret = this.#values.get(credentialId);
    if (!secret) {
      throw new Error("fixture credential missing");
    }
    const copy = Buffer.from(secret);
    if (this.#corruptNextRead) {
      this.#corruptNextRead = false;
      copy[0] = (copy[0] ?? 0) ^ 0xff;
    }
    return { ...descriptor(credentialId), secret: copy };
  }

  async delete(credentialId: string): Promise<boolean> {
    const existing = this.#values.get(credentialId);
    existing?.fill(0);
    return this.#values.delete(credentialId);
  }

  read(credentialId: string): string | undefined {
    return this.#values.get(credentialId)?.toString("utf8");
  }

  corruptNextReadback(): void {
    this.#corruptNextRead = true;
  }

  drop(credentialId: string): void {
    const existing = this.#values.get(credentialId);
    existing?.fill(0);
    this.#values.delete(credentialId);
  }
}

function descriptor(credentialId: string): CredentialDescriptor {
  return {
    provider: "openrouter",
    credentialId,
    protection: "windows-dpapi-current-user",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}
