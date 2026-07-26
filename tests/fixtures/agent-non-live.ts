export const groupedFrontendBackendFixture = {
  groupId: "notes",
  displayName: "Notes",
  frontend: {
    appId: "notes-web",
    name: "Notes Web",
    role: "frontend",
    paneLabel: "frontend",
    paneOrder: 10
  },
  backend: {
    appId: "notes-api",
    name: "Notes API",
    role: "backend",
    paneLabel: "backend",
    paneOrder: 20
  }
} as const;

export const samplePackageJsonFixtures = {
  next: {
    name: "fixture-next-app",
    scripts: { dev: "next dev" },
    dependencies: { next: "^16.0.0" }
  },
  vite: {
    name: "fixture-vite-app",
    scripts: { dev: "vite" },
    devDependencies: { vite: "^6.0.0" }
  },
  astro: {
    name: "fixture-astro-app",
    scripts: { dev: "astro dev" },
    devDependencies: { astro: "^5.0.0" }
  },
  ambiguousMonorepo: {
    name: "fixture-monorepo",
    workspaces: ["apps/*"],
    scripts: { dev: "npm --workspace apps/web run dev" }
  }
} as const;

export const sampleExistingManifest = {
  schemaVersion: 1,
  id: "notes-api",
  name: "Notes API",
  command: "npm.cmd run dev",
  protocol: "http",
  healthUrl: "/health",
  relaybase: {
    groupId: "notes",
    componentRole: "backend",
    displayName: "Notes",
    paneLabel: "backend",
    paneOrder: 20
  }
} as const;

export const sampleLogs = [
  {
    sequence: 1,
    appId: "notes-web",
    groupId: "notes",
    componentRole: "frontend",
    stream: "stdout",
    message: "frontend ready token=fixture-secret"
  },
  {
    sequence: 2,
    appId: "notes-api",
    groupId: "notes",
    componentRole: "backend",
    stream: "stderr",
    message: "backend needs health route"
  }
] as const;

export const sampleToolCallRequests = {
  lifecycleApproval: { name: "start_app", arguments: { appId: "notes-web" } },
  setupApproval: { name: "apply_setup_plan", arguments: { cwd: "C:/project", selectedPlanId: "managed-web" } },
  manifestPatchApproval: {
    name: "patch_manifest_fields",
    arguments: { manifestPath: "relaybase.app.json", patch: { healthUrl: "/healthz" } }
  }
} as const;

export const sampleSetupPlan = {
  id: "framework-port-flag",
  label: "Framework port flags",
  portStrategies: ["framework_port_flags", "generated_launch_wrapper"],
  risks: ["App must accept forwarded --host/--port flags"]
} as const;

export const sampleRedactedEnvFile = "PUBLIC_URL=http://localhost\nAPI_KEY=[redacted]\nSESSION_TOKEN=[redacted]\n";
