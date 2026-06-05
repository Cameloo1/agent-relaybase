import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { aggregateComponentStatus, buildAppComponentState } from "../src/appComponents.ts";
import { namespaceChildName, relaybaseChildResourceUri } from "../src/childMcp.ts";
import { relaybaseErrorResponse } from "../src/apiErrors.ts";
import { composeAppState } from "../src/appState.ts";
import { dashboardHtml } from "../src/dashboard.ts";
import { LogStore } from "../src/logStore.ts";
import { redactSecretLikeValues } from "../src/redaction.ts";
import { Registry } from "../src/registry.ts";
import { appIdFromHost, resolveRoute } from "../src/router.ts";
import {
  formatMissingTuiBinaryDiagnostic,
  checkDaemonReachable,
  resolveTuiBinary,
  runRelaybaseTui,
  type DaemonReachability
} from "../src/tuiBridge.ts";
import type { DaemonEnsureResult } from "../src/daemonLauncher.ts";
import { normalizeManifest, validateAppId } from "../src/validation.ts";
import {
  evaluateStatus,
  parseStatusLines,
  renderCleanWorktreeResult,
  runCleanWorktree
} from "../scripts/check-worktree-clean.mjs";
import {
  buildDoctorReport,
  currentPlatformDevelopmentBinaryPath,
  currentPlatformBinaryPath,
  formatGoExecutionPolicyDiagnostic,
  formatMissingGoDiagnostic,
  formatMissingGoReleaserDiagnostic,
  formatUnsupportedRaceDiagnostic,
  goCommandEnv,
  isApplicationControlOutput,
  isUnsupportedRaceOutput,
  raceUnsupportedExitCode,
  repoLocalGoReleaserPath,
  resolveGoReleaserBinary,
  runCli,
  targetForPlatform
} from "../scripts/tui-go.mjs";
import { runPackageCheck } from "../scripts/package-check.mjs";
import {
  artifactPaths,
  evaluateSmokePrerequisites,
  formatMissingTuiSmokeBinaryDiagnostic,
  preferenceEvidenceContainsSecretValue,
  preferenceEvidenceLooksComplete,
  preferencesSurvived,
  renderedTranscriptOutput,
  smokeFixtureDefinition,
  transcriptProcessOutput
} from "../scripts/tui-smoke.mjs";

type TestTuiSpawnOptions = {
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: "inherit" | ["ignore", "pipe", "pipe"];
  cwd?: string;
};

test("validates app ids", () => {
  assert.doesNotThrow(() => validateAppId("notes"));
  assert.doesNotThrow(() => validateAppId("notes-api-2"));
  assert.throws(() => validateAppId("Notes"));
  assert.throws(() => validateAppId("-notes"));
  assert.throws(() => validateAppId("notes.local"));
});

test("normalizes API errors and redacts secret-like details", () => {
  const body = relaybaseErrorResponse({
    code: "TEST_ERROR",
    message: "Test error.",
    retryable: true,
    correlationId: "unit-correlation",
    detail: {
      token: "super-secret-token",
      tokenPath: "C:\\relaybase\\session-token",
      tokenPresent: true,
      nested: {
        password: "hunter2"
      },
      header: "Authorization: Bearer bearer-secret",
      note: "api_key=key-secret"
    }
  });
  const details = body.details as {
    token: string;
    tokenPath: string;
    tokenPresent: boolean;
    nested: { password: string };
  };
  const rendered = JSON.stringify(body);

  assert.equal(body.error, "Test error.");
  assert.equal(body.recoverable, true);
  assert.equal(body.relaybaseError.retryable, true);
  assert.equal(body.relaybaseError.correlationId, "unit-correlation");
  assert.equal(details.token, "[redacted]");
  assert.equal(details.tokenPath, "C:\\relaybase\\session-token");
  assert.equal(details.tokenPresent, true);
  assert.equal(details.nested.password, "[redacted]");
  assert.doesNotMatch(rendered, /super-secret-token|hunter2|bearer-secret|key-secret/);
});

test("redacts obvious secret-like log values", () => {
  const result = redactSecretLikeValues(
    "token=inline-token Authorization: Bearer bearer-token env secret is super-secret-value password=hunter2",
    {
      SECRET_TOKEN: "super-secret-value"
    }
  );

  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.value, /inline-token|bearer-token|super-secret-value|hunter2/);
  assert.match(result.value, /\[redacted\]/);
});

test("redaction reports counts without exposing secret values", () => {
  const result = redactSecretLikeValues("API_KEY='inline-key' token=inline-token relay token is relaybase-secret", {
    RELAYBASE_TOKEN: "relaybase-secret"
  });

  assert.equal(result.redacted, true);
  assert.equal(result.report.replacements, 3);
  assert.equal(result.report.categories.env_assignment, 2);
  assert.equal(result.report.categories.environment_value, 1);
  assert.doesNotMatch(JSON.stringify(result.report), /inline-key|inline-token|relaybase-secret/);
});

test("TUI bridge resolves RELAYBASE_TUI_BIN first", async () => {
  const binaryPath = path.join(os.tmpdir(), "relaybase-tui-test.exe");
  const resolution = await resolveTuiBinary(
    {
      env: { RELAYBASE_TUI_BIN: binaryPath },
      packageRoot: path.join(os.tmpdir(), "relaybase-package"),
      platform: "win32",
      arch: "x64"
    },
    {
      fileExists: async (filePath) => filePath === binaryPath
    }
  );

  assert.equal(resolution.ok, true);
  assert.equal(resolution.path, binaryPath);
  assert.equal(resolution.source, "RELAYBASE_TUI_BIN");
});

test("TUI bridge resolves repo-local development binary before package asset", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-dev-checkout");
  const binaryPath = path.join(packageRoot, ".relaybase", "tui-dev-bin", "relaybase-tui-windows-amd64.exe");
  const resolution = await resolveTuiBinary(
    {
      env: {},
      packageRoot,
      platform: "win32",
      arch: "x64"
    },
    {
      fileExists: async (filePath) => filePath === path.join(packageRoot, ".git") || filePath === binaryPath
    }
  );

  assert.equal(resolution.ok, true);
  assert.equal(resolution.path, binaryPath);
  assert.equal(resolution.source, "development-build");
});

test("TUI bridge resolves packaged Windows exe path when dev checkout marker is absent", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-package");
  const binaryPath = path.join(packageRoot, "bin", "relaybase-tui", "relaybase-tui-windows-amd64.exe");
  const resolution = await resolveTuiBinary(
    {
      env: {},
      packageRoot,
      platform: "win32",
      arch: "x64"
    },
    {
      fileExists: async (filePath) => filePath === binaryPath
    }
  );

  assert.equal(resolution.ok, true);
  assert.equal(resolution.path, binaryPath);
  assert.equal(resolution.source, "package-assets");
});

test("TUI bridge resolves global relaybase-tui fallback without using a shell path string", async () => {
  const globalBinary = path.join(os.tmpdir(), "relaybase-tui.exe");
  const resolution = await resolveTuiBinary(
    {
      env: { Path: path.dirname(globalBinary) },
      packageRoot: path.join(os.tmpdir(), "relaybase-package"),
      platform: "win32",
      arch: "x64"
    },
    {
      fileExists: async () => false,
      findExecutableOnPath: async (command, options) => {
        assert.equal(command, "relaybase-tui.exe");
        assert.equal(options.platform, "win32");
        return globalBinary;
      }
    }
  );

  assert.equal(resolution.ok, true);
  assert.equal(resolution.path, globalBinary);
  assert.equal(resolution.source, "global-path");
});

