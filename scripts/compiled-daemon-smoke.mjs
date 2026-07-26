#!/usr/bin/env node

import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [launcherArgument, stateDirArgument] = process.argv.slice(2);
if (!launcherArgument || !stateDirArgument) {
  throw new Error("Usage: node scripts/compiled-daemon-smoke.mjs <daemon-launcher.js> <disposable-state-dir>");
}

const launcherPath = path.resolve(launcherArgument);
const stateDir = path.resolve(stateDirArgument);
const { discovery, ensureDaemon } = await import(pathToFileURL(launcherPath).href);
const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", resolve);
});
const address = reservation.address();
if (!address || typeof address === "string") {
  throw new Error("Could not reserve a disposable Relaybase port.");
}
const port = address.port;
await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));

const options = { cwd: process.cwd(), host: "127.0.0.1", port, stateDir };
let pid;
let failure;
try {
  const result = await ensureDaemon(options, true);
  pid = result.pid;
  if (!result.reachable || result.code !== "daemon_started" || !pid) {
    throw new Error(`Compiled daemon launcher failed: ${JSON.stringify(result)}`);
  }
  if (result.args?.includes("--experimental-strip-types")) {
    throw new Error("Compiled daemon launcher incorrectly enabled TypeScript stripping.");
  }
  if (
    !result.args?.some(
      (value) => path.basename(value) === "cli.js" && path.basename(path.dirname(value)) === "dist-runtime"
    )
  ) {
    throw new Error(`Compiled daemon launcher did not select dist-runtime/cli.js: ${JSON.stringify(result.args)}`);
  }
  const probe = await discovery(options);
  if (!probe.reachable) {
    throw new Error(`Compiled daemon discovery failed: ${JSON.stringify(probe)}`);
  }
} catch (error) {
  failure = error;
}

if (pid) {
  try {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await discovery(options)).reachable) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if ((await discovery(options)).reachable) {
      throw new Error(`Disposable compiled daemon on 127.0.0.1:${port} did not stop.`);
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Compiled daemon probe and cleanup both failed.") : error;
  }
}

if (failure) throw failure;
console.log("Installed compiled daemon launcher start/discovery/stop probe passed.");
