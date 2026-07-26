import { createRequire } from "node:module";
import OpenAI from "openai";
import { sanitizeErrorDetail } from "../apiErrors.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";
export const RELAYBASE_AGENT_MODEL_ENV = "RELAYBASE_AGENT_MODEL";
export const OPENROUTER_HTTP_REFERER_ENV = "OPENROUTER_HTTP_REFERER";
export const OPENROUTER_TITLE_ENV = "OPENROUTER_TITLE";
export const OPENROUTER_TITLE_HEADER = "X-OpenRouter-Title";

export type OpenRouterProviderErrorCode =
  | "BLOCKED_OPENROUTER_KEY_MISSING"
  | "BLOCKED_OPENROUTER_MODEL_MISSING"
  | "BLOCKED_OPENROUTER_MODEL_INVALID";

export class OpenRouterProviderError extends Error {
  readonly code: OpenRouterProviderErrorCode;
  readonly userAction: string;
  readonly detail?: unknown;

  constructor(code: OpenRouterProviderErrorCode, message: string, options: { userAction: string; detail?: unknown }) {
    super(`${code}: ${message}`);
    this.code = code;
    this.userAction = options.userAction;
    this.detail = sanitizeErrorDetail(options.detail);
  }
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  apiKeyEnvVar?: string;
  modelSlug?: string;
  baseURL?: string;
  httpReferer?: string;
  httpRefererEnvVar?: string;
  title?: string;
  titleEnvVar?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface OpenRouterSafeConfig {
  provider: "openrouter";
  baseURL: string;
  modelSlug: string;
  apiKeySource: {
    type: "environment" | "direct";
    envVar?: string;
    configured: boolean;
    redacted: "[configured]" | "[missing]";
  };
  headers: {
    httpRefererConfigured: boolean;
    titleConfigured: boolean;
    titleHeader: typeof OPENROUTER_TITLE_HEADER;
  };
  sdk: {
    package: "@openai/agents";
    modelTransport: "chat_completions";
    forkRequired: false;
  };
}

export interface OpenRouterCompatibility {
  client: OpenAI;
  model: OpenRouterModel;
  modelProvider: OpenRouterModelProvider;
  safeConfig: OpenRouterSafeConfig;
}

export function createOpenRouterCompatibility(options: OpenRouterProviderOptions = {}): OpenRouterCompatibility {
  const resolved = resolveOpenRouterProviderOptions(options);
  const headers = buildOpenRouterHeaders(resolved);
  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    defaultHeaders: headers,
    timeout: resolved.timeoutMs,
    maxRetries: resolved.maxRetries ?? 1
  });
  const { OpenAIChatCompletionsModel, OpenAIProvider } = loadOpenAIAgentsSdk();
  const model = new OpenAIChatCompletionsModel(client, resolved.modelSlug, {
    strictFeatureValidation: true
  });
  const modelProvider = new OpenAIProvider({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    useResponses: false,
    strictFeatureValidation: true
  });

  return {
    client,
    model,
    modelProvider,
    safeConfig: safeOpenRouterConfig(resolved)
  };
}

export function loadOpenAIAgentsSdk(): OpenAIAgentsSdkModule {
  return requireAgents("@openai/agents") as OpenAIAgentsSdkModule;
}

export function resolveOpenRouterProviderOptions(options: OpenRouterProviderOptions = {}): RequiredOpenRouterOptions {
  const apiKeyEnvVar = nonEmptyString(options.apiKeyEnvVar, OPENROUTER_KEY_ENV);
  const apiKey = nonEmptyString(options.apiKey, "") || nonEmptyString(process.env[apiKeyEnvVar], "");
  if (!apiKey) {
    throw new OpenRouterProviderError(
      "BLOCKED_OPENROUTER_KEY_MISSING",
      `${apiKeyEnvVar} is not set, so OpenRouter compatibility cannot be smoked.`,
      {
        userAction: `Set ${apiKeyEnvVar} in the daemon environment and rerun npm run agent:smoke:openrouter.`,
        detail: { apiKeyEnvVar }
      }
    );
  }

  const modelSlug = nonEmptyString(options.modelSlug, "") || nonEmptyString(process.env[RELAYBASE_AGENT_MODEL_ENV], "");
  assertValidOpenRouterModelSlug(modelSlug);

  const httpRefererEnvVar = nonEmptyString(options.httpRefererEnvVar, OPENROUTER_HTTP_REFERER_ENV);
  const titleEnvVar = nonEmptyString(options.titleEnvVar, OPENROUTER_TITLE_ENV);

  return {
    apiKey,
    apiKeyEnvVar,
    modelSlug,
    baseURL: nonEmptyString(options.baseURL, OPENROUTER_BASE_URL),
    httpReferer: nonEmptyString(options.httpReferer, "") || nonEmptyString(process.env[httpRefererEnvVar], ""),
    httpRefererEnvVar,
    title: nonEmptyString(options.title, "") || nonEmptyString(process.env[titleEnvVar], ""),
    titleEnvVar,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxRetries: options.maxRetries ?? 1,
    apiKeySourceType: options.apiKey ? "direct" : "environment"
  };
}