test("TUI bridge explains missing binary resolution order", async () => {
  const resolution = await resolveTuiBinary(
    {
      env: {},
      packageRoot: path.join(os.tmpdir(), "relaybase-package"),
      platform: "linux",
      arch: "x64"
    },
    {
      fileExists: async () => false
    }
  );
  const diagnostic = formatMissingTuiBinaryDiagnostic(resolution);

  assert.equal(resolution.ok, false);
  assert.match(diagnostic, /relaybase-tui binary was not found/);
  assert.match(diagnostic, /RELAYBASE_TUI_BIN/);
  assert.match(diagnostic, /repo-local/);
  assert.match(diagnostic, /\.relaybase\/tui-dev-bin/);
  assert.match(diagnostic, /inside this package/);
  assert.match(diagnostic, /globally installed relaybase-tui/);
  assert.match(diagnostic, /npm run tui:build/);
  assert.match(diagnostic, /npm run doctor:tui/);
  assert.match(diagnostic, /relaybase-tui-linux-amd64/);
});

test("TUI bridge forwards args and child exit code without shell spawn", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-package");
  const expectedBinary = path.join(packageRoot, "bin", "relaybase-tui", "relaybase-tui-windows-amd64.exe");
  let spawned:
    | {
        command: string;
        args: string[];
        options: TestTuiSpawnOptions;
      }
    | undefined;

  const exitCode = await runRelaybaseTui(
    {
      host: "127.0.0.1",
      port: 7777,
      stateDir: path.join(os.tmpdir(), "relaybase-state"),
      cwd: path.join(os.tmpdir(), "relaybase-project"),
      env: {},
      packageRoot,
      platform: "win32",
      arch: "x64"
    },
    ["--theme", "dark", "--debug", "notes && unsafe"],
    {
      checkDaemon: async (): Promise<DaemonReachability> => ({
        reachable: true,
        statusCode: 200,
        message: "OK"
      }),
      fileExists: async (filePath) => filePath === expectedBinary,
      spawn: (command, args, options) => {
        spawned = { command, args, options };
        const child = new EventEmitter() as import("node:child_process").ChildProcess;
        setTimeout(() => child.emit("exit", 7, null), 0);
        return child;
      }
    }
  );

  assert.equal(exitCode, 7);
  assert.equal(spawned?.command, expectedBinary);
  assert.deepEqual(spawned?.args, [
    "--base-url",
    "http://127.0.0.1:7777",
    "--state-dir",
    path.join(os.tmpdir(), "relaybase-state"),
    "--current-directory",
    path.join(os.tmpdir(), "relaybase-project"),
    "--theme",
    "dark",
    "--debug",
    "notes && unsafe"
  ]);
  assert.equal(spawned?.options.shell, false);
  assert.equal(spawned?.options.stdio, "inherit");
  assert.equal(spawned?.options.env.RELAYBASE_URL, "http://127.0.0.1:7777");
  assert.equal(spawned?.options.env.RELAYBASE_TUI_CURRENT_DIRECTORY, path.join(os.tmpdir(), "relaybase-project"));
});

