import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CorrectnessFixtureKind =
  | "node-vite"
  | "python-http"
  | "go-http"
  | "existing-manifest"
  | "invalid-manifest"
  | "ignored-port"
  | "ambiguous-monorepo"
  | "unsupported"
  | "sensitive-env"
  | "launch-failure";

export interface CorrectnessFixture {
  kind: CorrectnessFixtureKind;
  root: string;
  expected: {
    runtime?: "javascript-typescript" | "python" | "go";
    appId?: string;
    readOnly: boolean;
    requiresClarification?: boolean;
    failureKind?: "invalid_manifest" | "ignored_port" | "unsupported" | "early_exit";
  };
}

export interface CorrectnessFixtureLab {
  root: string;
  fixtures: Record<CorrectnessFixtureKind, CorrectnessFixture>;
  secretValue: string;
}

export async function createCorrectnessFixtureLab(): Promise<CorrectnessFixtureLab> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relaybase-agent-correctness-"));
  const secretValue = "correctness-fixture-secret-value";
  const fixtures = {} as Record<CorrectnessFixtureKind, CorrectnessFixture>;

  fixtures["node-vite"] = await fixture(
    root,
    "node-vite",
    {
      "package.json": json({
        name: "correctness-vite",
        private: true,
        scripts: { dev: "vite --host 127.0.0.1" },
        dependencies: { vite: "^7.0.0" }
      }),
      "index.html": "<main>correctness vite</main>\n"
    },
    { runtime: "javascript-typescript", readOnly: true }
  );

  fixtures["python-http"] = await fixture(
    root,
    "python-http",
    {
      "main.py": [
        "import http.server",
        "import os",
        "port = int(os.environ.get('PORT', '0'))",
        "http.server.ThreadingHTTPServer(('127.0.0.1', port), http.server.SimpleHTTPRequestHandler).serve_forever()",
        ""
      ].join("\n")
    },
    { runtime: "python", appId: "correctness-python", readOnly: true }
  );

  fixtures["go-http"] = await fixture(
    root,
    "go-http",
    {
      "go.mod": "module correctness-go\n\ngo 1.23\n",
      "main.go": [
        "package main",
        'import ("net/http"; "os")',
        'func main() { http.ListenAndServe("127.0.0.1:" + os.Getenv("PORT"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })) }',
        ""
      ].join("\n")
    },
    { runtime: "go", appId: "correctness-go", readOnly: true }
  );

  fixtures["existing-manifest"] = await fixture(
    root,
    "existing-manifest",
    {
      "server.mjs": "setInterval(() => {}, 1000);\n",
      "relaybase.app.json": json({
        schemaVersion: 1,
        id: "correctness-existing",
        name: "Correctness Existing",
        command: "node server.mjs",
        cwd: ".",
        protocol: "http",
        healthUrl: "/health"
      })
    },
    { runtime: "javascript-typescript", appId: "correctness-existing", readOnly: true }
  );

  fixtures["invalid-manifest"] = await fixture(
    root,
    "invalid-manifest",
    {
      "package.json": json({ name: "invalid-manifest", scripts: { dev: "node server.mjs" } }),
      "relaybase.app.json": '{"schemaVersion":1,"id":"broken","command":\n'
    },
    { runtime: "javascript-typescript", readOnly: true, failureKind: "invalid_manifest" }
  );

  fixtures["ignored-port"] = await fixture(
    root,
    "ignored-port",
    {
      "package.json": json({ name: "ignored-port", scripts: { dev: "node server.mjs" } }),
      "server.mjs":
        "import http from 'node:http'; http.createServer((_, r) => r.end('ok')).listen(31997, '127.0.0.1');\n",
      ".env": "PORT=31997\n"
    },
    { runtime: "javascript-typescript", readOnly: true, failureKind: "ignored_port" }
  );

  fixtures["ambiguous-monorepo"] = await fixture(
    root,
    "ambiguous-monorepo",
    {
      "package.json": json({ name: "correctness-monorepo", private: true, workspaces: ["apps/*"] }),
      "apps/web/package.json": json({ name: "web", scripts: { dev: "vite" }, dependencies: { vite: "^7.0.0" } }),
      "apps/api/package.json": json({ name: "api", scripts: { dev: "node server.mjs" } }),
      "apps/api/server.mjs": "setInterval(() => {}, 1000);\n"
    },
    { runtime: "javascript-typescript", readOnly: true, requiresClarification: true }
  );

  fixtures.unsupported = await fixture(
    root,
    "unsupported",
    {
      "README.md": "This directory contains design notes only and has no runnable application.\n",
      "data.txt": "not executable\n"
    },
    { readOnly: true, requiresClarification: true, failureKind: "unsupported" }
  );

  fixtures["sensitive-env"] = await fixture(
    root,
    "sensitive-env",
    {
      "package.json": json({ name: "sensitive-env", scripts: { dev: "node server.mjs" } }),
      "server.mjs": "setInterval(() => {}, 1000);\n",
      ".env": `OPENROUTER_API_KEY=${secretValue}\nDATABASE_URL=postgres://user:password@localhost/db\n`
    },
    { runtime: "javascript-typescript", readOnly: true }
  );

  fixtures["launch-failure"] = await fixture(
    root,
    "launch-failure",
    {
      "fail.mjs": "console.error('controlled early exit'); process.exit(7);\n",
      "relaybase.app.json": json({
        schemaVersion: 1,
        id: "correctness-failure",
        name: "Correctness Failure",
        command: "node fail.mjs",
        cwd: ".",
        protocol: "http",
        healthUrl: "/health"
      })
    },
    { runtime: "javascript-typescript", appId: "correctness-failure", readOnly: true, failureKind: "early_exit" }
  );

  return { root, fixtures, secretValue };
}

async function fixture(
  labRoot: string,
  kind: CorrectnessFixtureKind,
  files: Record<string, string>,
  expected: CorrectnessFixture["expected"]
): Promise<CorrectnessFixture> {
  const root = path.join(labRoot, kind);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf8");
  }
  return { kind, root, expected };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
