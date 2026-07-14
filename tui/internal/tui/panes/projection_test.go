package panes

import (
	"fmt"
	"strings"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func TestManagerScrollPaneByIDDoesNotChangeSelection(t *testing.T) {
	manager := NewManager()
	manager.layout = Layout{PaneHeight: 8, Height: 12}
	manager.panes["pane-a"] = &Pane{ID: "pane-a", Follow: true, Logs: projectionEvents(10)}
	manager.panes["pane-b"] = &Pane{ID: "pane-b", Follow: true, Logs: projectionEvents(10)}
	manager.order = []string{"pane-a", "pane-b"}

	if !manager.ScrollPane("pane-b", 3) {
		t.Fatal("expected pane-b scroll to succeed")
	}
	if manager.SelectedPaneID() != "pane-a" {
		t.Fatalf("scroll changed selection to %q", manager.SelectedPaneID())
	}
	if manager.panes["pane-a"].ScrollOffset != 0 || manager.panes["pane-b"].ScrollOffset != 3 {
		t.Fatalf("scroll affected wrong pane: a=%d b=%d", manager.panes["pane-a"].ScrollOffset, manager.panes["pane-b"].ScrollOffset)
	}
	if manager.panes["pane-b"].Follow {
		t.Fatal("scrolling toward older logs should disable follow")
	}
	if !manager.ScrollPane("pane-b", -100) || !manager.panes["pane-b"].Follow || manager.panes["pane-b"].ScrollOffset != 0 {
		t.Fatalf("scrolling to newest should restore follow: %#v", manager.panes["pane-b"])
	}
	if manager.ScrollPane("missing", 1) {
		t.Fatal("missing pane scroll should fail closed")
	}
}

func TestPaneSnapshotUsesBubblesViewportOverProjectedLines(t *testing.T) {
	manager := NewManager()
	manager.layout = Layout{PaneHeight: 12, Height: 24}
	events := append([]relaybaseclient.LogEvent{{Sequence: 1, Stream: "stdout", Message: "\n\t"}}, projectionEvents(10)...)
	manager.panes["pane"] = &Pane{ID: "pane", Title: "Pane", Follow: false, ScrollOffset: 2, Logs: events}
	manager.order = []string{"pane"}

	snapshot := manager.snapshotForPane(*manager.panes["pane"], true, false)
	if snapshot.ScrollOffset != 2 {
		t.Fatalf("snapshot offset=%d, want projected offset 2", snapshot.ScrollOffset)
	}
	if len(snapshot.LogLineModels) != 6 || snapshot.LogLineModels[0].Sequence != 3 || snapshot.LogLineModels[5].Sequence != 8 {
		t.Fatalf("snapshot did not use the projected Bubbles viewport window: %#v", snapshot.LogLineModels)
	}
	if manager.IsPaneAtOldestLogBoundary("pane") {
		t.Fatal("pane reached the oldest boundary before scrolling to the top")
	}
	manager.ScrollPane("pane", 100)
	if !manager.IsPaneAtOldestLogBoundary("pane") {
		t.Fatal("pane did not report the projected oldest boundary")
	}
}

func TestPaneLogAnchorsUseProjectedBottomRelativeOffsets(t *testing.T) {
	manager := NewManager()
	manager.layout = Layout{PaneHeight: 12, Height: 24}
	manager.panes["pane"] = &Pane{ID: "pane", Title: "Pane", Follow: false, ScrollOffset: 4, Logs: projectionEvents(10)}
	manager.order = []string{"pane"}

	before := manager.snapshotForPane(*manager.panes["pane"], true, false)
	manager.MergeSnapshot(LogTarget{PaneID: "pane", Mode: modePrependOlder}, &relaybaseclient.LogSnapshot{Events: []relaybaseclient.LogEvent{
		{Sequence: -2, Stream: "stdout", Message: "older 2"},
		{Sequence: -1, Stream: "stdout", Message: "older 1"},
	}})
	afterPrepend := manager.snapshotForPane(*manager.panes["pane"], true, false)
	if before.LogLineModels[0].Sequence != afterPrepend.LogLineModels[0].Sequence || manager.panes["pane"].ScrollOffset != 4 {
		t.Fatalf("prepend moved the bottom-relative anchor: before=%#v after=%#v offset=%d", before.LogLineModels, afterPrepend.LogLineModels, manager.panes["pane"].ScrollOffset)
	}

	manager.MergeSnapshot(LogTarget{PaneID: "pane", Mode: modeMergeLatest}, &relaybaseclient.LogSnapshot{Events: []relaybaseclient.LogEvent{{
		Sequence: 11, Stream: "stdout", Message: "line 011",
	}}})
	afterLatest := manager.snapshotForPane(*manager.panes["pane"], true, false)
	if afterLatest.LogLineModels[0].Sequence != before.LogLineModels[0].Sequence || manager.panes["pane"].ScrollOffset != 5 {
		t.Fatalf("latest merge did not preserve the scrolled anchor: before=%#v after=%#v offset=%d", before.LogLineModels, afterLatest.LogLineModels, manager.panes["pane"].ScrollOffset)
	}

	pane := &Pane{Follow: false, ScrollOffset: 1, Logs: projectionEvents(8)}
	pane.appendLog(relaybaseclient.LogEvent{Sequence: 8, Stream: "stdout", Message: "duplicate"}, DefaultMaxScrollback)
	pane.appendLog(relaybaseclient.LogEvent{Sequence: 9, Stream: "stdout", Message: "\n\t"}, DefaultMaxScrollback)
	if pane.ScrollOffset != 1 {
		t.Fatalf("duplicate or empty append shifted the anchor: %d", pane.ScrollOffset)
	}
	pane.appendLog(relaybaseclient.LogEvent{Sequence: 10, Stream: "stdout", Message: "new"}, DefaultMaxScrollback)
	if pane.ScrollOffset != 2 {
		t.Fatalf("visible append did not preserve the anchor: %d", pane.ScrollOffset)
	}
}

func TestPaneResizePreservesCompactAndFocusedLogAnchors(t *testing.T) {
	for _, focused := range []bool{false, true} {
		t.Run(fmt.Sprintf("focused_%t", focused), func(t *testing.T) {
			manager := NewManager()
			manager.layout = CalculateLayout(80, 20, 1)
			manager.panes["pane"] = &Pane{ID: "pane", Title: "Pane", Follow: false, ScrollOffset: 6, Logs: projectionEvents(40)}
			manager.order = []string{"pane"}
			if focused {
				manager.focusedID = "pane"
			}
			before := manager.snapshotForPane(*manager.panes["pane"], true, focused)
			manager.Resize(100, 30)
			after := manager.snapshotForPane(*manager.panes["pane"], true, focused)
			if len(before.LogLineModels) == 0 || len(after.LogLineModels) == 0 || !containsLogSequence(after.LogLineModels, before.LogLineModels[0].Sequence) {
				t.Fatalf("resize moved the visible anchor: before=%#v after=%#v", before.LogLineModels, after.LogLineModels)
			}
		})
	}
}

func containsLogSequence(lines []PaneLogLine, sequence int64) bool {
	for _, line := range lines {
		if line.Sequence == sequence {
			return true
		}
	}
	return false
}

func TestManagerLast20LogPayloadBoundaries(t *testing.T) {
	tests := []struct {
		count     int
		wantCount int
		wantFirst string
		wantLast  string
	}{
		{count: 0, wantCount: 0},
		{count: 1, wantCount: 1, wantFirst: "[stdout] line 001", wantLast: "[stdout] line 001"},
		{count: 20, wantCount: 20, wantFirst: "[stdout] line 001", wantLast: "[stdout] line 020"},
		{count: 21, wantCount: 20, wantFirst: "[stdout] line 002", wantLast: "[stdout] line 021"},
		{count: 500, wantCount: 20, wantFirst: "[stdout] line 481", wantLast: "[stdout] line 500"},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("count_%d", test.count), func(t *testing.T) {
			manager := NewManager()
			manager.panes["pane"] = &Pane{ID: "pane", Follow: false, ScrollOffset: 7, Logs: projectionEvents(test.count)}
			payload, count := manager.Last20LogPayload("pane")
			if count != test.wantCount {
				t.Fatalf("count=%d, want %d", count, test.wantCount)
			}
			if strings.HasSuffix(payload, "\n") {
				t.Fatalf("payload has trailing newline: %q", payload)
			}
			if count == 0 {
				if payload != "" {
					t.Fatalf("empty payload=%q", payload)
				}
				return
			}
			lines := strings.Split(payload, "\n")
			if lines[0] != test.wantFirst || lines[len(lines)-1] != test.wantLast {
				t.Fatalf("payload boundaries=%q..%q, want %q..%q", lines[0], lines[len(lines)-1], test.wantFirst, test.wantLast)
			}
			if manager.panes["pane"].ScrollOffset != 7 || manager.panes["pane"].Follow {
				t.Fatal("copy payload changed scroll/follow state")
			}
		})
	}
}

