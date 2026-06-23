import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  HealthCandidate,
  PortBindingStrategy,
  RepairCandidate,
  RuntimeAdapter,
  RuntimeDetectionInput,
  RuntimeDetectionResult,
  RuntimeId,
  RuntimeMatrixSnapshot,
  RuntimePackageJson,
  RuntimePlanInput,
  RuntimePlanResult,
  RuntimeRepairInput,
  SetupConfidence,
  SetupQuestion,
  StartCommandCandidate
} from "./setupRuntimeTypes.ts";

type PartialRuntimeDetectionInput = Omit<RuntimeDetectionInput, "relativeFiles" | "snippets"> &
  Partial<Pick<RuntimeDetectionInput, "relativeFiles" | "snippets">>;

const CONFIDENCE_SCORE: Record<SetupConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
  unsupported: 0
};

const SKIPPED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".relaybase",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__"
]);
const UNSAFE_COMMAND_PATH_CHARS = /[&|<>;$`"'\\]/;

const MAX_RELATIVE_FILES = 600;
const MAX_SNIPPETS = 120;
const MAX_SNIPPET_BYTES = 20_000;

export class RuntimeAdapterRegistry {
  readonly adapters: RuntimeAdapter[];

  constructor(adapters = defaultRuntimeAdapters()) {
    this.adapters = adapters;
  }

  async detect(input: PartialRuntimeDetectionInput): Promise<RuntimeMatrixSnapshot> {
    const project = await enrichInput(input);
    const runtimes: RuntimeDetectionResult[] = [];

    for (const adapter of this.adapters) {
      const detected = await adapter.detect(project);
      if (!detected || detected.confidence === "unsupported") {
        continue;
      }

      const planResult = await adapter.plan({ detection: detected, project });
      const repairCandidates = await adapter.repair({ detection: detected });
      runtimes.push({
        ...detected,
        startCommandCandidates: planResult.startCommandCandidates,
        portStrategies: planResult.portStrategies,
        healthCandidates: planResult.healthCandidates,
        questions: planResult.questions,
        repairCandidates: repairCandidates.length ? repairCandidates : detected.repairCandidates
      });
    }

    runtimes.sort(
      (left, right) =>
        CONFIDENCE_SCORE[right.confidence] - CONFIDENCE_SCORE[left.confidence] ||
        left.tier - right.tier ||
        left.runtime.localeCompare(right.runtime)
    );

    const questions = runtimeQuestions(runtimes);
    const diagnostics = runtimeDiagnostics(runtimes);
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      ...(runtimes[0] ? { primaryRuntime: runtimes[0].runtime } : {}),
      runtimes,
      questions,
      diagnostics
    };
  }
}

export async function detectRuntimeMatrix(input: PartialRuntimeDetectionInput): Promise<RuntimeMatrixSnapshot> {
  return new RuntimeAdapterRegistry().detect(input);
}

export function defaultRuntimeAdapters(): RuntimeAdapter[] {
  return [
    javascriptAdapter(),
    pythonAdapter(),
    goAdapter(),
    javaAdapter(),
    kotlinAdapter(),
    dotnetAdapter(),
    rubyAdapter(),
    phpAdapter(),
    dockerComposeAdapter(),
    rustAdapter(),
    elixirAdapter(),
    scalaAdapter(),
    clojureAdapter(),
    dartAdapter(),
    nativeAdapter(),
    procfileAdapter()
  ];
}

async function enrichInput(input: PartialRuntimeDetectionInput): Promise<RuntimeDetectionInput> {
  const relativeFiles = input.relativeFiles?.length ? input.relativeFiles : await collectRelativeFiles(input.root);
  const snippets = input.snippets ?? (await collectSnippets(input.root, relativeFiles));
  return {
    ...input,
    relativeFiles,
    snippets
  };
}

async function collectRelativeFiles(root: string): Promise<string[]> {
  const output: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 5 || output.length >= MAX_RELATIVE_FILES) {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (output.length >= MAX_RELATIVE_FILES) {
        return;
      }

      const absolute = path.join(directory, entry.name);
      const relative = slash(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          await visit(absolute, depth + 1);
        }
        continue;
      }

      if (entry.isFile()) {
        output.push(relative);
      }
    }
  }

  await visit(root, 0);
  return output;
}

async function collectSnippets(root: string, relativeFiles: string[]): Promise<Record<string, string>> {
  const snippets: Record<string, string> = {};
  for (const relative of relativeFiles.filter(isInterestingSnippetPath).slice(0, MAX_SNIPPETS)) {
    try {
      const absolute = path.resolve(root, relative);
      if (!isInside(root, absolute)) {
        continue;
      }
      const handle = await fs.open(absolute, "r");
      try {
        const buffer = Buffer.alloc(MAX_SNIPPET_BYTES);
        const result = await handle.read(buffer, 0, MAX_SNIPPET_BYTES, 0);
        snippets[relative] = buffer.subarray(0, result.bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      // Detection is best-effort; unreadable snippets become diagnostics only when
      // the corresponding runtime has enough other evidence to matter.
    }
  }
  return snippets;
}

function isInterestingSnippetPath(relative: string): boolean {
  return /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|Pipfile|manage\.py|app\.py|main\.py|wsgi\.py|asgi\.py|go\.mod|go\.work|main\.go|air\.toml|pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts|Program\.cs|[^/]+\.csproj|launchSettings\.json|Gemfile|config\.ru|composer\.json|artisan|Cargo\.toml|mix\.exs|build\.sbt|deps\.edn|project\.clj|pubspec\.yaml|Procfile|Procfile\.dev|Makefile|CMakeLists\.txt|docker-compose\.ya?ml|compose\.ya?ml)$/i.test(
    relative
  );
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function javascriptAdapter(): RuntimeAdapter {
  return adapter("javascript-typescript", 1, (input) => {
    const files = matchingFiles(input, [
      /^package\.json$/,
      /^tsconfig\.json$/,
      /^(next|vite|astro|svelte|nuxt|remix)\.config\./,
      /^angular\.json$/,
      /\.(?:js|cjs|mjs|ts)$/
    ]);
    if (!files.length && !input.packageJson) {
      return undefined;
    }

    const deps = input.dependencies;
    const scripts = input.scripts;
    const serverIndicators = [
      ...Object.entries(scripts)
        .filter(
          ([name, command]) =>
            /^(dev|start|serve)$/.test(name) || /\b(next|vite|astro|node|tsx|nuxt|remix)\b/.test(command)
        )
        .map(([name]) => `script:${name}`),
      ...indicatorDeps(deps, [
        "next",
        "vite",
        "astro",
        "express",
        "fastify",
        "@sveltejs/kit",
        "nuxt",
        "@remix-run/node"
      ])
    ];
    const framework = javascriptFramework(input);
    const confidence: SetupConfidence =
      input.packageJson && serverIndicators.length ? "high" : input.packageJson ? "medium" : "low";
    const candidates = javascriptStartCandidates(input);
    const ports = [
      portStrategy("env_port", confidence, { env: { PORT: "<PORT>", HOST: "<HOST>" } }),
      ...(framework
        ? [
            portStrategy("framework_port_flags", "high", { args: javascriptFrameworkArgs(framework) }),
            portStrategy("generated_launch_wrapper", "high", { wrapperKind: "node-launch-cjs" })
          ]
        : []),
      ...fixedPortStrategies(input)
    ];

    return result({
      runtime: "javascript-typescript",
      label: "JavaScript / TypeScript",
      tier: 1,
      confidence,
      detectionFiles: files,
      buildToolIndicators: [
        packageManagerFromPackageJson(input.packageJson, input.files),
        ...(hasFile(input, /^tsconfig\.json$/) ? ["TypeScript"] : [])
      ],
      serverIndicators,
      startCommandCandidates: candidates,
      portStrategies: ports,
      healthCandidates: health(
        ["/", "/health", "/api/health"],
        framework ? "framework route candidates" : "generic web route candidates"
      ),
      questions: [
        ...(candidates.length
          ? []
          : [question("javascript.script", "Choose the package script Relaybase should run.", true)]),
        ...(input.packageJson?.workspaces
          ? [question("javascript.workspace", "Choose the workspace package to configure.", true)]
          : [])
      ],
      diagnostics:
        confidence === "medium"
          ? [
              diagnostic(
                "SETUP_RUNTIME_ENTRYPOINT_REQUIRED",
                "warning",
                "JavaScript package detected, but no dev/start web script was obvious.",
                "Choose a package script or provide a manifest command."
              )
            ]
          : []
    });
  });
}

function pythonAdapter(): RuntimeAdapter {
  return adapter("python", 1, (input) => {
    const files = matchingFiles(input, [
      /^pyproject\.toml$/,
      /^requirements\.txt$/,
      /^uv\.lock$/,
      /^poetry\.lock$/,
      /^Pipfile$/,
      /^manage\.py$/,
      /^(app|main|wsgi|asgi)\.py$/
    ]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const django = hasFile(input, /^manage\.py$/) || /django/i.test(text);
    const fastapi = /fastapi|uvicorn|starlette/i.test(text);
    const flask = /flask/i.test(text);
    const tool = pythonTool(input);
    const module = hasFile(input, /^app\.py$/) ? "app:app" : "main:app";
    const candidates = [
      ...(django
        ? [
            command(
              "python.django",
              "Django development server",
              pythonCommand(tool, ["manage.py", "runserver", "<HOST>:<PORT>"]),
              "high",
              ["manage.py detected"]
            )
          ]
        : []),
      ...(fastapi
        ? [
            command(
              "python.asgi",
              "ASGI/Uvicorn server",
              pythonCommand(tool, ["-m", "uvicorn", module, "--host", "<HOST>", "--port", "<PORT>"]),
              "high",
              ["FastAPI/Uvicorn or ASGI indicators detected"]
            )
          ]
        : []),
      ...(flask
        ? [
            command(
              "python.flask",
              "Flask development server",
              pythonCommand(tool, ["-m", "flask", "run", "--host", "<HOST>", "--port", "<PORT>"]),
              "high",
              ["Flask indicators detected"]
            )
          ]
        : []),
      ...(!django && !fastapi && !flask && (hasFile(input, /^app\.py$/) || hasFile(input, /^main\.py$/))
        ? [
            command(
              "python.manual",
              "Python app entrypoint",
              ["python", hasFile(input, /^app\.py$/) ? "app.py" : "main.py"],
              "low",
              ["Python app file detected"],
              ["Relaybase cannot prove this command starts a web server."]
            )
          ]
        : [])
    ].map(flattenToolCommand);
    const confidence: SetupConfidence =
      django || fastapi || flask
        ? "high"
        : files.some((file) => /^pyproject\.toml$|^requirements\.txt$/.test(file))
          ? "medium"
          : "low";

    return result({
      runtime: "python",
      label: "Python",
      tier: 1,
      confidence,
      detectionFiles: files,
      buildToolIndicators: [
        tool === "poetry" ? "Poetry" : tool === "uv" ? "uv" : tool === "pipenv" ? "Pipenv" : "Python"
      ],
      serverIndicators: [
        ...(django ? ["Django"] : []),
        ...(fastapi ? ["FastAPI/Uvicorn"] : []),
        ...(flask ? ["Flask"] : [])
      ],
      startCommandCandidates: candidates,
      portStrategies: [
        portStrategy("explicit_host_port_flags", django || fastapi || flask ? "high" : "low", {
          args: django ? ["runserver", "<HOST>:<PORT>"] : ["--host", "<HOST>", "--port", "<PORT>"]
        }),
        portStrategy("env_port", "medium", { env: { PORT: "<PORT>", HOST: "<HOST>" } }),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/health", "/api/health", "/"], "common Python web health routes"),
      questions:
        candidates[0]?.confidence === "low"
          ? [question("python.entrypoint", "Choose the Python web module or server command.", true)]
          : []
    });
  });
}

function goAdapter(): RuntimeAdapter {
  return adapter("go", 1, (input) => {
    const files = matchingFiles(input, [
      /^go\.mod$/,
      /^go\.work$/,
      /^main\.go$/,
      /^cmd\/[^/]+\/main\.go$/,
      /^air\.toml$/
    ]);
    if (!files.length) {
      return undefined;
    }

    const cmdMains = matchingFiles(input, [/^cmd\/[^/]+\/main\.go$/]);
    const rootMain = hasFile(input, /^main\.go$/);
    const text = combinedSnippet(input);
    const serverIndicators = [
      ...(/net\/http|gin-gonic|labstack\/echo|gofiber|go-chi\/chi/i.test(text) ? ["HTTP server imports"] : []),
      ...(hasFile(input, /^air\.toml$/) ? ["air.toml"] : [])
    ];
    const candidates = [
      ...(rootMain
        ? [command("go.root", "Go root module", ["go", "run", "."], "high", ["main.go detected at project root"])]
        : []),
      ...cmdMains.flatMap((file) => {
        const commandPath = `./${path.posix.dirname(file)}`;
        if (!isSafeCommandPathPart(commandPath)) {
          return [];
        }

        return command(
          `go.${commandPath}`,
          `Go command ${commandPath}`,
          ["go", "run", commandPath],
          cmdMains.length === 1 ? "high" : "medium",
          [`${file} detected`]
        );
      }),
      ...(hasFile(input, /^air\.toml$/)
        ? [
            command(
              "go.air",
              "Air live reload",
              ["air"],
              "medium",
              ["air.toml detected"],
              ["Requires air to be installed."]
            )
          ]
        : [])
    ];

    return result({
      runtime: "go",
      label: "Go",
      tier: 1,
      confidence: serverIndicators.length || rootMain || cmdMains.length === 1 ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: [hasFile(input, /^go\.work$/) ? "Go workspace" : "Go module"],
      serverIndicators,
      startCommandCandidates: candidates,
      portStrategies: [
        portStrategy("env_port", "medium", { env: { PORT: "<PORT>", HOST: "<HOST>" } }),
        portStrategy("manual_custom", "medium"),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/health", "/ready", "/", "/api/health"], "common Go web health routes"),
      questions: cmdMains.length > 1 ? [question("go.command", "Choose the Go command package to run.", true)] : []
    });
  });
}

function javaAdapter(): RuntimeAdapter {
  return adapter("java", 1, (input) => {
    const files = matchingFiles(input, [
      /^pom\.xml$/,
      /^build\.gradle$/,
      /^mvnw(?:\.cmd)?$/,
      /^gradlew(?:\.bat)?$/,
      /^src\/main\/java\//
    ]);
    if (!files.length || hasFile(input, /^build\.gradle\.kts$/)) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const spring = /spring-boot|SpringBootApplication|org\.springframework/i.test(text);
    const quarkus = /quarkus/i.test(text);
    const micronaut = /micronaut/i.test(text);
    const maven = hasFile(input, /^pom\.xml$/);
    const gradle = hasFile(input, /^build\.gradle$/);
    const candidates = [
      ...(maven
        ? [
            command(
              "java.maven.spring",
              "Maven Spring Boot",
              [hasFile(input, /^mvnw(?:\.cmd)?$/) ? "./mvnw" : "mvn", "spring-boot:run"],
              spring ? "high" : "medium",
              ["Maven project detected"]
            )
          ]
        : []),
      ...(gradle
        ? [
            command(
              "java.gradle.boot",
              "Gradle bootRun",
              [hasFile(input, /^gradlew(?:\.bat)?$/) ? "./gradlew" : "gradle", "bootRun"],
              spring ? "high" : "medium",
              ["Gradle project detected"]
            )
          ]
        : [])
    ];

    return result({
      runtime: "java",
      label: "Java",
      tier: 1,
      confidence: spring || quarkus || micronaut ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: [...(maven ? ["Maven"] : []), ...(gradle ? ["Gradle"] : [])],
      serverIndicators: [
        ...(spring ? ["Spring Boot"] : []),
        ...(quarkus ? ["Quarkus"] : []),
        ...(micronaut ? ["Micronaut"] : [])
      ],
      startCommandCandidates: candidates,
      portStrategies: [
        portStrategy("runtime_specific_env", "high", { env: { SERVER_PORT: "<PORT>", HOST: "<HOST>" } }),
        portStrategy("explicit_host_port_flags", "medium", {
          args: ["--server.address=<HOST>", "--server.port=<PORT>"]
        }),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/actuator/health", "/q/health", "/health", "/"], "common JVM health routes"),
      questions:
        candidates.length > 1 ? [question("java.build-tool", "Choose the Java build tool/task to run.", true)] : []
    });
  });
}

function kotlinAdapter(): RuntimeAdapter {
  return adapter("kotlin-jvm", 1, (input) => {
    const files = matchingFiles(input, [/^build\.gradle\.kts$/, /^settings\.gradle\.kts$/, /^src\/main\/kotlin\//]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const ktor = /ktor/i.test(text);
    const spring = /spring-boot|SpringBootApplication|org\.springframework/i.test(text);
    const task = spring ? "bootRun" : "run";
    return result({
      runtime: "kotlin-jvm",
      label: "Kotlin / JVM",
      tier: 1,
      confidence: ktor || spring ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: ["Gradle Kotlin DSL"],
      serverIndicators: [...(ktor ? ["Ktor"] : []), ...(spring ? ["Spring Boot Kotlin"] : [])],
      startCommandCandidates: [
        command(
          "kotlin.gradle",
          `Gradle ${task}`,
          [hasFile(input, /^gradlew(?:\.bat)?$/) ? "./gradlew" : "gradle", task],
          ktor || spring ? "high" : "medium",
          ["Kotlin Gradle project detected"]
        )
      ],
      portStrategies: [
        portStrategy("runtime_specific_env", spring ? "high" : "medium", {
          env: spring ? { SERVER_PORT: "<PORT>" } : { PORT: "<PORT>" }
        }),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/health", "/actuator/health", "/", "/api/health"], "common Kotlin web health routes"),
      questions:
        spring || ktor ? [] : [question("kotlin.task", "Choose the Kotlin run task or server framework.", true)]
    });
  });
}

function dotnetAdapter(): RuntimeAdapter {
  return adapter("dotnet", 1, (input) => {
    const csprojFiles = matchingFiles(input, [/[^/]+\.csproj$/]);
    const files = matchingFiles(input, [
      /[^/]+\.sln$/,
      /[^/]+\.csproj$/,
      /Program\.cs$/,
      /launchSettings\.json$/,
      /^global\.json$/
    ]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const web = /Microsoft\.NET\.Sdk\.Web|WebApplication\.CreateBuilder|Microsoft\.AspNetCore/i.test(text);
    const safeCsproj = csprojFiles.length === 1 && isSafeCommandPathPart(csprojFiles[0]) ? csprojFiles[0] : undefined;
    const candidates = safeCsproj
      ? [
          command(
            "dotnet.project",
            "dotnet run project",
            ["dotnet", "run", "--project", safeCsproj],
            web ? "high" : "medium",
            [`${safeCsproj} detected`]
          )
        ]
      : [command("dotnet.run", "dotnet run", ["dotnet", "run"], web ? "medium" : "low", ["dotnet project detected"])];

    return result({
      runtime: "dotnet",
      label: "C# / .NET",
      tier: 1,
      confidence: web ? "high" : csprojFiles.length ? "medium" : "low",
      detectionFiles: files,
      buildToolIndicators: [csprojFiles.length > 1 ? ".NET solution/projects" : ".NET project"],
      serverIndicators: web ? ["ASP.NET Core"] : [],
      startCommandCandidates: candidates,
      portStrategies: [
        portStrategy("runtime_specific_env", "high", {
          env: { ASPNETCORE_URLS: "http://<HOST>:<PORT>", ASPNETCORE_HTTP_PORTS: "<PORT>", DOTNET_HTTP_PORTS: "<PORT>" }
        }),
        portStrategy("explicit_host_port_flags", "medium", { args: ["--urls", "http://<HOST>:<PORT>"] }),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/health", "/", "/swagger", "/api/health"], "common ASP.NET Core health routes"),
      questions: csprojFiles.length > 1 ? [question("dotnet.project", "Choose the .NET web project to run.", true)] : []
    });
  });
}

function rubyAdapter(): RuntimeAdapter {
  return adapter("ruby", 1, (input) => {
    const files = matchingFiles(input, [
      /^Gemfile$/,
      /^config\.ru$/,
      /^bin\/rails$/,
      /^config\/routes\.rb$/,
      /^Rakefile$/
    ]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const rails = hasFile(input, /^bin\/rails$/) || /rails/i.test(text);
    const rack = hasFile(input, /^config\.ru$/) || /rack|sinatra/i.test(text);
    const candidates = [
      ...(rails
        ? [
            command(
              "ruby.rails",
              "Rails server",
              [
                hasFile(input, /^bin\/rails$/) ? "bin/rails" : "bundle",
                ...(hasFile(input, /^bin\/rails$/) ? [] : ["exec", "rails"]),
                "server",
                "-b",
                "<HOST>",
                "-p",
                "<PORT>"
              ],
              "high",
              ["Rails indicators detected"]
            )
          ]
        : []),
      ...(rack
        ? [
            command("ruby.rack", "Rack server", ["bundle", "exec", "rackup", "-o", "<HOST>", "-p", "<PORT>"], "high", [
              "Rack config detected"
            ])
          ]
        : [])
    ];

    return result({
      runtime: "ruby",
      label: "Ruby",
      tier: 1,
      confidence: rails || rack ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: ["Bundler/Ruby"],
      serverIndicators: [...(rails ? ["Rails"] : []), ...(rack ? ["Rack/Sinatra"] : [])],
      startCommandCandidates: candidates.length
        ? candidates
        : [
            command(
              "ruby.manual",
              "Ruby server command",
              ["bundle", "exec", "ruby", "app.rb"],
              "low",
              ["Gemfile detected"],
              ["Relaybase needs confirmation of the server entrypoint."]
            )
          ],
      portStrategies: [
        portStrategy("explicit_host_port_flags", rails || rack ? "high" : "low", {
          args: ["-b", "<HOST>", "-p", "<PORT>"]
        }),
        portStrategy("env_port", "medium", { env: { PORT: "<PORT>" } }),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/up", "/health", "/"], "common Ruby web health routes"),
      questions: rails || rack ? [] : [question("ruby.server", "Choose the Ruby server command or process type.", true)]
    });
  });
}

function phpAdapter(): RuntimeAdapter {
  return adapter("php", 1, (input) => {
    const files = matchingFiles(input, [
      /^composer\.json$/,
      /^artisan$/,
      /^public\/index\.php$/,
      /^symfony\.lock$/,
      /^bin\/console$/
    ]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const laravel = hasFile(input, /^artisan$/) || /laravel/i.test(text);
    const symfony = hasFile(input, /^symfony\.lock$/) || hasFile(input, /^bin\/console$/) || /symfony/i.test(text);
    const publicRoot = hasFile(input, /^public\/index\.php$/);
    const candidates = [
      ...(laravel
        ? [
            command(
              "php.laravel",
              "Laravel artisan server",
              ["php", "artisan", "serve", "--host", "<HOST>", "--port", "<PORT>"],
              "high",
              ["Laravel artisan detected"]
            )
          ]
        : []),
      ...(symfony
        ? [
            command(
              "php.symfony",
              "Symfony local server",
              ["symfony", "serve", "--port=<PORT>"],
              "medium",
              ["Symfony indicators detected"],
              ["Requires Symfony CLI."]
            )
          ]
        : []),
      ...(publicRoot
        ? [
            command(
              "php.builtin",
              "PHP built-in server",
              ["php", "-S", "<HOST>:<PORT>", "-t", "public"],
              laravel || symfony ? "medium" : "high",
              ["public/index.php detected"]
            )
          ]
        : [])
    ];

    return result({
      runtime: "php",
      label: "PHP",
      tier: 1,
      confidence: laravel || symfony || publicRoot ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: ["Composer/PHP"],
      serverIndicators: [
        ...(laravel ? ["Laravel"] : []),
        ...(symfony ? ["Symfony"] : []),
        ...(publicRoot ? ["public document root"] : [])
      ],
      startCommandCandidates: candidates,
      portStrategies: [
        portStrategy("explicit_host_port_flags", "high", { args: ["--host", "<HOST>", "--port", "<PORT>"] }),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/up", "/health", "/", "/api/health"], "common PHP web health routes"),
      questions: candidates.length
        ? []
        : [question("php.server", "Choose the PHP server command or public root.", true)]
    });
  });
}

function dockerComposeAdapter(): RuntimeAdapter {
  return adapter("docker-compose", 1, (input) => {
    const files = matchingFiles(input, [/^docker-compose\.(?:ya?ml)$/, /^compose\.(?:ya?ml)$/]);
    if (!files.length) {
      return undefined;
    }

    return result({
      runtime: "docker-compose",
      label: "Docker Compose",
      tier: 1,
      confidence: "high",
      detectionFiles: files,
      buildToolIndicators: ["Docker Compose"],
      serverIndicators: ["Compose service definitions"],
      startCommandCandidates: [
        command(
          "compose.up",
          "Docker Compose stack",
          ["docker", "compose", "up"],
          "medium",
          ["Compose file detected"],
          ["Relaybase needs the app-facing service and target port before applying."]
        )
      ],
      portStrategies: [portStrategy("compose_port_mapping", "medium"), portStrategy("fixed_upstream_port", "medium")],
      healthCandidates: health(["/health", "/api/health", "/"], "Compose service health route candidates"),
      questions: [
        question("docker.service", "Choose the app-facing Compose service.", true),
        question("docker.targetPort", "Choose the target container port to route.", true)
      ]
    });
  });
}

function rustAdapter(): RuntimeAdapter {
  return adapter("rust", 2, (input) => {
    const files = matchingFiles(input, [/^Cargo\.toml$/, /^Cargo\.lock$/, /^src\/main\.rs$/, /^src\/bin\/[^/]+\.rs$/]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const web = /axum|actix-web|rocket|warp|hyper/i.test(text);
    const bins = matchingFiles(input, [/^src\/bin\/[^/]+\.rs$/]);
    return result({
      runtime: "rust",
      label: "Rust",
      tier: 2,
      confidence: web ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: ["Cargo"],
      serverIndicators: web ? ["Rust web framework dependency"] : [],
      startCommandCandidates: [
        ...(hasFile(input, /^src\/main\.rs$/)
          ? [command("rust.run", "Cargo run", ["cargo", "run"], web ? "high" : "medium", ["src/main.rs detected"])]
          : []),
        ...bins.flatMap((file) => {
          const binName = path.posix.basename(file, ".rs");
          if (!isSafeCommandPathPart(binName)) {
            return [];
          }

          return command(
            `rust.${file}`,
            `Cargo bin ${binName}`,
            ["cargo", "run", "--bin", binName],
            bins.length === 1 ? "high" : "medium",
            [`${file} detected`]
          );
        })
      ],
      portStrategies: [
        portStrategy("env_port", "medium", { env: { PORT: "<PORT>" } }),
        ...(text.includes("rocket")
          ? [portStrategy("runtime_specific_env", "high", { env: { ROCKET_PORT: "<PORT>" } })]
          : []),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/health", "/", "/api/health"], "common Rust web health routes"),
      questions: bins.length > 1 ? [question("rust.bin", "Choose the Rust binary target.", true)] : []
    });
  });
}

function elixirAdapter(): RuntimeAdapter {
  return adapter("elixir", 2, (input) => {
    const files = matchingFiles(input, [
      /^mix\.exs$/,
      /^config\/(?:dev|runtime)\.exs$/,
      /^lib\/[^/]+_web\/endpoint\.ex$/
    ]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const phoenix = /phoenix|phx\.server|Endpoint/i.test(text) || hasFile(input, /^lib\/[^/]+_web\/endpoint\.ex$/);
    return result({
      runtime: "elixir",
      label: "Elixir",
      tier: 2,
      confidence: phoenix ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: ["Mix"],
      serverIndicators: phoenix ? ["Phoenix endpoint"] : [],
      startCommandCandidates: [
        command("elixir.phx", "Phoenix server", ["mix", "phx.server"], phoenix ? "high" : "medium", [
          "mix.exs detected"
        ])
      ],
      portStrategies: [portStrategy("env_port", "medium", { env: { PORT: "<PORT>" } }), ...fixedPortStrategies(input)],
      healthCandidates: health(["/health", "/", "/api/health"], "common Elixir web health routes"),
      questions: phoenix ? [] : [question("elixir.endpoint", "Choose the Elixir endpoint or server command.", true)]
    });
  });
}

function scalaAdapter(): RuntimeAdapter {
  return adapter("scala", 2, (input) => {
    const files = matchingFiles(input, [/^build\.sbt$/, /^project\/build\.properties$/, /^src\/main\/scala\//]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const play = /playframework|play\.sbt|routes/i.test(text);
    return result({
      runtime: "scala",
      label: "Scala",
      tier: 2,
      confidence: play ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: ["sbt"],
      serverIndicators: play ? ["Play Framework"] : [],
      startCommandCandidates: [
        command("scala.sbt-run", "sbt run", ["sbt", "run"], play ? "high" : "medium", ["build.sbt detected"])
      ],
      portStrategies: [
        portStrategy("env_port", "medium", { env: { PORT: "<PORT>" } }),
        portStrategy("runtime_specific_env", play ? "high" : "medium", { env: { PLAY_HTTP_PORT: "<PORT>" } }),
        ...fixedPortStrategies(input)
      ],
      healthCandidates: health(["/health", "/", "/api/health"], "common Scala web health routes"),
      questions: [
        question("scala.main", "Choose the Scala module or main class when sbt reports multiple entrypoints.", false)
      ]
    });
  });
}

function clojureAdapter(): RuntimeAdapter {
  return adapter("clojure", 2, (input) => {
    const files = matchingFiles(input, [/^deps\.edn$/, /^project\.clj$/, /^build\.boot$/, /^src\/.*\.clj$/]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const ring = /ring|compojure|reitit|http-kit|jetty/i.test(text);
    const lein = hasFile(input, /^project\.clj$/);
    return result({
      runtime: "clojure",
      label: "Clojure",
      tier: 2,
      confidence: ring ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: [lein ? "Leiningen" : "Clojure CLI"],
      serverIndicators: ring ? ["Ring-compatible web stack"] : [],
      startCommandCandidates: [
        lein
          ? command("clojure.lein", "Lein Ring server", ["lein", "ring", "server-headless"], ring ? "high" : "medium", [
              "project.clj detected"
            ])
          : command(
              "clojure.clj",
              "Clojure CLI alias",
              ["clojure", "-M:dev"],
              "medium",
              ["deps.edn detected"],
              ["Relaybase needs the correct alias if :dev is not the web server."]
            )
      ],
      portStrategies: [portStrategy("env_port", "medium", { env: { PORT: "<PORT>" } }), ...fixedPortStrategies(input)],
      healthCandidates: health(["/health", "/", "/api/health"], "common Clojure web health routes"),
      questions: [question("clojure.alias", "Choose the Clojure alias or Ring handler.", !ring)]
    });
  });
}

function dartAdapter(): RuntimeAdapter {
  return adapter("dart", 2, (input) => {
    const files = matchingFiles(input, [/^pubspec\.yaml$/, /^bin\/(?:server|main)\.dart$/]);
    if (!files.length) {
      return undefined;
    }

    const text = combinedSnippet(input);
    const shelf = /shelf|shelf_router/i.test(text);
    const server = hasFile(input, /^bin\/server\.dart$/)
      ? "bin/server.dart"
      : hasFile(input, /^bin\/main\.dart$/)
        ? "bin/main.dart"
        : undefined;
    return result({
      runtime: "dart",
      label: "Dart",
      tier: 2,
      confidence: shelf || server ? "high" : "medium",
      detectionFiles: files,
      buildToolIndicators: ["Dart pub"],
      serverIndicators: shelf ? ["Shelf"] : [],
      startCommandCandidates: [
        command(
          "dart.run",
          "Dart server",
          server ? ["dart", "run", server] : ["dart", "run"],
          server ? "high" : "medium",
          ["pubspec.yaml detected"]
        )
      ],
      portStrategies: [portStrategy("env_port", "medium", { env: { PORT: "<PORT>" } }), ...fixedPortStrategies(input)],
      healthCandidates: health(["/health", "/", "/api/health"], "common Dart web health routes"),
      questions: server ? [] : [question("dart.executable", "Choose the Dart executable to run.", true)]
    });
  });
}

function nativeAdapter(): RuntimeAdapter {
  return adapter("native", 2, (input) => {
    const files = matchingFiles(input, [
      /^CMakeLists\.txt$/,
      /^Makefile$/,
      /^meson\.build$/,
      /^configure$/,
      /^src\/main\.(?:c|cc|cpp|cxx)$/
    ]);
    if (!files.length) {
      return undefined;
    }

    const makeRun = snippet(input, "Makefile")
      .split(/\r?\n/)
      .some((line) => /^run\s*:/.test(line));
    return result({
      runtime: "native",
      label: "Native / C / C++",
      tier: 2,
      confidence: makeRun ? "medium" : "low",
      detectionFiles: files,
      buildToolIndicators: [
        ...(hasFile(input, /^Makefile$/) ? ["Make"] : []),
        ...(hasFile(input, /^CMakeLists\.txt$/) ? ["CMake"] : [])
      ],
      serverIndicators: [],
      startCommandCandidates: makeRun
        ? [command("native.make-run", "Make run target", ["make", "run"], "medium", ["Makefile run target detected"])]
        : [],
      portStrategies: [portStrategy("manual_custom", "low"), ...fixedPortStrategies(input)],
      healthCandidates: health(["/health", "/", "/api/health"], "generic native HTTP health routes"),
      questions: [
        question("native.command", "Provide the native executable or run target Relaybase should manage.", true)
      ]
    });
  });
}

function procfileAdapter(): RuntimeAdapter {
  return adapter("procfile", 2, (input) => {
    const files = matchingFiles(input, [/^Procfile$/, /^Procfile\.dev$/, /^bin\/dev$/]);
    if (!files.length) {
      return undefined;
    }

    const procfileText = snippet(input, "Procfile") || snippet(input, "Procfile.dev");
    const webEntries = procfileText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^web(?:-\w+)?:/.test(line));
    return result({
      runtime: "procfile",
      label: "Procfile",
      tier: 2,
      confidence: webEntries.length === 1 ? "high" : files.includes("bin/dev") ? "medium" : "low",
      detectionFiles: files,
      buildToolIndicators: ["Procfile convention"],
      serverIndicators: webEntries.map((entry) => entry.split(":")[0] ?? "web"),
      startCommandCandidates: [
        ...(webEntries.length === 1
          ? [
              command(
                "procfile.web",
                "Procfile web process",
                ["foreman", "start", "web"],
                "medium",
                ["single web process detected"],
                ["Requires foreman or compatible runner."]
              )
            ]
          : []),
        ...(files.includes("bin/dev")
          ? [command("procfile.bin-dev", "bin/dev runner", ["bin/dev"], "medium", ["bin/dev detected"])]
          : [])
      ],
      portStrategies: [portStrategy("env_port", "medium", { env: { PORT: "<PORT>" } }), ...fixedPortStrategies(input)],
      healthCandidates: health(["/health", "/", "/api/health"], "Procfile web health routes"),
      questions:
        webEntries.length === 1
          ? []
          : [question("procfile.process", "Choose the Procfile web process Relaybase should manage.", true)]
    });
  });
}

function adapter(
  id: RuntimeId,
  tier: 1 | 2,
  detect: (input: RuntimeDetectionInput) => RuntimeDetectionResult | undefined
): RuntimeAdapter {
  return {
    id,
    tier,
    detect,
    plan(input: RuntimePlanInput): RuntimePlanResult {
      return {
        startCommandCandidates: input.detection.startCommandCandidates,
        portStrategies: input.detection.portStrategies,
        healthCandidates: input.detection.healthCandidates,
        questions: input.detection.questions
      };
    },
    repair(input: RuntimeRepairInput): RepairCandidate[] {
      return defaultRepairs(input.detection, input.reason);
    }
  };
}

function result(
  input: Omit<RuntimeDetectionResult, "repairCandidates" | "diagnostics"> & {
    diagnostics?: RuntimeDetectionResult["diagnostics"];
    repairCandidates?: RepairCandidate[];
  }
): RuntimeDetectionResult {
  return {
    ...input,
    repairCandidates: input.repairCandidates ?? defaultRepairs(input),
    diagnostics: input.diagnostics ?? []
  };
}

function defaultRepairs(
  input: Pick<RuntimeDetectionResult, "runtime" | "portStrategies">,
  reason?: string
): RepairCandidate[] {
  const hasExplicit = input.portStrategies.some((strategy) =>
    ["explicit_host_port_flags", "framework_port_flags", "runtime_specific_env"].includes(strategy.id)
  );
  return [
    ...(hasExplicit
      ? [
          repair(
            `${input.runtime}.explicit-port`,
            "Retry with runtime-specific host/port flags or env mapping.",
            input.runtime,
            "Relaybase can preview a manifest or wrapper change that passes the assigned port explicitly."
          )
        ]
      : []),
    repair(
      `${input.runtime}.pinned-upstream`,
      "Retry with a pinned upstream port after user approval.",
      input.runtime,
      reason ?? "Use only when the runtime cannot honor the daemon-assigned PORT."
    )
  ];
}

function repair(id: string, label: string, appliesTo: RuntimeId, message: string): RepairCandidate {
  return {
    id,
    label,
    appliesTo,
    previewOnly: true,
    approvalRequired: true,
    diagnostics: [diagnostic("SETUP_RUNTIME_REPAIR_PREVIEW", "info", message)]
  };
}

function runtimeQuestions(runtimes: RuntimeDetectionResult[]): SetupQuestion[] {
  const actionable = runtimes.filter((runtime) => CONFIDENCE_SCORE[runtime.confidence] >= CONFIDENCE_SCORE.medium);
  const questions = runtimes.flatMap((runtime) => runtime.questions);
  if (actionable.length > 1) {
    questions.unshift({
      id: "runtime.primary",
      prompt: "Choose the runtime Relaybase should configure for this folder.",
      required: true,
      choices: actionable.slice(0, 8).map((runtime) => ({
        id: runtime.runtime,
        label: runtime.label,
        detail: `${runtime.confidence} confidence from ${runtime.detectionFiles.slice(0, 4).join(", ")}`
      }))
    });
  }
  return dedupeQuestions(questions);
}

function runtimeDiagnostics(runtimes: RuntimeDetectionResult[]): RuntimeDetectionResult["diagnostics"] {
  if (!runtimes.length) {
    return [
      diagnostic(
        "SETUP_RUNTIME_UNSUPPORTED",
        "warning",
        "Relaybase could not identify a supported runtime in this folder.",
        "Provide a manifest or explicit app command."
      )
    ];
  }

  const actionable = runtimes.filter((runtime) => CONFIDENCE_SCORE[runtime.confidence] >= CONFIDENCE_SCORE.medium);
  return [
    ...(actionable.length > 1
      ? [
          diagnostic(
            "SETUP_RUNTIME_AMBIGUOUS",
            "warning",
            "Multiple plausible runtimes were detected; Relaybase will not choose silently.",
            "Choose the runtime and entrypoint before applying setup."
          )
        ]
      : []),
    ...runtimes.flatMap((runtime) => runtime.diagnostics)
  ];
}

function dedupeQuestions(questions: SetupQuestion[]): SetupQuestion[] {
  const seen = new Set<string>();
  return questions.filter((question) => {
    if (seen.has(question.id)) {
      return false;
    }
    seen.add(question.id);
    return true;
  });
}

function command(
  id: string,
  label: string,
  commandParts: string[],
  confidence: SetupConfidence,
  reasons: string[],
  risks: string[] = []
): StartCommandCandidate {
  const filtered = commandParts.filter(Boolean);
  return {
    id,
    label,
    command: filtered,
    commandPreview: filtered.map(quoteCommandPart).join(" "),
    confidence,
    reasons,
    risks
  };
}

function flattenToolCommand(candidate: StartCommandCandidate): StartCommandCandidate {
  if (candidate.command[0] === "python" || candidate.command.length < 2) {
    return candidate;
  }

  const tool = candidate.command[0];
  if (tool === "poetry") {
    return {
      ...candidate,
      command: ["poetry", "run", ...candidate.command.slice(1)],
      commandPreview: ["poetry", "run", ...candidate.command.slice(1)].map(quoteCommandPart).join(" ")
    };
  }
  if (tool === "uv") {
    return {
      ...candidate,
      command: ["uv", "run", ...candidate.command.slice(1)],
      commandPreview: ["uv", "run", ...candidate.command.slice(1)].map(quoteCommandPart).join(" ")
    };
  }
  if (tool === "pipenv") {
    return {
      ...candidate,
      command: ["pipenv", "run", ...candidate.command.slice(1)],
      commandPreview: ["pipenv", "run", ...candidate.command.slice(1)].map(quoteCommandPart).join(" ")
    };
  }
  return candidate;
}

function quoteCommandPart(part: string): string {
  return /\s/.test(part) ? JSON.stringify(part) : part;
}

function portStrategy(
  id: PortBindingStrategy["id"],
  confidence: SetupConfidence,
  options: Omit<PortBindingStrategy, "id" | "confidence" | "diagnostics"> & {
    diagnostics?: PortBindingStrategy["diagnostics"];
  } = {}
): PortBindingStrategy {
  return {
    id,
    confidence,
    ...(options.env ? { env: options.env } : {}),
    ...(options.args ? { args: options.args } : {}),
    ...(options.wrapperKind ? { wrapperKind: options.wrapperKind } : {}),
    diagnostics: options.diagnostics ?? []
  };
}

function fixedPortStrategies(input: RuntimeDetectionInput): PortBindingStrategy[] {
  return input.detectedPorts.length
    ? [
        portStrategy("fixed_upstream_port", "medium", {
          diagnostics: [
            diagnostic(
              "SETUP_RUNTIME_FIXED_PORT_DETECTED",
              "info",
              `Detected fixed port candidate ${input.detectedPorts[0]}.`
            )
          ]
        })
      ]
    : [];
}

function health(paths: string[], reason: string): HealthCandidate[] {
  return paths.map((pathName, index) => ({
    path: pathName,
    confidence: index === 0 ? "high" : "medium",
    reason
  }));
}

function question(id: string, prompt: string, required: boolean, choices?: SetupQuestion["choices"]): SetupQuestion {
  return {
    id,
    prompt,
    required,
    ...(choices?.length ? { choices } : {})
  };
}

function diagnostic(
  code: string,
  severity: "info" | "warning" | "error",
  message: string,
  userAction?: string,
  detail?: unknown
): RuntimeDetectionResult["diagnostics"][number] {
  return {
    code,
    severity,
    message,
    ...(detail === undefined ? {} : { detail }),
    ...(userAction ? { userAction } : {})
  };
}

function matchingFiles(input: RuntimeDetectionInput, patterns: RegExp[]): string[] {
  return input.relativeFiles.filter((file) => patterns.some((pattern) => pattern.test(file)));
}

function isSafeCommandPathPart(value: string): boolean {
  return !UNSAFE_COMMAND_PATH_CHARS.test(value);
}

function hasFile(input: RuntimeDetectionInput, pattern: RegExp): boolean {
  return input.relativeFiles.some((file) => pattern.test(file)) || input.files.some((file) => pattern.test(file));
}

function snippet(input: RuntimeDetectionInput, relative: string): string {
  return input.snippets[relative] ?? "";
}

function combinedSnippet(input: RuntimeDetectionInput): string {
  return Object.values(input.snippets).join("\n");
}

function indicatorDeps(deps: Record<string, string>, names: string[]): string[] {
  return names.filter((name) => Object.prototype.hasOwnProperty.call(deps, name));
}

function packageManagerFromPackageJson(packageJson: RuntimePackageJson | undefined, files: string[]): string {
  if (packageJson?.packageManager?.startsWith("pnpm") || files.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }
  if (packageJson?.packageManager?.startsWith("yarn") || files.includes("yarn.lock")) {
    return "yarn";
  }
  if (packageJson?.packageManager?.startsWith("bun") || files.includes("bun.lock") || files.includes("bun.lockb")) {
    return "bun";
  }
  return packageJson ? "npm" : "node";
}

function javascriptFramework(input: RuntimeDetectionInput): string | undefined {
  if (input.dependencies.next || hasFile(input, /^next\.config\./)) {
    return "next";
  }
  if (input.dependencies.vite || hasFile(input, /^vite\.config\./)) {
    return "vite";
  }
  if (input.dependencies.astro || hasFile(input, /^astro\.config\./)) {
    return "astro";
  }
  if (input.dependencies["@sveltejs/kit"] || hasFile(input, /^svelte\.config\./)) {
    return "sveltekit";
  }
  return undefined;
}

function javascriptStartCandidates(input: RuntimeDetectionInput): StartCommandCandidate[] {
  const packageManager = packageManagerFromPackageJson(input.packageJson, input.files);
  const runner =
    packageManager === "pnpm" ? "pnpm" : packageManager === "yarn" ? "yarn" : packageManager === "bun" ? "bun" : "npm";
  return ["dev", "start", "serve"]
    .filter((script) => input.scripts[script])
    .map((script) =>
      command(
        `javascript.${script}`,
        `${runner} run ${script}`,
        runner === "npm" ? ["npm", "run", script] : [runner, "run", script],
        script === "dev" || script === "start" ? "high" : "medium",
        [`package.json script ${script} detected`]
      )
    );
}

function javascriptFrameworkArgs(framework: string): string[] {
  if (framework === "next") {
    return ["--", "-H", "<HOST>", "-p", "<PORT>"];
  }
  return ["--", "--host", "<HOST>", "--port", "<PORT>"];
}

function pythonTool(input: RuntimeDetectionInput): "python" | "poetry" | "uv" | "pipenv" {
  if (hasFile(input, /^poetry\.lock$/)) {
    return "poetry";
  }
  if (hasFile(input, /^uv\.lock$/)) {
    return "uv";
  }
  if (hasFile(input, /^Pipfile$/)) {
    return "pipenv";
  }
  return "python";
}

function pythonCommand(tool: "python" | "poetry" | "uv" | "pipenv", args: string[]): string[] {
  return tool === "python" ? ["python", ...args] : [tool, "python", ...args];
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}
