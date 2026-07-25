# Relaybase documentation

This index separates the operator manual from contributor references and implementation planning. Start with the operator manual if you want to install Relaybase, launch development apps, use the terminal interface, or recover a failed setup.

## Operator manual

| Goal                                                       | Document                                                |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| Install Relaybase and launch a first app                   | [Getting started](getting-started.md)                   |
| Learn the terminal interface, help, settings, and commands | [Operator console](operator-console.md)                 |
| Use the optional built-in Agent                            | [Operator Agent](operator-agent.md)                     |
| Use command-line automation and diagnostics                | [CLI reference](cli.md)                                 |
| Define an app and its launch contract                      | [App manifest](app-manifest.md)                         |
| Group frontend, backend, and other app roles               | [App components](app-components.md)                     |
| Understand app status, readiness, and routes               | [App state](app-state.md)                               |
| Configure Docker Compose projects                          | [Docker Compose lifecycle](docker-compose-lifecycle.md) |
| Read, query, and export logs                               | [Logs](logs.md)                                         |
| Connect MCP clients and coding agents                      | [MCP](mcp.md)                                           |
| Use Relaybase with Codex                                   | [Relaybase development skill](relaybase-dev-skill.md)   |
| Build external agents that use Relaybase                   | [AI app builder](ai-app-builder/README.md)              |
| Recover from common failures                               | [Troubleshooting](troubleshooting.md)                   |
| Review the security boundary and current limits            | [Security and limits](security-and-limits.md)           |

## Contributor references

| Area                                                | Document                                                      |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Daemon ownership, lifecycle, routing, and setup     | [Architecture](architecture.md)                               |
| Go terminal-client ownership and failure boundaries | [TUI architecture](tui-architecture.md)                       |
| Daemon HTTP and event contracts used by the TUI     | [TUI API contract](tui-api-contract.md)                       |
| Full key and command behavior                       | [TUI keymap](tui-keymap.md)                                   |
| Local TUI preference storage                        | [TUI preferences](tui-preferences.md)                         |
| Operator Agent daemon/TUI/provider boundaries       | [Operator Agent architecture](tui-agent-architecture.md)      |
| OpenRouter provider and live-check boundary         | [Operator Agent OpenRouter provider](tui-agent-openrouter.md) |
| Operator Agent tool registry                        | [Operator Agent tools](tui-agent-tools.md)                    |
| Operator Agent approval and redaction rules         | [Operator Agent safety](tui-agent-safety.md)                  |
| Agent transcript and tool-trace rendering           | [Agent transcript and tool traces](tui-agent-activity.md)     |
| Independent Agent-work verification                 | [Agent work correctness](agent-work-correctness.md)           |
| Operator Agent test layers and commands             | [Operator Agent testing](tui-agent-testing.md)                |
| Setup file-write boundaries                         | [TUI setup file-write safety](tui-setup-file-write-safety.md) |
| Setup and onboarding implementation                 | [TUI setup and onboarding](tui-setup-onboarding.md)           |
| Runtime port strategies                             | [TUI setup port strategies](tui-setup-port-strategies.md)     |
| Supported runtime detection matrix                  | [TUI setup runtime matrix](tui-setup-runtime-matrix.md)       |
| General test strategy                               | [TUI testing strategy](tui-testing-strategy.md)               |
| Local builds, packaging, and publisher setup        | [TUI toolchain](tui-toolchain.md)                             |
| Repository artifact boundaries                      | [Artifact hygiene](artifact-hygiene.md)                       |
| Windows release trust boundary                      | [Code signing policy](code-signing-policy.md)                 |
| OpenAI Agents SDK dependency policy                 | [Agents SDK fork policy](agent-sdk-fork.md)                   |
| Rules for agent-driven repository work              | [Agent-driven development](agent-driven-development.md)       |

## Implementation planning

The following repository documents describe intended work or historical acceptance gates. They are not operator instructions and must not be used as evidence that a feature ships:

- `agent-config-hot-reload-and-credential-security-plan.md`
- `agent-security-settings-and-repair-plan.md`
- `register-verification-repair-plan.md`
- `relaybase-release-roadmap.md`
- `tui-setup-gap-map.md`

Current behavior is defined by source, tests, and the operator/contributor documents above. Planning documents are excluded from the published package.