func TestManagerLast20LogPayloadSkipsEmptyEventsBeforeTakingTail(t *testing.T) {
	events := projectionEvents(21)
	events = append(events, relaybaseclient.LogEvent{Sequence: 22, Stream: "stdout", Message: "\n\t"})
	manager := NewManager()
	manager.panes["pane"] = &Pane{ID: "pane", Logs: events}
	payload, count := manager.Last20LogPayload("pane")
	lines := strings.Split(payload, "\n")
	if count != 20 || lines[0] != "[stdout] line 002" || lines[19] != "[stdout] line 021" {
		t.Fatalf("unexpected non-empty tail count=%d lines=%#v", count, lines)
	}
}

func TestSanitizeLogDisplayLineMessageFallbackAndControls(t *testing.T) {
	tests := []struct {
		name  string
		event relaybaseclient.LogEvent
		want  string
	}{
		{name: "message and stream", event: relaybaseclient.LogEvent{Stream: "stderr", Message: "\x1b[31mdanger\nnext\x00\x1b[0m"}, want: "[stderr] danger next"},
		{name: "legacy line", event: relaybaseclient.LogEvent{Line: "legacy\rline"}, want: "legacy line"},
		{name: "empty", event: relaybaseclient.LogEvent{Stream: "stdout", Message: "\n\t"}, want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := SanitizeLogDisplayLine(test.event); got != test.want {
				t.Fatalf("SanitizeLogDisplayLine=%q, want %q", got, test.want)
			}
		})
	}
}

