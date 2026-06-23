import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRelaybaseServer } from "../src/server.ts";
import { detectProject, proposeSetupPlans } from "../src/setup.ts";
import { detectSetup, previewManifestPatch, previewSetup, repairSetup, SetupApiRequestError } from "../src/setupApi.ts";
import { detectRuntimeMatrix } from "../src/setupRuntimeAdapters.ts";
import type { RuntimeId } from "../src/setupRuntimeTypes.ts";

interface RuntimeFixture {
  runtime: RuntimeId;
  tier: 1 | 2;
  prefix: string;
  files: Record<string, string>;
  expectedPlanCommand?: RegExp;
  expectedQuestion?: string;
}

const runtimeFixtures: RuntimeFixture[] = [
  {
    runtime: "javascript-typescript",
    tier: 1,
    prefix: "relaybase-runtime-js-",
    files: {
      "package.json": JSON.stringify(
        {
          name: "runtime-js",
          scripts: { dev: "vite --host 127.0.0.1" },
          devDependencies: { vite: "^6.0.0" }
        },
        null,
        2
      ),
      "vite.config.ts": "export default {};\n"
    },
    expectedPlanCommand: /npm(?:\.cmd)? run dev|npm run dev/
  },
  {
    runtime: "python",
    tier: 1,
    prefix: "relaybase-runtime-python-",
    files: {
      "pyproject.toml": '[project]\ndependencies = ["fastapi", "uvicorn"]\n',
      "main.py": "from fastapi import FastAPI\napp = FastAPI()\n"
    },
    expectedPlanCommand: /external|python -m uvicorn/
  },
  {
    runtime: "go",
    tier: 1,
    prefix: "relaybase-runtime-go-",
    files: {
      "go.mod": "module example.com/runtime-go\n\ngo 1.23\n",
      "main.go": 'package main\nimport "net/http"\nfunc main(){ _ = http.ListenAndServe(":8080", nil) }\n'
    },
    expectedPlanCommand: /go run \./
  },
  {
    runtime: "java",
    tier: 1,
    prefix: "relaybase-runtime-java-",
    files: {
      "pom.xml":
        "<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n",
      "src/main/java/com/acme/App.java": "@SpringBootApplication class App {}\n"
    },
    expectedPlanCommand: /mvn spring-boot:run/
  },
  {
    runtime: "kotlin-jvm",
    tier: 1,
    prefix: "relaybase-runtime-kotlin-",
    files: {
      "build.gradle.kts":
        'plugins { kotlin("jvm") version "2.0.0" }\ndependencies { implementation("io.ktor:ktor-server-netty") }\n',
      "src/main/kotlin/App.kt": "fun main() {}\n"
    },
    expectedPlanCommand: /gradle run/
  },
  {
    runtime: "dotnet",
    tier: 1,
    prefix: "relaybase-runtime-dotnet-",
    files: {
      "RuntimeDotnet.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
      "Program.cs": "var builder = WebApplication.CreateBuilder(args);\n"
    },
    expectedPlanCommand: /dotnet run --project/
  },
  {
    runtime: "ruby",
    tier: 1,
    prefix: "relaybase-runtime-ruby-",
    files: {
      Gemfile: 'gem "rails"\n',
      "bin/rails": "#!/usr/bin/env ruby\n",
      "config/routes.rb": "Rails.application.routes.draw do\nend\n"
    },
    expectedPlanCommand: /external|rails server/
  },
  {
    runtime: "php",
    tier: 1,
    prefix: "relaybase-runtime-php-",
    files: {
      "composer.json": '{"require":{"laravel/framework":"^11"}}\n',
      artisan: "<?php\n",
      "public/index.php": "<?php echo 'ok';\n"
    },
    expectedPlanCommand: /external|php artisan serve/
  },
  {
    runtime: "docker-compose",
    tier: 1,
    prefix: "relaybase-runtime-compose-",
    files: {
      "compose.yaml":
        'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n  worker:\n    image: busybox\n'
    },
    expectedPlanCommand: /external|docker compose up/,
    expectedQuestion: "docker.service"
  },
  {
    runtime: "rust",
    tier: 2,
    prefix: "relaybase-runtime-rust-",
    files: {
      "Cargo.toml": '[package]\nname="runtime-rust"\nversion="0.1.0"\n[dependencies]\naxum="0.8"\n',
      "src/main.rs": "fn main() {}\n"
    },
    expectedPlanCommand: /cargo run/
  },
  {
    runtime: "elixir",
    tier: 2,
    prefix: "relaybase-runtime-elixir-",
    files: {
      "mix.exs": "defmodule Runtime.MixProject do\n# phoenix\nend\n",
      "lib/runtime_web/endpoint.ex": "defmodule RuntimeWeb.Endpoint do\nend\n"
    },
    expectedPlanCommand: /mix phx\.server/
  },
  {
    runtime: "scala",
    tier: 2,
    prefix: "relaybase-runtime-scala-",
    files: {
      "build.sbt": 'libraryDependencies += "com.typesafe.play" %% "play" % "2.9.0"\n',
      "src/main/scala/App.scala": "object App extends App {}\n"
    },
    expectedPlanCommand: /sbt run/
  },
  {
    runtime: "clojure",
    tier: 2,
    prefix: "relaybase-runtime-clojure-",
    files: {
      "project.clj":
        '(defproject runtime-clj "0.1.0" :plugins [[lein-ring "0.12.6"]] :dependencies [[ring "1.12.0"]])\n'
    },
    expectedPlanCommand: /lein ring server-headless/
  },
  {
    runtime: "dart",
    tier: 2,
    prefix: "relaybase-runtime-dart-",
    files: {
      "pubspec.yaml": "name: runtime_dart\ndependencies:\n  shelf: ^1.4.0\n",
      "bin/server.dart": "void main() {}\n"
    },
    expectedPlanCommand: /dart run bin\/server\.dart/
  },
  {
    runtime: "native",
    tier: 2,
    prefix: "relaybase-runtime-native-",
    files: {
      Makefile: "run:\n\t./server\n",
      "src/main.c": "int main(void) { return 0; }\n"
    },
    expectedPlanCommand: /make run/
  },
  {
    runtime: "procfile",
    tier: 2,
    prefix: "relaybase-runtime-procfile-",
    files: {
      Procfile: "web: npm run dev\nworker: npm run worker\n"
    },
    expectedPlanCommand: /external|foreman start web/
  }
];