test("TUI bridge starts Relaybase daemon before spawning when daemon is unavailable", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-package");
  const expectedBinary = path.join(packageRoot, "bin", "relaybase-tui", "relaybase-tui-linux-amd64");
  let ensureCalled = false;
  let spawned:
    | {
        command: string;
        args: string[];
        options: TestTuiSpawnOptions;
      }
    | undefined;

  const exitCode = await runRelaybaseTui(
    {
      host: "127.0.0.1",
      port: 7777,
      stateDir: path.join(os.tmpdir(), "relaybase-state"),
      env: {},
      packageRoot,
      platform: "linux",
      arch: "x64"
    },
    [],
    {
      checkDaemon: async (): Promise<DaemonReachability> => ({
        reachable: false,
        statusCode: 0,
        message: "connect ECONNREFUSED 127.0.0.1:7777"
      }),
      ensureDaemon: async (_options, allowStart): Promise<DaemonEnsureResult> => {
        ensureCalled = true;
        assert.equal(allowStart, true);
        return {
          reachable: true,
          started: true,
          code: "daemon_started",
          userAction: "Relaybase daemon started and is reachable."
        };
      },
      fileExists: async (filePath) => filePath === expectedBinary,
      spawn: (command, args, options) => {
        spawned = { command, args, options };
        const child = new EventEmitter() as import("node:child_process").ChildProcess;
        setTimeout(() => child.emit("exit", 0, null), 0);
        return child;
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(ensureCalled, true);
  assert.equal(spawned?.command, expectedBinary);
  assert.match(spawned?.options.env.RELAYBASE_TUI_BOOTSTRAP_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(spawned?.options.env.RELAYBASE_TUI_BOOTSTRAP_TOKEN);
  assert.match(spawned?.options.env.RELAYBASE_TUI_BOOTSTRAP_REPORT ?? "", /daemon_started/);
});

test("TUI bridge can skip daemon start while still launching offline TUI", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-package");
  const expectedBinary = path.join(packageRoot, "bin", "relaybase-tui", "relaybase-tui-linux-amd64");
  let ensureCalled = false;
  let spawned:
    | {
        command: string;
        args: string[];
        options: TestTuiSpawnOptions;
      }
    | undefined;
  let stderr = "";
  const exitCode = await runRelaybaseTui(
    {
      host: "127.0.0.1",
      port: 7777,
      stateDir: path.join(os.tmpdir(), "relaybase-state"),
      env: {},
      packageRoot,
      platform: "linux",
      arch: "x64",
      daemonStartPolicy: "never"
    },
    [],
    {
      checkDaemon: async (): Promise<DaemonReachability> => ({
        reachable: false,
        statusCode: 0,
        message: "connect ECONNREFUSED 127.0.0.1:7777"
      }),
      ensureDaemon: async (): Promise<DaemonEnsureResult> => {
        ensureCalled = true;
        throw new Error("unexpected daemon start");
      },
      fileExists: async (filePath) => filePath === expectedBinary,
      spawn: (command, args, options) => {
        spawned = { command, args, options };
        const child = new EventEmitter() as import("node:child_process").ChildProcess;
        setTimeout(() => child.emit("exit", 0, null), 0);
        return child;
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(ensureCalled, false);
  assert.equal(stderr, "");
  assert.equal(spawned?.command, expectedBinary);
  assert.match(spawned?.options.env.RELAYBASE_TUI_BOOTSTRAP_REPORT ?? "", /daemon_not_running/);
});

test("TUI bridge smoke-render launch skips interactive bootstrap channel", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-package");
  const expectedBinary = path.join(packageRoot, "bin", "relaybase-tui", "relaybase-tui-linux-amd64");
  let spawned:
    | {
        command: string;
        args: string[];
        options: TestTuiSpawnOptions;
      }
    | undefined;

  const exitCode = await runRelaybaseTui(
    {
      host: "127.0.0.1",
      port: 7777,
      stateDir: path.join(os.tmpdir(), "relaybase-state"),
      env: {},
      packageRoot,
      platform: "linux",
      arch: "x64",
      daemonStartPolicy: "never"
    },
    ["--smoke-render"],
    {
      checkDaemon: async (): Promise<DaemonReachability> => ({
        reachable: false,
        statusCode: 0,
        message: "connect ECONNREFUSED 127.0.0.1:7777"
      }),
      fileExists: async (filePath) => filePath === expectedBinary,
      spawn: (command, args, options) => {
        spawned = { command, args, options };
        const child = new EventEmitter() as import("node:child_process").ChildProcess;
        setTimeout(() => child.emit("exit", 0, null), 0);
        return child;
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(spawned?.command, expectedBinary);
  assert.deepEqual(spawned?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawned?.options.env.RELAYBASE_STATE_DIR, undefined);
  assert.equal(spawned?.options.env.RELAYBASE_TUI_BOOTSTRAP_URL, undefined);
  assert.equal(spawned?.options.env.RELAYBASE_TUI_BOOTSTRAP_TOKEN, undefined);
  assert.match(spawned?.options.env.RELAYBASE_TUI_BOOTSTRAP_REPORT ?? "", /daemon_not_running/);
});

test("TUI bridge reports spawn failures and closes bootstrap channel", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-package");
  const expectedBinary = path.join(packageRoot, "bin", "relaybase-tui", "relaybase-tui-windows-amd64.exe");
  let stderr = "";

  const exitCode = await runRelaybaseTui(
    {
      host: "127.0.0.1",
      port: 7777,
      stateDir: path.join(os.tmpdir(), "relaybase-state"),
      env: {},
      packageRoot,
      platform: "win32",
      arch: "x64",
      daemonStartPolicy: "never"
    },
    [],
    {
      checkDaemon: async (): Promise<DaemonReachability> => ({
        reachable: false,
        statusCode: 0,
        message: "connect ECONNREFUSED 127.0.0.1:7777"
      }),
      fileExists: async (filePath) => filePath === expectedBinary,
      spawn: () => {
        throw new Error("spawn UNKNOWN");
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }
      }
    }
  );

  assert.equal(exitCode, 1);
  assert.match(stderr, /could not launch/);
  assert.match(stderr, /spawn UNKNOWN/);
});

test("TUI bridge launches Windows development build before go-run fallback", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-dev-checkout");
  const expectedBinary = path.join(packageRoot, ".relaybase", "tui-dev-bin", "relaybase-tui-windows-amd64.exe");
  const calls: Array<{ command: string; args: string[]; options: { cwd?: string; env: NodeJS.ProcessEnv } }> = [];
  let stderr = "";
  await fs.mkdir(path.join(packageRoot, "tui"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "tui", "go.mod"), "module github.com/cameloo/relaybase/tui\n", "utf8");

  const exitCode = await runRelaybaseTui(
    {
      host: "127.0.0.1",
      port: 7777,
      stateDir: path.join(os.tmpdir(), "relaybase-state"),
      env: {},
      packageRoot,
      platform: "win32",
      arch: "x64",
      daemonStartPolicy: "never"
    },
    ["--smoke-render"],
    {
      checkDaemon: async (): Promise<DaemonReachability> => ({
        reachable: false,
        statusCode: 0,
        message: "connect ECONNREFUSED 127.0.0.1:7777"
      }),
      fileExists: async (filePath) => filePath === path.join(packageRoot, ".git") || filePath === expectedBinary,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter() as import("node:child_process").ChildProcess;
        setTimeout(() => child.emit("exit", 0, null), 0);
        return child;
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, expectedBinary);
  assert.deepEqual(calls[0]?.args.slice(0, 4), [
    "--base-url",
    "http://127.0.0.1:7777",
    "--state-dir",
    path.join(os.tmpdir(), "relaybase-state")
  ]);
  assert.equal(stderr, "");
});

test("TUI bridge falls back to go run only after Windows development binary spawn failure", async () => {
  const packageRoot = path.join(os.tmpdir(), "relaybase-dev-checkout-fallback");
  const expectedBinary = path.join(packageRoot, ".relaybase", "tui-dev-bin", "relaybase-tui-windows-amd64.exe");
  const calls: Array<{ command: string; args: string[]; options: { cwd?: string; env: NodeJS.ProcessEnv } }> = [];
  let stderr = "";
  await fs.mkdir(path.join(packageRoot, "tui"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "tui", "go.mod"), "module github.com/cameloo/relaybase/tui\n", "utf8");

  const exitCode = await runRelaybaseTui(
    {
      host: "127.0.0.1",
      port: 7777,
      stateDir: path.join(os.tmpdir(), "relaybase-state"),
      env: {},
      packageRoot,
      platform: "win32",
      arch: "x64",
      daemonStartPolicy: "never"
    },
    ["--smoke-render"],
    {
      checkDaemon: async (): Promise<DaemonReachability> => ({
        reachable: false,
        statusCode: 0,
        message: "connect ECONNREFUSED 127.0.0.1:7777"
      }),
      fileExists: async (filePath) => filePath === path.join(packageRoot, ".git") || filePath === expectedBinary,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === expectedBinary) {
          throw new Error("blocked by app control");
        }
        const child = new EventEmitter() as import("node:child_process").ChildProcess;
        setTimeout(() => child.emit("exit", 0, null), 0);
        return child;
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }
      }
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.command, expectedBinary);
  assert.equal(calls[1]?.command, "go");
  assert.deepEqual(calls[1]?.args.slice(0, 2), ["run", "./cmd/relaybase-tui"]);
  assert.equal(calls[1]?.options.cwd, path.join(packageRoot, "tui"));
  assert.match(calls[1]?.options.env.GOCACHE ?? "", /\.relaybase[\\/]go-build-cache$/);
  assert.match(calls[1]?.options.env.GOTMPDIR ?? "", /relaybase-go-build-tmp$/);
  assert.match(stderr, /falling back to `go run \.\/cmd\/relaybase-tui`/);
});

test("TUI bridge treats non-Relaybase 404 listeners as unreachable", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 404;
    response.end("not relaybase");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    const result = await checkDaemonReachable(`http://127.0.0.1:${address.port}`);

    assert.equal(result.reachable, false);
    assert.equal(result.statusCode, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("TUI Go wrapper explains missing Go with a retry command", () => {
  const diagnostic = formatMissingGoDiagnostic({
    requiredVersion: "1.25.0",
    action: "test",
    retryScript: "npm run tui:test"
  });

  assert.match(diagnostic, /Go 1\.25\.0 is required/);
  assert.match(diagnostic, /go was not found on PATH/);
  assert.match(diagnostic, /Failed toolchain probe: go version/);
  assert.match(diagnostic, /https:\/\/go\.dev\/dl\//);
  assert.match(diagnostic, /go version/);
  assert.match(diagnostic, /go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE/);
  assert.match(diagnostic, /npm run tui:build/);
  assert.match(diagnostic, /npm run tui:test/);
  assert.match(diagnostic, /npm run tui:vet/);
  assert.match(diagnostic, /npm run tui:race/);
  assert.match(diagnostic, /npm run tui:snapshot/);
});

test("worktree hygiene parser classifies unexpected dirty paths", () => {
  const entries = parseStatusLines(" M src/api.ts\n?? artifacts/ignored.txt\n?? reports/fix-planning/report.md\n");
  const result = evaluateStatus(entries);

  assert.equal(result.clean, false);
  assert.deepEqual(
    result.unexpected.map((entry) => entry.raw),
    [" M src/api.ts", "?? artifacts/ignored.txt", "?? reports/fix-planning/report.md"]
  );
});

test("worktree hygiene can explicitly allow report paths", () => {
  const entries = parseStatusLines("?? reports/fix-planning/report.md\n");
  const result = evaluateStatus(entries, { allowReports: true });

  assert.equal(result.clean, true);
  assert.equal(result.allowed[0]?.reason, "allowed report path");
});

test("worktree hygiene output lists dirty paths before failing", () => {
  const rendered = renderCleanWorktreeResult({
    clean: false,
    stderr: "",
    allowed: [],
    unexpected: parseStatusLines(" M package.json\n?? .codex/config.toml\n")
  });

  assert.match(rendered, /Relaybase worktree hygiene: dirty/);
  assert.match(rendered, /Unexpected dirty paths/);
  assert.match(rendered, /M package\.json/);
  assert.match(rendered, /\.codex\/config\.toml/);
  assert.match(rendered, /clean\/disposable checkout/);
});

test("worktree hygiene runner invokes git status without a shell and fails closed", () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: { shell: false; stdio: ["ignore", "pipe", "pipe"] };
  }> = [];
  const originalError = console.error;
  let stderr = "";
  console.error = (message?: unknown) => {
    stderr += String(message);
  };

  try {
    const status = runCleanWorktree([], {
      cwd: os.tmpdir(),
      spawn: (command: string, args: string[], options: { shell: false; stdio: ["ignore", "pipe", "pipe"] }) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: "?? unexpected.txt\n", stderr: "" };
      }
    });

    assert.equal(status, 1);
  } finally {
    console.error = originalError;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "git");
  assert.deepEqual(calls[0]?.args, ["status", "--short", "--untracked-files=all"]);
  assert.equal(calls[0]?.options.shell, false);
  assert.deepEqual(calls[0]?.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.match(stderr, /unexpected\.txt/);
});

test("TUI release wrapper explains missing GoReleaser with a retry command", () => {
  const diagnostic = formatMissingGoReleaserDiagnostic({
    retryScript: "npm run release:dry-run"
  });

  assert.match(diagnostic, /GoReleaser is required/);
  assert.match(diagnostic, /goreleaser was not found/);
  assert.match(diagnostic, /Failed release-tool probe: goreleaser --version/);
  assert.match(diagnostic, /GORELEASER_BIN/);
  assert.match(diagnostic, /\.codex-tools\/bin/);
  assert.match(diagnostic, /release archive\/checksum verification/);
  assert.match(diagnostic, /npm run release:dry-run/);
});

test("TUI release check probes GoReleaser and runs config validation without a shell", () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: { shell: false; stdio: "inherit" | ["ignore", "pipe", "pipe"] };
  }> = [];

  const status = runCli(["release-check"], {
    exists: () => false,
    spawn: (
      command: string,
      args: string[],
      options: { shell: false; stdio: "inherit" | ["ignore", "pipe", "pipe"] }
    ) => {
      calls.push({ command, args, options });
      if (args[0] === "--version") {
        return { status: 0, stdout: "goreleaser version 2.0.0", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(status, 0);
  assert.deepEqual(
    calls.map((call) => ({ command: call.command, args: call.args })),
    [
      { command: "goreleaser", args: ["--version"] },
      { command: "goreleaser", args: ["check"] }
    ]
  );
  assert.equal(calls[1]?.options.shell, false);
  assert.equal(calls[1]?.options.stdio, "inherit");
});

test("TUI release dry run uses snapshot clean arguments", () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  const status = runCli(["release-dry-run"], {
    exists: () => false,
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "--version") {
        return { status: 0, stdout: "goreleaser version 2.0.0", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(status, 0);
  assert.deepEqual(calls[1], {
    command: "goreleaser",
    args: ["release", "--snapshot", "--clean"]
  });
});

test("TUI release check fails closed when GoReleaser is missing", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const missingToolResult = {
    error: new Error("spawn ENOENT"),
    status: null,
    stdout: "",
    stderr: ""
  };

  const status = runCli(["release-check"], {
    exists: () => false,
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      return missingToolResult;
    }
  });

  assert.equal(status, 1);
  assert.deepEqual(calls, [{ command: "goreleaser", args: ["--version"] }]);
});

test("TUI release check uses repo-local GoReleaser when available", () => {
  const rootDir = path.join(os.tmpdir(), "relaybase-repo-local-goreleaser-test");
  const repoLocal = repoLocalGoReleaserPath({ rootDir, platform: "win32" });
  const calls: Array<{ command: string; args: string[] }> = [];

  const status = runCli(["release-check"], {
    rootDir,
    platform: "win32",
    env: {},
    exists: (filePath: string) => filePath === repoLocal,
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (command === repoLocal && args[0] === "--version") {
        return { status: 0, stdout: "goreleaser version 2.16.0", stderr: "" };
      }
      if (command === repoLocal && args[0] === "check") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  assert.equal(status, 0);
  assert.deepEqual(calls, [
    { command: repoLocal, args: ["--version"] },
    { command: repoLocal, args: ["check"] }
  ]);
});

test("TUI GoReleaser resolver prefers GORELEASER_BIN before repo-local and PATH", () => {
  const rootDir = path.join(os.tmpdir(), "relaybase-goreleaser-env-test");
  const envBinary = path.join(rootDir, "tools", "goreleaser.exe");
  const repoLocal = repoLocalGoReleaserPath({ rootDir, platform: "win32" });
  const calls: Array<{ command: string; args: string[] }> = [];

  const resolved = resolveGoReleaserBinary({
    rootDir,
    platform: "win32",
    env: { GORELEASER_BIN: envBinary },
    exists: (filePath: string) => filePath === repoLocal,
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: "goreleaser version 2.16.0", stderr: "" };
    }
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.command, envBinary);
  assert.equal(resolved.source, "GORELEASER_BIN");
  assert.deepEqual(calls, [{ command: envBinary, args: ["--version"] }]);
});

test("TUI Go doctor reports missing Go without installing tools", () => {
  const rootDir = path.join(os.tmpdir(), "relaybase-doctor-test");
  const missingToolResult = {
    error: new Error("spawn ENOENT"),
    status: null,
    stdout: "",
    stderr: ""
  };
  const report = buildDoctorReport({
    rootDir,
    platform: "win32",
    arch: "x64",
    env: {
      npm_config_user_agent: "npm/test"
    },
    exists: (filePath: string) => filePath.endsWith(path.join("tui", "go.mod")),
    readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
    spawn: () => missingToolResult
  });

  assert.equal(report.ok, false);
  assert.equal(report.requiredGoVersion, "1.25.0");
  assert.equal(report.checks.find((check) => check.name === "go")?.status, "fail");
  assert.equal(report.checks.find((check) => check.name === "go-env")?.status, "fail");
  assert.equal(report.checks.find((check) => check.name === "tui/go.mod")?.status, "pass");
  assert.equal(report.checks.find((check) => check.name === "tui/go.sum")?.status, "warn");
  assert.equal(report.checks.find((check) => check.name === "goreleaser")?.status, "warn");
});

test("TUI Go wrapper maps Windows x64 to the packaged exe name", () => {
  assert.equal(targetForPlatform("win32", "x64").binary, "relaybase-tui-windows-amd64.exe");
});

test("TUI Go wrapper exposes repo-local development launch binary path", () => {
  assert.match(
    currentPlatformDevelopmentBinaryPath({ rootDir: "repo", platform: "win32", arch: "x64" }),
    /repo[\\/]\.relaybase[\\/]tui-dev-bin[\\/]relaybase-tui-windows-amd64\.exe$/
  );
});

test("TUI Go wrapper defaults to repo-local build cache and OS temp execution dir", () => {
  const env = goCommandEnv({}, {});

  assert.match(env.GOCACHE, /\.relaybase[\\/]go-build-cache$/);
  assert.match(env.GOTMPDIR, /relaybase-go-build-tmp$/);
});

test("TUI Go test wrapper can run normal go test on Windows when stable binary mode is disabled", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const status = runCli(["test"], {
    platform: "win32",
    useStableWindowsTestBinary: false,
    readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "version") {
        return { status: 0, stdout: "go version go1.25.0 windows/amd64", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(status, 0);
  assert.ok(calls.some((call) => call.command === "go" && call.args.join(" ") === "test ./..."));
  assert.ok(!calls.some((call) => call.args.includes("-c")));
});

test("TUI Go test wrapper classifies Windows Application Control failures", () => {
  const blocked =
    "fork/exec C:\\Users\\wamin\\AppData\\Local\\Temp\\relaybase-go-build-tmp\\go-build123\\model.test.exe: An Application Control policy has blocked this file.";
  assert.equal(isApplicationControlOutput(blocked), true);
  assert.match(formatGoExecutionPolicyDiagnostic({ action: "test" }), /environment policy blocker/);

  const originalError = console.error;
  let stderr = "";
  console.error = (message?: unknown) => {
    stderr += String(message);
  };
  try {
    const status = runCli(["test"], {
      platform: "win32",
      useStableWindowsTestBinary: false,
      readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
      spawn: (_command: string, args: string[]) => {
        if (args[0] === "version") {
          return { status: 0, stdout: "go version go1.25.0 windows/amd64", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: blocked };
      }
    });

    assert.equal(status, 1);
  } finally {
    console.error = originalError;
  }

  assert.match(stderr, /host blocked execution by application-control policy/);
  assert.match(stderr, /Do not mark TUI build\/test\/vet verification as passing/);
});

test("TUI Go test wrapper uses stable binary path by default on Windows", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const status = runCli(["test"], {
    platform: "win32",
    readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "version") {
        return { status: 0, stdout: "go version go1.25.0 windows/amd64", stderr: "" };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout: [
            "github.com/cameloo/relaybase/tui/internal/config|1|0",
            "github.com/cameloo/relaybase/tui/internal/tui/views|1|0"
          ].join("\n"),
          stderr: ""
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(status, 0);
  const configCompile = calls.find(
    (call) =>
      call.command === "go" &&
      call.args[0] === "test" &&
      call.args.includes("-c") &&
      call.args.includes("github.com/cameloo/relaybase/tui/internal/config")
  );
  assert.ok(configCompile);
  assert.ok(
    calls.some(
      (call) =>
        call.command === "go" &&
        call.args[0] === "test" &&
        call.args.includes("-c") &&
        call.args.includes("github.com/cameloo/relaybase/tui/internal/tui/views")
    )
  );
  assert.ok(calls.some((call) => /internal_config\.exe$/.test(call.command)));
  assert.ok(calls.some((call) => /internal_tui_views\.exe$/.test(call.command)));
});

test("TUI Go test wrapper can opt out of stable binary path on Windows", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const status = runCli(["test"], {
    platform: "win32",
    useStableWindowsTestBinary: false,
    readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "version") {
        return { status: 0, stdout: "go version go1.25.0 windows/amd64", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(status, 0);
  assert.ok(calls.some((call) => call.command === "go" && call.args.join(" ") === "test ./..."));
  assert.ok(!calls.some((call) => call.args.includes("-c")));
});

test("TUI Go stable test wrapper falls back to package go test on execution-policy EACCES", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const status = runCli(["test"], {
    platform: "win32",
    stableTestRunId: "fallback-test",
    readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "version") {
        return { status: 0, stdout: "go version go1.25.0 windows/amd64", stderr: "" };
      }
      if (args[0] === "list") {
        return {
          status: 0,
          stdout: "github.com/cameloo/relaybase/tui/internal/tui/setupwizard|1|0",
          stderr: ""
        };
      }
      if (args[0] === "test" && args.includes("-c")) {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command.endsWith("internal_tui_setupwizard.exe")) {
        return { status: null, error: new Error("spawn internal_tui_setupwizard.exe EACCES"), stdout: "", stderr: "" };
      }
      if (command === "go" && args.join(" ") === "test github.com/cameloo/relaybase/tui/internal/tui/setupwizard") {
        return { status: 0, stdout: "ok setupwizard\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected call" };
    }
  });

  assert.equal(status, 0);
  assert.ok(
    calls.some(
      (call) =>
        call.command === "go" &&
        call.args.join(" ") === "test github.com/cameloo/relaybase/tui/internal/tui/setupwizard"
    )
  );
});

test("TUI snapshot wrapper can opt into stable golden test binary on Windows", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const status = runCli(["snapshot"], {
    platform: "win32",
    useStableWindowsTestBinary: true,
    readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "version") {
        return { status: 0, stdout: "go version go1.25.0 windows/amd64", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(status, 0);
  assert.ok(calls.some((call) => call.command === "go" && call.args.includes("./internal/tui/views")));
  const runCall = calls.find((call) => /internal_tui_views\.exe$/.test(call.command));
  assert.deepEqual(runCall?.args, ["-test.run=TestGolden"]);
});

test("package check uses a repo-local npm cache by default", () => {
  const previousCache = process.env.npm_config_cache;
  const previousPackageCheckCache = process.env.RELAYBASE_PACKAGE_NPM_CACHE;
  process.env.npm_config_cache = "C:\\Users\\wamin\\AppData\\Local\\npm-cache";
  delete process.env.RELAYBASE_PACKAGE_NPM_CACHE;
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const originalLog = console.log;
  let stdout = "";
  console.log = (message?: unknown) => {
    stdout += `${String(message)}\n`;
  };
  try {
    const status = runPackageCheck([], {
      platform: "win32",
      arch: "x64",
      exists: () => true,
      spawn: (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, env: options.env });
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              filename: "cameloo-relaybase-0.1.0.tgz",
              files: [{ path: "bin/relaybase-tui/relaybase-tui-windows-amd64.exe" }]
            }
          ]),
          stderr: ""
        };
      }
    });

    assert.equal(status, 0);
    assert.match(stdout, /TUI package binary: present/);
    assert.ok(calls[0]?.env?.npm_config_cache?.endsWith(path.join("artifacts", "npm-cache")));
  } finally {
    console.log = originalLog;
    if (previousCache === undefined) {
      delete process.env.npm_config_cache;
    } else {
      process.env.npm_config_cache = previousCache;
    }
    if (previousPackageCheckCache === undefined) {
      delete process.env.RELAYBASE_PACKAGE_NPM_CACHE;
    } else {
      process.env.RELAYBASE_PACKAGE_NPM_CACHE = previousPackageCheckCache;
    }
  }
});

test("TUI snapshot command fails closed when Go is missing", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const missingToolResult = {
    error: new Error("spawn ENOENT"),
    status: null,
    stdout: "",
    stderr: ""
  };

  const status = runCli(["snapshot"], {
    readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      return missingToolResult;
    }
  });

  assert.equal(status, 1);
  assert.deepEqual(calls[0], { command: "go", args: ["version"] });
});

test("TUI smoke artifacts use the release evidence paths", () => {
  const rootPath = path.join(os.tmpdir(), "relaybase-tui-artifacts");
  const paths = artifactPaths(rootPath);

  assert.equal(paths.ptyTranscript, path.join(rootPath, "pty-transcript.txt"));
  assert.equal(paths.tuiOutput, path.join(rootPath, "tui-output.txt"));
  assert.equal(paths.stateBefore, path.join(rootPath, "state-before.json"));
  assert.equal(paths.stateAfter, path.join(rootPath, "state-after.json"));
  assert.equal(paths.preferencesBefore, path.join(rootPath, "preferences-before.json"));
  assert.equal(paths.preferencesAfter, path.join(rootPath, "preferences-after.json"));
  assert.equal(paths.groupedEightPanes, path.join(rootPath, "grouped-8pane-transcript.txt"));
});

test("TUI smoke 8-pane fixture defines four frontend/backend groups", () => {
  const fixture = smokeFixtureDefinition("8pane");
  const groups = new Set(fixture.apps.map((app) => app.groupId));
  const rolesByGroup = new Map<string, Set<string>>();

  for (const app of fixture.apps) {
    const roles = rolesByGroup.get(app.groupId) ?? new Set<string>();
    roles.add(app.role);
    rolesByGroup.set(app.groupId, roles);
  }

  assert.equal(fixture.expectedPaneCount, 8);
  assert.equal(fixture.apps.length, 8);
  assert.deepEqual([...groups].sort(), ["admin", "blog", "notes", "shop"]);
  for (const roles of rolesByGroup.values()) {
    assert.deepEqual([...roles].sort(), ["backend", "frontend"]);
  }
});

test("TUI smoke prerequisites fail closed when the binary is missing", () => {
  const rootDir = path.join(os.tmpdir(), "relaybase-tui-smoke-missing");
  const prerequisite = evaluateSmokePrerequisites({
    rootDir,
    platform: "win32",
    arch: "x64",
    requiredGoVersion: "1.25.0",
    exists: () => false
  });

  assert.equal(prerequisite.ok, false);
  assert.equal(prerequisite.binaryPath, currentPlatformBinaryPath({ rootDir, platform: "win32", arch: "x64" }));
  assert.match(prerequisite.diagnostic, /relaybase-tui binary is required/);
  assert.match(prerequisite.diagnostic, /npm run tui:build/);
  assert.match(prerequisite.diagnostic, /Go 1\.25\.0 is required/);
});

test("TUI smoke prerequisites prefer repo-local development launch binary", () => {
  const rootDir = path.join(os.tmpdir(), "relaybase-tui-smoke-dev");
  const devBinary = currentPlatformDevelopmentBinaryPath({ rootDir, platform: "win32", arch: "x64" });
  const packageBinary = currentPlatformBinaryPath({ rootDir, platform: "win32", arch: "x64" });
  const prerequisite = evaluateSmokePrerequisites({
    rootDir,
    platform: "win32",
    arch: "x64",
    exists: (filePath: string) => filePath === devBinary || filePath === packageBinary
  });

  assert.equal(prerequisite.ok, true);
  assert.equal(prerequisite.binaryPath, devBinary);
});

test("TUI smoke missing-binary diagnostic does not mark UX evidence as passing", () => {
  const diagnostic = formatMissingTuiSmokeBinaryDiagnostic({
    binaryPath: path.join(os.tmpdir(), "relaybase-tui.exe"),
    requiredGoVersion: "1.25.0"
  });

  assert.match(diagnostic, /will not mark TUI launch/);
  assert.match(diagnostic, /screenshots/);
  assert.match(diagnostic, /confirmations/);
  assert.match(diagnostic, /preference evidence/);
});

test("TUI smoke preference evidence requires full local UI preference surface", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-tui-pref-evidence-"));
  const beforePath = path.join(dir, "before.json");
  const afterPath = path.join(dir, "after.json");
  const preferences = {
    version: 1,
    theme: "dark",
    keymap: { contextMenu: ["ctrl+x", "ctrl+y"] },
    panes: {
      pinned: ["notes:notes-web:frontend:frontend"],
      hidden: ["archived:archived-web:frontend:frontend"],
      order: ["notes:notes-web:frontend:frontend", "notes:notes-api:backend:backend"],
      colors: {
        "notes:notes-web:frontend:frontend": "#216869",
        "notes:notes-api:backend:backend": "#8a5a00"
      }
    },
    assistant: {
      barColor: "#216869",
      historyRetentionDays: 30
    },
    layout: {
      lastPage: 0,
      density: "compact"
    }
  };

  await fs.writeFile(beforePath, JSON.stringify(preferences, null, 2), "utf8");
  await fs.writeFile(afterPath, JSON.stringify(preferences, null, 2), "utf8");

  assert.equal(preferenceEvidenceLooksComplete(preferences), true);
  assert.equal(preferenceEvidenceContainsSecretValue(preferences), false);
  assert.equal(await preferencesSurvived(beforePath, afterPath), "passed");
});

test("TUI smoke preference evidence rejects secret-like persisted values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-tui-pref-secret-"));
  const beforePath = path.join(dir, "before.json");
  const afterPath = path.join(dir, "after.json");
  const preferences = {
    version: 1,
    theme: "dark",
    keymap: { contextMenu: ["ctrl+x", "ctrl+y"] },
    panes: {
      pinned: ["notes:notes-web:frontend:frontend"],
      hidden: ["archived:archived-web:frontend:frontend"],
      order: ["notes:notes-web:frontend:frontend", "notes:notes-api:backend:backend"],
      colors: {
        "notes:notes-web:frontend:frontend": "#216869",
        "notes:notes-api:backend:backend": "#8a5a00"
      }
    },
    assistant: {
      barColor: "#216869",
      historyRetentionDays: 30,
      lastInput: "token=should-not-persist"
    },
    layout: {
      lastPage: 0,
      density: "compact"
    }
  };

  await fs.writeFile(beforePath, JSON.stringify(preferences, null, 2), "utf8");
  await fs.writeFile(afterPath, JSON.stringify(preferences, null, 2), "utf8");

  assert.equal(preferenceEvidenceContainsSecretValue(preferences), true);
  assert.equal(await preferencesSurvived(beforePath, afterPath), "failed");
});

test("TUI smoke evidence parser ignores transcript metadata", () => {
  const transcript = [
    "# slash stop confirmation",
    "$ relaybase-tui --smoke-render",
    "",
    "STDOUT:",
    "Relaybase TUI",
    "daemon: connected",
    "",
    "STDERR:",
    ""
  ].join("\n");

  const rendered = renderedTranscriptOutput(transcript);
  assert.match(rendered, /Relaybase TUI/);
  assert.doesNotMatch(rendered, /slash stop confirmation/);

  const offlineTranscript = [
    "# bridge daemon unavailable",
    "$ relaybase tui --port 1",
    "",
    "STDOUT:",
    "",
    "STDERR:",
    "relaybase tui: Relaybase daemon is not reachable at http://127.0.0.1:1."
  ].join("\n");
  const processOutput = transcriptProcessOutput(offlineTranscript);
  assert.match(processOutput, /daemon is not reachable/);
  assert.doesNotMatch(processOutput, /bridge daemon unavailable/);
});

test("TUI race wrapper reports unsupported race without claiming a pass", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const status = runCli(["race"], {
    readFile: () => "module github.com/cameloo/relaybase/tui\n\ngo 1.25.0\n",
    spawn: (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === "version") {
        return { status: 0, stdout: "go version go1.25.0 windows/amd64", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "go: -race requires cgo" };
    }
  });

  assert.equal(status, raceUnsupportedExitCode);
  assert.deepEqual(calls[1], { command: "go", args: ["test", "-race", "./..."] });
  assert.equal(isUnsupportedRaceOutput("go: -race requires cgo"), true);
  assert.equal(isUnsupportedRaceOutput('cgo: C compiler "gcc" not found'), true);
  assert.match(formatUnsupportedRaceDiagnostic(), /did not pass/);
  assert.match(formatUnsupportedRaceDiagnostic(), /Documented unsupported-race exit code: 2/);
});