func TestClassifyLogToneUsesOnlyTypedMetadata(t *testing.T) {
	tests := []struct {
		name  string
		event relaybaseclient.LogEvent
		want  LogTone
	}{
		{name: "explicit success", event: relaybaseclient.LogEvent{Level: "success"}, want: LogToneSuccess},
		{name: "lifecycle completed", event: relaybaseclient.LogEvent{Source: "app.lifecycle_operation_completed", Level: "error"}, want: LogToneSuccess},
		{name: "error", event: relaybaseclient.LogEvent{Level: "error"}, want: LogToneError},
		{name: "fatal", event: relaybaseclient.LogEvent{Level: "fatal"}, want: LogToneError},
		{name: "panic", event: relaybaseclient.LogEvent{Level: "panic"}, want: LogToneError},
		{name: "lifecycle failed", event: relaybaseclient.LogEvent{Source: "app.lifecycle_operation_failed"}, want: LogToneError},
		{name: "warning", event: relaybaseclient.LogEvent{Level: "warning"}, want: LogToneWarning},
		{name: "plain stderr", event: relaybaseclient.LogEvent{Stream: "stderr", Level: "info"}, want: LogToneWarning},
		{name: "debug", event: relaybaseclient.LogEvent{Level: "debug"}, want: LogToneMuted},
		{name: "trace", event: relaybaseclient.LogEvent{Level: "trace"}, want: LogToneMuted},
		{name: "daemon pre-start hook", event: relaybaseclient.LogEvent{Source: "preStart", Level: "info"}, want: LogToneStart},
		{name: "daemon process start output", event: relaybaseclient.LogEvent{Source: "start", Level: "info"}, want: LogToneStart},
		{name: "daemon stop hook", event: relaybaseclient.LogEvent{Source: "stop", Level: "info"}, want: LogToneStop},
		{name: "daemon stop verification hook", event: relaybaseclient.LogEvent{Source: "verifyStopped", Level: "info"}, want: LogToneStop},
		{name: "start error keeps error precedence", event: relaybaseclient.LogEvent{Source: "start", Stream: "stderr", Level: "error"}, want: LogToneError},
		{name: "stop warning keeps warning precedence", event: relaybaseclient.LogEvent{Source: "stop", Stream: "stderr", Level: "warning"}, want: LogToneWarning},
		{name: "untyped start-looking message", event: relaybaseclient.LogEvent{Source: "system", Level: "info", Message: "[relaybase] starting notes on 127.0.0.1:17000"}, want: LogToneNeutral},
		{name: "untyped stop-looking message", event: relaybaseclient.LogEvent{Source: "system", Level: "info", Message: "[relaybase] stopping"}, want: LogToneNeutral},
		{name: "structured start command", event: relaybaseclient.LogEvent{Source: "lifecycle_start_command", Level: "info", Message: "npm run dev"}, want: LogToneStart},
		{name: "structured stop command", event: relaybaseclient.LogEvent{Source: "lifecycle_stop_command", Level: "info", Message: "npm run stop"}, want: LogToneStop},
		{name: "raw error word", event: relaybaseclient.LogEvent{Stream: "stdout", Level: "info", Message: "error success stop start"}, want: LogToneNeutral},
		{name: "unknown", event: relaybaseclient.LogEvent{Level: "custom"}, want: LogToneNeutral},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ClassifyLogTone(test.event); got != test.want {
				t.Fatalf("ClassifyLogTone=%q, want %q", got, test.want)
			}
		})
	}
}

