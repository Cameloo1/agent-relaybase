#!/usr/bin/env node

import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deadlineMs = 30_000;
const fixtureModelA = "openrouter/runtime-smoke-a";
const fixtureModelB = "openrouter/runtime-smoke-b";

export async function runAgentConfigRuntimeSmoke() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "relaybase-agent-config-smoke-"));
  const stateDir = path.join(workspace, "state");
  const configPath = path.join(workspace, "agent.env");
  const port = await availablePort();
  await writeConfig(configPath, fixtureModelA);
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      path.join(root, "src", "cli.ts"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--state-dir",
      stateDir,
      "--agent-config",
      configPath
    ],
    {
      cwd: root,
      env: scrubAgentEnvironment(process.env),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const discovery = await waitForJson(`http://127.0.0.1:${port}/.well-known/mcp.json`, deadlineMs);
    const firstStatus = await runCliJson(
      ["agent", "config", "status", "--port", String(port), "--state-dir", stateDir, "--json"],
      deadlineMs
    );
    const firstConfig = firstStatus.agent?.config;
    assert(firstConfig?.provider?.modelSlug === fixtureModelA, "initial CLI status did not use explicit config");
    assert(firstConfig?.source?.mode === "external_file", "initial source mode was not external_file");
    const firstRevision = firstConfig?.revision?.id;
    assert(typeof firstRevision === "string" && firstRevision, "initial config revision is missing");

    await writeConfig(configPath, fixtureModelB);
    const reload = await runCliJson(
      ["agent", "config", "reload", "--port", String(port), "--state-dir", stateDir, "--json"],
      deadlineMs
    );
    assert(reload.agent?.reload?.status === "applied", "CLI reload did not apply the changed explicit config");
    const secondStatus = await runCliJson(
      ["agent", "config", "status", "--port", String(port), "--state-dir", stateDir, "--json"],
      deadlineMs
    );
    const secondConfig = secondStatus.agent?.config;
    assert(secondConfig?.provider?.modelSlug === fixtureModelB, "next status did not expose the new model revision");
    assert(secondConfig?.revision?.id !== firstRevision, "config revision did not change after a valid reload");

    const token = (await readFile(path.join(stateDir, "session-token"), "utf8")).trim();
    const restartPreview = await fetchJson(
      `http://127.0.0.1:${port}/__hub/api/daemon/restart-preview`,
      deadlineMs,
      token
    );
    assert(restartPreview.restart?.preview?.canRestart === true, "isolated daemon restart preview was not ready");
    assert(
      restartPreview.restart?.preview?.instanceId === discovery.daemon?.instanceId,
      "restart preview was not bound to the discovered daemon instance"
    );

    return {
      ok: true,
      port,
      sourceMode: secondConfig.source.mode,
      firstRevision,
      secondRevision: secondConfig.revision.id,
      reloadStatus: reload.agent.reload.status,
      restartPreviewReady: true
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nDaemon stdout:\n${bounded(stdout)}\nDaemon stderr:\n${bounded(stderr)}`,
      { cause: error }
    );
  } finally {
    await stopChild(child);
    await waitForPortClosed(port, 5000);
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeConfig(configPath, model) {
  await writeFile(
    configPath,
    [
      "RELAYBASE_AGENT_ENABLED=false",
      "RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=false",
      `RELAYBASE_AGENT_MODEL=${model}`,
      ""
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 }
  );
}

function scrubAgentEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => key !== "OPENROUTER_API_KEY" && !key.startsWith("RELAYBASE_AGENT_"))
  );
}

async function availablePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(url, 1000);
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function fetchJson(url, timeoutMs, token) {
  const response = await fetch(url, {
    headers: token ? { "x-relaybase-token": token } : {},
    signal: globalThis.AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}`);
  }
  return body;
}

async function runCliJson(args, timeoutMs) {
  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    env: scrubAgentEnvironment(process.env),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await Promise.race([
    once(child, "exit").then(([code]) => code),
    delay(timeoutMs).then(() => {
      child.kill();
      throw new Error(`CLI timed out: ${args.slice(0, 3).join(" ")}`);
    })
  ]);
  if (exitCode !== 0) {
    throw new Error(`CLI failed (${exitCode}): ${bounded(stderr || stdout)}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`CLI returned invalid JSON: ${bounded(stdout)}`);
  }
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  const stopped = await Promise.race([once(child, "exit").then(() => true), delay(3000).then(() => false)]);
  if (!stopped && process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore"
    });
    await Promise.race([once(child, "exit"), delay(2000)]);
  }
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const timeout = setTimeout(() => finish(false), 250);
      const finish = (value) => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (!connected) return;
    await delay(50);
  }
  throw new Error(`Isolated daemon port ${port} remained open after shutdown.`);
}

function bounded(value) {
  const text = String(value ?? "").trim();
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAgentConfigRuntimeSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
