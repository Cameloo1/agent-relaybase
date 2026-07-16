# Changelog

## Unreleased

- Added one-file folder registration with strict manifest-file mode, approval-bound previews, drift detection, and idempotent registry updates.
- Added structured shell-free launch declarations with controlled Relaybase tokens and direct PowerShell/Python argument adapters.
- Added coordinator parity across HTTP, CLI, MCP, and the TUI while keeping lifecycle start separate.
- Added explicit quick registration verification with one bounded start, health, stop, and backend-port closure proof; successful proof ends stopped.
- Added stable verification failure codes, bounded localhost health-route diagnosis, approval-bound repair/reproof, cancellation, cleanup-failure gating, and redacted operation evidence.
- Added `/manage` as the canonical app manager, kept bare `/start` as the fast launcher, and added approval-gated rename and unregister operations. Rename preserves the stable app ID, route, running process, packages, panes, logs, history, and automation; unregister preserves projects, manifests, logs, and operation history.
- Added the `/packages` table manager, app-scoped **Add to package** flow, revision-bound package rename/member editing/deletion, explicit launch ordering, and visible short-terminal action overflow.

All notable user-facing changes are documented here.

## 0.1.0 - Preview

- Added the local-first Relaybase daemon, stable app routing, lifecycle operations, health, logs, dashboard, and MCP control plane.
- Added the Go operator console with app inventory, command palette, multiline composer, response rendering, packages, usage, setup, and recovery surfaces.
- Added approval-gated agent project inspection and setup workflows with canonical project-root authorization.
- Added self-contained npm packaging for Windows, macOS, and Linux on x64 and arm64.

This release remains preview software. Review `docs/security-and-limits.md` before sensitive or production use.
