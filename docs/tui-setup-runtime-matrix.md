# TUI Setup Runtime Matrix

This document describes the current daemon-side runtime adapter matrix used by Relaybase setup and onboarding.

Current verified implementation:

- `src/setup.ts` detects Node/package-manager projects, static projects, MCP hints, Docker Compose files, existing setup artifacts, env port keys, and existing manifests.
- `src/setup.ts` proposes managed dynamic port, framework port flag wrapper, pinned upstream port, Docker Compose service, static preview, and MCP-only plans.
- `src/setupApi.ts` exposes detect, plan, preview, apply, manifest, open, prove, and repair routes with confirmation gates and redaction.
- `src/setupRuntimeTypes.ts` exports typed runtime adapter models including `RuntimeDetector`, `RuntimeAdapter`, `RuntimeAdapterRegistry`-compatible inputs, `StartCommandCandidate`, `PortBindingStrategy`, `HealthCandidate`, `SetupQuestion`, `SetupConfidence`, `RepairCandidate`, and `RuntimeMatrixSnapshot`.
- `src/setupRuntimeAdapters.ts` implements the daemon-owned `RuntimeAdapterRegistry` and adapters for JavaScript/TypeScript, Python, Go, Java, Kotlin/JVM, C#/.NET, Ruby, PHP, Docker Compose, Rust, Elixir, Scala, Clojure, Dart, native/C/C++, and Procfile projects.
- `/__hub/api/setup/detect` includes `runtimeMatrix` and `primaryRuntime`.
- `/__hub/api/setup/plans` and `/__hub/api/setup/preview` include runtime id, confidence, start command candidates, port strategies, health candidates, setup questions, and repair candidates on plan choices.
- `/__hub/api/setup/repair` includes runtime matrix and runtime repair candidates.
- Operator Agent prompts and setup tool descriptions require runtime-matrix setup behavior and forbid assuming Node/npm.
- Go TUI setup panels and approval previews render runtime/language confidence, command candidates, port strategy candidates, setup questions, and runtime-specific repair candidates returned by the daemon.

The adapter matrix preserves the existing daemon-owned preview, apply, approval, manifest, proof, redaction, and event boundaries. The Go TUI still renders daemon-produced choices and approvals; it does not detect runtimes, write setup files, or manage lifecycle locally.

## Design Goals

- Detect common server projects across 16 runtime/process types without guessing unsafe commands.
- Keep all setup file writes, manifest writes, env edits, proof, repair, lifecycle, and registration in the daemon.
- Return setup choices, questions, and diagnostics when a project is ambiguous.
- Prefer dynamic daemon-owned ports when a runtime can honor `PORT` or explicit host/port flags.
- Use generated wrappers only after preview and approval.
- Use pinned upstream ports when dynamic port injection cannot be proven.
- Never execute arbitrary user-supplied shell commands as setup detection.

## Verified Boundary

Automated tests exercise disposable fixtures for every supported runtime in `tests/setup-runtime-matrix.test.ts`. Operator Agent and Go TUI tests cover runtime-aware prompt instructions, tool schemas/output, setup panel rendering, and approval rendering. The tests verify detection, runtime-aware setup plans, read-only previews, apply confirmation gates, runtime-aware repair candidates, Docker Compose and Procfile ambiguity questions, secret redaction, and path traversal rejection through existing setup APIs.

This is not a claim that every runtime fixture has been launched live. Live app proof still depends on an approved setup apply, daemon lifecycle start, app health behavior, and runtime tool availability on the host.

## Setup Engine Interfaces

These interfaces are implemented in `src/setupRuntimeTypes.ts` and exposed through the setup engine facade. Some internal input helper names differ from this excerpt, but the public boundary is the same.