test("runtime matrix detects and plans all supported setup adapters", async () => {
  for (const fixture of runtimeFixtures) {
    const project = await runtimeProject(fixture);
    const detection = await detectProject(project);
    const runtime = detection.runtimeMatrix.runtimes.find((candidate) => candidate.runtime === fixture.runtime);

    assert.ok(runtime, `${fixture.runtime} should be detected`);
    assert.notEqual(runtime.confidence, "unsupported");
    assert.equal(runtime.tier, fixture.tier);
    assert.ok(runtime.detectionFiles.length, `${fixture.runtime} should report detection files`);
    assert.ok(runtime.startCommandCandidates.length, `${fixture.runtime} should report start command candidates`);
    assert.ok(runtime.portStrategies.length, `${fixture.runtime} should report port strategies`);
    assert.ok(runtime.healthCandidates.length, `${fixture.runtime} should report health candidates`);
    if (fixture.expectedQuestion) {
      assert.ok(
        detection.runtimeMatrix.questions.some((question) => question.id === fixture.expectedQuestion),
        `${fixture.runtime} should ask ${fixture.expectedQuestion}`
      );
    }

    const plans = await proposeSetupPlans(detection);
    assert.ok(plans.length, `${fixture.runtime} should produce setup plans`);
    assert.ok(plans.some((plan) => plan.runtimeId === fixture.runtime));
    assert.ok(plans.some((plan) => plan.startCommandCandidates?.length));
    if (fixture.expectedPlanCommand) {
      const commandSurface = [
        ...plans.map((plan) => String(plan.manifest.command)),
        ...(runtime.startCommandCandidates ?? []).map((candidate) => candidate.commandPreview)
      ].join("\n");
      assert.match(commandSurface, fixture.expectedPlanCommand, fixture.runtime);
    }
  }
});