test("normalizes manifests with relative cwd and env", () => {
  const manifestPath = path.join(os.tmpdir(), "relaybase-manifest", "relaybase.app.json");
  const app = normalizeManifest(
    {
      id: "notes",
      name: "Notes",
      command: "npm.cmd run dev",
      cwd: "app",
      protocol: "http",
      healthUrl: "/health",
      env: { NODE_ENV: "development" },
      upstreamPort: 18001
    },
    { manifestPath, now: new Date("2026-05-06T00:00:00.000Z") }
  );

  assert.equal(app.id, "notes");
  assert.equal(app.cwd, path.join(os.tmpdir(), "relaybase-manifest", "app"));
  assert.equal(app.env.NODE_ENV, "development");
  assert.equal(app.upstreamPort, 18001);
});

test("normalizes lifecycle hook fields and rejects invalid timeouts", () => {
  const app = normalizeManifest({
    id: "compose-app",
    name: "Compose App",
    command: ".\\scripts\\relaybase-start.ps1",
    cwd: ".",
    protocol: "http",
    preStartCommand: ".\\scripts\\relaybase-prestart.ps1",
    stopCommand: ".\\scripts\\relaybase-stop.ps1",
    verifyStoppedCommand: ".\\scripts\\relaybase-verify-stopped.ps1",
    preStartTimeoutMs: 120000,
    startTimeoutMs: 600000,
    stopTimeoutMs: 60000,
    healthTimeoutMs: 30000
  });

  assert.equal(app.schemaVersion, 1);
  assert.equal(app.preStartCommand, ".\\scripts\\relaybase-prestart.ps1");
  assert.equal(app.stopTimeoutMs, 60000);
  assert.throws(
    () =>
      normalizeManifest({
        id: "bad-timeout",
        name: "Bad Timeout",
        command: "node server.js",
        stopTimeoutMs: 1
      }),
    /stopTimeoutMs/
  );
});

