package model

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/response"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

const maxAgentTranscriptItems = 512

func (m *RootModel) applyAgentTranscriptEvent(event relaybaseclient.AgentRunEvent) bool {
	if event.Sequence <= 0 {
		return false
	}
	if event.Type == "message.user" {
		content := stringField(event.Data, "content")
		if content == "" {
			return false
		}
		id := firstNonEmpty(stringField(event.Data, "messageId"), event.ID, fmt.Sprintf("%s:%d", event.RunID, event.Sequence))
		return m.upsertAgentTranscriptItem(views.AgentTranscriptItem{
			ID: "message:" + id, RunID: event.RunID, Kind: "user", State: "completed",
			Output: content, OutputLineCount: transcriptLineCount(content), Sequence: event.Sequence, UpdatedSequence: event.Sequence,
		})
	}
	if event.Type == "model.delta" {
		delta := rawTranscriptStringField(event.Data, "delta")
		if delta == "" {
			return false
		}
		for _, item := range m.agentTranscript {
			if item.RunID == event.RunID && item.Kind == "assistant" && event.Sequence >= item.Sequence && event.Sequence <= item.UpdatedSequence {
				return false
			}
		}
		for index := len(m.agentTranscript) - 1; index >= 0; index-- {
			item := &m.agentTranscript[index]
			if item.RunID == event.RunID && item.Kind == "assistant" && item.State == "active" {
				item.Output += delta
				item.OutputLineCount = transcriptLineCount(item.Output)
				item.UpdatedSequence = event.Sequence
				return true
			}
		}
		return m.upsertAgentTranscriptItem(views.AgentTranscriptItem{
			ID: fmt.Sprintf("assistant:%s:%d", event.RunID, event.Sequence), RunID: event.RunID,
			Kind: "assistant", State: "active", Output: delta, OutputLineCount: transcriptLineCount(delta),
			Sequence: event.Sequence, UpdatedSequence: event.Sequence,
		})
	}
	if event.Type == "answer" {
		content := stringField(event.Data, "content")
		for index := len(m.agentTranscript) - 1; index >= 0; index-- {
			item := &m.agentTranscript[index]
			if item.RunID != event.RunID || item.Kind != "assistant" {
				continue
			}
			if item.UpdatedSequence >= event.Sequence || (item.State != "active" && content != "" && item.Output == content) {
				return false
			}
			if content != "" && len(content) >= len(item.Output) {
				item.Output = content
			}
			item.OutputLineCount = transcriptLineCount(item.Output)
			item.State = "completed"
			item.UpdatedSequence = event.Sequence
			return true
		}
		if content == "" {
			return false
		}
		return m.upsertAgentTranscriptItem(views.AgentTranscriptItem{
			ID: fmt.Sprintf("assistant:%s:%d", event.RunID, event.Sequence), RunID: event.RunID,
			Kind: "assistant", State: "completed", Output: content, OutputLineCount: transcriptLineCount(content),
			Sequence: event.Sequence, UpdatedSequence: event.Sequence,
		})
	}

	var envelope struct {
		Activity *relaybaseclient.AgentActivity `json:"activity"`
	}
	_ = json.Unmarshal(event.Data, &envelope)
	activity := envelope.Activity
	if activity == nil {
		activity = legacyAgentActivity(event)
	} else if activity.Output == "" && (event.Type == "tool.completed" || event.Type == "tool.failed") {
		if legacy := legacyAgentActivity(event); legacy != nil {
			activity.Output = legacy.Output
			activity.OutputLineCount = legacy.OutputLineCount
			activity.OutputTruncated = legacy.OutputTruncated
		}
	}
	if activity == nil || strings.TrimSpace(activity.ID) == "" || strings.TrimSpace(activity.Label) == "" {
		return false
	}
	if activity.Kind != "run" && activity.State == "active" {
		m.completeActiveAssistantSegments(event.RunID, event.Sequence)
	}
	lineCount := activity.OutputLineCount
	if lineCount == 0 && activity.Output != "" {
		lineCount = transcriptLineCount(activity.Output)
	}
	return m.upsertAgentTranscriptItem(views.AgentTranscriptItem{
		ID: activity.ID, RunID: event.RunID, Kind: activity.Kind, State: activity.State,
		Label: activity.Label, Detail: activity.Detail, Output: activity.Output,
		OutputLineCount: lineCount, OutputTruncated: activity.OutputTruncated,
		DurationMS: activity.DurationMS, Sequence: event.Sequence, UpdatedSequence: event.Sequence,
	})
}

