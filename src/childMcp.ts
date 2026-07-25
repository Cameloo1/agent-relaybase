import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AppRecord,
  ChildMcpConfig,
  ChildMcpDrainResult,
  ChildMcpRuntimeStatus,
  ChildMcpRuntimeView
} from "./types.ts";

const DRAIN_TIMEOUT_MS = 3000;
const INITIAL_RESTART_BACKOFF_MS = 1000;
const MAX_RESTART_BACKOFF_MS = 30000;

export type ChildMcpEvent =
  | { type: "log"; appId: string; childId: string; level: "info" | "warning" | "error"; message: string }
  | { type: "list_changed"; appId: string; childId: string; list: "tools" | "resources" | "prompts" };

type ChildTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

interface ExposedTool {
  originalName: string;
  tool: Tool;
}

interface ExposedResource {
  originalUri: string;
  resource: Resource;
}

interface ExposedPrompt {
  originalName: string;
  prompt: Prompt;
}

interface ChildRuntime {
  app: AppRecord;
  config: ChildMcpConfig;
  status: ChildMcpRuntimeStatus;
  client?: Client;
  transport?: ChildTransport;
  exposedTools: Map<string, ExposedTool>;
  exposedResources: Map<string, ExposedResource>;
  exposedPrompts: Map<string, ExposedPrompt>;
  inFlight: number;
  restartAttempts: number;
  acceptingCalls: boolean;
  closing: boolean;
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastError?: string;
  nextRestartAt?: string;
  restartTimer?: NodeJS.Timeout;
  drainResolved?: () => void;
}

interface AppMcpRuntime {
  appId: string;
  children: Map<string, ChildRuntime>;
}

export class ChildMcpSupervisor {
  #apps = new Map<string, AppMcpRuntime>();
  #listeners = new Set<(event: ChildMcpEvent) => void>();
  #sanitizeEnvironment: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

  constructor(options: { sanitizeEnvironment?: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv } = {}) {
    this.#sanitizeEnvironment = options.sanitizeEnvironment ?? ((environment) => ({ ...environment }));
  }