```ts
export type RuntimeId =
  | "javascript-typescript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin-jvm"
  | "dotnet"
  | "ruby"
  | "php"
  | "elixir"
  | "scala"
  | "clojure"
  | "dart"
  | "native"
  | "docker-compose"
  | "procfile";

export type SetupConfidence = "high" | "medium" | "low" | "unsupported";

export interface RuntimeDetector {
  id: RuntimeId;
  tier: 1 | 2;
  detect(input: RuntimeDetectionInput): Promise<RuntimeDetectionResult>;
}

export interface RuntimeAdapter {
  id: RuntimeId;
  plan(input: RuntimePlanInput): Promise<RuntimePlanResult>;
  repair(input: RuntimeRepairInput): Promise<RepairCandidate[]>;
  fixtureBuilder?: FixtureBuilder;
}

export interface RuntimeDetectionResult {
  runtime: RuntimeId;
  confidence: SetupConfidence;
  detectionFiles: string[];
  buildToolIndicators: string[];
  serverIndicators: string[];
  startCommandCandidates: StartCommandCandidate[];
  portStrategies: PortBindingStrategy[];
  healthCandidates: HealthCandidate[];
  questions: SetupQuestion[];
  diagnostics: SetupDiagnostic[];
}

export interface StartCommandCandidate {
  id: string;
  label: string;
  command: string[];
  commandPreview: string;
  workingDirectory?: string;
  requiresTool?: string;
  confidence: SetupConfidence;
  reasons: string[];
  risks: string[];
}

export interface PortBindingStrategy {
  id:
    | "env_port"
    | "explicit_host_port_flags"
    | "framework_port_flags"
    | "generated_launch_wrapper"
    | "fixed_upstream_port"
    | "runtime_specific_env"
    | "compose_port_mapping"
    | "manual_custom";
  confidence: SetupConfidence;
  env?: Record<string, string>;
  args?: string[];
  wrapperKind?: string;
  diagnostics: SetupDiagnostic[];
}

export interface HealthCandidate {
  path: string;
  confidence: SetupConfidence;
  reason: string;
}

export interface SetupQuestion {
  id: string;
  prompt: string;
  required: boolean;
  choices?: Array<{ id: string; label: string; detail?: string }>;
}

export interface RepairCandidate {
  id: string;
  label: string;
  appliesTo: RuntimeId;
  previewOnly: boolean;
  approvalRequired: boolean;
  diagnostics: SetupDiagnostic[];
}

export interface FixtureBuilder {
  fixtureId: string;
  files: Record<string, string>;
  expectedDetection: Partial<RuntimeDetectionResult>;
}

export interface RuntimeMatrixSnapshot {
  version: 1;
  generatedAt: string;
  runtimes: RuntimeDetectionResult[];
}
```

## Registry Flow

1. `detectProject` resolves and validates the project root.
2. `RuntimeAdapterRegistry` runs every detector against bounded file metadata and safe text snippets.
3. The registry sorts detections by confidence, explicit user hints, existing manifest data, and entrypoint confidence.
4. If one runtime is high confidence, the adapter returns setup plan metadata candidates.
5. If multiple runtimes are plausible, setup returns `SetupQuestion[]` and `SETUP_RUNTIME_AMBIGUOUS` diagnostics instead of choosing silently.
6. `preview` returns file-write plans and redacted diffs without changing disk.
7. `apply` requires confirmation and invokes existing daemon write/registration logic.
8. `prove` and `repair` use daemon lifecycle, logs, route checks, and setup APIs only.

## Tiering

Tier 1 should be implemented and tested first because these runtimes are common for local web apps and have clear setup paths:

- JavaScript / TypeScript
- Python
- Go
- Java / Kotlin JVM
- C# / .NET
- Ruby
- PHP
- Docker Compose

Tier 2 should follow after the adapter boundary is stable:

- Rust
- Elixir
- Scala
- Clojure
- Dart
- generic native / C / C++
- Procfile

## Runtime Matrix

### JavaScript / TypeScript