func rawTranscriptStringField(data json.RawMessage, field string) string {
	if len(data) == 0 {
		return ""
	}
	var record map[string]json.RawMessage
	if json.Unmarshal(data, &record) != nil || len(record[field]) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(record[field], &value) != nil {
		return ""
	}
	return response.SanitizeTerminalText(value)
}

func (m *RootModel) upsertAgentTranscriptItem(item views.AgentTranscriptItem) bool {
	for index := range m.agentTranscript {
		current := &m.agentTranscript[index]
		if current.ID != item.ID {
			continue
		}
		if current.UpdatedSequence >= item.UpdatedSequence {
			return false
		}
		item.Sequence = current.Sequence
		if item.Detail == "" {
			item.Detail = current.Detail
		}
		if item.Output == "" {
			item.Output = current.Output
			item.OutputLineCount = current.OutputLineCount
			item.OutputTruncated = current.OutputTruncated
		}
		if item.DurationMS == 0 {
			item.DurationMS = current.DurationMS
		}
		*current = item
		return true
	}
	m.agentTranscript = append(m.agentTranscript, item)
	sort.SliceStable(m.agentTranscript, func(i, j int) bool {
		return m.agentTranscript[i].Sequence < m.agentTranscript[j].Sequence
	})
	if len(m.agentTranscript) > maxAgentTranscriptItems {
		m.agentTranscript = append([]views.AgentTranscriptItem(nil), m.agentTranscript[len(m.agentTranscript)-maxAgentTranscriptItems:]...)
		m.agentTranscriptRenderCache.Reset()
	}
	if m.agentTranscriptSelected == "" && transcriptItemSelectable(item) {
		m.agentTranscriptSelected = item.ID
	}
	return true
}

func (m *RootModel) completeActiveAssistantSegments(runID string, sequence int64) {
	for index := range m.agentTranscript {
		item := &m.agentTranscript[index]
		if item.RunID == runID && item.Kind == "assistant" && item.State == "active" {
			item.State = "completed"
			item.UpdatedSequence = sequence
		}
	}
}

func (m *RootModel) reconcileTerminalAgentTranscript(event relaybaseclient.AgentRunEvent) {
	state := ""
	switch event.Type {
	case "run.completed":
		state = "completed"
	case "run.failed":
		state = "failed"
		if boolField(event.Data, "cancelled") {
			state = "cancelled"
		}
	case "run.finalized":
		state = "failed"
		if stringField(event.Data, "outcome") == "completed" {
			state = "completed"
		}
	}
	if state == "" {
		return
	}
	for index := range m.agentTranscript {
		item := &m.agentTranscript[index]
		if item.RunID != event.RunID || item.State != "active" || item.UpdatedSequence > event.Sequence {
			continue
		}
		item.State = state
		item.UpdatedSequence = event.Sequence
	}
}

func (m *RootModel) rebuildAgentTranscript(session *relaybaseclient.AgentSession) {
	expanded := copyStringBoolMap(m.agentTranscriptExpanded)
	selected := m.agentTranscriptSelected
	m.agentTranscriptRenderCache.Reset()
	m.agentTranscript = nil
	m.agentTranscriptSelected = ""
	if session == nil {
		m.agentTranscriptExpanded = map[string]bool{}
		return
	}
	runs := append([]relaybaseclient.AgentRun(nil), session.Runs...)
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].CreatedAt < runs[j].CreatedAt })
	for _, run := range runs {
		events := append([]relaybaseclient.AgentRunEvent(nil), run.Events...)
		sort.SliceStable(events, func(i, j int) bool { return events[i].Sequence < events[j].Sequence })
		firstSequence := int64(1)
		if len(events) > 0 {
			firstSequence = events[0].Sequence
		}
		if message, ok := agentMessageForRun(session.Messages, run.ID, "user"); ok && !runHasEvent(events, "message.user") {
			m.upsertAgentTranscriptItem(views.AgentTranscriptItem{
				ID: "message:" + message.ID, RunID: run.ID, Kind: "user", State: "completed", Output: message.Content,
				OutputLineCount: transcriptLineCount(message.Content), Sequence: firstSequence - 1, UpdatedSequence: firstSequence - 1,
			})
		}
		for _, event := range events {
			m.applyAgentTranscriptEvent(event)
			m.reconcileTerminalAgentTranscript(event)
		}
		if message, ok := agentMessageForRun(session.Messages, run.ID, "assistant"); ok && !transcriptHasAssistantRun(m.agentTranscript, run.ID) {
			sequence := firstSequence
			if len(events) > 0 {
				sequence = events[len(events)-1].Sequence + 1
			}
			m.upsertAgentTranscriptItem(views.AgentTranscriptItem{
				ID: "message:" + message.ID, RunID: run.ID, Kind: "assistant", State: "completed", Output: message.Content,
				OutputLineCount: transcriptLineCount(message.Content), Sequence: sequence, UpdatedSequence: sequence,
			})
		}
	}
	m.agentTranscriptExpanded = map[string]bool{}
	for _, item := range m.agentTranscript {
		if expanded[item.ID] {
			m.agentTranscriptExpanded[item.ID] = true
		}
		if item.ID == selected {
			m.agentTranscriptSelected = selected
		}
	}
	if m.agentTranscriptSelected == "" {
		m.selectAgentTranscriptEdge(false)
	}
}

