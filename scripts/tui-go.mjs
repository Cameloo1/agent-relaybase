#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tuiDir = path.join(root, "tui");
const outputDir = path.join(root, "bin", "relaybase-tui");
const devOutputDir = path.join(root, ".relaybase", "tui-dev-bin");
const defaultGoCacheDir = path.join(os.tmpdir(), "relaybase-go-build-cache");
const defaultGoTmpDir = path.join(os.tmpdir(), "relaybase-go-build-tmp");
const stableGoTestBinDir = path.join(root, ".tmp", "go-test-bin");
const viewsPackage = "./internal/tui/views";
export const raceUnsupportedExitCode = 2;

export const targets = [
  { goos: "windows", goarch: "amd64", binary: "relaybase-tui-windows-amd64.exe" },
  { goos: "windows", goarch: "arm64", binary: "relaybase-tui-windows-arm64.exe" },
  { goos: "darwin", goarch: "amd64", binary: "relaybase-tui-darwin-amd64" },
  { goos: "darwin", goarch: "arm64", binary: "relaybase-tui-darwin-arm64" },
  { goos: "linux", goarch: "amd64", binary: "relaybase-tui-linux-amd64" },
  { goos: "linux", goarch: "arm64", binary: "relaybase-tui-linux-arm64" }
];

const goCommands = {
  build: {
    action: "build",
    retryScript: "npm run tui:build"
  },
  test: {
    action: "test",
    retryScript: "npm run tui:test",
    args: ["test", "./..."]
  },
  vet: {
    action: "vet",
    retryScript: "npm run tui:vet",
    args: ["vet", "./..."]
  },
  race: {
    action: "race test",
    retryScript: "npm run tui:race",
    args: ["test", "-race", "./..."]
  },
  snapshot: {
    action: "snapshot test",
    retryScript: "npm run tui:snapshot",
    args: ["test", "./internal/tui/views", "-run", "TestGolden", "-count=1"]
  }
};

export function requiredGoVersion(options = {}) {
  const goModPath = options.goModPath ?? path.join(tuiDir, "go.mod");
  try {
    const content = (options.readFile ?? readFileSync)(goModPath, "utf8");
    const match = /^go\s+([^\s]+)$/m.exec(content);
    return match?.[1] ?? "1.25.0";
  } catch {
    return "1.25.0";
  }
}

export function targetForPlatform(platform = process.platform, arch = process.arch) {
  const goos = platform === "win32" ? "windows" : platform;
  const goarch = arch === "x64" ? "amd64" : arch;
  const target = targets.find((item) => item.goos === goos && item.goarch === goarch);
  if (!target) {
    throw new Error(
      `relaybase tui: unsupported platform ${platform}/${arch}. Supported targets: windows-amd64, windows-arm64, darwin-amd64, darwin-arm64, linux-amd64, linux-arm64.`
    );
  }
  return target;
}

export function currentPlatformBinaryPath(options = {}) {
  const target = targetForPlatform(options.platform, options.arch);
  return path.join(options.rootDir ?? root, "bin", "relaybase-tui", target.binary);
}

export function currentPlatformDevelopmentBinaryPath(options = {}) {
  const target = targetForPlatform(options.platform, options.arch);
  return path.join(options.rootDir ?? root, ".relaybase", "tui-dev-bin", target.binary);
}

export function repoLocalGoReleaserPath(options = {}) {
  const binary = (options.platform ?? process.platform) === "win32" ? "goreleaser.exe" : "goreleaser";
  return path.join(options.rootDir ?? root, ".codex-tools", "bin", binary);
}

export function formatMissingGoDiagnostic(options = {}) {
  const version = options.requiredVersion ?? requiredGoVersion(options);
  const retryScript = options.retryScript ?? "npm run tui:build";
  const action = options.action ?? "build";
  const blockedScripts = [
    "npm run tui:build",
    "npm run tui:test",
    "npm run tui:vet",
    "npm run tui:race",
    "npm run tui:snapshot"
  ];
  return [
    `relaybase tui ${action}: Go ${version} is required but go was not found on PATH.`,
    "Failed toolchain probe: go version",
    `Install Go ${version}. Use https://go.dev/dl/ or an approved package manager, then open a new terminal so PATH is refreshed.`,
    "Verify with: go version",
    "Release verification must also capture: go env GOVERSION GOOS GOARCH GOMOD GOMODCACHE",
    `Blocked TUI scripts until Go is available: ${blockedScripts.join(", ")}`,
    `Then run: ${retryScript}`
  ].join("\n");
}