- Tier: 1.
- Detection files: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `tsconfig.json`, `next.config.*`, `vite.config.*`, `astro.config.*`, `svelte.config.*`, `nuxt.config.*`, `remix.config.*`, `angular.json`.
- Build tool indicators: npm, pnpm, yarn, bun, TypeScript, Vite, Next, Astro, SvelteKit, Nuxt, Remix, Angular.
- Server indicators: `scripts.dev`, `scripts.start`, dependencies such as `next`, `vite`, `astro`, `express`, `fastify`, `@sveltejs/kit`, `nuxt`, `@remix-run/*`.
- Start command candidates: `npm run dev`, `npm start`, `pnpm dev`, `pnpm start`, `yarn dev`, `yarn start`, `bun run dev`, `bun run start`.
- Port strategy: env `PORT`, framework flags, generated launch wrapper, or pinned upstream port.
- Health candidates: `/`, `/health`, `/api/health`.
- Wrapper strategy: generated `.relaybase/launch.cjs` that uses `spawn` with `shell:false`, passes `HOST` and `PORT`, and maps Next to `-H/-p`, Vite/Astro/SvelteKit to `--host/--port`.
- Pinned-port fallback: use detected env ports or framework defaults such as 3000, 5173, or 4321 only when evidence exists.
- Repair when dynamic `PORT` is ignored: retry with framework wrapper, then pinned upstream port, then ask for custom command.
- Ambiguity questions: package manager, script, workspace package, monorepo app path, frontend/backend role.
- Fixture plan: Next, Vite, Astro, generic Express, SvelteKit, monorepo workspace, missing script, env secret redaction.
- Confidence: high when package and script/framework are detected; medium for package without web script; low for JavaScript files only.
- Unsupported diagnostic: ask for explicit command or manifest when no script/framework/server file is found.

### Python

- Tier: 1.
- Detection files: `pyproject.toml`, `requirements.txt`, `uv.lock`, `poetry.lock`, `Pipfile`, `manage.py`, `app.py`, `main.py`, `wsgi.py`, `asgi.py`.
- Build tool indicators: uv, Poetry, Pipenv, pip requirements, Django management, module entrypoint files.
- Server indicators: FastAPI, Uvicorn, Flask, Django, ASGI, WSGI, `app = FastAPI`, `Flask(__name__)`, `DJANGO_SETTINGS_MODULE`.
- Start command candidates: `uvicorn module:app --host HOST --port PORT`, `python -m uvicorn module:app --host HOST --port PORT`, `flask run --host HOST --port PORT`, `python manage.py runserver HOST:PORT`, `poetry run ...`, `uv run ...`, `pipenv run ...`.
- Port strategy: explicit host/port flags first, env `PORT` when app config reads it, pinned upstream port when import target is ambiguous.
- Health candidates: `/health`, `/api/health`, `/`.
- Wrapper strategy: generated Python or command wrapper only after detecting import target and package tool; otherwise ask.
- Pinned-port fallback: use known configured port from env/settings only after redacted preview.
- Repair when dynamic `PORT` is ignored: switch to explicit Uvicorn/Flask/Django flags or ask for module target.
- Ambiguity questions: ASGI module name, Flask app import, Django settings, uv/poetry/pipenv environment, multiple app files.
- Fixture plan: FastAPI, Flask, Django, generic `python -m http.server` rejected or manual, Poetry, uv, ambiguous `main.py`.
- Confidence: high for Django/FastAPI/Flask indicators; medium for generic app files; low for plain Python scripts.
- Unsupported diagnostic: "Python project detected but no web entrypoint could be determined; choose module and command."

### Go

- Tier: 1.
- Detection files: `go.mod`, `go.work`, `main.go`, `cmd/*/main.go`, `air.toml`.
- Build tool indicators: Go module/workspace, `air` config, common router imports.
- Server indicators: `net/http`, Gin, Echo, Fiber, Chi, multiple `cmd` packages.
- Start command candidates: `go run .`, `go run ./cmd/<name>`, `air` when configured and available.
- Port strategy: env `PORT`, explicit `--port` or `-port` only when detectable/configured, generated wrapper that sets env, pinned upstream port.
- Health candidates: `/health`, `/ready`, `/`, `/api/health`.
- Wrapper strategy: env wrapper only; avoid inventing CLI flags unless parser/config evidence exists.
- Pinned-port fallback: use configured or documented port only when detected.
- Repair when dynamic `PORT` is ignored: propose env read patch or pinned upstream port after approval.
- Ambiguity questions: which `cmd/*` package, whether to use `air`, port flag name, health route.
- Fixture plan: root `main.go`, multi-command module, Gin/Fiber import, `air.toml`, app ignoring `PORT`.
- Confidence: high for single main package with HTTP imports; medium for multi-cmd; low for non-server Go module.
- Unsupported diagnostic: "Go project detected but multiple runnable commands exist; choose the app command."

### Java

