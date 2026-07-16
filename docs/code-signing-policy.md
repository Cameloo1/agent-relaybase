# Code signing policy

Relaybase's Windows release pipeline requires Authenticode signing before a release candidate can be published to npm or GitHub. The binaries are built from a tagged commit on GitHub-hosted Actions runners, submitted through SignPath's GitHub trusted-build integration, and then verified and executed on a separate Windows runner. Signing never occurs from a maintainer workstation.

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Project roles

- Committer and reviewer: [Cameloo1](https://github.com/Cameloo1)
- Signing approver: [Cameloo1](https://github.com/Cameloo1)

Changes from people without commit access require maintainer review before merge. SignPath Foundation requires a manual approval for every signing request. The signing approver verifies the version tag, workflow origin, and release candidate before approving it.

## Build and signing boundary

- Source repository: `https://github.com/Cameloo1/relaybase`
- Release workflow: `.github/workflows/release.yml`
- SignPath project: `relaybase`
- Signing policy: `release-signing`
- Artifact configuration: `windows-binaries`, tracked at `.signpath/windows-binaries.xml`
- Signed files: `relaybase-tui-windows-amd64.exe` and `relaybase-tui-windows-arm64.exe`

The artifact configuration restricts product name, product version, file version, company name, and copyright metadata. The workflow rejects missing certificate tables, invalid Windows trust, changed candidate hashes, or a packaged TUI that cannot execute. Later packaging steps copy the signed binaries and never rebuild them.

## Privacy policy

Relaybase is local-first. This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Normal local daemon, TUI, routing, logging, and deterministic command parsing stay on the user's machine. Network access occurs only for an action the user chooses, such as installing Relaybase from npm, opening a routed application that makes its own requests, configuring a child MCP service, or enabling the optional remote Operator Agent. When the user explicitly enables OpenRouter, the selected prompt categories are sent under [OpenRouter's privacy policy](https://openrouter.ai/privacy). Relaybase does not enable that path by default and does not persist raw provider keys in its agent configuration.

See [Security and limits](security-and-limits.md) and [Security policy](../SECURITY.md) for the complete trust boundary and reporting instructions.

## System changes and removal

A global npm installation adds the `relaybase` command and a platform-specific TUI package under npm's configured global prefix. First launch creates Relaybase state under the operating system's normal local application-data location unless the operator explicitly selects another state directory. Relaybase does not modify Windows Application Control, execution policy, firewall, or public network exposure settings.

Remove the global installation with:

```bash
npm uninstall --global @cameloo/relaybase
```

That removes the command and npm-managed optional platform package. Relaybase does not automatically delete registered projects, manifests, logs, or local state. Remove the reported Relaybase state directory separately only when those retained records are no longer needed.