export function formatMissingGoReleaserDiagnostic(options = {}) {
  const retryScript = options.retryScript ?? "npm run release:check";
  return [
    "relaybase tui release: GoReleaser is required for release archive/checksum verification but goreleaser was not found.",
    "Failed release-tool probe: goreleaser --version",
    "Set GORELEASER_BIN, install GoReleaser into .codex-tools/bin, put goreleaser on PATH, or run this command in release CI where GoReleaser is installed.",
    `Then run: ${retryScript}`
  ].join("\n");
}

export function isUnsupportedRaceOutput(output = "") {
  return /race detector is not supported|unsupported.*race|race.*unsupported|-race requires cgo|race is not supported|C compiler .* not found|gcc.*not found/i.test(
    output
  );
}

export function isApplicationControlOutput(output = "") {
  return /Application Control policy has blocked|blocked by app control|blocked execution of a newly compiled Go test binary/i.test(
    output
  );
}

export function formatUnsupportedRaceDiagnostic(options = {}) {
  const exitCode = options.exitCode ?? raceUnsupportedExitCode;
  return [
    "relaybase tui race test: Go race testing is unavailable in this environment.",
    "The race check did not pass and must not be reported as passed.",
    "If this is a host/toolchain limitation, rerun on a supported Go race-detector host or CI lane.",
    `Documented unsupported-race exit code: ${exitCode}.`
  ].join("\n");
}

export function formatGoExecutionPolicyDiagnostic(options = {}) {
  const action = options.action ?? "test";
  return [
    `relaybase tui ${action}: Go compiled a test executable, but the host blocked execution by application-control policy.`,
    "This is an environment policy blocker, not a passing TUI verification result.",
    "Run the same command on a host or CI lane that permits Go test binaries, or adjust the local application-control policy.",
    "Do not mark TUI build/test/vet verification as passing until the command exits successfully."
  ].join("\n");
}

export function executableStatus(command, args = ["--version"], options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? null,
    error: result.error?.message,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : ""
  };
}

export function resolveGoReleaserBinary(options = {}) {
  const exists = options.exists ?? existsSync;
  const spawn = options.spawn ?? spawnSync;
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? root;
  const candidates = [];
  const envBinary = env.GORELEASER_BIN?.trim();
  if (envBinary) {
    candidates.push({ command: envBinary, source: "GORELEASER_BIN" });
  }

  const repoLocalBinary = repoLocalGoReleaserPath({
    rootDir,
    platform: options.platform ?? process.platform
  });
  if (exists(repoLocalBinary)) {
    candidates.push({ command: repoLocalBinary, source: "repo-local" });
  }

  candidates.push({ command: "goreleaser", source: "PATH" });

  const attempts = [];
  for (const candidate of candidates) {
    const status = executableStatus(candidate.command, ["--version"], {
      ...options,
      spawn,
      cwd: rootDir
    });
    attempts.push({ ...candidate, ...status });
    if (status.ok) {
      return { ...candidate, ...status, attempts };
    }
  }

  return {
    ok: false,
    command: candidates.at(-1)?.command ?? "goreleaser",
    source: "unresolved",
    attempts,
    status: attempts.at(-1)?.status ?? null,
    error: attempts.at(-1)?.error,
    stdout: attempts.at(-1)?.stdout ?? "",
    stderr: attempts.at(-1)?.stderr ?? ""
  };
}

