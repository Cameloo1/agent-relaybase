# TUI Evidence Report

Generated: 2026-06-05T20:36:41.052Z
Verdict: PASS
Fixture: default
Artifact root: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default
Cleanup: daemon and fixture processes stopped

## Tooling

- Expected binary: C:\Users\wamin\Desktop\development\relaybase\.relaybase\tui-dev-bin\relaybase-tui-windows-amd64.exe
- Binary exists: true
- Required Go version: 1.25.0
- VHS available: false
- asciinema available: false
- Video capture: not available; transcript artifacts are the captured evidence

## Evidence Cases

| Case | Status |
| --- | --- |
| bridgeDaemonUnavailable | passed |
| daemonUnavailable | passed |
| directLaunch | passed |
| bridgeLaunch | passed |
| daemonConnection | passed |
| groupedPanes | passed |
| groupedEightPanes | not_applicable |
| preferences | passed |
| slashConfirmation | passed |
| exportConfirmation | passed |
| assistantConfirmation | passed |
| noDestructiveBeforeConfirmation | passed |
| recording | not_available |

## Artifact Paths

- PTY transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\pty-transcript.txt
- TUI output: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\tui-output.txt
- Metadata: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\metadata.json
- Command log: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\commands.md
- State before: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\state-before.json
- State after: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\state-after.json
- Preferences before: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\preferences-before.json
- Preferences after: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\preferences-after.json
- Bridge daemon unavailable: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\bridge-daemon-unavailable.txt
- Daemon unavailable transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\daemon-unavailable-transcript.txt
- Grouped 2-pane transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\grouped-panes-transcript.txt
- Grouped 8-pane transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\grouped-8pane-transcript.txt
- Slash stop confirmation transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\slash-stop-confirmation-transcript.txt
- Export confirmation transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\export-confirmation-transcript.txt
- Assistant confirmation transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\default\assistant-confirmation-transcript.txt

## Notes

- VHS/asciinema capture tools were unavailable; recording remains not_available and terminal transcript artifacts are the captured evidence.