func (m *RootModel) applyAgentUserMessage(message relaybaseclient.AgentMessage, run relaybaseclient.AgentRun) {
	if strings.TrimSpace(message.Content) == "" {
		return
	}
	sequence := int64(1)
	if len(run.Events) > 0 && run.Events[0].Sequence > 0 {
		sequence = run.Events[0].Sequence - 1
	}
	m.upsertAgentTranscriptItem(views.AgentTranscriptItem{
		ID: "message:" + firstNonEmpty(message.ID, run.ID), RunID: run.ID, Kind: "user", State: "completed",
		Output: message.Content, OutputLineCount: transcriptLineCount(message.Content), Sequence: sequence, UpdatedSequence: sequence,
	})
}

func legacyAgentActivity(event relaybaseclient.AgentRunEvent) *relaybaseclient.AgentActivity {
	tool := firstNonEmpty(stringField(event.Data, "toolName"), stringField(event.Data, "tool"), "tool")
	id := firstNonEmpty(stringField(event.Data, "toolCallId"), stringField(event.Data, "approvalId"), event.ID)
	activity := &relaybaseclient.AgentActivity{ID: "legacy:" + id, Kind: "tool"}
	switch event.Type {
	case "tool.requested", "tool.started":
		activity.State, activity.Label = "active", "Using "+tool
	case "tool.completed":
		activity.State, activity.Label = "completed", "Used "+tool
		activity.Output = rawJSONField(event.Data, "result")
	case "tool.failed":
		activity.State, activity.Label = "failed", "Failed "+tool
		activity.Output = firstNonEmpty(stringField(event.Data, "error"), rawJSONField(event.Data, "result"))
	case "tool.approval_required", "approval_required", "setup.file_write_approval_required", "setup.manifest_patch_approval_required":
		activity.Kind, activity.State, activity.Label = "approval", "waiting_approval", "Approval required for "+tool
	default:
		return nil
	}
	activity.OutputLineCount = transcriptLineCount(activity.Output)
	return activity
}

func rawJSONField(data json.RawMessage, field string) string {
	var record map[string]json.RawMessage
	if json.Unmarshal(data, &record) != nil || len(record[field]) == 0 {
		return ""
	}
	var value any
	if json.Unmarshal(record[field], &value) != nil {
		return ""
	}
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return ""
	}
	return response.SanitizeTerminalText(string(encoded))
}

