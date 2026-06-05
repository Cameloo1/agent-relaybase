import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  createOpenRouterCompatibility,
  formatOpenRouterProviderError,
  OPENROUTER_BASE_URL,
  OpenRouterProviderError,
  resolveOpenRouterProviderOptions
} from "../src/agent/openrouterProvider.ts";

const execFileAsync = promisify(execFile);

test("OpenRouter provider config reads key from env and never exposes raw key in safe config", () => {
  const previousKey = process.env.RELAYBASE_TEST_OPENROUTER_KEY;
  process.env.RELAYBASE_TEST_OPENROUTER_KEY = "sk-or-test-secret-value";
  try {
    const compatibility = createOpenRouterCompatibility({
      apiKeyEnvVar: "RELAYBASE_TEST_OPENROUTER_KEY",
      modelSlug: "openrouter/test-model",
      httpReferer: "https://relaybase.local",
      title: "Relaybase Test"
    });
    assert.equal(compatibility.client.baseURL, OPENROUTER_BASE_URL);
    assert.equal(compatibility.safeConfig.provider, "openrouter");
    assert.equal(compatibility.safeConfig.modelSlug, "openrouter/test-model");
    assert.equal(compatibility.safeConfig.apiKeySource.envVar, "RELAYBASE_TEST_OPENROUTER_KEY");
    assert.equal(compatibility.safeConfig.apiKeySource.configured, true);
    assert.equal(compatibility.safeConfig.headers.httpRefererConfigured, true);
    assert.equal(compatibility.safeConfig.headers.titleConfigured, true);
    assert.equal(compatibility.safeConfig.sdk.modelTransport, "chat_completions");
    assert.equal(compatibility.safeConfig.sdk.forkRequired, false);
    assert.doesNotMatch(JSON.stringify(compatibility.safeConfig), /sk-or-test-secret-value/);
  } finally {
    restoreEnv("RELAYBASE_TEST_OPENROUTER_KEY", previousKey);
  }
});

test("OpenRouter provider can construct a Chat Completions SDK model provider without network", async () => {
  const compatibility = createOpenRouterCompatibility({
    apiKey: "sk-or-direct-secret",
    modelSlug: "openrouter/test-model"
  });
  const model = await compatibility.modelProvider.getModel("openrouter/test-model");
  assert.equal(model.constructor.name, "OpenAIChatCompletionsModel");
  assert.equal(compatibility.model.constructor.name, "OpenAIChatCompletionsModel");
  assert.doesNotMatch(JSON.stringify(compatibility.safeConfig), /sk-or-direct-secret/);
});

test("OpenRouter provider reports missing key as BLOCKED without leaking configured secret-like values", () => {
  const previousKey = process.env.RELAYBASE_TEST_OPENROUTER_KEY_MISSING;
  delete process.env.RELAYBASE_TEST_OPENROUTER_KEY_MISSING;
  try {
    assert.throws(
      () =>
        resolveOpenRouterProviderOptions({
          apiKeyEnvVar: "RELAYBASE_TEST_OPENROUTER_KEY_MISSING",
          modelSlug: "openrouter/test-model"
        }),
      (error) => {
        assert.ok(error instanceof OpenRouterProviderError);
        assert.equal(error.code, "BLOCKED_OPENROUTER_KEY_MISSING");
        const formatted = formatOpenRouterProviderError(error);
        assert.match(formatted, /BLOCKED_OPENROUTER_KEY_MISSING/);
        assert.doesNotMatch(formatted, /sk-/);
        return true;
      }
    );
  } finally {
    restoreEnv("RELAYBASE_TEST_OPENROUTER_KEY_MISSING", previousKey);
  }
});

test("OpenRouter provider validates model slug before network use", () => {
  assert.throws(
    () => resolveOpenRouterProviderOptions({ apiKey: "sk-or-test-secret" }),
    (error) => error instanceof OpenRouterProviderError && error.code === "BLOCKED_OPENROUTER_MODEL_MISSING"
  );
  assert.throws(
    () => resolveOpenRouterProviderOptions({ apiKey: "sk-or-test-secret", modelSlug: "bad slug" }),
    (error) => error instanceof OpenRouterProviderError && error.code === "BLOCKED_OPENROUTER_MODEL_INVALID"
  );
});

test("agent smoke-openrouter command exits BLOCKED when key is missing", async () => {
  const env = {
    ...process.env,
    OPENROUTER_API_KEY: "",
    RELAYBASE_AGENT_MODEL: "openrouter/test-model"
  };
  await assert.rejects(
    execFileAsync(process.execPath, ["--experimental-strip-types", "src/cli.ts", "agent", "smoke-openrouter"], {
      env
    }),
    (error: any) => {
      assert.equal(error.code, 1);
      const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
      assert.match(output, /BLOCKED_OPENROUTER_KEY_MISSING/);
      assert.doesNotMatch(output, /sk-/);
      return true;
    }
  );
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
