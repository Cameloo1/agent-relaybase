package model

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func transcriptActivityEvent(t *testing.T, sequence int64, eventType, id, state, label, output string) relaybaseclient.AgentRunEvent {
	t.Helper()
	data, err := json.Marshal(map[string]any{"activity": map[string]any{
		"id": id, "kind": "tool", "state": state, "label": label,
		"output": output, "outputLineCount": transcriptLineCount(output),
	}})
	if err != nil {
		t.Fatal(err)
	}
	return relaybaseclient.AgentRunEvent{Sequence: sequence, RunID: "run-1", Type: eventType, Data: data}
}

func transcriptEvent(t *testing.T, sequence int64, eventType string, data map[string]any) relaybaseclient.AgentRunEvent {
	t.Helper()
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return relaybaseclient.AgentRunEvent{Sequence: sequence, RunID: "run-1", Type: eventType, Data: raw}
}

func TestAgentTranscriptInterleavesMessagesAndUpdatesToolsInPlace(t *testing.T) {
	root := newTestModel(t)
	events := []relaybaseclient.AgentRunEvent{
		transcriptEvent(t, 1, "message.user", map[string]any{"messageId": "m1", "content": "Inspect this project."}),
		transcriptEvent(t, 2, "model.delta", map[string]any{"delta": "I will inspect it."}),
		transcriptActivityEvent(t, 3, "tool.started", "tool:1", "active", "Inspecting project", ""),
		transcriptActivityEvent(t, 4, "tool.completed", "tool:1", "completed", "Inspected project", "Framework: Vite\nCommand: npm run dev"),
		transcriptEvent(t, 5, "model.delta", map[string]any{"delta": "The project uses Vite."}),
		transcriptEvent(t, 6, "answer", map[string]any{"content": "The project uses Vite."}),
	}
	for _, event := range events {
		root.applyAgentTranscriptEvent(event)
	}
	if len(root.agentTranscript) != 4 {
		t.Fatalf("transcript items = %#v", root.agentTranscript)
	}
	wantKinds := []string{"user", "assistant", "tool", "assistant"}
	for index, want := range wantKinds {
		if root.agentTranscript[index].Kind != want {
			t.Fatalf("item %d kind = %q, want %q", index, root.agentTranscript[index].Kind, want)
		}
	}
	if root.agentTranscript[2].State != "completed" || root.agentTranscript[2].OutputLineCount != 2 {
		t.Fatalf("tool item = %#v", root.agentTranscript[2])
	}
	for _, event := range events {
		root.applyAgentTranscriptEvent(event)
	}
	if len(root.agentTranscript) != 4 {
		t.Fatalf("replayed events duplicated transcript items: %#v", root.agentTranscript)
	}
}

func TestAgentTranscriptIsBoundedAndReducedMotionDoesNotSchedule(t *testing.T) {
	root := newTestModel(t)
	root.preferences.Layout.AgentPaneCollapsed = false
	for sequence := int64(1); sequence <= maxAgentTranscriptItems+5; sequence++ {
		root.applyAgentTranscriptEvent(transcriptActivityEvent(t, sequence, "tool.started", fmt.Sprintf("tool:%d", sequence), "active", "Working", ""))
	}
	if len(root.agentTranscript) != maxAgentTranscriptItems {
		t.Fatalf("transcript items = %d", len(root.agentTranscript))
	}
	root.agentActivityAnimations = false
	if command := root.scheduleAgentActivityTick(); command != nil {
		t.Fatal("reduced motion scheduled animation")
	}
}