test("normalizes relaybase component metadata without changing app command ownership", () => {
  const app = normalizeManifest({
    id: "notes-web",
    name: "Notes Web",
    command: "npm.cmd run dev",
    protocol: "http",
    relaybase: {
      groupId: "notes",
      componentRole: "frontend",
      displayName: "Notes",
      paneLabel: "frontend",
      paneOrder: 10
    }
  });

  assert.equal(app.schemaVersion, 1);
  assert.equal(app.command, "npm.cmd run dev");
  assert.deepEqual(app.relaybase, {
    groupId: "notes",
    componentRole: "frontend",
    displayName: "Notes",
    paneLabel: "frontend",
    paneOrder: 10
  });
  assert.equal(app.manifestDiagnostics, undefined);
});

test("keeps malformed relaybase metadata valid and records diagnostics", () => {
  const app = normalizeManifest({
    id: "bad-meta",
    name: "Bad Metadata",
    command: "node server.js",
    relaybase: {
      groupId: "Bad.Group",
      componentRole: "ui",
      paneOrder: "first"
    }
  });

  assert.equal(app.relaybase?.groupId, "bad-meta");
  assert.equal(app.relaybase?.componentRole, "other");
  assert.equal(app.relaybase?.paneLabel, "other");
  assert.equal(app.relaybase?.paneOrder, 100);
  assert.ok(app.manifestDiagnostics?.some((diagnostic) => diagnostic.field === "relaybase.groupId"));
  assert.ok(app.manifestDiagnostics?.some((diagnostic) => diagnostic.field === "relaybase.componentRole"));
  assert.ok(app.manifestDiagnostics?.some((diagnostic) => diagnostic.field === "relaybase.paneOrder"));
});

