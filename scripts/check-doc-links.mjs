#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function checkDocumentationLinks(options = {}) {
  const rootDir = options.rootDir ?? root;
  const files = [
    path.join(rootDir, "README.md"),
    path.join(rootDir, "SECURITY.md"),
    ...markdownFiles(path.join(rootDir, "docs"))
  ];
  const failures = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, "");
      if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      const relative = raw.split("#", 1)[0];
      const target = path.resolve(path.dirname(file), decodeURIComponent(relative));
      if (!existsSync(target)) failures.push(`${path.relative(rootDir, file)} -> ${raw}`);
    }
  }
  checkPublicDocumentationContracts(rootDir, failures);
  if (failures.length) {
    console.error(["Documentation verification failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
    return 1;
  }
  console.log(`Documentation links and public contracts verified across ${files.length} Markdown files.`);
  return 0;
}

function checkPublicDocumentationContracts(rootDir, failures) {
  const requiredDocuments = [
    "docs/README.md",
    "docs/getting-started.md",
    "docs/operator-console.md",
    "docs/operator-agent.md",
    "docs/cli.md",
    "docs/architecture.md",
    "docs/troubleshooting.md"
  ];
  for (const relative of requiredDocuments) {
    if (!existsSync(path.join(rootDir, relative))) failures.push(`required public document is missing: ${relative}`);
  }
  if (requiredDocuments.some((relative) => !existsSync(path.join(rootDir, relative)))) return;

  const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
  const docsIndex = readFileSync(path.join(rootDir, "docs", "README.md"), "utf8");
  const operatorConsole = readFileSync(path.join(rootDir, "docs", "operator-console.md"), "utf8");
  const cliReference = readFileSync(path.join(rootDir, "docs", "cli.md"), "utf8");
  const agentToolReference = readFileSync(path.join(rootDir, "docs", "tui-agent-tools.md"), "utf8");

  const readmeRequirements = [
    "docs/README.md",
    "docs/getting-started.md",
    "docs/operator-console.md",
    "docs/operator-agent.md",
    "docs/cli.md",
    "docs/architecture.md",
    "/help",
    "/settings",
    "/settings agent",
    "/start",
    "/manage",
    "/packages",
    "relaybase start",
    "relaybase check"
  ];
  for (const value of readmeRequirements) {
    if (!readme.includes(value)) failures.push(`README.md is missing required public entry point: ${value}`);
  }

  const slashCatalogPath = path.join(rootDir, "tui", "internal", "tui", "slash", "catalog.go");
  if (!existsSync(slashCatalogPath)) {
    failures.push("slash command catalog is missing: tui/internal/tui/slash/catalog.go");
  } else {
    const slashCatalog = readFileSync(slashCatalogPath, "utf8");
    const commands = [
      ...new Set([...slashCatalog.matchAll(/descriptor\(\s*[^,]+,\s*"([^"]+)"/g)].map((match) => match[1]))
    ];
    if (commands.length === 0) {
      failures.push("could not derive public slash commands from tui/internal/tui/slash/catalog.go");
    }
    for (const command of commands) {
      if (!operatorConsole.includes(command)) {
        failures.push(`docs/operator-console.md is missing cataloged command: ${command}`);
      }
    }
  }

  const cliSourcePath = path.join(rootDir, "src", "cli.ts");
  if (!existsSync(cliSourcePath)) {
    failures.push("CLI source is missing: src/cli.ts");
  } else {
    const cliSource = readFileSync(cliSourcePath, "utf8");
    const commandsStart = cliSource.indexOf("Commands:");
    const optionsStart = commandsStart >= 0 ? cliSource.indexOf("Options:", commandsStart) : -1;
    if (commandsStart < 0 || optionsStart < 0) {
      failures.push("could not derive the public CLI command list from src/cli.ts");
    } else {
      const helpBlock = cliSource.slice(commandsStart, optionsStart);
      const commands = [
        ...new Set(
          [...helpBlock.matchAll(/^\s{2}([a-z][a-z-]*(?:\s+[a-z][a-z-]*)?)(?:\s+<[^>]+>)?\s{2,}/gm)].map(
            (match) => match[1]
          )
        )
      ];
      for (const command of commands) {
        if (!cliReference.includes(`relaybase ${command}`) && !cliReference.includes(`## ${command}`)) {
          failures.push(`docs/cli.md is missing CLI help command: ${command}`);
        }
      }
    }
  }

  const agentToolDirectory = path.join(rootDir, "src", "agent", "tools");
  if (!existsSync(agentToolDirectory)) {
    failures.push("Agent tool source directory is missing: src/agent/tools");
  } else {
    const toolNames = new Set();
    for (const file of filesWithExtension(agentToolDirectory, ".ts")) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bname:\s*"([a-z][a-z0-9_]*)"/g)) toolNames.add(match[1]);
    }
    if (toolNames.size === 0) failures.push("could not derive Agent tool names from src/agent/tools");
    for (const toolName of toolNames) {
      if (!agentToolReference.includes(`\`${toolName}\``)) {
        failures.push(`docs/tui-agent-tools.md is missing registered Agent tool: ${toolName}`);
      }
    }
  }

  const planningDocuments = [
    "agent-config-hot-reload-and-credential-security-plan.md",
    "agent-security-settings-and-repair-plan.md",
    "register-verification-repair-plan.md",
    "relaybase-release-roadmap.md",
    "tui-setup-gap-map.md"
  ];
  const publicNavigation = `${readme}\n${docsIndex}`;
  for (const planning of planningDocuments) {
    if (publicNavigation.includes(`](${planning})`) || publicNavigation.includes(`](docs/${planning})`)) {
      failures.push(`public navigation links to planning-only document: ${planning}`);
    }
  }

  const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const packagedFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
  for (const planning of planningDocuments) {
    const exclusion = `!docs/${planning}`;
    if (!packagedFiles.includes(exclusion)) {
      failures.push(`package.json does not exclude planning-only document: ${planning}`);
    }
  }
}

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(target);
    return entry.isFile() && target.endsWith(".md") ? [target] : [];
  });
}

function filesWithExtension(directory, extension) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesWithExtension(target, extension);
    return entry.isFile() && target.endsWith(extension) ? [target] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = checkDocumentationLinks();
}