func TestAgentActivityAnimationRequiresConnectedAuthoritativeRunningState(t *testing.T) {
	root := newTestModel(t)
	root.preferences.Layout.AgentPaneCollapsed = false
	root.agentActivityAnimations = true
	root.agentStatus = "running"
	root.agentStream = &relaybaseclient.AgentEventStream{}
	root.applyAgentTranscriptEvent(transcriptActivityEvent(t, 1, "tool.started", "tool:1", "active", "Reading logs", ""))

	if root.agentActivityAuthoritative() {
		t.Fatal("active tool execution incorrectly drove the thinking shimmer")
	}
	root.applyAgentTranscriptEvent(transcriptEvent(t, 2, "model.processing_started", map[string]any{
		"activity": map[string]any{
			"id": "processing:run-1:1", "kind": "processing", "state": "active", "label": "Thinking",
		},
	}))
	if !root.agentActivityAuthoritative() {
		t.Fatal("connected model-processing activity was not authoritative")
	}
	if command := root.scheduleAgentActivityTick(); command == nil {
		t.Fatal("connected running activity did not schedule animation")
	}

	root.agentActivityTicking = false
	root.agentStreamReconnecting = true
	if root.agentActivityAuthoritative() {
		t.Fatal("reconnecting stream remained authoritative")
	}
	if command := root.scheduleAgentActivityTick(); command != nil {
		t.Fatal("reconnecting stream scheduled animation")
	}

	root.agentStreamReconnecting = false
	root.agentInitialReplay = true
	if root.agentActivityAuthoritative() {
		t.Fatal("initial replay remained authoritative")
	}

	root.agentInitialReplay = false
	root.agentStatus = "waiting"
	if root.agentActivityAuthoritative() {
		t.Fatal("approval wait remained authoritative")
	}

	root.agentStatus = "running"
	root.agentStream = nil
	if root.agentActivityAuthoritative() {
		t.Fatal("disconnected active transcript row remained authoritative")
	}
}

func TestOpeningFullAgentChatRestartsVisibleActivityAnimation(t *testing.T) {
	root := newTestModel(t)
	root.preferences.Layout.AgentPaneCollapsed = true
	root.agentActivityAnimations = true
	root.agentStatus = "running"
	root.agentStream = &relaybaseclient.AgentEventStream{}
	root.applyAgentTranscriptEvent(transcriptEvent(t, 1, "model.processing_started", map[string]any{
		"activity": map[string]any{
			"id": "processing:run-1:1", "kind": "processing", "state": "active", "label": "Thinking",
		},
	}))
	if root.agentActivityVisible() || root.agentActivityTicking {
		t.Fatalf("collapsed Agent surface unexpectedly remained visible or ticking: visible=%v ticking=%v", root.agentActivityVisible(), root.agentActivityTicking)
	}

	updated, command := root.Update(agentChatKey())
	root = updated.(RootModel)
	if command == nil || !root.agentChatFull || !root.agentActivityTicking {
		t.Fatalf("F6 did not restart the authoritative activity tick: command=%v full=%v ticking=%v", command, root.agentChatFull, root.agentActivityTicking)
	}
}

func TestRunTerminalEventCannotLeaveTranscriptActivityActive(t *testing.T) {
	root := newTestModel(t)
	root.applyAgentTranscriptEvent(transcriptActivityEvent(t, 1, "tool.started", "tool:1", "active", "Reading logs", ""))
	root.reconcileTerminalAgentTranscript(relaybaseclient.AgentRunEvent{Sequence: 2, RunID: "run-1", Type: "run.failed"})
	if root.agentTranscript[0].State != "failed" {
		t.Fatalf("terminal transcript item = %#v", root.agentTranscript[0])
	}
}

func TestHistoricalToolEventsBackfillWithoutActivityProjection(t *testing.T) {
	root := newTestModel(t)
	event := transcriptEvent(t, 4, "tool.completed", map[string]any{
		"toolCallId": "legacy-1", "toolName": "list_apps", "result": map[string]any{"count": 2},
	})
	if !root.applyAgentTranscriptEvent(event) || len(root.agentTranscript) != 1 {
		t.Fatalf("legacy transcript = %#v", root.agentTranscript)
	}
	if root.agentTranscript[0].State != "completed" || root.agentTranscript[0].Output == "" {
		t.Fatalf("legacy item = %#v", root.agentTranscript[0])
	}
}

func TestHistoricalActivityProjectionBackfillsMissingToolOutput(t *testing.T) {
	root := newTestModel(t)
	event := transcriptEvent(t, 7, "tool.completed", map[string]any{
		"toolCallId": "old-activity", "toolName": "get_app_state", "result": map[string]any{"status": "ready"},
		"activity": map[string]any{"id": "tool:old-activity", "kind": "tool", "state": "completed", "label": "Inspected app state"},
	})
	root.applyAgentTranscriptEvent(event)
	if len(root.agentTranscript) != 1 || root.agentTranscript[0].Output == "" {
		t.Fatalf("historical projected item = %#v", root.agentTranscript)
	}
}