test("normalizes MCP child blocks with exact allowlists", () => {
  const manifestPath = path.join(os.tmpdir(), "relaybase-mcp-manifest", "relaybase.app.json");
  const app = normalizeManifest(
    {
      schemaVersion: 1,
      id: "notes",
      name: "Notes",
      command: "npm.cmd run dev",
      cwd: "app",
      protocol: "http",
      mcp: {
        enabled: true,
        children: [
          {
            id: "tools",
            transport: "stdio",
            command: "node",
            args: ["./mcp-server.js"],
            cwd: ".",
            expose: {
              tools: ["search", "search"],
              resources: ["docs://index"],
              prompts: ["debug"]
            }
          }
        ]
      }
    },
    { manifestPath, now: new Date("2026-05-06T00:00:00.000Z") }
  );

  assert.equal(app.schemaVersion, 1);
  assert.equal(app.mcp?.enabled, true);
  assert.equal(app.mcp?.children[0].cwd, path.join(os.tmpdir(), "relaybase-mcp-manifest", "app"));
  assert.deepEqual(app.mcp?.children[0].expose.tools, ["search"]);
});

test("rejects wildcard MCP child exposure", () => {
  assert.throws(
    () =>
      normalizeManifest({
        id: "notes",
        name: "Notes",
        command: "npm.cmd run dev",
        cwd: ".",
        protocol: "http",
        mcp: {
          enabled: true,
          children: [
            {
              id: "tools",
              transport: "stdio",
              command: "node",
              expose: {
                tools: ["*"],
                resources: [],
                prompts: []
              }
            }
          ]
        }
      }),
    /wildcard/
  );
});

