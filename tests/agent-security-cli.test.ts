import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRelaybaseServer } from "../src/server.ts";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("relaybase repair supports diagnosis, preview, apply, receipt recovery, and stable exit codes", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-security-cli-state-"));
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-security-cli-project-"));
  const secret = "sk-or-cli-must-not-read-this";
  await fs.writeFile(path.join(projectDir, ".env"), `OPENROUTER_API_KEY ${secret}\n`, "utf8");
  const previousKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const hub = await createRelaybaseServer({ port: 0, stateDir });
  try {
    await hub.listen();
    const common = [
      "--host",
      "127.0.0.1",
      "--port",
      String(hub.address().port),
      "--state-dir",
      stateDir,
      "--cwd",
      projectDir,
      "--json"
    ];

    const diagnosed = await runRelaybaseCli(["repair", "--agent-security", ...common]);
    assert.equal(diagnosed.code, 3);
    const diagnosisBody = JSON.parse(diagnosed.stdout);
    assert.equal(diagnosisBody.outcome, "findings");
    assert.equal(diagnosisBody.healthy, false);
    assert.ok(diagnosisBody.remainingIssueCodes.includes("AGENT_CREDENTIAL_MISSING"));
    assert.equal(diagnosed.stderr, "");

    const planned = await runRelaybaseCli([
      "repair",
      "--agent-security",
      "--action",
      "route_to_provider_connect",
      "--plan",
      ...common
    ]);
    assert.equal(planned.code, 3);
    const planBody = JSON.parse(planned.stdout);
    assert.equal(planBody.outcome, "confirmation_required");
    assert.equal(planBody.preview.actions[0].id, "route_to_provider_connect");
    assert.ok(planBody.preview.previewId);

    const applied = await runRelaybaseCli([
      "repair",
      "--agent-security",
      "--apply",
      planBody.preview.previewId,
      "--yes",
      ...common
    ]);
    assert.equal(applied.code, 3);
    const appliedBody = JSON.parse(applied.stdout);
    assert.equal(appliedBody.outcome, "blocked");
    assert.ok(appliedBody.operationId);

    const stale = await runRelaybaseCli([
      "repair",
      "--agent-security",
      "--apply",
      planBody.preview.previewId,
      "--yes",
      ...common
    ]);
    assert.equal(stale.code, 4);
    assert.equal(JSON.parse(stale.stdout).outcome, "stale");

    const resolved = await runRelaybaseCli(["repair", "--operation", appliedBody.operationId, ...common]);
    assert.equal(resolved.code, 3);
    assert.equal(JSON.parse(resolved.stdout).operationId, appliedBody.operationId);

    const transcript = [
      diagnosed.stdout,
      diagnosed.stderr,
      planned.stdout,
      applied.stdout,
      stale.stdout,
      resolved.stdout
    ].join("\n");
    assert.doesNotMatch(transcript, /sk-or-|OPENROUTER_API_KEY\s/);
    assert.doesNotMatch(transcript, /ENV_FILE_INVALID_LINE|Relaybase \.env loading failed/);
  } finally {
    await hub.close();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
});

test("relaybase repair refuses mutation without authorization and reports daemon unavailability", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-security-cli-offline-"));
  const unauthorized = await runRelaybaseCli([
    "repair",
    "--agent-security",
    "--apply",
    "preview-id",
    "--json",
    "--state-dir",
    stateDir
  ]);
  assert.equal(unauthorized.code, 2);
  assert.match(JSON.parse(unauthorized.stdout).error.message, /--apply requires --yes/);

  const unavailable = await runRelaybaseCli([
    "repair",
    "--agent-security",
    "--json",
    "--port",
    "65534",
    "--state-dir",
    stateDir
  ]);
  assert.equal(unavailable.code, 1);
  const body = JSON.parse(unavailable.stdout);
  assert.equal(body.outcome, "error");
  assert.match(body.error.message, /daemon is unavailable/i);
});

function runRelaybaseCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", path.join(rootDir, "src", "cli.ts"), ...args],
      {
        cwd: rootDir,
        env: { ...process.env },
        windowsHide: true
      }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`relaybase repair CLI timed out: ${args.join(" ")}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