- Tier: 1.
- Detection files: `pom.xml`, `build.gradle`, `build.gradle.kts`, `settings.gradle`, `gradlew`, `gradlew.bat`, `mvnw`, `mvnw.cmd`, `src/main/java`.
- Build tool indicators: Maven, Gradle, Maven wrapper, Gradle wrapper, Spring Boot plugin, Quarkus, Micronaut.
- Server indicators: Spring Boot dependencies/plugins, `@SpringBootApplication`, Quarkus or Micronaut dependencies.
- Start command candidates: `./mvnw spring-boot:run`, `mvn spring-boot:run`, `./gradlew bootRun`, `gradle bootRun`, `java -jar target/*.jar` only when artifact or build plan exists.
- Port strategy: `SERVER_PORT`, `--server.port=PORT`, pinned upstream port.
- Health candidates: `/actuator/health`, `/q/health`, `/health`, `/`.
- Wrapper strategy: generated script/wrapper that sets `SERVER_PORT` or appends safe server port args.
- Pinned-port fallback: use `server.port` from properties/yaml after redacted preview.
- Repair when dynamic `PORT` is ignored: switch to `SERVER_PORT`, add server port arg, or manifest pinned port.
- Ambiguity questions: Maven vs Gradle, wrapper vs system tool, module, web vs batch app.
- Fixture plan: Spring Boot Maven, Spring Boot Gradle, Quarkus, generic non-web Maven.
- Confidence: high for Spring Boot web project; medium for JVM project with web deps; low for generic Java app.
- Unsupported diagnostic: "Java project detected but no web framework or runnable task was found."

### Kotlin / JVM

- Tier: 1.
- Detection files: `build.gradle.kts`, `settings.gradle.kts`, `src/main/kotlin`, Ktor dependencies, Spring Boot Kotlin dependencies.
- Build tool indicators: Gradle Kotlin DSL, Ktor plugin/deps, Spring Boot Kotlin plugin/deps.
- Server indicators: Ktor engine, Spring Boot Kotlin app, route definitions.
- Start command candidates: `./gradlew run`, `./gradlew bootRun`, `./gradlew :module:run`.
- Port strategy: `SERVER_PORT` for Spring Boot, Ktor env/config port when detected, pinned upstream port.
- Health candidates: `/health`, `/actuator/health`, `/`, `/api/health`.
- Wrapper strategy: generated Gradle wrapper command with env injection; no direct config edits without approval.
- Pinned-port fallback: use config value in `application.conf`, yaml, or properties only after redaction.
- Repair when dynamic `PORT` is ignored: propose Ktor config/env patch, Spring env port, or pinned port.
- Ambiguity questions: module, run task, Spring vs Ktor, configured port path.
- Fixture plan: Ktor, Spring Boot Kotlin, multi-module Gradle.
- Confidence: high for Ktor/Spring deps; medium for Gradle Kotlin app; low for library-only Kotlin.
- Unsupported diagnostic: ask for module and run task.

### C# / .NET

- Tier: 1.
- Detection files: `*.csproj`, `*.sln`, `launchSettings.json`, `Program.cs`, `appsettings.json`, `global.json`.
- Build tool indicators: .NET SDK project, solution, ASP.NET Core SDK, web SDK project.
- Server indicators: `Microsoft.NET.Sdk.Web`, `WebApplication.CreateBuilder`, Kestrel settings.
- Start command candidates: `dotnet run`, `dotnet run --project <project>`.
- Port strategy: `ASPNETCORE_HTTP_PORTS`, `ASPNETCORE_URLS`, `DOTNET_HTTP_PORTS`, `--urls http://HOST:PORT`, pinned upstream port.
- Health candidates: `/health`, `/`, `/swagger`, `/api/health`.
- Wrapper strategy: command wrapper setting ASP.NET Core URL env vars or passing `--urls`.
- Pinned-port fallback: use `applicationUrl` from `launchSettings.json` when present.
- Repair when dynamic `PORT` is ignored: switch to `ASPNETCORE_URLS` or patch manifest pinned port.
- Ambiguity questions: project in solution, web project vs library/test, URL binding source.
- Fixture plan: single ASP.NET Core project, solution with multiple projects, launchSettings fixed URL.
- Confidence: high for Web SDK; medium for solution with one web project; low for generic .NET console/library.
- Unsupported diagnostic: "Multiple .NET projects detected; choose the web project."