test("setup detect and preview expose runtime matrix without writing files", async () => {
  for (const fixture of runtimeFixtures.filter((item) => item.tier === 1)) {
    const project = await runtimeProject(fixture);
    const detect = await detectSetup({ cwd: project });
    assert.ok(detect.runtimeMatrix?.runtimes.some((runtime) => runtime.runtime === fixture.runtime));
    assert.equal(detect.primaryRuntime?.runtime, fixture.runtime);

    const before = await exists(path.join(project, "relaybase.app.json"));
    const preview = await previewSetup({ cwd: project, selectedPlanId: "managed-web" });
    assert.equal(preview.selectedPlan.choice.runtimeId, fixture.runtime);
    assert.ok(preview.selectedPlan.choice.runtimeStartCommandCandidates?.length);
    assert.equal(await exists(path.join(project, "relaybase.app.json")), before);
  }
});

test("runtime matrix skips command candidates from unsafe filesystem names", async () => {
  const relativeFiles = [
    "go.mod",
    "cmd/server&&whoami/main.go",
    "Cargo.toml",
    "src/bin/server&&whoami.rs",
    "Program.cs",
    "src/web&&whoami.csproj"
  ];
  const matrix = await detectRuntimeMatrix({
    root: os.tmpdir(),
    packageJson: undefined,
    files: relativeFiles,
    relativeFiles,
    scripts: {},
    dependencies: {},
    envFiles: [],
    portEnvKeys: [],
    detectedPorts: [],
    dockerComposeFiles: [],
    snippets: {
      "go.mod": "module example.com/unsafe\n",
      "Cargo.toml": "[package]\nname='unsafe'\n[dependencies]\naxum='0.8'\n",
      "Program.cs": "var builder = WebApplication.CreateBuilder(args);\n"
    }
  });

  const commands = matrix.runtimes.flatMap((runtime) =>
    runtime.startCommandCandidates.map((candidate) => candidate.commandPreview)
  );
  assert.equal(
    commands.some((command) => /[&|<>;$`]/.test(command)),
    false
  );
  assert.ok(commands.includes("dotnet run"));
});

test("empty folders produce unsupported runtime diagnostics without guessing a command", async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-runtime-empty-"));
  const detection = await detectProject(project);

  assert.equal(detection.runtimeMatrix.runtimes.length, 0);
  assert.ok(detection.runtimeMatrix.diagnostics.some((diagnostic) => diagnostic.code === "SETUP_RUNTIME_UNSUPPORTED"));

  const plans = await proposeSetupPlans(detection);
  assert.ok(plans.length);
  assert.equal(plans[0]?.manifest.command, "external");
  assert.ok(plans[0]?.score < 60);
  assert.equal(await exists(path.join(project, "relaybase.app.json")), false);
});

test("setup apply remains token and confirmation gated for Tier 1 runtime fixtures", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-runtime-state-"));
  const hub = await createRelaybaseServer({ port: 0, stateDir });

  try {
    await hub.listen();
    const port = hub.address().port;
    for (const fixture of runtimeFixtures.filter((item) => item.tier === 1)) {
      const project = await runtimeProject(fixture);
      const unconfirmed = await apiRequest(
        port,
        "POST",
        "/__hub/api/setup/apply",
        { cwd: project, selectedPlanId: "managed-web" },
        { "x-relaybase-token": hub.runtime.token }
      );
      assert.equal(unconfirmed.statusCode, 428, fixture.runtime);
      assert.equal(await exists(path.join(project, "relaybase.app.json")), false);

      const applied = await apiRequest(
        port,
        "POST",
        "/__hub/api/setup/apply",
        { cwd: project, selectedPlanId: "managed-web", confirm: true },
        { "x-relaybase-token": hub.runtime.token }
      );
      assert.equal(applied.statusCode, 202, fixture.runtime);
      assert.equal(applied.json.setup.selectedPlan.runtimeId, fixture.runtime);
      assert.equal(await exists(path.join(project, "relaybase.app.json")), true);
    }
  } finally {
    await hub.close();
  }
});

test("runtime-aware repair returns ignored-port choices and ambiguity questions", async () => {
  const pythonProject = await runtimeProject(runtimeFixtures.find((fixture) => fixture.runtime === "python")!);
  const repair = await repairSetup({ cwd: pythonProject, reason: "app ignored PORT" });
  assert.ok(repair.plan.runtimeMatrix?.runtimes.some((runtime) => runtime.runtime === "python"));
  assert.ok(repair.plan.repairCandidates?.some((candidate) => candidate.appliesTo === "python"));
  assert.ok(repair.plan.diagnostics.some((diagnostic) => diagnostic.code === "SETUP_REPAIR_PREVIEW_ONLY"));

  const dotnetProject = await runtimeProject(runtimeFixtures.find((fixture) => fixture.runtime === "dotnet")!);
  const dotnetRepair = await repairSetup({ cwd: dotnetProject, reason: "app ignored PORT" });
  assert.ok(dotnetRepair.plan.repairCandidates?.some((candidate) => candidate.id === "dotnet.explicit-port"));

  const composeProject = await runtimeProject(runtimeFixtures.find((fixture) => fixture.runtime === "docker-compose")!);
  const composeDetect = await detectSetup({ cwd: composeProject });
  assert.ok(composeDetect.runtimeMatrix?.questions.some((question) => question.id === "docker.service"));

  const procfileProject = await runtimeProject({
    runtime: "procfile",
    tier: 2,
    prefix: "relaybase-runtime-procfile-ambiguous-",
    files: {
      Procfile: "web: npm run dev\nweb-api: npm run api\n"
    }
  });
  const procfileDetect = await detectSetup({ cwd: procfileProject });
  assert.ok(procfileDetect.runtimeMatrix?.questions.some((question) => question.id === "procfile.process"));
});

test("runtime setup redacts secrets and rejects path traversal through existing setup API", async () => {
  const project = await runtimeProject(runtimeFixtures.find((fixture) => fixture.runtime === "javascript-typescript")!);
  await fs.writeFile(path.join(project, ".env"), "API_KEY=super-secret-runtime-key\nVITE_PORT=5173\n", "utf8");
  await fs.writeFile(
    path.join(project, "relaybase.app.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: "runtime-js",
        name: "Runtime JS",
        command: "npm.cmd run dev",
        cwd: ".",
        protocol: "http"
      },
      null,
      2
    ),
    "utf8"
  );
  const detect = await detectSetup({ cwd: project });
  const preview = await previewSetup({ cwd: project, selectedPlanId: "managed-web" });

  assert.doesNotMatch(JSON.stringify(detect), /super-secret-runtime-key/);
  assert.doesNotMatch(JSON.stringify(preview), /super-secret-runtime-key/);
  await assert.rejects(
    previewManifestPatch({
      cwd: project,
      manifestPath: path.join(project, "..", "outside.app.json"),
      patch: { healthUrl: "/health" }
    }),
    (error: unknown) => error instanceof SetupApiRequestError && error.code === "SETUP_PATH_OUTSIDE_PROJECT"
  );
});

async function runtimeProject(fixture: RuntimeFixture): Promise<string> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), fixture.prefix));
  for (const [relative, contents] of Object.entries(fixture.files)) {
    const target = path.join(project, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
  }
  return project;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function apiRequest(
  port: number,
  method: string,
  pathName: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string; json: Record<string, any>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          host: "localhost",
          ...(payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload).toString() }
            : {}),
          ...headers
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: response.statusCode ?? 0,
            body: bodyText,
            json: bodyText ? JSON.parse(bodyText) : {},
            headers: response.headers
          });
        });
      }
    );
    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}