func TestTranscriptRebuildPreservesStableExpansionAndSelection(t *testing.T) {
	root := newTestModel(t)
	event := transcriptActivityEvent(t, 3, "tool.completed", "tool:stable", "completed", "Inspected project", "one\ntwo")
	session := &relaybaseclient.AgentSession{
		ID:       "thread-1",
		Messages: []relaybaseclient.AgentMessage{{ID: "user-1", RunID: "run-1", Role: "user", Content: "Inspect it."}},
		Runs:     []relaybaseclient.AgentRun{{ID: "run-1", Events: []relaybaseclient.AgentRunEvent{event}}},
	}
	root.rebuildAgentTranscript(session)
	root.agentTranscriptExpanded["tool:stable"] = true
	root.agentTranscriptSelected = "tool:stable"
	root.rebuildAgentTranscript(session)
	if len(root.agentTranscript) != 2 || !root.agentTranscriptExpanded["tool:stable"] || root.agentTranscriptSelected != "tool:stable" {
		t.Fatalf("rebuilt transcript state = items:%#v expanded:%#v selected:%q", root.agentTranscript, root.agentTranscriptExpanded, root.agentTranscriptSelected)
	}
}

func TestAgentTranscriptPreservesWhitespaceAcrossModelDeltas(t *testing.T) {
	root := newTestModel(t)
	first := transcriptEvent(t, 1, "model.delta", map[string]any{"delta": "The project "})
	second := transcriptEvent(t, 2, "model.delta", map[string]any{"delta": "uses Vite."})
	root.applyAgentTranscriptEvent(first)
	root.applyAgentTranscriptEvent(second)
	root.applyAgentTranscriptEvent(first)
	root.applyAgentTranscriptEvent(second)
	if len(root.agentTranscript) != 1 || root.agentTranscript[0].Output != "The project uses Vite." {
		t.Fatalf("streamed assistant output = %#v", root.agentTranscript)
	}
}

func TestCollapsingLargeToolOutputReturnsToStableToolHeader(t *testing.T) {
	root := newTestModelWithPanes(t, 3)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	root.preferences.Layout.AgentPaneCollapsed = false
	output := strings.Repeat("expanded output row\n", 2_000)
	root.agentTranscript = []views.AgentTranscriptItem{{
		ID: "tool:large", Kind: "tool", State: "completed", Label: "Read output", Output: output,
		OutputLineCount: 2_000, Sequence: 1, UpdatedSequence: 1,
	}}
	root.agentTranscriptExpanded["tool:large"] = true
	root.agentTranscriptSelected = "tool:large"
	root.responseFollow = false
	root.responseOffset = 1_000
	if !root.toggleAgentTranscriptItem("tool:large") {
		t.Fatal("large tool output did not collapse")
	}
	if root.agentTranscriptExpanded["tool:large"] || root.responseOffset != 0 || root.responseFollow {
		t.Fatalf("collapse did not restore the tool header: expanded=%v offset=%d follow=%v", root.agentTranscriptExpanded["tool:large"], root.responseOffset, root.responseFollow)
	}
}

func TestProcessingActivityRemainsChronologicalBetweenToolCalls(t *testing.T) {
	root := newTestModel(t)
	events := []relaybaseclient.AgentRunEvent{
		transcriptActivityEvent(t, 1, "model.processing_started", "processing:run-1:1", "active", "Thinking", ""),
		transcriptActivityEvent(t, 2, "model.processing_completed", "processing:run-1:1", "completed", "Thought", ""),
		transcriptActivityEvent(t, 3, "tool.started", "tool:1", "active", "Listing registered apps", ""),
		transcriptActivityEvent(t, 4, "tool.completed", "tool:1", "completed", "Listed registered apps", "one\ntwo"),
		transcriptActivityEvent(t, 5, "model.processing_started", "processing:run-1:2", "active", "Reviewing tool result", ""),
	}
	for _, event := range events {
		root.applyAgentTranscriptEvent(event)
	}
	if len(root.agentTranscript) != 3 {
		t.Fatalf("processing transcript = %#v", root.agentTranscript)
	}
	want := []string{"processing:run-1:1", "tool:1", "processing:run-1:2"}
	for index, id := range want {
		if root.agentTranscript[index].ID != id {
			t.Fatalf("item %d = %q, want %q", index, root.agentTranscript[index].ID, id)
		}
	}
	if root.agentTranscript[2].State != "active" || root.agentTranscript[2].Label != "Reviewing tool result" {
		t.Fatalf("inter-tool processing item = %#v", root.agentTranscript[2])
	}
}