### Ruby

- Tier: 1.
- Detection files: `Gemfile`, `config.ru`, `bin/rails`, `config/routes.rb`, `Rakefile`.
- Build tool indicators: Bundler, Rails, Rack, Sinatra.
- Server indicators: Rails routes, Rack app, Sinatra dependency.
- Start command candidates: `bin/rails server -b HOST -p PORT`, `bundle exec rails server -b HOST -p PORT`, `bundle exec rackup -o HOST -p PORT`.
- Port strategy: explicit `-p`, env `PORT`, pinned upstream port, Procfile/bin/dev if present.
- Health candidates: `/up`, `/health`, `/`, `/rails/info/routes` only as diagnostic text, not default health.
- Wrapper strategy: command wrapper selecting Rails or Rack with host/port flags.
- Pinned-port fallback: use existing env/config port when detected.
- Repair when dynamic `PORT` is ignored: switch to Rails/Rack explicit flags or pinned port.
- Ambiguity questions: Rails vs Rack/Sinatra, `bin/dev` vs server command, process type.
- Fixture plan: Rails, Rack config.ru, Sinatra Gemfile, Procfile.dev.
- Confidence: high for Rails/Rack; medium for Gemfile with web deps; low for generic Ruby.
- Unsupported diagnostic: ask for command/process type.

### PHP

- Tier: 1.
- Detection files: `composer.json`, `artisan`, `public/index.php`, `symfony.lock`, `bin/console`.
- Build tool indicators: Composer, Laravel Artisan, Symfony console/lock.
- Server indicators: Laravel, Symfony, public document root.
- Start command candidates: `php artisan serve --host HOST --port PORT`, `symfony serve --port=PORT`, `php -S HOST:PORT -t public`, Composer script when defined.
- Port strategy: explicit host/port flags, `SERVER_PORT` only when framework supports it, pinned upstream port.
- Health candidates: `/up`, `/health`, `/`, `/api/health`.
- Wrapper strategy: generated wrapper to pass explicit flags and choose document root.
- Pinned-port fallback: use known configured local server port when present.
- Repair when dynamic `PORT` is ignored: use explicit server flags or pinned upstream port.
- Ambiguity questions: Laravel vs Symfony vs generic public root, Composer script, PHP binary availability.
- Fixture plan: Laravel, Symfony, generic `public/index.php`, Composer script.
- Confidence: high for Laravel/Symfony; medium for public docroot; low for library package.
- Unsupported diagnostic: ask for server command and public root.

### Docker Compose

- Tier: 1.
- Detection files: `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`.
- Build tool indicators: Compose service definitions, Dockerfiles, profiles, ports, healthchecks.
- Server indicators: selected service, target container port, healthcheck, exposed ports.
- Start command candidates: `docker compose up <service>`, `docker compose up`.
- Port strategy: service port mapping, env `PORT` passed into service, pinned upstream port.
- Health candidates: service healthcheck path when detectable, `/health`, `/api/health`, `/`.
- Wrapper strategy: existing Docker profile/overlay/lifecycle hooks; preserve dependency port policies.
- Pinned-port fallback: target selected service published port only after explicit service/port selection.
- Repair when dynamic `PORT` is ignored: update generated Compose overlay, choose service/target port, or pinned upstream port.
- Ambiguity questions: app service, target container port, profiles, env values, Docker Desktop startup approval.
- Fixture plan: single web service, multi-service ambiguous stack, private image, missing env, dangerous host port.
- Confidence: high for single service with web port; medium for several eligible services; low when no port/health metadata.
- Unsupported diagnostic: require service and target port rather than guessing.

### Rust

- Tier: 2.
- Detection files: `Cargo.toml`, `Cargo.lock`, `src/main.rs`, `src/bin/*.rs`.
- Build tool indicators: Cargo package, bin targets, `cargo-watch`.
- Server indicators: Axum, Actix Web, Rocket, Warp, Hyper dependencies.
- Start command candidates: `cargo run`, `cargo run --bin <name>`, `cargo watch -x run` when configured and available.
- Port strategy: env `PORT`, `ROCKET_PORT` for Rocket, pinned upstream port, explicit args only when configured.
- Health candidates: `/health`, `/`, `/api/health`.
- Wrapper strategy: generated env wrapper; no CLI arg guessing.
- Pinned-port fallback: use Rocket config or env only after preview.
- Repair when dynamic `PORT` is ignored: propose `ROCKET_PORT`, app config patch, or pinned port.
- Ambiguity questions: binary target, framework, port config, watch mode.
- Fixture plan: Axum, Rocket, multi-bin Cargo, non-web CLI.
- Confidence: high for web framework deps; medium for HTTP imports; low for generic binary.
- Unsupported diagnostic: ask for binary and port behavior.