  onEvent(listener: (event: ChildMcpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async startApp(app: AppRecord): Promise<ChildMcpRuntimeView[]> {
    await this.stopApp(app.id, { drainTimeoutMs: 0, quiet: true });

    const appRuntime: AppMcpRuntime = {
      appId: app.id,
      children: new Map()
    };
    this.#apps.set(app.id, appRuntime);

    if (!app.mcp?.enabled) {
      return [];
    }

    for (const config of app.mcp.children) {
      const child: ChildRuntime = {
        app,
        config,
        status: "stopped",
        exposedTools: new Map(),
        exposedResources: new Map(),
        exposedPrompts: new Map(),
        inFlight: 0,
        restartAttempts: 0,
        acceptingCalls: false,
        closing: false
      };
      appRuntime.children.set(config.id, child);
      await this.#connectChild(child);
    }

    return this.statusForApp(app.id);
  }

  async stopApp(
    appId: string,
    options: { drainTimeoutMs?: number; quiet?: boolean } = {}
  ): Promise<ChildMcpDrainResult[]> {
    const runtime = this.#apps.get(appId);
    if (!runtime) {
      return [];
    }

    const timeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    const results: ChildMcpDrainResult[] = [];
    for (const child of runtime.children.values()) {
      results.push(await this.#stopChild(child, timeoutMs, options.quiet ?? false));
    }

    this.#apps.delete(appId);
    return results;
  }

  statusForApp(appId: string): ChildMcpRuntimeView[] {
    const runtime = this.#apps.get(appId);
    if (!runtime) {
      return [];
    }

    return [...runtime.children.values()].map((child) => this.#view(child));
  }

  listTools(): Tool[] {
    const tools: Tool[] = [];
    for (const child of this.#children()) {
      for (const exposed of child.exposedTools.values()) {
        tools.push({ ...exposed.tool });
      }
    }

    return tools.sort((a, b) => a.name.localeCompare(b.name));
  }

  listResources(): Resource[] {
    const resources: Resource[] = [];
    for (const child of this.#children()) {
      for (const exposed of child.exposedResources.values()) {
        resources.push({ ...exposed.resource });
      }
    }

    return resources.sort((a, b) => a.uri.localeCompare(b.uri));
  }

  listPrompts(): Prompt[] {
    const prompts: Prompt[] = [];
    for (const child of this.#children()) {
      for (const exposed of child.exposedPrompts.values()) {
        prompts.push({ ...exposed.prompt });
      }
    }

    return prompts.sort((a, b) => a.name.localeCompare(b.name));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const match = this.#findTool(name);
    if (!match) {
      throw new Error(`Unknown child MCP tool: ${name}`);
    }

    const { child, exposed } = match;
    this.#assertCallable(child);
    child.inFlight += 1;
    try {
      return (await child.client!.callTool({
        name: exposed.originalName,
        arguments: args
      })) as CallToolResult;
    } finally {
      this.#completeInFlight(child);
    }
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const match = this.#findResource(uri);
    if (!match) {
      throw new Error(`Unknown child MCP resource: ${uri}`);
    }

    const { child, exposed } = match;
    this.#assertCallable(child);
    child.inFlight += 1;
    try {
      const result = await child.client!.readResource({ uri: exposed.originalUri });
      return {
        ...result,
        contents: result.contents.map((content) => ({
          ...content,
          uri: relaybaseChildResourceUri(child.app.id, content.uri)
        }))
      };
    } finally {
      this.#completeInFlight(child);
    }
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<GetPromptResult> {
    const match = this.#findPrompt(name);
    if (!match) {
      throw new Error(`Unknown child MCP prompt: ${name}`);
    }

    const { child, exposed } = match;
    this.#assertCallable(child);
    child.inFlight += 1;
    try {
      return await child.client!.getPrompt({
        name: exposed.originalName,
        arguments: args
      });
    } finally {
      this.#completeInFlight(child);
    }
  }

  async close(): Promise<void> {
    const appIds = [...this.#apps.keys()];
    for (const appId of appIds) {
      await this.stopApp(appId, { drainTimeoutMs: 0, quiet: true });
    }
  }

  async #connectChild(child: ChildRuntime): Promise<void> {
    child.status = "starting";
    child.acceptingCalls = false;
    child.closing = false;
    child.lastStartedAt = new Date().toISOString();
    child.lastError = undefined;
    child.nextRestartAt = undefined;
    let client: Client | undefined;
    let transport: ChildTransport | undefined;

    try {
      client = new Client(
        {
          name: `relaybase-${child.app.id}-${child.config.id}`,
          version: "0.1.0"
        },
        {
          listChanged: {
            tools: {
              debounceMs: 0,
              onChanged: (error, tools) => void this.#handleChildListChanged(child, "tools", error, tools)
            },
            resources: {
              debounceMs: 0,
              onChanged: (error, resources) => void this.#handleChildListChanged(child, "resources", error, resources)
            },
            prompts: {
              debounceMs: 0,
              onChanged: (error, prompts) => void this.#handleChildListChanged(child, "prompts", error, prompts)
            }
          }
        }
      );
      transport = await this.#createTransport(child);
      transport.onclose = () => void this.#handleChildClosed(child);
      transport.onerror = (error) => {
        child.lastError = error.message;
        this.#emit({
          type: "log",
          appId: child.app.id,
          childId: child.config.id,
          level: "error",
          message: error.message
        });
      };

      child.client = client;
      child.transport = transport;
      await client.connect(transport);
      await this.#refreshChildListings(child);
      child.status = "connected";
      child.acceptingCalls = true;
      child.restartAttempts = 0;
      this.#emit({
        type: "log",
        appId: child.app.id,
        childId: child.config.id,
        level: "info",
        message: "Child MCP server connected."
      });
      this.#emitListChanged(child);
    } catch (error) {
      if (client && child.client === client) {
        child.client = undefined;
      }
      if (transport && child.transport === transport) {
        child.transport = undefined;
      }
      try {
        await client?.close();
      } catch {
        // The failed connect path is already reported below.
      }
      child.status = "errored";
      child.acceptingCalls = false;
      child.lastError = error instanceof Error ? error.message : String(error);
      this.#emit({
        type: "log",
        appId: child.app.id,
        childId: child.config.id,
        level: "error",
        message: `Child MCP server failed: ${child.lastError}`
      });
      this.#scheduleRestart(child);
    }
  }

  async #createTransport(child: ChildRuntime): Promise<ChildTransport> {
    const config = child.config;
    if (config.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command!,
        args: config.args,
        cwd: config.cwd,
        env: Object.fromEntries(
          Object.entries(
            this.#sanitizeEnvironment({
              ...process.env,
              ...config.env,
              RELAYBASE_APP_ID: child.app.id,
              RELAYBASE_CHILD_MCP_ID: config.id
            })
          ).filter((entry): entry is [string, string] => typeof entry[1] === "string")
        ),
        stderr: "pipe"
      });
      transport.stderr?.on("data", (chunk) => {
        this.#emit({
          type: "log",
          appId: child.app.id,
          childId: config.id,
          level: "info",
          message: chunk.toString().trim()
        });
      });
      return transport;
    }

    if (config.transport === "sse") {
      return new SSEClientTransport(new URL(config.legacySseUrl ?? config.url!));
    }

    try {
      return new StreamableHTTPClientTransport(new URL(config.url!));
    } catch (error) {
      if (!config.legacySseUrl) {
        throw error;
      }

      return new SSEClientTransport(new URL(config.legacySseUrl));
    }
  }

  async #refreshChildListings(child: ChildRuntime): Promise<void> {
    await Promise.all([this.#refreshTools(child), this.#refreshResources(child), this.#refreshPrompts(child)]);
  }

  async #refreshTools(child: ChildRuntime, tools?: Tool[] | null): Promise<void> {
    try {
      const listed = tools ?? (await child.client!.listTools()).tools;
      const allow = new Set(child.config.expose.tools);
      child.exposedTools = new Map(
        listed
          .filter((tool) => allow.has(tool.name))
          .map((tool) => [
            namespaceChildName(child.app.id, tool.name),
            {
              originalName: tool.name,
              tool: {
                ...tool,
                name: namespaceChildName(child.app.id, tool.name),
                description: tool.description ?? `Child MCP tool ${tool.name} from ${child.app.id}.`
              }
            }
          ])
      );
    } catch (error) {
      child.exposedTools = new Map();
      child.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async #refreshResources(child: ChildRuntime, resources?: Resource[] | null): Promise<void> {
    try {
      const listed = resources ?? (await child.client!.listResources()).resources;
      const allow = new Set(child.config.expose.resources);
      child.exposedResources = new Map(
        listed
          .filter((resource) => allow.has(resource.uri))
          .map((resource) => [
            relaybaseChildResourceUri(child.app.id, resource.uri),
            {
              originalUri: resource.uri,
              resource: {
                ...resource,
                uri: relaybaseChildResourceUri(child.app.id, resource.uri),
                name: `${child.app.id}.${resource.name}`
              }
            }
          ])
      );
    } catch (error) {
      child.exposedResources = new Map();
      child.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async #refreshPrompts(child: ChildRuntime, prompts?: Prompt[] | null): Promise<void> {
    try {
      const listed = prompts ?? (await child.client!.listPrompts()).prompts;
      const allow = new Set(child.config.expose.prompts);
      child.exposedPrompts = new Map(
        listed
          .filter((prompt) => allow.has(prompt.name))
          .map((prompt) => [
            namespaceChildName(child.app.id, prompt.name),
            {
              originalName: prompt.name,
              prompt: {
                ...prompt,
                name: namespaceChildName(child.app.id, prompt.name),
                description: prompt.description ?? `Child MCP prompt ${prompt.name} from ${child.app.id}.`
              }
            }
          ])
      );
    } catch (error) {
      child.exposedPrompts = new Map();
      child.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async #handleChildListChanged(
    child: ChildRuntime,
    list: "tools" | "resources" | "prompts",
    error: Error | null,
    items: Tool[] | Resource[] | Prompt[] | null
  ): Promise<void> {
    if (error) {
      child.lastError = error.message;
      this.#emit({
        type: "log",
        appId: child.app.id,
        childId: child.config.id,
        level: "warning",
        message: `Child MCP ${list} refresh failed: ${error.message}`
      });
      return;
    }

    if (list === "tools") {
      await this.#refreshTools(child, items as Tool[] | null);
    } else if (list === "resources") {
      await this.#refreshResources(child, items as Resource[] | null);
    } else {
      await this.#refreshPrompts(child, items as Prompt[] | null);
    }

    this.#emit({ type: "list_changed", appId: child.app.id, childId: child.config.id, list });
  }

  async #handleChildClosed(child: ChildRuntime): Promise<void> {
    child.acceptingCalls = false;
    child.lastStoppedAt = new Date().toISOString();
    child.exposedTools.clear();
    child.exposedResources.clear();
    child.exposedPrompts.clear();
    this.#emitListChanged(child);

    if (child.closing) {
      child.status = "stopped";
      return;
    }

    child.status = "errored";
    child.lastError = "Child MCP server connection closed.";
    this.#emit({
      type: "log",
      appId: child.app.id,
      childId: child.config.id,
      level: "warning",
      message: "Child MCP server closed; scheduling restart."
    });
    this.#scheduleRestart(child);
  }

  #scheduleRestart(child: ChildRuntime): void {
    if (child.closing) {
      return;
    }
    if (child.restartTimer) {
      return;
    }

    child.restartAttempts += 1;
    child.status = "restarting";
    const delay = Math.min(INITIAL_RESTART_BACKOFF_MS * 2 ** (child.restartAttempts - 1), MAX_RESTART_BACKOFF_MS);
    child.nextRestartAt = new Date(Date.now() + delay).toISOString();
    child.restartTimer = setTimeout(() => {
      child.restartTimer = undefined;
      void this.#connectChild(child);
    }, delay);
    child.restartTimer.unref();
    this.#emit({
      type: "log",
      appId: child.app.id,
      childId: child.config.id,
      level: "warning",
      message: `Restarting child MCP server in ${delay}ms.`
    });
  }

  async #stopChild(child: ChildRuntime, timeoutMs: number, quiet: boolean): Promise<ChildMcpDrainResult> {
    if (child.restartTimer) {
      clearTimeout(child.restartTimer);
      child.restartTimer = undefined;
    }

    child.closing = true;
    child.acceptingCalls = false;
    child.status = child.client ? "draining" : "stopped";
    const inFlightAtDrainStart = child.inFlight;
    const timedOut = await this.#waitForDrain(child, timeoutMs);

    try {
      await child.client?.close();
    } catch (error) {
      child.lastError = error instanceof Error ? error.message : String(error);
    }

    child.status = "stopped";
    child.lastStoppedAt = new Date().toISOString();
    child.exposedTools.clear();
    child.exposedResources.clear();
    child.exposedPrompts.clear();
    if (!quiet) {
      this.#emit({
        type: "log",
        appId: child.app.id,
        childId: child.config.id,
        level: "info",
        message: "Child MCP server stopped."
      });
      this.#emitListChanged(child);
    }

    return {
      id: child.config.id,
      inFlightAtDrainStart,
      pendingAfterTimeout: child.inFlight,
      timedOut,
      stopped: true
    };
  }

  #waitForDrain(child: ChildRuntime, timeoutMs: number): Promise<boolean> {
    if (child.inFlight === 0 || timeoutMs <= 0) {
      return Promise.resolve(child.inFlight > 0);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.drainResolved = undefined;
        resolve(true);
      }, timeoutMs);
      child.drainResolved = () => {
        clearTimeout(timer);
        child.drainResolved = undefined;
        resolve(false);
      };
    });
  }

  #assertCallable(child: ChildRuntime): void {
    if (!child.client || child.status !== "connected" || !child.acceptingCalls) {
      throw new Error(`Child MCP server ${child.app.id}/${child.config.id} is not accepting calls.`);
    }
  }

  #completeInFlight(child: ChildRuntime): void {
    child.inFlight = Math.max(0, child.inFlight - 1);
    if (child.inFlight === 0) {
      child.drainResolved?.();
    }
  }

  #findTool(name: string): { child: ChildRuntime; exposed: ExposedTool } | undefined {
    for (const child of this.#children()) {
      const exposed = child.exposedTools.get(name);
      if (exposed) {
        return { child, exposed };
      }
    }

    return undefined;
  }

  #findResource(uri: string): { child: ChildRuntime; exposed: ExposedResource } | undefined {
    for (const child of this.#children()) {
      const exposed = child.exposedResources.get(uri);
      if (exposed) {
        return { child, exposed };
      }
    }

    return undefined;
  }

  #findPrompt(name: string): { child: ChildRuntime; exposed: ExposedPrompt } | undefined {
    for (const child of this.#children()) {
      const exposed = child.exposedPrompts.get(name);
      if (exposed) {
        return { child, exposed };
      }
    }

    return undefined;
  }

  #children(): ChildRuntime[] {
    const children: ChildRuntime[] = [];
    for (const runtime of this.#apps.values()) {
      for (const child of runtime.children.values()) {
        children.push(child);
      }
    }

    return children;
  }

  #view(child: ChildRuntime): ChildMcpRuntimeView {
    return {
      id: child.config.id,
      transport: child.config.transport,
      status: child.status,
      exposedTools: [...child.exposedTools.keys()].sort(),
      exposedResources: [...child.exposedResources.keys()].sort(),
      exposedPrompts: [...child.exposedPrompts.keys()].sort(),
      inFlight: child.inFlight,
      restartAttempts: child.restartAttempts,
      ...(child.lastStartedAt ? { lastStartedAt: child.lastStartedAt } : {}),
      ...(child.lastStoppedAt ? { lastStoppedAt: child.lastStoppedAt } : {}),
      ...(child.lastError ? { lastError: child.lastError } : {}),
      ...(child.nextRestartAt ? { nextRestartAt: child.nextRestartAt } : {})
    };
  }

  #emitListChanged(child: ChildRuntime): void {
    this.#emit({ type: "list_changed", appId: child.app.id, childId: child.config.id, list: "tools" });
    this.#emit({ type: "list_changed", appId: child.app.id, childId: child.config.id, list: "resources" });
    this.#emit({ type: "list_changed", appId: child.app.id, childId: child.config.id, list: "prompts" });
  }

  #emit(event: ChildMcpEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

export function namespaceChildName(appId: string, name: string): string {
  return `${appId}.${name}`;
}

export function relaybaseChildResourceUri(appId: string, resourceUri: string): string {
  return `relaybase://app/${appId}/mcp/${resourceUri}`;
}
