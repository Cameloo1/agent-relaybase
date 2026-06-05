# TUI Evidence Report

Generated: 2026-06-05T20:36:41.108Z
Verdict: PASS
Fixture: 8pane
Artifact root: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane
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
| groupedEightPanes | passed |
| preferences | passed |
| slashConfirmation | passed |
| exportConfirmation | passed |
| assistantConfirmation | passed |
| noDestructiveBeforeConfirmation | passed |
| recording | not_available |

## Artifact Paths

- PTY transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\pty-transcript.txt
- TUI output: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\tui-output.txt
- Metadata: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\metadata.json
- Command log: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\commands.md
- State before: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\state-before.json
- State after: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\state-after.json
- Preferences before: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\preferences-before.json
- Preferences after: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\preferences-after.json
- Bridge daemon unavailable: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\bridge-daemon-unavailable.txt
- Daemon unavailable transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\daemon-unavailable-transcript.txt
- Grouped 2-pane transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\grouped-panes-transcript.txt
- Grouped 8-pane transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\grouped-8pane-transcript.txt
- Slash stop confirmation transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\slash-stop-confirmation-transcript.txt
- Export confirmation transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\export-confirmation-transcript.txt
- Assistant confirmation transcript: C:\Users\wamin\Desktop\development\relaybase\artifacts\tui-verification\8pane\assistant-confirmation-transcript.txt

## Notes

- VHS/asciinema capture tools were unavailable; recording remains not_available and terminal transcript artifacts are the captured evidence.
