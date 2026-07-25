# Security policy

Relaybase is local-first preview software and is not a production security boundary.

Report suspected vulnerabilities privately through GitHub's security-advisory interface for this repository. Do not open a public issue containing tokens, environment files, raw logs, private source, state databases, or reproduction credentials.

Include the Relaybase version, operating system, affected command or endpoint, diagnostic code, and a minimal redacted reproduction. See `docs/security-and-limits.md` for the current trust and exposure boundaries.

Windows release executables must pass the repository's [code signing policy](docs/code-signing-policy.md) before publication. Do not disable Windows Application Control to run an unsigned Relaybase build.

The Windows Operator Agent stores its dedicated OpenRouter credential with current-user DPAPI and restricts the protected blob to the current user and SYSTEM. Decrypted credentials remain daemon-only and are excluded from child environments, APIs, logs, diagnostics, exports, audits, and ordinary configuration.

Credential diagnosis and repair use the authenticated daemon through `/settings` → **Agent → Security and credentials** or `relaybase repair --agent-security`. Local diagnosis is silent and offline by default. Repair previews are short-lived and bound to current state; apply is idempotent, serialized, audit-redacted, and post-verified. The CLI control path does not load project `.env` credentials. Relaybase never edits arbitrary environment files or claims remote revocation without provider confirmation.

DPAPI does not defeat malware, debuggers, injected code, or other processes already running as the same Windows user. It primarily reduces offline, cross-user, and accidental plaintext exposure. Use a dedicated provider key with a conservative spending limit and expiration.