export function buildDoctorReport(options = {}) {
  const exists = options.exists ?? existsSync;
  const spawn = options.spawn ?? spawnSync;
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? root;
  const goModPath = path.join(rootDir, "tui", "go.mod");
  const goSumPath = path.join(rootDir, "tui", "go.sum");
  const requiredVersion = requiredGoVersion({ ...options, goModPath });
  const go = executableStatus("go", ["version"], { ...options, spawn, cwd: rootDir });
  const goEnv = go.ok
    ? executableStatus("go", ["env", "GOVERSION", "GOOS", "GOARCH", "GOMOD", "GOMODCACHE"], {
        ...options,
        spawn,
        cwd: path.join(rootDir, "tui")
      })
    : { ok: false, stdout: "", stderr: "", status: null, error: "go unavailable" };
  const goreleaser = resolveGoReleaserBinary({ ...options, exists, spawn, cwd: rootDir, rootDir });
  const binaryPath = currentPlatformBinaryPath({
    rootDir,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch
  });
  const envBinary = env.RELAYBASE_TUI_BIN?.trim();

  const checks = [
    { name: "node", status: "pass", detail: process.version },
    {
      name: "npm",
      status: env.npm_config_user_agent ? "pass" : "warn",
      detail: env.npm_config_user_agent ?? "not running under npm"
    },
    {
      name: "go",
      status: go.ok ? "pass" : "fail",
      detail: go.ok
        ? go.stdout
        : formatMissingGoDiagnostic({ requiredVersion, action: "doctor", retryScript: "npm run doctor:tui" })
    },
    {
      name: "go-env",
      status: goEnv.ok ? "pass" : "fail",
      detail: goEnv.ok ? goEnv.stdout.replace(/\r?\n/g, " | ") : "go env unavailable until Go is installed"
    },
    {
      name: "tui/go.mod",
      status: exists(goModPath) ? "pass" : "fail",
      detail: exists(goModPath) ? `requires Go ${requiredVersion}` : "missing tui/go.mod"
    },
    {
      name: "tui/go.sum",
      status: exists(goSumPath) ? "pass" : "warn",
      detail: exists(goSumPath) ? "present" : "missing; run go mod tidy from tui/ on a Go-capable host"
    },
    {
      name: "relaybase-tui package binary",
      status: exists(binaryPath) ? "pass" : "warn",
      detail: exists(binaryPath) ? binaryPath : `missing ${binaryPath}; build with npm run tui:build`
    },
    {
      name: "RELAYBASE_TUI_BIN",
      status: envBinary ? (exists(envBinary) ? "pass" : "fail") : "warn",
      detail: envBinary ? (exists(envBinary) ? envBinary : `points to a missing file: ${envBinary}`) : "not set"
    },
    {
      name: "goreleaser",
      status: goreleaser.ok ? "pass" : "warn",
      detail: goreleaser.ok
        ? `${goreleaser.stdout} (${goreleaser.source})`
        : "not installed; required only for release archive/checksum dry-runs"
    }
  ];

  return {
    ok: checks.every((check) => check.status !== "fail"),
    requiredGoVersion: requiredVersion,
    checks
  };
}