test("generates child MCP namespaces and Relaybase resource URIs", () => {
  assert.equal(namespaceChildName("notes", "search"), "notes.search");
  assert.equal(relaybaseChildResourceUri("notes", "docs://index"), "relaybase://app/notes/mcp/docs://index");
});

test("generates standard app state shape", () => {
  const state = composeAppState({
    id: "notes",
    name: "Notes",
    registered: true,
    runtime: {
      status: "running",
      health: "healthy",
      pid: 123,
      assignedPort: 18001,
      logLines: 2
    },
    hubHost: "127.0.0.1",
    hubPort: 7777,
    backendPort: 18001,
    backendPortOpen: true,
    routeReachable: true,
    recentLogs: ["ready"],
    readinessCheckedAt: "2026-05-08T00:00:00.000Z",
    timeoutMs: 8000
  });

  assert.equal(state.id, "notes");
  assert.equal(state.registered, true);
  assert.equal(state.runtime.status, "running");
  assert.equal(state.backendPortOpen, true);
  assert.equal(state.routeReachable, true);
  assert.equal(state.humanUrl, "http://notes.localhost:7777");
  assert.equal(state.agentUrl, "http://127.0.0.1:7777");
  assert.deepEqual(state.agentHeaders, { "X-Relaybase-App": "notes" });
  assert.match(state.logSnapshotUrl, /\/__hub\/api\/apps\/notes\/logs$/);
  assert.match(state.logStreamUrl, /\/__hub\/api\/apps\/notes\/logs\/stream$/);
  assert.equal(state.readiness.state, "ready");
  assert.ok(state.readiness.checks.some((check) => check.name === "route-reachable" && check.ok));
});

test("builds grouped component read models from app states", () => {
  const checkedAt = "2026-05-08T00:00:00.000Z";
  const frontendState = composeAppState({
    id: "notes-web",
    name: "Notes Web",
    registered: true,
    runtime: {
      status: "running",
      health: "healthy",
      pid: 101,
      assignedPort: 18001,
      logLines: 0
    },
    hubHost: "127.0.0.1",
    hubPort: 7777,
    backendPort: 18001,
    backendPortOpen: true,
    routeReachable: true,
    recentLogs: [],
    readinessCheckedAt: checkedAt
  });
  const backendState = composeAppState({
    id: "notes-api",
    name: "Notes API",
    registered: true,
    runtime: {
      status: "stopped",
      health: "unknown",
      logLines: 0
    },
    hubHost: "127.0.0.1",
    hubPort: 7777,
    backendPortOpen: false,
    routeReachable: false,
    recentLogs: [],
    readinessCheckedAt: checkedAt
  });
  const statusBase = {
    command: "external",
    cwd: ".",
    protocol: "http" as const,
    env: {},
    createdAt: checkedAt,
    updatedAt: checkedAt
  };
  const grouped = buildAppComponentState({
    states: [frontendState, backendState],
    statuses: [
      {
        ...statusBase,
        id: "notes-web",
        name: "Notes Web",
        runtime: frontendState.runtime,
        relaybase: {
          groupId: "notes",
          componentRole: "frontend",
          displayName: "Notes",
          paneLabel: "frontend",
          paneOrder: 10
        }
      },
      {
        ...statusBase,
        id: "notes-api",
        name: "Notes API",
        runtime: backendState.runtime,
        relaybase: {
          groupId: "notes",
          componentRole: "backend",
          displayName: "Notes API",
          paneLabel: "backend",
          paneOrder: 20
        }
      }
    ],
    generatedAt: checkedAt
  });

  assert.equal(grouped.components[0]?.appId, "notes-web");
  assert.equal(grouped.components[0]?.role, "frontend");
  assert.equal(grouped.components[0]?.port, 18001);
  assert.equal(grouped.components[1]?.role, "backend");
  assert.equal(grouped.groups.length, 1);
  assert.equal(grouped.groups[0]?.groupId, "notes");
  assert.equal(grouped.groups[0]?.displayName, "Notes");
  assert.equal(grouped.groups[0]?.aggregateStatus, "degraded");
});

