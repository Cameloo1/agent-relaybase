import { describe, expect, test } from "@jest/globals";
import { namespaceChildName, relaybaseChildResourceUri } from "../../src/childMcp.ts";
import { composeAppState } from "../../src/appState.ts";
import { isValidAppId, normalizeManifest } from "../../src/validation.ts";

describe("Relaybase Jest smoke coverage", () => {
  test("validates app id boundaries", () => {
    expect(isValidAppId("notes")).toBe(true);
    expect(isValidAppId("notes-api")).toBe(true);
    expect(isValidAppId("-notes")).toBe(false);
    expect(isValidAppId("Notes")).toBe(false);
  });

  test("normalizes manifests for routed apps", () => {
    const manifest = normalizeManifest(
      {
        id: "notes",
        name: "Notes",
        command: "npm.cmd run dev",
        cwd: ".",
        protocol: "http",
        healthUrl: "/health"
      },
      {
        manifestPath: "C:/relaybase/examples/relaybase.app.json",
        now: new Date("2026-05-09T00:00:00.000Z")
      }
    );

    expect(manifest.id).toBe("notes");
    expect(manifest.healthUrl).toBe("/health");
    expect(manifest.cwd.replace(/\\/g, "/")).toMatch(/C:\/relaybase\/examples$/);
  });

  test("keeps child MCP namespaces deterministic", () => {
    expect(namespaceChildName("notes", "search")).toBe("notes.search");
    expect(relaybaseChildResourceUri("notes", "docs://index")).toBe("relaybase://app/notes/mcp/docs://index");
  });

  test("composes app state for dashboard consumers", () => {
    const state = composeAppState({
      id: "notes",
      name: "Notes",
      registered: true,
      runtime: {
        status: "running",
        health: "healthy",
        assignedPort: 17100,
        logLines: 1
      },
      hubHost: "127.0.0.1",
      hubPort: 7777,
      backendPort: 17100,
      routeReachable: true,
      backendPortOpen: true,
      recentLogs: ["ready"],
      readinessCheckedAt: "2026-05-09T00:00:00.000Z"
    });

    expect(state.registered).toBe(true);
    expect(state.readiness.state).toBe("ready");
    expect(state.agentHeaders["X-Relaybase-App"]).toBe("notes");
    expect(state.logStreamUrl).toBe("http://127.0.0.1:7777/__hub/api/apps/notes/logs/stream");
  });
});