export function renderDoctorReport(report) {
  const lines = [`Relaybase TUI doctor: ${report.ok ? "ready" : "not ready"}`, ""];
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.name}: ${check.detail}`);
  }
  return lines.join("\n");
}

export function goCommandEnv(commandEnv = {}, baseEnv = process.env) {
  return {
    ...baseEnv,
    GOCACHE: baseEnv.GOCACHE && baseEnv.GOCACHE.trim() !== "" ? baseEnv.GOCACHE : defaultGoCacheDir,
    GOTMPDIR: baseEnv.GOTMPDIR && baseEnv.GOTMPDIR.trim() !== "" ? baseEnv.GOTMPDIR : defaultGoTmpDir,
    ...commandEnv
  };
}

export function runCli(args = process.argv.slice(2), options = {}) {
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }
  if (command === "doctor") {
    const report = buildDoctorReport(options);
    console.log(renderDoctorReport(report));
    return report.ok ? 0 : 1;
  }
  if (command === "release-check") {
    return runGoReleaser(["check"], { ...options, retryScript: "npm run release:check" });
  }
  if (command === "release-dry-run") {
    return runGoReleaser(["release", "--snapshot", "--clean"], {
      ...options,
      retryScript: "npm run release:dry-run"
    });
  }
  if (command === "build") {
    return runBuild(args.slice(1), options);
  }
  if (command === "test" || command === "vet" || command === "snapshot") {
    return runGoCommand(goCommands[command], options);
  }
  if (command === "race") {
    return runRaceCommand(goCommands.race, options);
  }

  console.error(`relaybase tui: unknown toolchain command '${command}'.`);
  printUsage();
  return 1;
}

function runBuild(args, options = {}) {
  const selectedTargets = args.includes("--all") ? targets : [targetForPlatform()];
  const currentTarget = targetForPlatform();
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(devOutputDir, { recursive: true });

  for (const target of selectedTargets) {
    const outputPath = path.join(outputDir, target.binary);
    const status = runGoCommand(
      {
        action: "build",
        retryScript: args.includes("--all") ? "npm run tui:build:all" : "npm run tui:build",
        args: ["build", "-trimpath", "-o", outputPath, "./cmd/relaybase-tui"],
        env: {
          CGO_ENABLED: "0",
          GOOS: target.goos,
          GOARCH: target.goarch
        }
      },
      options
    );
    if (status !== 0) {
      return status;
    }

    if (target.goos === currentTarget.goos && target.goarch === currentTarget.goarch) {
      const devOutputPath = path.join(devOutputDir, target.binary);
      const devStatus = runGoCommand(
        {
          action: "build",
          retryScript: args.includes("--all") ? "npm run tui:build:all" : "npm run tui:build",
          args: ["build", "-trimpath", "-o", devOutputPath, "./cmd/relaybase-tui"],
          env: {
            CGO_ENABLED: "0",
            GOOS: target.goos,
            GOARCH: target.goarch
          }
        },
        options
      );
      if (devStatus !== 0) {
        return devStatus;
      }
    }
  }

  return 0;
}

function runGoCommand(command, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const requiredVersion = requiredGoVersion(options);
  const go = executableStatus("go", ["version"], { ...options, spawn, cwd: tuiDir });
  if (!go.ok) {
    console.error(
      formatMissingGoDiagnostic({
        requiredVersion,
        action: command.action,
        retryScript: command.retryScript
      })
    );
    return 1;
  }

  if (usesStableWindowsViewsTest(command, options)) {
    return runWindowsStableViewsCheck(command, { ...options, spawn });
  }

  mkdirSync(defaultGoCacheDir, { recursive: true });
  mkdirSync(defaultGoTmpDir, { recursive: true });
  const result = spawn("go", command.args, {
    cwd: tuiDir,
    env: goCommandEnv(command.env),
    encoding: "utf8",
    shell: false,
    stdio: ["inherit", "pipe", "pipe"]
  });

  if (typeof result.stdout === "string" && result.stdout !== "") {
    process.stdout.write(result.stdout);
  }
  if (typeof result.stderr === "string" && result.stderr !== "") {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    console.error(`relaybase tui ${command.action}: could not run go: ${result.error.message}`);
    return 1;
  }
  const output = `${typeof result.stdout === "string" ? result.stdout : ""}\n${
    typeof result.stderr === "string" ? result.stderr : ""
  }`;
  const status = result.status ?? 1;
  if (status !== 0 && isApplicationControlOutput(output)) {
    console.error(formatGoExecutionPolicyDiagnostic({ action: command.action }));
  }
  return status;
}

function usesStableWindowsViewsTest(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const explicitlyDisabled =
    options.useStableWindowsTestBinary === false || env.RELAYBASE_TUI_STABLE_TEST_BINARY === "0";
  const explicitlyEnabled = options.useStableWindowsTestBinary === true || env.RELAYBASE_TUI_STABLE_TEST_BINARY === "1";
  const defaultEnabled = platform === "win32" && command.action === "test";
  return (
    !explicitlyDisabled &&
    (explicitlyEnabled || defaultEnabled) &&
    platform === "win32" &&
    (command.action === "test" || command.action === "snapshot test")
  );
}

function runWindowsStableViewsCheck(command, options = {}) {
  if (command.action === "snapshot test") {
    return runStablePackageTestBinary(viewsPackage, { ...options, runArgs: ["-test.run=TestGolden"] });
  }

  const packages = listGoTestPackages(options);
  if (!packages.ok) {
    return packages.status;
  }

  for (const packageName of packages.packages) {
    const testResult = runStablePackageTestBinary(packageName, options);
    if (testResult !== 0) {
      return testResult;
    }
  }
  return 0;
}

function listGoTestPackages(options = {}) {
  const spawn = options.spawn ?? spawnSync;
  mkdirSync(defaultGoCacheDir, { recursive: true });
  mkdirSync(defaultGoTmpDir, { recursive: true });
  const result = spawn("go", ["list", "-f", "{{.ImportPath}}|{{len .TestGoFiles}}|{{len .XTestGoFiles}}", "./..."], {
    cwd: tuiDir,
    env: goCommandEnv(options.commandEnv),
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (typeof result.stdout === "string" && result.stdout !== "") {
    // Package lists are implementation detail for the stable Windows test path.
  }
  if (typeof result.stderr === "string" && result.stderr !== "") {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    console.error(`relaybase tui test: could not list Go packages: ${result.error.message}`);
    return { ok: false, status: 1, packages: [] };
  }

  const status = result.status ?? 1;
  if (status !== 0) {
    return { ok: false, status, packages: [] };
  }

  return {
    ok: true,
    status: 0,
    packages: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [packageName, testCount, externalTestCount] = line.split("|");
        return {
          packageName,
          testCount: Number(testCount),
          externalTestCount: Number(externalTestCount)
        };
      })
      .filter((entry) => entry.packageName && (entry.testCount > 0 || entry.externalTestCount > 0))
      .map((entry) => entry.packageName)
  };
}

function runStablePackageTestBinary(packageName, options = {}) {
  const extension = (options.platform ?? process.platform) === "win32" ? ".exe" : "";
  const runDir = path.join(
    stableGoTestBinDir,
    String(options.stableTestRunId ?? process.env.RELAYBASE_TUI_STABLE_TEST_RUN_ID ?? process.pid)
  );
  const outputPath = path.join(runDir, `${stableTestBinaryName(packageName)}${extension}`);
  mkdirSync(defaultGoCacheDir, { recursive: true });
  mkdirSync(defaultGoTmpDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  const compileStatus = runGoSpawn(["test", "-c", "-o", outputPath, packageName], options);
  if (compileStatus !== 0) {
    return compileStatus;
  }

  const spawn = options.spawn ?? spawnSync;
  const runResult = spawn(outputPath, options.runArgs ?? [], {
    cwd: tuiDir,
    env: goCommandEnv(options.commandEnv),
    shell: false,
    stdio: "inherit"
  });
  if (runResult.error) {
    if (isStableTestExecutionPolicyError(runResult.error.message) && !options.runArgs?.length) {
      const fallbackStatus = runGoSpawn(["test", packageName], options);
      if (fallbackStatus === 0) {
        return 0;
      }
    }
    console.error(formatStableGoTestBinaryDiagnostic(outputPath, runResult.error.message));
    return 1;
  }
  return runResult.status ?? 1;
}

function isStableTestExecutionPolicyError(errorMessage) {
  return /Application Control|blocked|UNKNOWN|EACCES|permission denied/i.test(errorMessage);
}

function formatStableGoTestBinaryDiagnostic(binaryPath, errorMessage) {
  const appControlHint = isStableTestExecutionPolicyError(errorMessage)
    ? [
        "The host appears to have blocked execution of a newly compiled Go test binary.",
        "This is an environment policy blocker, not a passing TUI verification result.",
        "Rerun on a host or CI lane that permits Go test binaries, or adjust the local application-control policy."
      ]
    : [];
  return [
    `relaybase tui test: could not run stable Go test binary: ${errorMessage}`,
    `Blocked binary: ${binaryPath}`,
    ...appControlHint
  ].join("\n");
}

function stableTestBinaryName(packageName) {
  return (
    packageName
      .replace(/^github\.com\/cameloo\/relaybase\/tui\/?/, "")
      .replace(/^\.\//, "")
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "root"
  );
}

function runGoSpawn(args, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const result = spawn("go", args, {
    cwd: tuiDir,
    env: goCommandEnv(options.commandEnv),
    shell: false,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(`relaybase tui test: could not run go: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function runRaceCommand(command, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const requiredVersion = requiredGoVersion(options);
  const go = executableStatus("go", ["version"], { ...options, spawn, cwd: tuiDir });
  if (!go.ok) {
    console.error(
      formatMissingGoDiagnostic({
        requiredVersion,
        action: command.action,
        retryScript: command.retryScript
      })
    );
    return 1;
  }

  mkdirSync(defaultGoCacheDir, { recursive: true });
  mkdirSync(defaultGoTmpDir, { recursive: true });
  const result = spawn("go", command.args, {
    cwd: tuiDir,
    env: goCommandEnv(command.env),
    encoding: "utf8",
    shell: false,
    stdio: ["inherit", "pipe", "pipe"]
  });

  if (typeof result.stdout === "string" && result.stdout !== "") {
    process.stdout.write(result.stdout);
  }
  if (typeof result.stderr === "string" && result.stderr !== "") {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    console.error(`relaybase tui ${command.action}: could not run go: ${result.error.message}`);
    return 1;
  }

  const output = `${typeof result.stdout === "string" ? result.stdout : ""}\n${
    typeof result.stderr === "string" ? result.stderr : ""
  }`;
  const status = result.status ?? 1;
  if (status !== 0 && isUnsupportedRaceOutput(output)) {
    console.error(formatUnsupportedRaceDiagnostic({ exitCode: raceUnsupportedExitCode }));
    return raceUnsupportedExitCode;
  }
  return status;
}

function runGoReleaser(args, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const goreleaser = resolveGoReleaserBinary({ ...options, spawn, cwd: root, rootDir: options.rootDir ?? root });
  if (!goreleaser.ok) {
    console.error(formatMissingGoReleaserDiagnostic(options));
    return 1;
  }

  const result = spawn(goreleaser.command, args, {
    cwd: options.rootDir ?? root,
    shell: false,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(`relaybase tui release: could not run ${goreleaser.command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function printUsage() {
  console.log(`Usage: node scripts/tui-go.mjs <command>

Commands:
  build [--all]       Build relaybase-tui for this platform, or all release targets with --all.
  test                Run go test ./... from tui/.
  vet                 Run go vet ./... from tui/.
  race                Run go test -race ./... from tui/.
  snapshot            Run deterministic TUI render snapshot tests from tui/.
  doctor              Check local TUI verification readiness.
  release-check       Run goreleaser check.
  release-dry-run     Run goreleaser release --snapshot --clean.
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