### Elixir

- Tier: 2.
- Detection files: `mix.exs`, `config/dev.exs`, `config/runtime.exs`, `lib/*_web/endpoint.ex`.
- Build tool indicators: Mix, Phoenix dependency, umbrella apps.
- Server indicators: Phoenix endpoint, `Plug.Cowboy`, endpoint config.
- Start command candidates: `mix phx.server`, `iex -S mix phx.server`.
- Port strategy: `PORT` env when endpoint config reads it, Phoenix endpoint config patch after approval, pinned upstream port.
- Health candidates: `/health`, `/`, `/api/health`.
- Wrapper strategy: env wrapper plus approved config repair when needed.
- Pinned-port fallback: configured endpoint port.
- Repair when dynamic `PORT` is ignored: preview `dev.exs` or runtime config repair, or pinned upstream port.
- Ambiguity questions: umbrella app, endpoint module, config file to patch.
- Fixture plan: Phoenix, umbrella Phoenix, generic Mix app.
- Confidence: high for Phoenix; medium for Plug; low for generic Mix.
- Unsupported diagnostic: ask for app and endpoint.

### Scala

- Tier: 2.
- Detection files: `build.sbt`, `project/build.properties`, `src/main/scala`.
- Build tool indicators: sbt, Play Framework, Akka HTTP, http4s.
- Server indicators: Play routes, Akka HTTP deps, main class.
- Start command candidates: `sbt run`, `sbt <module>/run`, `sbt "~run"` only when user chooses watch mode.
- Port strategy: env `PORT`, Play HTTP port config, pinned upstream port.
- Health candidates: `/health`, `/`, `/api/health`.
- Wrapper strategy: generated sbt command wrapper with env; no module guessing.
- Pinned-port fallback: Play config port or explicit user choice.
- Repair when dynamic `PORT` is ignored: pass Play port config, ask for main class/module, or pinned port.
- Ambiguity questions: module, main class, Play vs generic, watch mode.
- Fixture plan: Play, Akka HTTP, multi-module sbt.
- Confidence: high for Play; medium for HTTP deps; low for library project.
- Unsupported diagnostic: ask for module/main class.

### Clojure

- Tier: 2.
- Detection files: `deps.edn`, `project.clj`, `build.boot`, `src/*/core.clj`.
- Build tool indicators: Clojure CLI, Leiningen, Boot, aliases.
- Server indicators: Ring, Compojure, Reitit, http-kit, Jetty adapter.
- Start command candidates: `lein ring server-headless`, `lein run`, `clj -M:<alias>`, `clojure -M:<alias>`.
- Port strategy: env `PORT` when Ring adapter/config supports it, alias/script-specific, pinned upstream port.
- Health candidates: `/health`, `/`, `/api/health`.
- Wrapper strategy: generated tool wrapper after alias selection.
- Pinned-port fallback: configured Ring port when detected.
- Repair when dynamic `PORT` is ignored: ask for alias/main, propose config/env patch, or pinned port.
- Ambiguity questions: lein vs clj, alias, Ring handler, namespace/main.
- Fixture plan: Lein Ring, deps.edn alias, ambiguous aliases.
- Confidence: high for Ring plugin/deps; medium for web deps; low for generic Clojure.
- Unsupported diagnostic: ask for alias and handler.

### Dart