func transcriptLineCount(value string) int {
	value = strings.TrimRight(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	if value == "" {
		return 0
	}
	return len(strings.Split(value, "\n"))
}

func agentMessageForRun(messages []relaybaseclient.AgentMessage, runID string, role string) (relaybaseclient.AgentMessage, bool) {
	for _, message := range messages {
		if message.RunID == runID && message.Role == role {
			return message, true
		}
	}
	return relaybaseclient.AgentMessage{}, false
}

func runHasEvent(events []relaybaseclient.AgentRunEvent, eventType string) bool {
	for _, event := range events {
		if event.Type == eventType {
			return true
		}
	}
	return false
}

func transcriptHasAssistantRun(items []views.AgentTranscriptItem, runID string) bool {
	for _, item := range items {
		if item.RunID == runID && item.Kind == "assistant" {
			return true
		}
	}
	return false
}

func copyStringBoolMap(source map[string]bool) map[string]bool {
	result := make(map[string]bool, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func transcriptItemSelectable(item views.AgentTranscriptItem) bool {
	return item.Kind != "user" && item.Kind != "assistant"
}

func (m *RootModel) toggleAgentTranscriptItem(id string) bool {
	if strings.TrimSpace(id) == "" {
		return false
	}
	if m.agentTranscriptExpanded == nil {
		m.agentTranscriptExpanded = map[string]bool{}
	}
	m.agentTranscriptExpanded[id] = !m.agentTranscriptExpanded[id]
	m.agentTranscriptSelected = id
	m.setCurrentResponseFollow(false)
	m.setCurrentResponseOffset(views.ResponseOffsetForTranscriptItem(m.styles, m.shellData(), id))
	return true
}

func (m *RootModel) toggleAllAgentTranscriptItems() {
	if m.agentTranscriptExpanded == nil {
		m.agentTranscriptExpanded = map[string]bool{}
	}
	expand := false
	for _, item := range m.agentTranscript {
		if transcriptItemSelectable(item) && item.OutputLineCount > 0 && !m.agentTranscriptExpanded[item.ID] {
			expand = true
			break
		}
	}
	for _, item := range m.agentTranscript {
		if transcriptItemSelectable(item) && item.OutputLineCount > 0 {
			m.agentTranscriptExpanded[item.ID] = expand
		}
	}
	m.setCurrentResponseFollow(false)
}

func (m *RootModel) moveAgentTranscriptSelection(delta int) bool {
	ids := []string{}
	for _, item := range m.agentTranscript {
		if transcriptItemSelectable(item) {
			ids = append(ids, item.ID)
		}
	}
	if len(ids) == 0 {
		return false
	}
	index := 0
	for current, id := range ids {
		if id == m.agentTranscriptSelected {
			index = current
			break
		}
	}
	index = minInt(maxInt(index+delta, 0), len(ids)-1)
	m.agentTranscriptSelected = ids[index]
	m.setCurrentResponseFollow(false)
	m.setCurrentResponseOffset(views.ResponseOffsetForTranscriptItem(m.styles, m.shellData(), m.agentTranscriptSelected))
	return true
}

func (m *RootModel) selectAgentTranscriptEdge(first bool) {
	start, end, step := len(m.agentTranscript)-1, -1, -1
	if first {
		start, end, step = 0, len(m.agentTranscript), 1
	}
	for index := start; index != end; index += step {
		if transcriptItemSelectable(m.agentTranscript[index]) {
			m.agentTranscriptSelected = m.agentTranscript[index].ID
			return
		}
	}
}

func (m RootModel) agentTranscriptCopyText() string {
	parts := []string{}
	for _, item := range m.agentTranscript {
		switch item.Kind {
		case "user":
			parts = append(parts, "You\n"+item.Output)
		case "assistant":
			parts = append(parts, "Agent\n"+item.Output)
		default:
			entry := item.Label
			if item.Output != "" {
				entry += "\n" + item.Output
			}
			parts = append(parts, entry)
		}
	}
	return response.SanitizeTerminalText(strings.Join(parts, "\n\n"))
}

func (m RootModel) hasActiveAgentThinking() bool {
	for _, item := range m.agentTranscript {
		if item.State == "active" && item.Kind == "processing" {
			return true
		}
	}
	return false
}

func (m RootModel) agentActivityVisible() bool {
	return m.agentChatFull || !m.preferences.Layout.AgentPaneCollapsed || m.responseDetailsVisible()
}

func (m RootModel) agentActivityAuthoritative() bool {
	return m.agentActivityAnimations &&
		m.agentStream != nil &&
		!m.agentStreamReconnecting &&
		!m.agentInitialReplay &&
		m.agentStatus == "running" &&
		m.hasActiveAgentThinking()
}

func (m *RootModel) scheduleAgentActivityTick() tea.Cmd {
	if m.agentActivityTicking || !m.agentActivityAuthoritative() || !m.agentActivityVisible() {
		return nil
	}
	m.agentActivityTicking = true
	return tea.Tick(120*time.Millisecond, func(time.Time) tea.Msg { return agentActivityTickMsg{} })
}

func terminalActivityASCII() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("TERM")), "dumb") || envTruthy("RELAYBASE_TUI_ASCII")
}

func terminalReducedMotion() bool { return envTruthy("RELAYBASE_TUI_REDUCED_MOTION") }

func envTruthy(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