func TestPaneSnapshotPreservesTypedLogMetadata(t *testing.T) {
	manager := NewManager()
	manager.panes["pane"] = &Pane{ID: "pane", Follow: true, Logs: []relaybaseclient.LogEvent{{
		Sequence: 9, Timestamp: "2026-07-10T10:00:00Z", At: "2026-07-10T10:00:00Z", AppID: "app", GroupID: "group",
		ComponentRole: "worker", Stream: "stderr", Source: "start", Level: "warn", Message: "careful", Redacted: true,
	}}}
	manager.order = []string{"pane"}
	snapshot := manager.SelectedPane()
	if snapshot == nil || len(snapshot.LogLineModels) != 1 {
		t.Fatalf("typed snapshot missing: %#v", snapshot)
	}
	line := snapshot.LogLineModels[0]
	if line.Sequence != 9 || line.Timestamp == "" || line.At == "" || line.AppID != "app" || line.GroupID != "group" ||
		line.ComponentRole != "worker" || line.Text != "[stderr] careful" || line.Tone != LogToneWarning ||
		line.Stream != "stderr" || line.Source != "start" || line.Level != "warn" || !line.Redacted {
		t.Fatalf("typed metadata changed: %#v", line)
	}
	if len(snapshot.LogLines) != 1 || snapshot.LogLines[0] != line.Text {
		t.Fatalf("compatibility log text diverged: %#v", snapshot.LogLines)
	}
}

func projectionEvents(count int) []relaybaseclient.LogEvent {
	events := make([]relaybaseclient.LogEvent, 0, count)
	for index := 1; index <= count; index++ {
		events = append(events, relaybaseclient.LogEvent{
			Sequence: int64(index),
			Stream:   "stdout",
			Level:    "info",
			Message:  fmt.Sprintf("line %03d", index),
		})
	}
	return events
}