- Tier: 2.
- Detection files: `pubspec.yaml`, `bin/server.dart`, `bin/main.dart`.
- Build tool indicators: Dart pub package, Shelf dependencies.
- Server indicators: `shelf`, `shelf_router`, executable in `bin`.
- Start command candidates: `dart run`, `dart run bin/server.dart`, `dart run <package>:<executable>`.
- Port strategy: env `PORT`, explicit `--port` only when command supports it, pinned upstream port.
- Health candidates: `/health`, `/`, `/api/health`.
- Wrapper strategy: generated command wrapper with env and optional selected executable.
- Pinned-port fallback: detected constants/config only after preview.
- Repair when dynamic `PORT` is ignored: ask for executable/flag, or pinned upstream port.
- Ambiguity questions: executable target, Shelf vs CLI app, port flag support.
- Fixture plan: Shelf app, multiple executables, non-server Dart package.
- Confidence: high for Shelf server; medium for bin server file; low for package only.
- Unsupported diagnostic: ask for executable and port handling.

### Generic Native / C / C++

- Tier: 2.
- Detection files: `CMakeLists.txt`, `Makefile`, `meson.build`, `configure`, `src/main.c`, `src/main.cpp`, `build/*`.
- Build tool indicators: CMake, Make, Meson, existing built executable.
- Server indicators: existing configured command, port constants, known HTTP libraries only when detectable.
- Start command candidates: existing manifest command, `make run` only if target exists, build plus executable only when explicit plan selected.
- Port strategy: env `PORT`, pinned upstream port, ask user.
- Health candidates: `/health`, `/`, `/api/health`.
- Wrapper strategy: env wrapper around explicit executable; no compile/run guessing.
- Pinned-port fallback: user-provided port or detected config.
- Repair when dynamic `PORT` is ignored: ask for command or pinned upstream port; file patches only after explicit diff approval.
- Ambiguity questions: build tool, run target, executable path, port behavior.
- Fixture plan: Makefile run target, CMake project with no run target, existing executable manifest.
- Confidence: medium for `make run`; low for generic source tree.
- Unsupported diagnostic: "Native project detected; Relaybase needs an explicit run command before setup can proceed."

### Procfile

- Tier: 2.
- Detection files: `Procfile`, `Procfile.dev`, `bin/dev`.
- Build tool indicators: Foreman-compatible process file, Heroku local convention, custom dev runner.
- Server indicators: `web:` process type, `release:` ignored for serving, multiple web-like process entries.
- Start command candidates: `foreman start`, `heroku local`, `bin/dev`, or selected process command.
- Port strategy: env `PORT`, process type selection, pinned upstream port.
- Health candidates: `/health`, `/`, `/api/health`.
- Wrapper strategy: generated wrapper only if a selected web process can receive `PORT`.
- Pinned-port fallback: existing Procfile/env port after preview.
- Repair when dynamic `PORT` is ignored: select web process, add env wrapper, or pinned port.
- Ambiguity questions: process type, foreman/heroku availability, single-process vs multi-process group.
- Fixture plan: Procfile with web, Procfile.dev with frontend/backend, bin/dev, ambiguous multiple web entries.
- Confidence: high for single `web:` process; medium for `bin/dev`; low for several process types.
- Unsupported diagnostic: ask for process type and command.

## Test Coverage

Fixture-driven tests do not touch real user state:

- detection fixture per runtime
- plan fixture per runtime
- preview writes nothing for every runtime
- apply requires confirmation for file writes and registration
- prove/repair behavior for runtimes where feasible
- secret redaction in env/config snippets
- path traversal rejection
- ambiguous project questions for multi-module or multi-process projects
- runtime adapter primary-runtime selection through setup detect results
- no arbitrary shell execution during detection; adapters inspect bounded files and snippets only
- no TUI file writes or lifecycle ownership; setup remains daemon-owned

Current test evidence:

- `tests/setup-runtime-matrix.test.ts`
- `node --experimental-strip-types --test tests\setup-runtime-matrix.test.ts`

## Unsupported Behavior Contract

When Relaybase cannot identify a safe setup path, the daemon should return diagnostics rather than choosing:

- `SETUP_RUNTIME_AMBIGUOUS`
- `SETUP_RUNTIME_UNSUPPORTED`
- `SETUP_RUNTIME_ENTRYPOINT_REQUIRED`
- `SETUP_RUNTIME_PORT_STRATEGY_REQUIRED`
- `SETUP_RUNTIME_TOOL_MISSING`
- `SETUP_RUNTIME_MULTIPLE_SERVERS`

Each diagnostic should include the detected evidence, the exact user decision needed, and the safest next command or manifest field to provide.