export function assertValidOpenRouterModelSlug(modelSlug: string | undefined): asserts modelSlug is string {
  const value = nonEmptyString(modelSlug, "");
  if (!value) {
    throw new OpenRouterProviderError(
      "BLOCKED_OPENROUTER_MODEL_MISSING",
      `${RELAYBASE_AGENT_MODEL_ENV} is not set, so the smoke command has no OpenRouter model to call.`,
      {
        userAction: `Set ${RELAYBASE_AGENT_MODEL_ENV} to a tool-capable OpenRouter model slug before running the smoke.`
      }
    );
  }
  if (hasWhitespaceOrControl(value)) {
    throw new OpenRouterProviderError("BLOCKED_OPENROUTER_MODEL_INVALID", "OpenRouter model slug is invalid.", {
      userAction: "Use an OpenRouter model slug without whitespace or control characters.",
      detail: { modelSlug: value }
    });
  }
}

export function formatOpenRouterProviderError(error: unknown): string {
  if (error instanceof OpenRouterProviderError) {
    const detail = error.detail === undefined ? "" : ` detail=${JSON.stringify(error.detail)}`;
    return `${error.code}: ${error.message}\nAction: ${error.userAction}${detail}`;
  }
  const sanitized = sanitizeErrorDetail(error);
  const message =
    sanitized && typeof sanitized === "object" && "message" in sanitized
      ? String((sanitized as { message: unknown }).message)
      : String(sanitized);
  return `OPENROUTER_COMPATIBILITY_ERROR: ${message}`;
}

function buildOpenRouterHeaders(options: RequiredOpenRouterOptions): Record<string, string> {
  return {
    ...(options.httpReferer ? { "HTTP-Referer": options.httpReferer } : {}),
    ...(options.title ? { [OPENROUTER_TITLE_HEADER]: options.title } : {})
  };
}

function safeOpenRouterConfig(options: RequiredOpenRouterOptions): OpenRouterSafeConfig {
  return {
    provider: "openrouter",
    baseURL: options.baseURL,
    modelSlug: options.modelSlug,
    apiKeySource: {
      type: options.apiKeySourceType,
      ...(options.apiKeySourceType === "environment" ? { envVar: options.apiKeyEnvVar } : {}),
      configured: true,
      redacted: "[configured]"
    },
    headers: {
      httpRefererConfigured: Boolean(options.httpReferer),
      titleConfigured: Boolean(options.title),
      titleHeader: OPENROUTER_TITLE_HEADER
    },
    sdk: {
      package: "@openai/agents",
      modelTransport: "chat_completions",
      forkRequired: false
    }
  };
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function hasWhitespaceOrControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character.trim() === "" || code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

interface RequiredOpenRouterOptions {
  apiKey: string;
  apiKeyEnvVar: string;
  apiKeySourceType: "environment" | "direct";
  modelSlug: string;
  baseURL: string;
  httpReferer: string;
  httpRefererEnvVar: string;
  title: string;
  titleEnvVar: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface OpenRouterModel {
  getResponse?: (...args: unknown[]) => Promise<unknown>;
  getStreamedResponse?: (...args: unknown[]) => AsyncIterable<unknown>;
  constructor: { name: string };
}

export interface OpenRouterModelProvider {
  getModel(modelName?: string): Promise<OpenRouterModel>;
  close?: () => Promise<void>;
}

interface OpenAIAgentsSdkModule {
  Agent: new (options: Record<string, unknown>) => unknown;
  OpenAIChatCompletionsModel: new (
    client: OpenAI,
    model: string,
    options?: { strictFeatureValidation?: boolean }
  ) => OpenRouterModel;
  OpenAIProvider: new (options?: {
    apiKey?: string;
    baseURL?: string;
    useResponses?: boolean;
    strictFeatureValidation?: boolean;
  }) => OpenRouterModelProvider;
  Runner: new (options?: Record<string, unknown>) => {
    run(agent: unknown, input: string, options?: Record<string, unknown>): Promise<any>;
  };
  tool: (options: Record<string, unknown>) => unknown;
}

const requireAgents = createRequire(import.meta.url);