test("applies aggregate component status rules", () => {
  const component = {
    appId: "app",
    groupId: "group",
    role: "other" as const,
    paneLabel: "app",
    paneOrder: 100,
    displayName: "App",
    route: {
      humanUrl: "http://app.localhost:7777",
      agentUrl: "http://127.0.0.1:7777",
      reachable: false
    },
    lastError: null
  };

  assert.equal(aggregateComponentStatus([{ ...component, status: "failed" }]), "failed");
  assert.equal(
    aggregateComponentStatus([
      { ...component, appId: "a", status: "starting" },
      { ...component, appId: "b", status: "running" }
    ]),
    "starting"
  );
  assert.equal(aggregateComponentStatus([{ ...component, status: "running" }]), "running");
  assert.equal(aggregateComponentStatus([{ ...component, status: "stopped" }]), "stopped");
  assert.equal(
    aggregateComponentStatus([
      { ...component, appId: "a", status: "running" },
      { ...component, appId: "b", status: "stopped" }
    ]),
    "degraded"
  );
});

test("durable log store appends, queries, pages, rotates, and reopens", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-log-store-"));
  const store = await LogStore.open(stateDir, { maxEventsPerSegment: 2 });

  await store.append({
    appId: "notes-web",
    groupId: "notes",
    componentRole: "frontend",
    stream: "stdout",
    source: "start",
    message: "first"
  });
  await store.append({
    appId: "notes-web",
    groupId: "notes",
    componentRole: "frontend",
    stream: "stdout",
    source: "start",
    message: "second"
  });
  await store.append({
    appId: "notes-web",
    groupId: "notes",
    componentRole: "frontend",
    stream: "stderr",
    source: "start",
    message: "third error"
  });

  const latest = await store.query({ appId: "notes-web", limit: 2 });
  assert.deepEqual(
    latest.events.map((event) => event.message),
    ["second", "third error"]
  );
  assert.equal(latest.events[1]?.level, "error");
  assert.equal(latest.page.hasMore, true);
  assert.equal(latest.page.nextBefore, latest.events[0]?.sequence);

  const before = await store.query({ appId: "notes-web", limit: 1, before: latest.events[1]?.sequence });
  assert.equal(before.events[0]?.message, "second");

  const bySequence = await store.getBySequence(latest.events[0]?.sequence ?? 0);
  assert.equal(bySequence?.message, "second");

  assert.equal(await countJsonlFiles(path.join(stateDir, "logs", "segments")), 2);
  await store.rotate("notes-web");
  await store.append({
    appId: "notes-web",
    groupId: "notes",
    componentRole: "frontend",
    stream: "stdout",
    source: "start",
    message: "after rotation"
  });
  assert.equal(await countJsonlFiles(path.join(stateDir, "logs", "segments")), 3);
  await store.close();

  const reopened = await LogStore.open(stateDir);
  const recovered = await reopened.query({ groupId: "notes", componentRole: "frontend", limit: 10 });
  assert.ok(recovered.events.some((event) => event.message === "after rotation"));
  assert.equal(reopened.health().status, "healthy");
  await reopened.close();
});

test("durable log store handles huge log payloads", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-log-huge-"));
  const store = await LogStore.open(stateDir);
  const hugeMessage = "huge-log-line ".repeat(40_000);

  await store.append({
    appId: "huge-app",
    groupId: "huge",
    componentRole: "backend",
    stream: "stdout",
    source: "start",
    message: hugeMessage
  });

  const result = await store.query({ appId: "huge-app", limit: 1 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.message.length, hugeMessage.length);
  assert.equal(result.events[0]?.message, hugeMessage);
  assert.equal(store.health().status, "healthy");
  await store.close();
});

test("durable log store unavailable path degrades with diagnostics", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-log-unavailable-"));
  await fs.writeFile(path.join(stateDir, "logs"), "not a directory", "utf8");

  const store = await LogStore.open(stateDir);
  const health = store.health();
  assert.equal(health.status, "degraded");
  assert.ok(health.diagnostics.some((diagnostic) => diagnostic.code === "LOG_STORE_UNAVAILABLE"));

  const result = await store.query({ appId: "blocked", limit: 10 });
  assert.equal(result.events.length, 0);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "LOG_STORE_UNAVAILABLE"));

  await assert.rejects(
    () =>
      store.append({
        appId: "blocked",
        stream: "stdout",
        message: "should not be durable"
      }),
    /unavailable/
  );
  await store.close();
});

test("durable log store reports corrupt index and segment diagnostics", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-log-corrupt-"));
  const logRoot = path.join(stateDir, "logs");
  const segmentDir = path.join(logRoot, "segments", "bad-app", "2026-06-01");
  await fs.mkdir(segmentDir, { recursive: true });
  await fs.writeFile(path.join(logRoot, "index.json"), "{ not-json", "utf8");
  await fs.writeFile(
    path.join(segmentDir, "bad.jsonl"),
    '{"sequence":1,"appId":"bad-app","stream":"stdout","message":"ok"}\nnot-json\n',
    "utf8"
  );

  const store = await LogStore.open(stateDir);
  const result = await store.query({ appId: "bad-app", limit: 10 });

  assert.equal(result.events.length, 1);
  assert.ok(store.diagnostics().some((diagnostic) => diagnostic.code === "LOG_INDEX_CORRUPT"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "LOG_SEGMENT_CORRUPT"));
  assert.equal(store.health().status, "degraded");
  await store.close();
});

test("durable log store retention removes old segments", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-log-retention-"));
  const store = await LogStore.open(stateDir, { retentionDays: 1 });
  await store.append({
    appId: "old-app",
    stream: "stdout",
    source: "start",
    timestamp: "2026-05-01T00:00:00.000Z",
    message: "old"
  });
  await store.flush();
  const files = await jsonlFiles(path.join(stateDir, "logs", "segments"));
  assert.equal(files.length, 1);
  const oldDate = new Date("2026-05-01T00:00:00.000Z");
  await fs.utimes(files[0], oldDate, oldDate);
  await store.cleanupRetention(new Date("2026-06-01T00:00:00.000Z"));
  assert.equal(await countJsonlFiles(path.join(stateDir, "logs", "segments")), 0);
  await store.close();
});

test("persists registry records", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-registry-"));
  const registry = new Registry(stateDir);
  await registry.load();
  await registry.upsertManifest({
    id: "alpha",
    name: "Alpha",
    command: "node server.js",
    cwd: ".",
    protocol: "http"
  });

  const reloaded = new Registry(stateDir);
  await reloaded.load();
  assert.equal((await reloaded.get("alpha"))?.name, "Alpha");
});

test("dashboard labels app backend ports explicitly", () => {
  const html = dashboardHtml({
    token: "test-token",
    apps: [
      {
        id: "fixed-app",
        name: "Fixed App",
        command: "node server.js",
        cwd: ".",
        protocol: "http",
        env: {},
        upstreamPort: 3000,
        createdAt: "2026-05-08T00:00:00.000Z",
        updatedAt: "2026-05-08T00:00:00.000Z",
        runtime: {
          status: "stopped",
          health: "unknown",
          logLines: 0,
          canStart: true,
          canStop: false
        }
      }
    ]
  });

  assert.match(html, /<th scope="col">Backend port<\/th>/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="Start ' \+ appLabel/);
  assert.match(html, /aria-label="Stop ' \+ appLabel/);
  assert.match(html, /disabled aria-disabled="true"/);
  assert.doesNotMatch(html, /<th>Port<\/th>/);
  assert.match(html, /fixed :/);
  assert.match(html, /requested/);
});

test("resolves agent header before host header", () => {
  const route = resolveRoute({
    url: "/",
    headers: {
      "x-relaybase-app": "api",
      host: "human.localhost:7777"
    }
  });

  assert.deepEqual(route, { kind: "app", appId: "api", source: "header" });
});

test("resolves hub and host routes", () => {
  assert.deepEqual(resolveRoute({ url: "/__hub", headers: { host: "notes.localhost:7777" } }), { kind: "hub" });
  assert.equal(appIdFromHost("notes.localhost:7777"), "notes");
  assert.equal(appIdFromHost("localhost:7777"), undefined);
});

async function countJsonlFiles(root: string): Promise<number> {
  return (await jsonlFiles(root)).length;
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await jsonlFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  return files.sort();
}
