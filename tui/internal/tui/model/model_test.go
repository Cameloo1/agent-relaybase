package model

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/color"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/bootstrap"
	"github.com/cameloo/relaybase/tui/internal/config"
	"github.com/cameloo/relaybase/tui/internal/events"
	"github.com/cameloo/relaybase/tui/internal/preferences"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/assistant"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/contextmenu"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/testfixtures"
)

func TestRootModelInitialState(t *testing.T) {
	root := newTestModel(t)

	if root.ConnectionStatus() != "connecting" {
		t.Fatalf("unexpected connection status: %s", root.ConnectionStatus())
	}
	if root.EventStatus() != "connecting" {
		t.Fatalf("unexpected event status: %s", root.EventStatus())
	}
	if root.Theme().Mode != "light" {
		t.Fatalf("expected light theme, got %s", root.Theme().Mode)
	}
}

func TestRootViewUsesResolvedThemeCanvasColors(t *testing.T) {
	tests := []string{"light", "dark"}
	for _, mode := range tests {
		t.Run(mode, func(t *testing.T) {
			cfg := config.Config{
				BaseURL:   "http://127.0.0.1:7777",
				StateDir:  t.TempDir(),
				Token:     "test-token",
				ThemeMode: mode,
			}
			root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, nil))
			view := root.View()

			if !sameColor(view.BackgroundColor, root.Theme().Background) {
				t.Fatalf("expected %s view background to use theme background", mode)
			}
			if !sameColor(view.ForegroundColor, root.Theme().Text) {
				t.Fatalf("expected %s view foreground to use theme text color", mode)
			}
			if !view.AltScreen {
				t.Fatal("expected alt-screen canvas for full terminal background rendering")
			}
		})
	}
}

func TestDaemonUnavailableDiagnostic(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(commands.StateFailedMsg{Err: errors.New("connection refused")})
	model := updated.(RootModel)

	if model.ConnectionStatus() != "offline" {
		t.Fatalf("expected offline status, got %s", model.ConnectionStatus())
	}
	if !hasDiagnostic(model.Diagnostics(), "daemon_unavailable") {
		t.Fatalf("expected daemon_unavailable diagnostic, got %#v", model.Diagnostics())
	}
}

func TestInitialDaemonStateFetchGatesDependentStartupCalls(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		if r.URL.Path != "/__hub/api/state" {
			t.Fatalf("unexpected startup request before daemon state gate: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"apps":[],"groups":[],"components":[]}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "light"}
	client := relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client())
	root := NewRoot(cfg, client)

	msg := root.Init()()
	if _, ok := msg.(commands.StateLoadedMsg); !ok {
		t.Fatalf("expected gated startup to fetch state, got %T", msg)
	}
	if len(requests) != 1 || requests[0] != "/__hub/api/state" {
		t.Fatalf("expected only state request before daemon gate, got %#v", requests)
	}
}

func TestOfflineDaemonConsolidatesDiagnosticsAndDefersDependentFetches(t *testing.T) {
	root := newTestModel(t)
	updated, cmd := root.Update(commands.StateFailedMsg{Err: errors.New(`Get "http://127.0.0.1:7777/__hub/api/state": connect refused`)})
	model := updated.(RootModel)

	if cmd == nil {
		t.Fatal("expected offline daemon to schedule a retry")
	}
	if model.ConnectionStatus() != "offline" || model.EventStatus() != "waiting" {
		t.Fatalf("expected offline/waiting statuses, got daemon=%s events=%s", model.ConnectionStatus(), model.EventStatus())
	}
	if countDiagnostics(model.Diagnostics(), daemonUnavailableDiagnosticCode) != 1 {
		t.Fatalf("expected one consolidated daemon diagnostic, got %#v", model.Diagnostics())
	}
	diagnosticsText := fmt.Sprint(model.Diagnostics())
	if strings.Contains(diagnosticsText, "__hub/api/state") || strings.Contains(diagnosticsText, "connect refused") {
		t.Fatalf("offline diagnostic should stay concise, got %#v", model.Diagnostics())
	}

	updated, _ = model.Update(commands.AgentConfigFailedMsg{Err: errors.New("agent config refused")})
	model = updated.(RootModel)
	updated, _ = model.Update(commands.AgentDiagnosticsFailedMsg{Err: errors.New("agent diagnostics refused")})
	model = updated.(RootModel)
	updated, _ = model.Update(events.StreamDisconnectedMsg{Err: errors.New("events refused")})
	model = updated.(RootModel)
	updated, _ = model.Update(commands.StateFailedMsg{Err: errors.New("still offline")})
	model = updated.(RootModel)

	if countDiagnostics(model.Diagnostics(), daemonUnavailableDiagnosticCode) != 1 {
		t.Fatalf("expected repeated offline failures to replace daemon diagnostic, got %#v", model.Diagnostics())
	}
	for _, code := range []string{eventDisconnectedDiagnosticCode, agentGatewayUnavailableCode, agentDiagnosticsUnavailableCode} {
		if hasDiagnostic(model.Diagnostics(), code) {
			t.Fatalf("offline daemon should not record dependent %s diagnostics: %#v", code, model.Diagnostics())
		}
	}
}

func TestDaemonReconnectStartsDependentStreamsAndClearsOfflineDiagnostics(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(commands.StateFailedMsg{Err: errors.New("offline")})
	model := updated.(RootModel)
	if !hasDiagnostic(model.Diagnostics(), daemonUnavailableDiagnosticCode) {
		t.Fatal("expected offline diagnostic before reconnect")
	}

	updated, cmd := model.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{}})
	model = updated.(RootModel)
	if model.ConnectionStatus() != "connected" || hasDiagnostic(model.Diagnostics(), daemonUnavailableDiagnosticCode) {
		t.Fatalf("expected reconnect to clear offline diagnostic, status=%s diagnostics=%#v", model.ConnectionStatus(), model.Diagnostics())
	}
	if cmd == nil {
		t.Fatal("expected reconnect to start dependent TUI daemon reads")
	}
	msg := cmd()
	if batch, ok := msg.(tea.BatchMsg); !ok || len(batch) < 3 {
		t.Fatalf("expected event stream and agent config/diagnostics commands after reconnect, got %T %#v", msg, msg)
	}
}

func TestDaemonReconnectClearsStaleRecoveryDiagnostics(t *testing.T) {
	root := newTestModel(t)
	root.addDiagnostic(daemonUnavailableDiagnosticCode, "error", "offline")
	root.addDiagnostic(eventDisconnectedDiagnosticCode, "warning", "disconnected")
	root.addDiagnostic(authTokenInvalidDiagnosticCode, "warning", "bad token")
	root.addDiagnostic("daemon_bootstrap_daemon_not_running", "error", "bridge failed")

	updated, _ := root.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{}})
	model := updated.(RootModel)

	for _, code := range []string{
		daemonUnavailableDiagnosticCode,
		eventDisconnectedDiagnosticCode,
		authTokenInvalidDiagnosticCode,
		"daemon_bootstrap_daemon_not_running",
	} {
		if hasDiagnostic(model.Diagnostics(), code) {
			t.Fatalf("expected reconnect to clear %s, diagnostics=%#v", code, model.Diagnostics())
		}
	}
}

func TestDiagnosticsReplaceByCode(t *testing.T) {
	root := newTestModel(t)
	root.addDiagnostic(eventDisconnectedDiagnosticCode, "warning", "first disconnect")
	root.addDiagnostic(eventDisconnectedDiagnosticCode, "warning", "second disconnect")

	if countDiagnostics(root.Diagnostics(), eventDisconnectedDiagnosticCode) != 1 {
		t.Fatalf("expected one event diagnostic, got %#v", root.Diagnostics())
	}
	if strings.Contains(fmt.Sprint(root.Diagnostics()), "first disconnect") {
		t.Fatalf("expected stale diagnostic message to be replaced, got %#v", root.Diagnostics())
	}
	if !strings.Contains(fmt.Sprint(root.Diagnostics()), "second disconnect") {
		t.Fatalf("expected latest diagnostic message, got %#v", root.Diagnostics())
	}
}

func TestAgentDiagnosticsReplaceAndClear(t *testing.T) {
	root := newTestModel(t)
	loaded := commands.AgentDiagnosticsLoadedMsg{Diagnostics: []relaybaseclient.AgentDiagnostic{{
		Code:     "budget_exceeded",
		Severity: "warning",
		Message:  "budget exceeded",
	}}}
	updated, _ := root.Update(loaded)
	model := updated.(RootModel)
	updated, _ = model.Update(loaded)
	model = updated.(RootModel)

	if countDiagnostics(model.Diagnostics(), "budget_exceeded") != 1 {
		t.Fatalf("expected one agent diagnostic after repeated loads, got %#v", model.Diagnostics())
	}

	updated, _ = model.Update(commands.AgentDiagnosticsLoadedMsg{Diagnostics: nil})
	model = updated.(RootModel)
	if hasDiagnostic(model.Diagnostics(), "budget_exceeded") {
		t.Fatalf("expected empty daemon diagnostics to clear stale code, got %#v", model.Diagnostics())
	}
}

func TestInitialAgentReplayKeepsHistoricalDiagnosticsOutOfCurrentHealth(t *testing.T) {
	root := newTestModel(t)
	root.agentInitialReplay = true
	root.applyAgentRunEvent(rawAgentEvent("diagnostic", `{"code":"AGENT_DISABLED","severity":"error","message":"historical disabled state"}`))

	if hasDiagnostic(root.Diagnostics(), "agent_disabled") {
		t.Fatalf("historical replay diagnostic contaminated current health: %#v", root.Diagnostics())
	}
	if !strings.Contains(strings.Join(root.assistantTimeline, "\n"), "historical disabled state") {
		t.Fatalf("historical replay should remain visible in the thread timeline: %#v", root.assistantTimeline)
	}

	root.applyAgentRunEvent(rawAgentEvent("stream.replay_completed", `{"afterSequence":0}`))
	root.applyAgentRunEvent(rawAgentEvent("diagnostic", `{"code":"AGENT_PROVIDER_TIMEOUT","severity":"error","message":"current provider timeout"}`))

	if !hasDiagnostic(root.Diagnostics(), "agent_provider_timeout") {
		t.Fatalf("current live diagnostic should remain visible after replay: %#v", root.Diagnostics())
	}
}

func TestAgentConfigDiagnosticsReplaceAndClear(t *testing.T) {
	root := newTestModel(t)
	disabled := commands.AgentConfigLoadedMsg{Config: &relaybaseclient.AgentConfig{Enabled: false}}
	updated, _ := root.Update(disabled)
	model := updated.(RootModel)
	updated, _ = model.Update(disabled)
	model = updated.(RootModel)

	if countDiagnostics(model.Diagnostics(), "agent_disabled") != 1 {
		t.Fatalf("expected one disabled-agent diagnostic, got %#v", model.Diagnostics())
	}

	updated, _ = model.Update(commands.AgentConfigLoadedMsg{Config: enabledAgentConfig(true)})
	model = updated.(RootModel)
	if hasDiagnostic(model.Diagnostics(), "agent_disabled") {
		t.Fatalf("expected enabled config to clear stale disabled diagnostic, got %#v", model.Diagnostics())
	}
}

func TestOfflineBrokenSummaryIsConcise(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(commands.StateFailedMsg{Err: errors.New(`Get "http://127.0.0.1:7777/__hub/api/state": connect refused`)})
	model := updated.(RootModel)

	assistantUpdated, cmd := model.submitAssistantInput("what is broken?")
	if cmd != nil {
		t.Fatal("expected offline broken summary to stay local")
	}
	model = assistantUpdated
	history := model.NaturalAssistantHistory()
	if len(history) == 0 {
		t.Fatal("expected assistant history for offline broken summary")
	}
	message := history[len(history)-1].Message
	if !strings.Contains(message, "Relaybase daemon is unavailable") || !strings.Contains(message, "relaybase serve") {
		t.Fatalf("expected concise offline recovery message, got %q", message)
	}
	if strings.Contains(message, "__hub/api") || strings.Contains(message, "agent_gateway_unavailable") || strings.Contains(message, "event_stream_disconnected") {
		t.Fatalf("offline broken summary should not enumerate failed endpoints, got %q", message)
	}
}

func TestDaemonUnavailableDiagnosticUsingFakeServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"relaybaseError":{"code":"daemon_unavailable","message":"Daemon unavailable","retryable":true,"correlationId":"c1"}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: ".relaybase", Token: "test-token", ThemeMode: "light"}
	client := relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client())
	root := NewRoot(cfg, client)

	msg := commands.FetchStateCmd(context.Background(), client)()
	failed, ok := msg.(commands.StateFailedMsg)
	if !ok {
		t.Fatalf("expected StateFailedMsg, got %T", msg)
	}
	updated, _ := root.Update(failed)
	model := updated.(RootModel)

	if !hasDiagnostic(model.Diagnostics(), "daemon_unavailable") {
		t.Fatalf("expected daemon_unavailable diagnostic, got %#v", model.Diagnostics())
	}
}

func TestSuccessfulStateFetchMessage(t *testing.T) {
	root := newTestModel(t)
	state := &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "notes", RuntimeStatus: "running"}}}
	updated, cmd := root.Update(commands.StateLoadedMsg{State: state})
	model := updated.(RootModel)

	if model.ConnectionStatus() != "connected" {
		t.Fatalf("expected connected status, got %s", model.ConnectionStatus())
	}
	if model.State() == nil || len(model.State().Apps) != 1 {
		t.Fatalf("state was not stored: %#v", model.State())
	}
	if len(model.PaneManager().VisiblePanes()) != 1 {
		t.Fatalf("expected one visible pane, got %#v", model.PaneManager().VisiblePanes())
	}
	if cmd == nil {
		t.Fatal("expected initial state load to request pane scrollback")
	}
}

func TestAPIVersionMismatchDiagnostic(t *testing.T) {
	root := newTestModel(t)
	state := &relaybaseclient.RelaybaseState{APIVersion: "v999"}
	updated, _ := root.Update(commands.StateLoadedMsg{State: state})
	model := updated.(RootModel)

	if !hasDiagnostic(model.Diagnostics(), "api_version_mismatch") {
		t.Fatalf("expected api_version_mismatch diagnostic, got %#v", model.Diagnostics())
	}
}

func TestEventMessageHandling(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(events.DaemonEventMsg{Event: relaybaseclient.DaemonEvent{Type: "daemon.ready", Sequence: 1}})
	model := updated.(RootModel)

	if model.EventCount() != 1 {
		t.Fatalf("expected event count 1, got %d", model.EventCount())
	}
}

func TestDashboardKeyFlow(t *testing.T) {
	root := newTestModelWithPanes(t, 2)
	updated, _ := root.Update(tea.KeyPressMsg{Text: "", Code: 0})
	model := updated.(RootModel)
	first := model.PaneManager().SelectedPaneID()

	updated, _ = model.Update(tea.KeyPressMsg{Text: "", Code: 0})
	model = updated.(RootModel)
	if model.PaneManager().SelectedPaneID() != first {
		t.Fatalf("unexpected selection change for empty key")
	}

	updated, _ = model.Update(keyPress("right"))
	model = updated.(RootModel)
	if model.PaneManager().SelectedPaneID() == first {
		t.Fatal("expected right arrow to move selection")
	}

	updated, _ = model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if !model.PaneManager().Focused() {
		t.Fatal("expected enter to focus selected pane")
	}

	updated, _ = model.Update(keyPress("esc"))
	model = updated.(RootModel)
	if model.PaneManager().Focused() {
		t.Fatal("expected escape to return to dashboard")
	}
}

func TestDashboardPageKeysMovePanePages(t *testing.T) {
	root := newTestModelWithPanes(t, 9)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	root = updated.(RootModel)
	if root.PaneManager().PageCount() != 2 {
		t.Fatalf("expected two dashboard pages, got %d", root.PaneManager().PageCount())
	}

	updated, cmd := root.Update(keyPress("pgdown"))
	model := updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected page change to persist preferences")
	}
	if model.PaneManager().Page() != 1 {
		t.Fatalf("expected PageDown to move to page 1, got %d", model.PaneManager().Page())
	}

	updated, cmd = model.Update(keyPress("pgup"))
	model = updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected page change to persist preferences")
	}
	if model.PaneManager().Page() != 0 {
		t.Fatalf("expected PageUp to move to page 0, got %d", model.PaneManager().Page())
	}
}

func TestPaneSelectionSurvivesEventReconnectAndStateRefresh(t *testing.T) {
	root := newTestModelWithPanes(t, 9)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	root = updated.(RootModel)
	if !root.paneManager.SelectPane("app-9:app-9-web:frontend:frontend") {
		t.Fatal("expected page-two pane to be selectable")
	}

	updated, cmd := root.Update(events.StreamDisconnectedMsg{Err: errors.New("event stream disconnected")})
	model := updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected reconnect check command after event stream disconnect")
	}
	if model.EventStatus() != "reconnecting" {
		t.Fatalf("expected reconnecting event status, got %s", model.EventStatus())
	}
	assertModelSelectedPaneID(t, model, "app-9:app-9-web:frontend:frontend")

	updated, _ = model.Update(commands.StateLoadedMsg{State: paneState(9)})
	model = updated.(RootModel)
	assertModelSelectedPaneID(t, model, "app-9:app-9-web:frontend:frontend")
	if model.PaneManager().Page() != 1 {
		t.Fatalf("expected selection to keep page 1 after reconnect state refresh, got %d", model.PaneManager().Page())
	}
}

func TestFocusedPanePageKeysScrollLogsAndFetchOlder(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	root = updated.(RootModel)
	paneID := root.PaneManager().SelectedPaneID()
	root.paneManager.MergeSnapshot(panes.LogTarget{PaneID: paneID, AppID: "app-1-web"}, &relaybaseclient.LogSnapshot{
		Events: testLogEvents("app-1-web", "app-1", "frontend", 30),
		Page: relaybaseclient.LogPage{
			NextBefore: "10",
			HasOlder:   true,
		},
	})
	updated, _ = root.Update(keyPress("enter"))
	model := updated.(RootModel)

	updated, cmd := model.Update(keyPress("pgup"))
	model = updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected focused PageUp to request older logs when available")
	}
	if pane := model.PaneManager().SelectedPane(); pane == nil || pane.ScrollOffset == 0 {
		t.Fatalf("expected focused PageUp to scroll away from follow position, got %#v", pane)
	}

	updated, cmd = model.Update(keyPress("pgdown"))
	model = updated.(RootModel)
	if cmd != nil {
		t.Fatal("focused PageDown should scroll locally without fetching logs")
	}
	if pane := model.PaneManager().SelectedPane(); pane == nil || pane.ScrollOffset != 0 {
		t.Fatalf("expected focused PageDown to return to the latest logs, got %#v", pane)
	}
}

func TestFocusEscapeFlowKeepsAssistantBarVisible(t *testing.T) {
	root := newTestModelWithPanes(t, 8)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	model := updated.(RootModel)

	updated, _ = model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if !model.PaneManager().Focused() {
		t.Fatal("expected enter to focus selected pane")
	}
	if rendered := model.Render(); !strings.Contains(rendered, "> _") || !strings.Contains(rendered, "focused") {
		t.Fatalf("expected focused render to keep assistant bar and focused marker:\n%s", rendered)
	}

	updated, _ = model.Update(keyPress("esc"))
	model = updated.(RootModel)
	if model.PaneManager().Focused() {
		t.Fatal("expected escape to return to dashboard")
	}
	if rendered := model.Render(); !strings.Contains(rendered, "> _") {
		t.Fatalf("expected dashboard render to keep assistant bar:\n%s", rendered)
	}
}

func TestConstrainedRecoveryPreservesStateAndBackgroundWheelIsInert(t *testing.T) {
	root := newTestModel(t)
	root = typeAssistantText(t, root, "preserve this draft")
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 120, Height: 12})
	model := updated.(RootModel)

	view := model.View()
	if view.MouseMode != tea.MouseModeCellMotion {
		t.Fatalf("expected mouse wheel support, got mouse mode %v", view.MouseMode)
	}

	initial := model.Render()
	if !strings.Contains(initial, "needs at least 40") || model.CommandInput() != "preserve this draft" {
		t.Fatalf("expected resize recovery without losing the draft, input=%q:\n%s", model.CommandInput(), initial)
	}

	updated, _ = model.Update(tea.MouseWheelMsg{X: 10, Y: 5, Button: tea.MouseWheelDown})
	model = updated.(RootModel)
	if model.bodyScrollOffset != 0 || model.CommandInput() != "preserve this draft" {
		t.Fatalf("background wheel should be inert during recovery, offset=%d input=%q", model.bodyScrollOffset, model.CommandInput())
	}
}

func TestLogLineEventFetchesPaneLogs(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	payload, err := json.Marshal(map[string]any{
		"log": map[string]any{
			"appId":         "app-1-web",
			"groupId":       "app-1",
			"componentRole": "frontend",
			"sequence":      4,
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	event := relaybaseclient.DaemonEvent{Type: "log.line_available", Data: payload}
	logEvent, ok := logEventFromDaemonEvent(event)
	if !ok {
		t.Fatal("expected log event payload to parse")
	}
	if targets := root.PaneManager().TargetsForLogEvent(logEvent); len(targets) != 1 {
		t.Fatalf("expected one pane log target, got %#v", targets)
	}
	_, cmd := root.Update(events.DaemonEventMsg{Event: event})
	if cmd == nil {
		t.Fatal("expected log fetch command")
	}
}

func TestLogsFailedMarksPaneAndSanitizesDiagnostic(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	target := panes.LogTarget{PaneID: root.PaneManager().SelectedPaneID(), AppID: "app-1-web"}
	updated, _ := root.Update(commands.LogsFailedMsg{
		Target: target,
		Err:    errors.New("token=abc123 log query failed"),
	})
	model := updated.(RootModel)

	pane := model.PaneManager().SelectedPane()
	if pane == nil || pane.LogError == "" {
		t.Fatalf("expected pane log error, got %#v", pane)
	}
	if strings.Contains(pane.LogError, "abc123") || strings.Contains(pane.LogError, "token=") {
		t.Fatalf("pane log error leaked secret-like content: %#v", pane.LogError)
	}
	diagnostics := model.Diagnostics()
	if !hasDiagnostic(diagnostics, "pane_logs_unavailable") {
		t.Fatalf("expected pane_logs_unavailable diagnostic, got %#v", diagnostics)
	}
	for _, diagnostic := range diagnostics {
		if strings.Contains(diagnostic.Message, "abc123") || strings.Contains(diagnostic.Message, "token=") {
			t.Fatalf("diagnostic leaked secret-like content: %#v", diagnostic)
		}
	}
}

func TestQuitKeyReturnsQuitCommand(t *testing.T) {
	root := newTestModel(t)
	_, cmd := root.Update(tea.KeyPressMsg{Text: "q", Code: 'q'})
	if cmd == nil {
		t.Fatal("expected quit command")
	}
}

func TestHelpViewToggles(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(tea.KeyPressMsg{Text: "?", Code: '?'})
	model := updated.(RootModel)

	if !model.HelpVisible() {
		t.Fatal("expected help to be visible")
	}
	if !strings.Contains(model.Render(), "Help") {
		t.Fatal("expected rendered help text")
	}
}

func TestAssistantInputBackspaceClearsLastNaturalCharacter(t *testing.T) {
	root := newTestModel(t)
	model := typeAssistantText(t, root, "hi")

	updated, _ := model.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
	model = updated.(RootModel)
	if model.CommandInput() != "h" || !model.commandActive {
		t.Fatalf("expected named backspace to leave one active character, active=%v input=%q", model.commandActive, model.CommandInput())
	}

	updated, _ = model.Update(tea.KeyPressMsg{Code: 127})
	model = updated.(RootModel)
	if model.CommandInput() != "" || model.commandActive {
		t.Fatalf("expected raw backspace to clear and close empty input, active=%v input=%q", model.commandActive, model.CommandInput())
	}
	if model.assistantPrompt != assistant.PromptPlaceholder() {
		t.Fatalf("expected placeholder after clearing input, got %q", model.assistantPrompt)
	}
}

func TestAssistantInputEditingKeysAndPasteStayUsable(t *testing.T) {
	root := newTestModel(t)

	updated, _ := root.Update(tea.KeyPressMsg{Text: "a", Code: 'a'})
	model := updated.(RootModel)
	if !model.commandActive || model.CommandInput() != "a" {
		t.Fatalf("expected one typed character, active=%v input=%q", model.commandActive, model.CommandInput())
	}

	updated, _ = model.Update(tea.KeyPressMsg{Text: strings.Repeat("b", 80), Code: 'b'})
	model = updated.(RootModel)
	if !strings.HasPrefix(model.CommandInput(), "ab") || len(model.CommandInput()) != 81 {
		t.Fatalf("expected long sentence input to append, got %q", model.CommandInput())
	}

	updated, _ = model.Update(tea.KeyPressMsg{Code: tea.KeyDelete})
	model = updated.(RootModel)
	if len(model.CommandInput()) != 81 {
		t.Fatalf("delete at end should not backspace, got %q", model.CommandInput())
	}

	updated, _ = model.Update(tea.KeyPressMsg{Code: 8})
	model = updated.(RootModel)
	if len(model.CommandInput()) != 80 {
		t.Fatalf("ctrl+h/raw backspace should remove one rune, got %q", model.CommandInput())
	}

	updated, _ = model.Update(tea.KeyPressMsg{Code: 21})
	model = updated.(RootModel)
	if model.commandActive || model.CommandInput() != "" {
		t.Fatalf("ctrl+u should clear input, active=%v input=%q", model.commandActive, model.CommandInput())
	}

	updated, _ = model.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
	model = updated.(RootModel)
	if model.commandActive || model.CommandInput() != "" {
		t.Fatalf("backspace at start should stay inert, active=%v input=%q", model.commandActive, model.CommandInput())
	}

	updated, _ = model.Update(tea.KeyPressMsg{Text: "show\ndiagnostics", Code: 's'})
	model = updated.(RootModel)
	if model.CommandInput() != "show\ndiagnostics" {
		t.Fatalf("multiline paste should preserve lines, got %q", model.CommandInput())
	}
}

func TestAssistantInputBracketedPasteStartsAndNormalizesInput(t *testing.T) {
	root := newTestModel(t)

	updated, command := root.Update(tea.PasteMsg{Content: "launch\nnotes\tfrontend"})
	if command == nil {
		t.Fatal("expected asynchronous bracketed paste normalization")
	}
	updated, _ = updated.Update(command())
	model := updated.(RootModel)

	if !model.commandActive || model.CommandInput() != "launch\nnotes    frontend" {
		t.Fatalf("expected bracketed paste to start normalized input, active=%v input=%q", model.commandActive, model.CommandInput())
	}
}

func TestAssistantInputCtrlVPastesSystemClipboard(t *testing.T) {
	root := newTestModel(t)
	clipboard := "show\ndiagnostics"
	readClipboardText = func() (string, error) {
		return clipboard, nil
	}
	t.Cleanup(func() {
		readClipboardText = readSystemClipboardText
	})

	updated, cmd := root.Update(tea.KeyPressMsg{Code: 22})
	if cmd == nil {
		t.Fatal("expected ctrl+v to request clipboard contents")
	}
	updated, pasteCommand := updated.Update(cmd())
	if pasteCommand == nil {
		t.Fatal("expected clipboard text to enter the shared paste pipeline")
	}
	updated, _ = updated.Update(pasteCommand())
	model := updated.(RootModel)
	if !model.commandActive || model.CommandInput() != "show\ndiagnostics" {
		t.Fatalf("expected ctrl+v to paste normalized clipboard text, active=%v input=%q", model.commandActive, model.CommandInput())
	}

	clipboard = " now"
	updated, cmd = model.Update(tea.KeyPressMsg{Code: 22})
	if cmd == nil {
		t.Fatal("expected ctrl+v to request clipboard contents while input is active")
	}
	updated, pasteCommand = updated.Update(cmd())
	if pasteCommand == nil {
		t.Fatal("expected second clipboard read to enter the shared paste pipeline")
	}
	updated, _ = updated.Update(pasteCommand())
	model = updated.(RootModel)
	if model.CommandInput() != "show\ndiagnostics now" {
		t.Fatalf("expected second paste to append to active input, got %q", model.CommandInput())
	}
}

func TestAssistantInputCopyShortcutCopiesCurrentInputOnly(t *testing.T) {
	root := newTestModel(t)
	model := typeAssistantText(t, root, "SECRET_TOKEN=abc123")
	copied := ""
	writeClipboardText = func(text string) error {
		copied = text
		return nil
	}
	t.Cleanup(func() {
		writeClipboardText = writeSystemClipboardText
	})

	updated, cmd := model.Update(tea.KeyPressMsg{Code: 3})
	if cmd == nil {
		t.Fatal("expected ctrl+c to copy active input")
	}
	updated, _ = updated.Update(cmd())
	model = updated.(RootModel)
	if copied != "SECRET_TOKEN=abc123" {
		t.Fatalf("expected current input to be copied exactly, got %q", copied)
	}
	if model.CommandInput() != "SECRET_TOKEN=abc123" || !model.commandActive {
		t.Fatalf("copy should not clear active input, active=%v input=%q", model.commandActive, model.CommandInput())
	}
	if strings.Contains(fmt.Sprint(model.Diagnostics()), "abc123") {
		t.Fatalf("copy diagnostic leaked clipboard contents: %#v", model.Diagnostics())
	}
}

func TestAssistantInputBackspaceClosesBareSlashPrompt(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(keyPress("/"))
	model := updated.(RootModel)
	if !model.commandActive || model.CommandInput() != "/" {
		t.Fatalf("expected slash input to be active, active=%v input=%q", model.commandActive, model.CommandInput())
	}

	updated, _ = model.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
	model = updated.(RootModel)
	if model.CommandInput() != "" || model.commandActive {
		t.Fatalf("expected backspace to clear bare slash prompt, active=%v input=%q", model.commandActive, model.CommandInput())
	}
}

func TestAssistantInputCanSubmitRepeatedLocalCommandsAfterFailuresAndCancel(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())

	first := typeAssistantText(t, root, "unknown command")
	updated, cmd := first.Update(keyPress("enter"))
	model := updated.(RootModel)
	if cmd != nil || !model.commandActive || model.CommandInput() != "unknown command" {
		t.Fatalf("unsupported command should stay local and preserve its retryable draft, cmd=%v active=%v input=%q", cmd, model.commandActive, model.CommandInput())
	}
	model.commandInput = ""
	model.composer.Clear()
	model.setPrimaryFocus("panes")

	second := typeAssistantText(t, model, "what is broken?")
	updated, cmd = second.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd != nil || model.commandActive {
		t.Fatalf("second local command should submit cleanly, cmd=%v active=%v", cmd, model.commandActive)
	}
	if history := strings.Join(model.assistantHistoryForView(), "\n"); !strings.Contains(history, "No failed or degraded apps") {
		t.Fatalf("expected second local response, got %#v", history)
	}

	pending, cmd := model.submitAssistantInput("stop backend")
	if cmd != nil || !pending.PendingConfirmation() {
		t.Fatalf("expected pending confirmation before cancel, cmd=%v pending=%v", cmd, pending.PendingConfirmation())
	}
	updated, cmd = pending.Update(keyPress("esc"))
	cancelled := updated.(RootModel)
	if cmd != nil || cancelled.PendingConfirmation() {
		t.Fatalf("expected /cancel to clear pending confirmation, cmd=%v pending=%v", cmd, cancelled.PendingConfirmation())
	}
	afterCancel := typeAssistantText(t, cancelled, "show diagnostics")
	updated, cmd = afterCancel.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd != nil || model.commandActive {
		t.Fatalf("input after /cancel should submit locally, cmd=%v active=%v", cmd, model.commandActive)
	}
}

func TestAssistantInputSurvivesDaemonEventsResizeScrollAndThemeChange(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(commands.StateFailedMsg{Err: errors.New("offline")})
	model := updated.(RootModel)
	updated, _ = model.Update(commands.StateLoadedMsg{State: notesFrontendBackendState()})
	model = updated.(RootModel)

	model = typeAssistantText(t, model, "what is")
	updated, _ = model.Update(events.DaemonEventMsg{Event: relaybaseclient.DaemonEvent{Type: "heartbeat"}})
	model = updated.(RootModel)
	if model.CommandInput() != "what is" || !model.commandActive {
		t.Fatalf("event update should not disturb input, active=%v input=%q", model.commandActive, model.CommandInput())
	}

	model = typeAssistantText(t, model, " broken?")
	updated, cmd := model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd != nil || model.commandActive {
		t.Fatalf("submit after event should stay local and reset input, cmd=%v active=%v", cmd, model.commandActive)
	}

	updated, _ = model.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	model = updated.(RootModel)
	updated, _ = model.Update(tea.MouseWheelMsg{X: 4, Y: 0, Button: tea.MouseWheelDown})
	model = updated.(RootModel)
	if model.bodyScrollOffset != 0 {
		t.Fatalf("background wheel should not move the fixed operator shell, offset=%d", model.bodyScrollOffset)
	}

	model = typeAssistantText(t, model, "show diagnostics")
	updated, _ = model.Update(tea.WindowSizeMsg{Width: 90, Height: 24})
	model = updated.(RootModel)
	if model.CommandInput() != "show diagnostics" || !model.commandActive {
		t.Fatalf("resize should preserve input, active=%v input=%q", model.commandActive, model.CommandInput())
	}
	model.applyTheme("dark")
	if model.CommandInput() != "show diagnostics" || !model.commandActive {
		t.Fatalf("theme switch should preserve input, active=%v input=%q", model.commandActive, model.CommandInput())
	}
	rendered := model.Render()
	if !strings.Contains(rendered, "show diagnostics") {
		t.Fatalf("bottom assistant bar should remain visible while body is scrolled:\n%s", rendered)
	}
}

func TestAssistantLongInputUsesTheBoundedMultilineComposer(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	model := updated.(RootModel)
	longInput := "ask " + strings.Repeat("x", 240)
	model = typeAssistantText(t, model, longInput)
	rendered := model.Render()
	if model.CommandInput() != longInput || model.composer.Rows() != 3 {
		t.Fatalf("expected preserved input in three-row composer, rows=%d input=%q", model.composer.Rows(), model.CommandInput())
	}
	if got := lipgloss.Height(rendered); got != 24 || !strings.Contains(rendered, "Composer") {
		t.Fatalf("expected fixed operator shell with composer, rows=%d:\n%s", got, rendered)
	}
}

func TestPendingConfirmationBlocksBackgroundAssistantTextInput(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	pending, cmd := root.submitAssistantInput("stop the backend")
	if cmd != nil || !pending.PendingConfirmation() {
		t.Fatalf("expected pending confirmation, cmd=%v pending=%v", cmd, pending.PendingConfirmation())
	}

	updated, cmd := pending.Update(keyPress("x"))
	model := updated.(RootModel)
	if cmd != nil || model.commandActive || model.CommandInput() != "" {
		t.Fatalf("modal should consume background typing, cmd=%v active=%v input=%q", cmd, model.commandActive, model.CommandInput())
	}
	if !model.PendingConfirmation() {
		t.Fatal("expected original confirmation to remain pending")
	}
}

func TestPendingApprovalBlocksNewDestructiveAssistantPhrase(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	pending, cmd := root.submitAssistantInput("stop the backend")
	if cmd != nil || !pending.PendingConfirmation() {
		t.Fatalf("expected initial pending confirmation, cmd=%v pending=%v", cmd, pending.PendingConfirmation())
	}

	updated, cmd := pending.Update(keyPress("r"))
	model := updated.(RootModel)
	if cmd != nil {
		t.Fatalf("destructive phrase while pending should not return command: %v", cmd)
	}
	if !model.PendingConfirmation() {
		t.Fatal("expected original pending confirmation to remain")
	}
	if model.pendingConfirm.Command.Kind != slash.KindStop {
		t.Fatalf("expected original stop confirmation to remain, got %#v", model.pendingConfirm.Command)
	}
	if model.commandActive || model.CommandInput() != "" {
		t.Fatalf("modal should consume destructive background typing, active=%v input=%q", model.commandActive, model.CommandInput())
	}
}

func TestPendingAgentApprovalBlocksBackgroundAssistantTextInput(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	root.applyAgentRunEvent(agentSimpleApprovalEvent("approval-typing", "stop_app"))
	if root.pendingAgentApproval == nil {
		t.Fatal("expected pending agent approval")
	}

	updated, cmd := root.Update(keyPress("x"))
	model := updated.(RootModel)
	if cmd != nil || model.commandActive || model.CommandInput() != "" {
		t.Fatalf("approval modal should consume background typing, cmd=%v active=%v input=%q", cmd, model.commandActive, model.CommandInput())
	}
	if model.pendingAgentApproval == nil {
		t.Fatal("expected original agent approval to remain pending")
	}
}

func TestCtrlZOpensContextMenu(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(ctrlKey("z"))
	model := updated.(RootModel)

	if !model.ContextMenuOpen() {
		t.Fatal("expected Ctrl+Z to open context menu")
	}
}

func TestCtrlOFallbackOpensContextMenu(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(ctrlKey("o"))
	model := updated.(RootModel)

	if !model.ContextMenuOpen() {
		t.Fatal("expected Ctrl+O fallback to open context menu")
	}
}

func TestPaneMenuNavigationInModel(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(ctrlKey("o"))
	model := updated.(RootModel)
	updated, _ = model.Update(keyPress("down"))
	model = updated.(RootModel)

	if item := model.contextMenu.SelectedItem(); item == nil || item.Action != contextmenu.ActionPanePinToggle {
		t.Fatalf("expected pin action after menu navigation, got %#v", item)
	}
}

func TestAssistantMenuNavigationInModel(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.KeyPressMsg{Text: "/", Code: '/'})
	model := updated.(RootModel)
	updated, _ = model.Update(ctrlKey("o"))
	model = updated.(RootModel)
	updated, _ = model.Update(keyPress("down"))
	model = updated.(RootModel)

	if item := model.contextMenu.SelectedItem(); item == nil || item.Action != contextmenu.ActionAssistantNewThread {
		t.Fatalf("expected assistant menu new thread action, got %#v", item)
	}
}

func TestMenuActionUpdatesPanePreferences(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(ctrlKey("o"))
	model := updated.(RootModel)
	updated, _ = model.Update(keyPress("down"))
	model = updated.(RootModel)
	updated, cmd := model.Update(keyPress("enter"))
	model = updated.(RootModel)

	if cmd == nil {
		t.Fatal("expected preference save command")
	}
	if pinned := model.preferenceSnapshot().Panes.Pinned; len(pinned) != 1 {
		t.Fatalf("expected pinned pane in preference snapshot, got %#v", pinned)
	}
}

func TestPaneMenuDisabledRouteExplainsWhy(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(ctrlKey("o"))
	model := updated.(RootModel)
	selectMenuAction(t, &model, contextmenu.ActionPaneCopyRoute)

	updated, cmd := model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd != nil {
		t.Fatal("disabled route action should not return a command")
	}
	history := strings.Join(model.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Show route is unavailable: selected pane has no route.") {
		t.Fatalf("expected route unavailable reason, got %#v", history)
	}
}

func TestPaneMenuShowsRouteWhenAvailable(t *testing.T) {
	root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{
		Components: []relaybaseclient.AppComponent{{
			AppID:       "notes-web",
			GroupID:     "notes",
			Role:        "frontend",
			PaneLabel:   "frontend",
			DisplayName: "Notes",
			Status:      "running",
			Route:       relaybaseclient.RouteInfo{HumanURL: "http://notes.localhost:7777", Reachable: true},
		}},
	})
	root.openContextMenu()
	selectMenuAction(t, &root, contextmenu.ActionPaneCopyRoute)

	cmd := root.executeContextMenuSelection()
	if cmd != nil {
		t.Fatal("show route should not call the daemon")
	}
	history := strings.Join(root.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Route: http://notes.localhost:7777") {
		t.Fatalf("expected route to be shown from pane state, got %#v", history)
	}
}

func TestPaneMenuDaemonActionsDisabledWhileOffline(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.connectionStatus = "offline"
	root.openContextMenu()

	for _, action := range []string{contextmenu.ActionPaneExportLogs, contextmenu.ActionPaneStop, contextmenu.ActionPaneRestart} {
		item := findMenuItem(t, root.contextMenu, action)
		if item.Enabled {
			t.Fatalf("expected %s to be disabled while daemon is offline", action)
		}
		if item.DisabledReason != "daemon is offline" {
			t.Fatalf("expected daemon offline reason for %s, got %#v", action, item)
		}
	}

	selectMenuAction(t, &root, contextmenu.ActionPaneStop)
	cmd := root.executeContextMenuSelection()
	if cmd != nil || root.PendingConfirmation() {
		t.Fatalf("offline stop menu must not create daemon command or confirmation, cmd=%v pending=%v", cmd, root.PendingConfirmation())
	}
	history := strings.Join(root.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Stop app/component is unavailable: daemon is offline.") {
		t.Fatalf("expected offline menu diagnostic, got %#v", history)
	}
}

func TestPaneMenuReopensAvailablePane(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.paneManager.CloseSelected()
	if root.paneManager.SelectedPane() != nil {
		t.Fatal("expected selected pane to be hidden after close")
	}
	if !root.paneManager.CanReopen() {
		t.Fatal("expected hidden pane to be reopenable")
	}

	root.openContextMenu()
	item := findMenuItem(t, root.contextMenu, contextmenu.ActionPaneReopen)
	if !item.Enabled {
		t.Fatalf("expected reopen to be enabled when hidden pane exists: %#v", item)
	}
	selectMenuAction(t, &root, contextmenu.ActionPaneReopen)
	cmd := root.executeContextMenuSelection()
	if cmd == nil {
		t.Fatal("expected preference save command after reopening pane")
	}
	if panes := root.PaneManager().VisiblePanes(); len(panes) != 1 {
		t.Fatalf("expected one reopened pane, got %#v", panes)
	}
	history := strings.Join(root.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Reopened pane.") {
		t.Fatalf("expected reopen message, got %#v", history)
	}
}

func TestPaneMenuDiagnosticsShowsDetails(t *testing.T) {
	root := newTestModel(t)
	root.addDiagnostic("route_failed", "warning", "Route health failed")
	root.contextMenu = contextmenu.PaneMenu(nil)
	selectMenuAction(t, &root, contextmenu.ActionPaneDiagnostics)

	cmd := root.executeContextMenuSelection()
	if cmd != nil {
		t.Fatal("diagnostics menu should not return a command")
	}
	history := strings.Join(root.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Diagnostics:") ||
		!strings.Contains(history, "route_failed") ||
		!strings.Contains(history, "Route health failed") {
		t.Fatalf("expected diagnostics details in assistant history, got %#v", history)
	}
}

func TestAssistantMenuChatExportUnavailableExplainsWhy(t *testing.T) {
	root := newTestModel(t)
	root.contextMenu = contextmenu.AssistantMenu()
	selectMenuAction(t, &root, contextmenu.ActionAssistantExportChat)

	cmd := root.executeContextMenuSelection()
	if cmd != nil {
		t.Fatal("disabled chat export should not return a command")
	}
	history := strings.Join(root.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Export chat is unavailable: no daemon-backed active thread.") {
		t.Fatalf("expected chat export unavailable reason, got %#v", history)
	}
}

func TestSlashCommandConfirmationGate(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, cmd := root.submitSlashCommand("/stop current")

	if cmd != nil {
		t.Fatal("expected stop command to wait for confirmation")
	}
	if !updated.PendingConfirmation() {
		t.Fatal("expected pending confirmation")
	}
	if !strings.Contains(updated.Render(), "Confirm Action") {
		t.Fatal("expected confirmation preview to render")
	}
}

func TestSlashDestructiveCommandsRequireConfirmationBeforeDaemonCall(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	tests := []string{
		"/launch current",
		"/stop current",
		"/restart current",
		"/logs export pane",
	}
	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			called = false
			cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
			root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
			root = applyTestPanes(root, 1)

			updated, cmd := root.submitSlashCommand(input)
			if cmd != nil {
				t.Fatalf("%s returned command before confirmation", input)
			}
			if called {
				t.Fatalf("%s called daemon before confirmation", input)
			}
			if !updated.PendingConfirmation() {
				t.Fatalf("%s did not create confirmation preview", input)
			}
		})
	}
}

func TestDaemonRepairUsesBootstrapBridgeAfterConfirmation(t *testing.T) {
	var requestedPath string
	var authHeader string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.RequestURI()
		authHeader = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"daemon":{"reachable":true,"started":true,"code":"daemon_started","userAction":"Relaybase daemon started and is reachable."}}`))
	}))
	defer server.Close()

	cfg := config.Config{
		BaseURL:        "http://127.0.0.1:7777",
		StateDir:       t.TempDir(),
		Token:          "test-token",
		ThemeMode:      "auto",
		BootstrapURL:   server.URL,
		BootstrapToken: "bootstrap-token",
	}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, nil))

	pending, cmd := root.submitSlashCommand("/daemon repair")
	if cmd != nil || !pending.PendingConfirmation() {
		t.Fatalf("expected pending daemon repair confirmation, cmd=%v pending=%v", cmd, pending.PendingConfirmation())
	}
	if requestedPath != "" {
		t.Fatalf("daemon repair called bridge before confirmation: %s", requestedPath)
	}

	confirmed, cmd := pending.submitSlashCommand("/confirm")
	if cmd == nil {
		t.Fatal("expected confirmed daemon repair to return bootstrap command")
	}
	if confirmed.PendingConfirmation() {
		t.Fatal("expected daemon repair confirmation to clear")
	}
	msg := cmd()
	if requestedPath != "/daemon/ensure" {
		t.Fatalf("expected bridge ensure endpoint, got %s", requestedPath)
	}
	if authHeader != "Bearer bootstrap-token" {
		t.Fatalf("expected bootstrap token auth, got %q", authHeader)
	}
	result, ok := msg.(commands.DaemonBootstrapEnsureMsg)
	if !ok || result.Result == nil || !result.Result.Reachable || result.Result.Code != "daemon_started" {
		t.Fatalf("unexpected daemon bootstrap message: %#v", msg)
	}
}

func TestDaemonBootstrapSuccessClearsStaleRecoveryDiagnostics(t *testing.T) {
	root := newTestModel(t)
	root.addDiagnostic(daemonUnavailableDiagnosticCode, "error", "daemon offline")
	root.addDiagnostic(eventDisconnectedDiagnosticCode, "warning", "events offline")
	root.addDiagnostic(authTokenInvalidDiagnosticCode, "warning", "token rejected")
	root.addDiagnostic("daemon_bootstrap_daemon_not_running", "error", "bridge could not start")

	updated, _ := root.Update(commands.DaemonBootstrapEnsureMsg{Result: &bootstrap.DaemonResult{
		Reachable:  true,
		Started:    true,
		Code:       "daemon_started",
		UserAction: "Relaybase daemon started and is reachable.",
	}})
	model := updated.(RootModel)

	if model.ConnectionStatus() != "connecting" || model.EventStatus() != "checking" {
		t.Fatalf("expected bootstrap success to recheck daemon/event state, daemon=%s events=%s", model.ConnectionStatus(), model.EventStatus())
	}
	for _, code := range []string{
		daemonUnavailableDiagnosticCode,
		eventDisconnectedDiagnosticCode,
		authTokenInvalidDiagnosticCode,
		"daemon_bootstrap_daemon_not_running",
	} {
		if hasDiagnostic(model.Diagnostics(), code) {
			t.Fatalf("expected bootstrap success to clear %s, diagnostics=%#v", code, model.Diagnostics())
		}
	}
	if !hasDiagnostic(model.Diagnostics(), "daemon_bootstrap_ready") {
		t.Fatalf("expected bootstrap-ready diagnostic, got %#v", model.Diagnostics())
	}
}

func TestDirectLaunchDaemonCommandsGiveSafeRecoveryInstructions(t *testing.T) {
	cfg := config.Config{
		BaseURL:   "http://127.0.0.1:8765",
		StateDir:  "C:/Relaybase State",
		Token:     "test-token",
		ThemeMode: "auto",
	}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, nil))

	updated, cmd := root.submitSlashCommand("/daemon status")
	model := updated
	if cmd != nil {
		t.Fatal("direct TUI daemon status should stay local")
	}
	history := strings.Join(model.assistantHistoryForView(), "\n")
	for _, want := range []string{
		"direct TUI launch",
		"relaybase tui",
		"relaybase serve",
		"--port 8765",
		`--state-dir "C:/Relaybase State"`,
		"/daemon retry",
	} {
		if !strings.Contains(history, want) {
			t.Fatalf("expected daemon status guidance to contain %q, got %#v", want, history)
		}
	}

	updated, cmd = model.submitSlashCommand("/daemon repair")
	model = updated
	if cmd != nil || model.PendingConfirmation() {
		t.Fatalf("direct TUI daemon repair should not start or confirm bridge work, cmd=%v pending=%v", cmd, model.PendingConfirmation())
	}
	history = strings.Join(model.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Daemon repair through the local launch bridge is unavailable") {
		t.Fatalf("expected no-bridge repair diagnostic, got %#v", history)
	}
	if strings.Contains(history, "started by bridge") {
		t.Fatalf("direct launch must not claim daemon was started, got %#v", history)
	}
}

func TestSlashConfirmAndCancelWorkFromPendingInput(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	pending, cmd := root.submitSlashCommand("/stop current")
	if cmd != nil || !pending.PendingConfirmation() {
		t.Fatalf("expected pending stop confirmation, cmd=%v pending=%v", cmd, pending.PendingConfirmation())
	}

	updated, cmd := pending.Update(keyPress("esc"))
	cancelled := updated.(RootModel)
	if cmd != nil {
		t.Fatal("/cancel should not return a daemon command")
	}
	if cancelled.PendingConfirmation() {
		t.Fatal("/cancel should clear pending confirmation")
	}
	if history := strings.Join(cancelled.assistantHistoryForView(), "\n"); !strings.Contains(history, "Confirmation cancelled.") {
		t.Fatalf("expected cancellation message, got %#v", history)
	}

	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op-slash-confirm"}`))
	}))
	defer server.Close()
	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root = NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyTestPanes(root, 1)
	pending, cmd = root.submitSlashCommand("/stop current")
	if cmd != nil || !pending.PendingConfirmation() {
		t.Fatalf("expected pending stop confirmation, cmd=%v pending=%v", cmd, pending.PendingConfirmation())
	}

	updated, cmd = pending.Update(keyPress("enter"))
	confirmed := updated.(RootModel)
	if cmd == nil {
		t.Fatal("/confirm should return confirmed daemon command")
	}
	if confirmed.PendingConfirmation() {
		t.Fatal("/confirm should clear pending confirmation")
	}
	if requestedPath != "" {
		t.Fatalf("daemon was called before executing returned command: %s", requestedPath)
	}
	msg := cmd()
	if requestedPath != "/__hub/api/apps/app-1-web/stop?async=true" {
		t.Fatalf("unexpected daemon request path after /confirm: %s", requestedPath)
	}
	if lifecycle, ok := msg.(commands.LifecycleRequestedMsg); !ok || lifecycle.OperationID != "op-slash-confirm" {
		t.Fatalf("unexpected lifecycle message after /confirm: %#v", msg)
	}
}

func TestSlashConfirmedExportCallsDaemonOnlyAfterConfirm(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"export":{"exportId":"export-1","status":"completed","format":"log","outputPath":"redacted.log"}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyTestPanes(root, 1)

	pending, cmd := root.submitSlashCommand("/logs export pane")
	if cmd != nil || !pending.PendingConfirmation() {
		t.Fatalf("expected pending export confirmation, cmd=%v pending=%v", cmd, pending.PendingConfirmation())
	}
	if requestedPath != "" {
		t.Fatalf("daemon was called before export confirmation: %s", requestedPath)
	}

	confirmed, cmd := pending.submitSlashCommand("/confirm")
	if cmd == nil {
		t.Fatal("expected /confirm to create export command")
	}
	if confirmed.PendingConfirmation() {
		t.Fatal("expected export confirmation to clear")
	}
	msg := cmd()
	if requestedPath != "/__hub/api/logs/export" {
		t.Fatalf("unexpected export request path: %s", requestedPath)
	}
	if exported, ok := msg.(commands.LogsExportedMsg); !ok || exported.Result == nil || exported.Result.ExportID != "export-1" {
		t.Fatalf("unexpected export message: %#v", msg)
	}
}

func TestSlashNonDestructiveCommandsDoNotRequireConfirmation(t *testing.T) {
	root := newTestModelWithPanes(t, 9)
	for _, input := range []string{
		"/page next",
		"/theme dark",
		"/pane color current blue",
		"/pin current",
		"/unpin current",
		"/help",
		"/confirm",
		"/cancel",
	} {
		t.Run(input, func(t *testing.T) {
			updated, _ := root.submitSlashCommand(input)
			if updated.PendingConfirmation() {
				t.Fatalf("%s should not require confirmation", input)
			}
		})
	}
}

func TestSlashUnknownTargetMessageIsActionable(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	updated, cmd := root.submitSlashCommand("/stop missing")
	if cmd != nil {
		t.Fatal("unknown target should not create command")
	}
	if updated.PendingConfirmation() {
		t.Fatal("unknown target should not create confirmation")
	}
	history := strings.Join(updated.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Unknown target \"missing\"") || !strings.Contains(history, "exact app id") {
		t.Fatalf("expected actionable unknown-target message, got %#v", history)
	}
}

func TestNaturalLaunchCreatesActionPreviewWithoutNetwork(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyState(root, notesFrontendBackendState())

	updated, cmd := root.submitAssistantInput("launch notes")
	if cmd != nil {
		t.Fatal("expected launch notes to wait for confirmation")
	}
	if called {
		t.Fatal("natural preview should not call the daemon")
	}
	if !updated.PendingConfirmation() {
		t.Fatal("expected pending confirmation")
	}
	history := updated.NaturalAssistantHistory()
	if len(history) == 0 || history[len(history)-1].Type != "action_preview" {
		t.Fatalf("expected action preview history, got %#v", history)
	}
}

func TestNaturalDestructivePhrasesRequireConfirmation(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	tests := []string{
		"launch notes",
		"start notes frontend",
		"run the backend",
		"stop the backend",
		"shut down notes",
		"restart api",
		"reboot api",
		"reload api",
		"restrt api",
		"export logs for notes",
	}

	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			updated, cmd := root.submitAssistantInput(input)
			if cmd != nil {
				t.Fatalf("%q returned command before confirmation", input)
			}
			if !updated.PendingConfirmation() {
				t.Fatalf("%q should create confirmation preview", input)
			}
		})
	}
}

func TestDeterministicPhrasesStayLocalWhenAgentGatewayEnabled(t *testing.T) {
	agentRequests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		agentRequests = append(agentRequests, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyState(root, notesFrontendBackendState())
	root.agentConfig = enabledAgentConfig(true)
	root.agentSession = &relaybaseclient.AgentSession{ID: "session-1"}
	root.agentStream = &relaybaseclient.AgentEventStream{}

	for _, test := range []struct {
		input       string
		wantPending bool
	}{
		{input: "what is broken?"},
		{input: "show diagnostics"},
		{input: "help"},
		{input: "launch notes", wantPending: true},
		{input: "stop the backend", wantPending: true},
		{input: "export logs for notes", wantPending: true},
	} {
		t.Run(test.input, func(t *testing.T) {
			agentRequests = nil
			updated, cmd := root.submitAssistantInput(test.input)
			if cmd != nil {
				t.Fatalf("%q should not send an agent/daemon command before local handling, got %v", test.input, cmd)
			}
			if len(agentRequests) != 0 {
				t.Fatalf("%q unexpectedly called Agent Gateway: %#v", test.input, agentRequests)
			}
			if updated.PendingConfirmation() != test.wantPending {
				t.Fatalf("%q pending=%v, want %v", test.input, updated.PendingConfirmation(), test.wantPending)
			}
		})
	}
}

func TestPathRichNaturalPhraseRoutesToAgentGatewayWhenEnabled(t *testing.T) {
	var requestBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/agent/sessions/session-1/messages" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		requestBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"message":{"id":"message-1","sessionId":"session-1","role":"user","content":"ok","createdAt":"2026-06-02T00:00:00Z"},"run":{"id":"run-1","sessionId":"session-1","status":"completed","provider":"openrouter","events":[]},"diagnostics":[]}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)
	root.agentSession = &relaybaseclient.AgentSession{ID: "session-1"}
	root.agentStream = &relaybaseclient.AgentEventStream{}

	updated, cmd := root.submitAssistantInput(`start the server in C:\Users\wamin\Desktop\development\ratemygithub>`)
	model := updated
	if cmd == nil {
		t.Fatal("expected path-rich phrase to send Agent Gateway message")
	}
	msg := cmd()
	updatedModel, _ := model.Update(msg)
	model = updatedModel.(RootModel)

	if !strings.Contains(requestBody, `"content":"start the server in C:\\Users\\wamin\\Desktop\\development\\ratemygithub"`) {
		t.Fatalf("expected normalized folder startup message, got %s", requestBody)
	}
	if strings.Contains(requestBody, `ratemygithub>`) {
		t.Fatalf("expected trailing prompt marker to be stripped, got %s", requestBody)
	}
	if model.PendingConfirmation() {
		t.Fatal("path-rich phrase should not create local lifecycle confirmation")
	}
}

func TestExplicitAgentManagedSlashSerializesOnlyCanonicalAuthorizedProjectRoot(t *testing.T) {
	projectRoot := t.TempDir()
	canonicalRoot, err := filepath.EvalSymlinks(projectRoot)
	if err != nil {
		canonicalRoot = filepath.Clean(projectRoot)
	}
	cfg := config.Config{
		BaseURL:          "http://127.0.0.1:7777",
		StateDir:         t.TempDir(),
		Token:            "test-token",
		ThemeMode:        "auto",
		CurrentDirectory: filepath.Dir(projectRoot),
	}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, nil))
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)
	root.agentSession = &relaybaseclient.AgentSession{ID: "session-1"}
	root.agentStream = &relaybaseclient.AgentEventStream{}

	for _, command := range []string{"/add", "/configure"} {
		updated, cmd := root.submitSlashCommand(command + ` "` + projectRoot + `"`)
		if cmd == nil {
			t.Fatalf("expected explicit %s path to use Agent Gateway", command)
		}
		payload, err := json.Marshal(updated.agentContext())
		if err != nil {
			t.Fatalf("marshal %s agent context: %v", command, err)
		}
		var contextPayload relaybaseclient.TuiAgentContext
		if err := json.Unmarshal(payload, &contextPayload); err != nil {
			t.Fatalf("unmarshal %s agent context: %v", command, err)
		}
		if len(contextPayload.AuthorizedProjectRoots) != 1 || !strings.EqualFold(contextPayload.AuthorizedProjectRoots[0], canonicalRoot) {
			t.Fatalf("%s authorized roots=%#v, want only %q", command, contextPayload.AuthorizedProjectRoots, canonicalRoot)
		}
	}

	registered, registerCmd := root.submitSlashCommand(`/register "` + projectRoot + `"`)
	if registerCmd == nil {
		t.Fatal("expected /register to use the deterministic daemon preview")
	}
	if roots := registered.agentContext().AuthorizedProjectRoots; len(roots) != 0 {
		t.Fatalf("deterministic /register unexpectedly authorized Agent roots: %#v", roots)
	}

	plain, _ := root.submitAgentInput("inspect arbitrary model text mentioning " + projectRoot)
	if roots := plain.agentContext().AuthorizedProjectRoots; len(roots) != 0 {
		t.Fatalf("arbitrary model text authorized project roots: %#v", roots)
	}
}

func TestRegistrationPreviewNamesQuickLifecycleAndNoVerifyOptOut(t *testing.T) {
	for _, test := range []struct {
		name             string
		command          string
		verificationMode string
		willStart        bool
	}{
		{name: "quick", command: "/register C:/project", verificationMode: "quick", willStart: true},
		{name: "no verify", command: "/register C:/project --no-verify", verificationMode: "none", willStart: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requestBody string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				requestBody = string(body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(fmt.Sprintf(`{"setup":{"schemaVersion":1,"status":"approval_required","message":"Ready","projectRoot":"C:/project","manifestPath":"C:/project/relaybase.app.json","manifestState":"valid","previewId":"preview-1","app":{"id":"notes","name":"Notes"},"verificationIntent":{"mode":%q,"willStart":%t,"willStop":%t,"expectedMaximumMs":12000,"healthCandidates":["/api/ping"]},"approval":{"required":true,"previewId":"preview-1"},"registered":false,"started":false,"filesWritten":false,"retrySafe":true}}`, test.verificationMode, test.willStart, test.willStart)))
			}))
			defer server.Close()

			cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto", CurrentDirectory: "C:/project"}
			root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
			updated, cmd := root.submitSlashCommand(test.command)
			if cmd == nil {
				t.Fatal("expected registration preview command")
			}
			msg := cmd()
			updatedModel, _ := updated.Update(msg)
			model := updatedModel.(RootModel)
			if !strings.Contains(requestBody, `"verificationMode":"`+test.verificationMode+`"`) {
				t.Fatalf("unexpected registration preview body: %s", requestBody)
			}
			confirmation := model.confirmationForView()
			if confirmation == nil {
				t.Fatal("expected registration confirmation")
			}
			if test.willStart && !strings.Contains(confirmation.Risk, "starts the app once") {
				t.Fatalf("quick confirmation did not name lifecycle work: %#v", confirmation)
			}
			if !test.willStart && !strings.Contains(confirmation.ExpectedResult, "unverified") {
				t.Fatalf("no-verify confirmation did not name unverified result: %#v", confirmation)
			}
		})
	}
}

func TestAddPathFallsBackToDeterministicDaemonPreviewWhenAgentUnavailable(t *testing.T) {
	configs := []struct {
		name   string
		config *relaybaseclient.AgentConfig
	}{
		{name: "disabled", config: &relaybaseclient.AgentConfig{Enabled: false}},
		{name: "unconfigured", config: enabledAgentConfig(false)},
	}
	for _, test := range configs {
		t.Run(test.name, func(t *testing.T) {
			var requestedPath string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestedPath = r.URL.Path
				if requestedPath != "/__hub/api/setup/preview" {
					t.Fatalf("unexpected fallback path: %s", requestedPath)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","selectedPlan":{"id":"managed","choice":{"id":"managed"}},"fileWritePlan":{"root":"C:/project","approvalRequired":true,"writes":[]},"diagnostics":[]}}`))
			}))
			defer server.Close()

			cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto", CurrentDirectory: "C:/"}
			root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
			root.connectionStatus = "connected"
			root.agentConfig = test.config

			updated, cmd := root.submitSlashCommand("/add C:/project")
			if cmd == nil {
				t.Fatal("expected deterministic setup preview command")
			}
			if updated.PendingConfirmation() {
				t.Fatal("read-only deterministic preview should not require mutation confirmation")
			}
			if history := strings.Join(updated.assistantHistoryForView(), "\n"); !strings.Contains(history, "deterministic daemon setup preview") {
				t.Fatalf("missing deterministic fallback status: %s", history)
			}
			message := cmd()
			if _, ok := message.(commands.SetupPreviewCompletedMsg); !ok {
				t.Fatalf("fallback returned %T, want SetupPreviewCompletedMsg", message)
			}
			result, _ := updated.Update(message)
			model := result.(RootModel)
			if requestedPath != "/__hub/api/setup/preview" || model.setupSession.Preview == nil {
				t.Fatalf("deterministic preview did not populate setup state: path=%s state=%#v", requestedPath, model.setupSession)
			}
		})
	}
}

func TestAgentReconnectStatusIsVisibleAndClearsOnReplay(t *testing.T) {
	root := newTestModel(t)
	stream := &relaybaseclient.AgentEventStream{}
	root.agentSession = &relaybaseclient.AgentSession{ID: "session-1"}
	root.agentStream = stream
	root.agentStreamSessionID = "session-1"
	root.agentStreamGeneration = 1
	reconnecting := rawAgentEvent("stream.reconnecting", `{"afterSequence":7,"attempt":2}`)
	updated, _ := root.Update(commands.AgentEventMsg{Stream: stream, Event: reconnecting, SessionID: "session-1", Generation: 1})
	model := updated.(RootModel)
	if model.agentStatus != "reconnecting" || !hasDiagnostic(model.Diagnostics(), agentEventDisconnectedCode) {
		t.Fatalf("reconnect status not visible: status=%s diagnostics=%#v", model.agentStatus, model.Diagnostics())
	}

	replayed := rawAgentEvent("answer", `{"content":"reconnected"}`)
	updated, _ = model.Update(commands.AgentEventMsg{Stream: stream, Event: replayed, SessionID: "session-1", Generation: 1})
	model = updated.(RootModel)
	if model.agentStatus != "streaming" || hasDiagnostic(model.Diagnostics(), agentEventDisconnectedCode) {
		t.Fatalf("reconnect status did not clear: status=%s diagnostics=%#v", model.agentStatus, model.Diagnostics())
	}
}

func TestPathRichNaturalPhraseDoesNotResolveAsLifecycleTarget(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	root.connectionStatus = "connected"
	root.agentConfig = &relaybaseclient.AgentConfig{Enabled: false}

	updated, cmd := root.submitAssistantInput(`start the server in C:\Users\wamin\Desktop\development\ratemygithub`)
	if cmd != nil {
		t.Fatal("disabled Agent Gateway should not send command")
	}
	if updated.PendingConfirmation() {
		t.Fatal("folder startup phrase should not create local app lifecycle confirmation")
	}
	history := strings.Join(updated.assistantHistoryForView(), "\n")
	if strings.Contains(history, "Unknown target") || strings.Contains(history, "Unknown app") {
		t.Fatalf("folder startup phrase was treated as lifecycle target: %s", history)
	}
	if !strings.Contains(history, `Slash fallback: /configure C:\Users\wamin\Desktop\development\ratemygithub --dry-run`) {
		t.Fatalf("expected actionable slash fallback, got %s", history)
	}
}

func TestPathRichNaturalPhraseDisabledAgentGivesActionableFallback(t *testing.T) {
	root := newTestModel(t)
	root.connectionStatus = "connected"
	root.agentConfig = &relaybaseclient.AgentConfig{Enabled: false}

	updated, cmd := root.submitAssistantInput(`add "C:\Users\wamin\Desktop\development\My App" using npm run dev`)
	if cmd != nil {
		t.Fatal("disabled Agent Gateway should not send command")
	}
	history := strings.Join(updated.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Operator Agent is disabled") ||
		!strings.Contains(history, `Slash fallback: /add "C:\Users\wamin\Desktop\development\My App" using npm run dev`) ||
		!strings.Contains(history, "relaybase serve") {
		t.Fatalf("expected disabled-agent fallback with slash and daemon command, got %s", history)
	}
}

func TestPathRichNaturalPhraseOfflineDaemonGivesStartCommandAndFallback(t *testing.T) {
	root := newTestModel(t)
	root.connectionStatus = "offline"
	root.agentConfig = enabledAgentConfig(true)

	updated, cmd := root.submitAssistantInput(`start project .\apps\notes`)
	if cmd != nil {
		t.Fatal("offline daemon should not send Agent Gateway command")
	}
	history := strings.Join(updated.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Relaybase daemon is unavailable") ||
		!strings.Contains(history, "relaybase serve") ||
		!strings.Contains(history, `Slash fallback: /configure .\apps\notes --dry-run`) {
		t.Fatalf("expected daemon start command and setup slash fallback, got %s", history)
	}
}

func TestPathRichNaturalPhraseCanSubmitRepeatedMessages(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/agent/sessions/session-1/messages" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		requests = append(requests, string(body))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"message":{"id":"message-1","sessionId":"session-1","role":"user","content":"ok","createdAt":"2026-06-02T00:00:00Z"},"run":{"id":"run-1","sessionId":"session-1","status":"completed","provider":"openrouter","events":[]},"diagnostics":[]}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)
	root.agentSession = &relaybaseclient.AgentSession{ID: "session-1"}
	root.agentStream = &relaybaseclient.AgentEventStream{}

	for _, input := range []string{
		`start the server in C:\Users\wamin\Desktop\development\ratemygithub>`,
		`use npm run dev in .\apps\notes`,
	} {
		updated, cmd := root.submitAssistantInput(input)
		if cmd == nil {
			t.Fatalf("expected Agent Gateway command for %q", input)
		}
		msg := cmd()
		updatedModel, _ := updated.Update(msg)
		root = updatedModel.(RootModel)
	}

	if len(requests) != 2 {
		t.Fatalf("expected two Agent Gateway requests, got %d: %#v", len(requests), requests)
	}
	if !strings.Contains(requests[0], `ratemygithub`) || strings.Contains(requests[0], `ratemygithub>`) ||
		!strings.Contains(requests[1], `"content":"add .\\apps\\notes using npm run dev"`) {
		t.Fatalf("unexpected request bodies: %#v", requests)
	}
}

func TestNaturalStopBackendAsksClarificationWhenAmbiguous(t *testing.T) {
	root := newTestModel(t)
	root.state = &relaybaseclient.RelaybaseState{
		Components: []relaybaseclient.AppComponent{
			{AppID: "notes-api", GroupID: "notes", Role: "backend", Status: "running"},
			{AppID: "shop-api", GroupID: "shop", Role: "backend", Status: "running"},
		},
	}

	updated, cmd := root.submitAssistantInput("stop backend")
	if cmd != nil {
		t.Fatal("expected ambiguous stop to avoid daemon command")
	}
	if updated.PendingConfirmation() {
		t.Fatal("did not expect confirmation for ambiguous target")
	}
	history := updated.NaturalAssistantHistory()
	if len(history) == 0 || history[len(history)-1].Type != "clarification_needed" {
		t.Fatalf("expected clarification history, got %#v", history)
	}
	if !strings.Contains(history[len(history)-1].Message, "Select a pane") || !strings.Contains(history[len(history)-1].Message, "Options:") {
		t.Fatalf("expected actionable ambiguity message, got %#v", history[len(history)-1])
	}
}

func TestNaturalStopBackendResolvesSelectedGroup(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())

	updated, cmd := root.submitAssistantInput("stop backend")
	if cmd != nil {
		t.Fatal("expected stop backend to wait for confirmation")
	}
	if !updated.PendingConfirmation() {
		t.Fatal("expected confirmation for selected backend")
	}
	if apps := updated.pendingConfirm.Target.AppIDs; len(apps) != 1 || apps[0] != "notes-api" {
		t.Fatalf("expected notes backend app target, got %#v", updated.pendingConfirm.Target)
	}
}

func TestNaturalShowFrontendLogsDoesNotRequireConfirmation(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"appId":"notes-web","events":[{"sequence":1,"appId":"notes-web","groupId":"notes","componentRole":"frontend","stream":"stdout","message":"ready"}]}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyState(root, notesFrontendBackendState())

	updated, cmd := root.submitAssistantInput("show frontend logs")
	if cmd == nil {
		t.Fatal("expected local show-logs command to fetch pane logs")
	}
	if updated.PendingConfirmation() {
		t.Fatal("show logs should not require confirmation")
	}
	if !updated.PaneManager().Focused() {
		t.Fatal("show logs should focus the resolved pane")
	}
	msg := cmd()
	if requestedPath != "/__hub/api/apps/notes-web/logs?limit=200" {
		t.Fatalf("unexpected logs request path: %s", requestedPath)
	}
	if loaded, ok := msg.(commands.LogsLoadedMsg); !ok || loaded.Snapshot == nil || len(loaded.Snapshot.Events) != 1 {
		t.Fatalf("unexpected logs loaded message: %#v", msg)
	}
}

func TestNaturalLocalPhrasesDoNotRequireConfirmation(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	for _, input := range []string{
		"pin this pane",
		"unpin this pane",
		"change this pane to blue",
		"go to next page",
		"go to previous page",
		"show diagnostics",
		"what is broken?",
	} {
		t.Run(input, func(t *testing.T) {
			updated, _ := root.submitAssistantInput(input)
			if updated.PendingConfirmation() {
				t.Fatalf("%q should not require confirmation", input)
			}
		})
	}
}

func TestNaturalUnknownTargetMessageIsActionable(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	updated, cmd := root.submitAssistantInput("launch missing")
	if cmd != nil {
		t.Fatal("unknown natural target should not create command")
	}
	if updated.PendingConfirmation() {
		t.Fatal("unknown natural target should not create confirmation")
	}
	history := updated.NaturalAssistantHistory()
	if len(history) == 0 {
		t.Fatal("expected natural assistant history")
	}
	if !strings.Contains(history[len(history)-1].Message, "Unknown target \"missing\"") ||
		!strings.Contains(history[len(history)-1].Message, "exact app id") {
		t.Fatalf("expected actionable unknown-target message, got %#v", history[len(history)-1])
	}
}

func TestNaturalWhatIsBrokenSummarizesCurrentState(t *testing.T) {
	root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{
		Apps: []relaybaseclient.AppState{
			{ID: "api", Name: "API", RuntimeStatus: "failed", LastError: "health timeout"},
		},
		Components: []relaybaseclient.AppComponent{
			{AppID: "api", GroupID: "notes", Role: "backend", Status: "failed", LastError: "port closed"},
		},
		Diagnostics: []relaybaseclient.Diagnostic{
			{Code: "route_failed", Severity: "warning", Message: "Route health failed"},
		},
	})

	updated, cmd := root.submitAssistantInput("what is broken?")
	if cmd != nil {
		t.Fatal("expected broken summary to be local")
	}
	history := updated.NaturalAssistantHistory()
	if len(history) == 0 || !strings.Contains(history[len(history)-1].Message, "API") || !strings.Contains(history[len(history)-1].Message, "route_failed") {
		t.Fatalf("expected broken summary from state, got %#v", history)
	}
}

func TestNaturalLifecycleRequiresConfirmation(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	updated, cmd := root.submitAssistantInput("restart api")

	if cmd != nil {
		t.Fatal("expected restart to wait for confirmation")
	}
	if !updated.PendingConfirmation() {
		t.Fatal("expected pending confirmation")
	}
}

func TestNaturalExportRequiresConfirmation(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	updated, cmd := root.submitAssistantInput("export logs for notes")

	if cmd != nil {
		t.Fatal("expected export to wait for confirmation")
	}
	if !updated.PendingConfirmation() {
		t.Fatal("expected pending confirmation")
	}
	if updated.pendingConfirm.ExportRequest == nil || updated.pendingConfirm.ExportRequest.Scope != "group" {
		t.Fatalf("expected group export confirmation, got %#v", updated.pendingConfirm)
	}
}

func TestNaturalAssistantHistoryRecordsDaemonResult(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op-natural-1"}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyState(root, notesFrontendBackendState())

	updated, _ := root.submitAssistantInput("stop backend")
	model := updated
	updatedAfterConfirm, cmd := model.Update(keyPress("enter"))
	if cmd == nil {
		t.Fatal("expected confirmed daemon command")
	}
	model = updatedAfterConfirm.(RootModel)
	msg := cmd()
	updatedModel, _ := model.Update(msg)
	model = updatedModel.(RootModel)

	if requestedPath != "/__hub/api/apps/notes-api/stop?async=true" {
		t.Fatalf("unexpected daemon path: %s", requestedPath)
	}
	history := model.NaturalAssistantHistory()
	if len(history) == 0 || !strings.Contains(history[len(history)-1].Message, "op-natural-1") {
		t.Fatalf("expected operation result in natural assistant history, got %#v", history)
	}
}

func TestNaturalSecretLikeInputIsNotPersistedUnredacted(t *testing.T) {
	stateDir := t.TempDir()
	root := applyState(newTestModelInStateDir(stateDir), notesFrontendBackendState())
	updated, _ := root.submitAssistantInput("token=abc123 launch notes")
	history := updated.NaturalAssistantHistory()
	if len(history) == 0 || strings.Contains(history[len(history)-1].Input, "abc123") {
		t.Fatalf("expected redacted natural input history, got %#v", history)
	}
	if msg := updated.persistPreferencesCmd()(); !isPreferencesSavedMsg(msg) {
		t.Fatalf("expected preferences save success, got %T", msg)
	}
	preferencesJSON, err := os.ReadFile(filepath.Join(stateDir, "tui", "preferences.json"))
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}
	if strings.Contains(string(preferencesJSON), "abc123") || strings.Contains(string(preferencesJSON), "token=") {
		t.Fatalf("preference JSON leaked secret-like input: %s", preferencesJSON)
	}
}

func TestLifecycleMenuActionCallsDaemonClient(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.RequestURI()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"operationId":"op-stop-1"}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyTestPanes(root, 1)

	updated, _ := root.Update(ctrlKey("o"))
	model := updated.(RootModel)
	for index := 0; index < 6; index++ {
		updated, _ = model.Update(keyPress("down"))
		model = updated.(RootModel)
	}
	updated, cmd := model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd != nil {
		t.Fatal("expected menu stop action to wait for confirmation")
	}
	if !model.PendingConfirmation() {
		t.Fatal("expected pending confirmation")
	}

	updated, cmd = model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected confirmed lifecycle command")
	}
	msg := cmd()
	if requestedPath != "/__hub/api/apps/app-1-web/stop?async=true" {
		t.Fatalf("unexpected daemon request path: %s", requestedPath)
	}
	if lifecycle, ok := msg.(commands.LifecycleRequestedMsg); !ok || lifecycle.OperationID != "op-stop-1" {
		t.Fatalf("unexpected lifecycle message: %#v", msg)
	}
}

func TestAuthInvalidDiagnosticForEventStream(t *testing.T) {
	root := newTestModel(t)
	apiError := &relaybaseclient.APIError{
		StatusCode: http.StatusUnauthorized,
		ErrorBody:  relaybaseclient.RelaybaseError{Code: "auth_invalid", Message: "Token rejected"},
	}
	updated, _ := root.Update(events.StreamDisconnectedMsg{Err: apiError})
	model := updated.(RootModel)

	if !hasDiagnostic(model.Diagnostics(), "auth_token_invalid") {
		t.Fatalf("expected auth_token_invalid diagnostic, got %#v", model.Diagnostics())
	}
}

func TestPreferencesLoadFailureDiagnostic(t *testing.T) {
	stateDir := t.TempDir()
	blockingFile := filepath.Join(stateDir, "not-a-directory")
	if err := os.WriteFile(blockingFile, []byte("x"), 0o600); err != nil {
		t.Fatalf("write blocking file: %v", err)
	}
	cfg := config.Config{
		BaseURL:   "http://127.0.0.1:7777",
		StateDir:  blockingFile,
		Token:     "test-token",
		ThemeMode: "auto",
	}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, nil))
	if !hasDiagnostic(root.Diagnostics(), "preferences_load_failed") {
		t.Fatalf("expected preferences_load_failed diagnostic, got %#v", root.Diagnostics())
	}
}

func TestMissingLLMProviderDiagnostic(t *testing.T) {
	stateDir := t.TempDir()
	store := preferences.NewStore(stateDir)
	prefs := preferences.Default()
	prefs.Assistant.Provider = assistant.ProviderConfig{
		Mode:  assistant.ModeLocalModel,
		Model: "local-test",
	}
	if err := store.Save(prefs); err != nil {
		t.Fatalf("save preferences: %v", err)
	}

	root := newTestModelInStateDir(stateDir)
	if !hasDiagnostic(root.Diagnostics(), "assistant_provider_missing") {
		t.Fatalf("expected assistant_provider_missing diagnostic, got %#v", root.Diagnostics())
	}
	if !hasDiagnostic(root.Diagnostics(), "assistant_provider_shell_only") {
		t.Fatalf("expected shell-only diagnostic, got %#v", root.Diagnostics())
	}
}

func TestLLMModeMenuDoesNotCallRemoteEndpoint(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	stateDir := t.TempDir()
	store := preferences.NewStore(stateDir)
	prefs := preferences.Default()
	prefs.Assistant.Provider = assistant.ProviderConfig{
		Mode:          assistant.ModeRemoteModel,
		Provider:      "openai-compatible",
		Model:         "gpt-test",
		BaseURL:       server.URL,
		APIKeyRef:     "env:PROVIDER_API_KEY",
		RemoteEnabled: true,
	}
	if err := store.Save(prefs); err != nil {
		t.Fatalf("save preferences: %v", err)
	}

	root := newTestModelInStateDir(stateDir)
	updated, _ := root.Update(tea.KeyPressMsg{Text: "/", Code: '/'})
	model := updated.(RootModel)
	updated, _ = model.Update(ctrlKey("o"))
	model = updated.(RootModel)
	for index := 0; index < 6; index++ {
		updated, _ = model.Update(keyPress("down"))
		model = updated.(RootModel)
	}
	updated, cmd := model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd != nil {
		t.Fatal("LLM shell status should not start a command")
	}
	if called {
		t.Fatal("LLM shell status must not call the remote endpoint")
	}
	history := model.assistantHistoryForView()
	if len(history) == 0 || !strings.Contains(strings.Join(history, "\n"), "deterministic mode remains active") {
		t.Fatalf("expected deterministic-mode status message, got %#v", history)
	}
}

func TestLLMModeMenuReportsMissingModelAndKeyFromDaemonConfig(t *testing.T) {
	root := newTestModel(t)
	root.agentConfig = &relaybaseclient.AgentConfig{
		Enabled: true,
		Provider: relaybaseclient.AgentProviderConfig{
			Provider:           "openrouter",
			RemoteModelEnabled: false,
			APIKeySource: relaybaseclient.AgentAPIKeySource{
				Type:       "environment",
				EnvVar:     "OPENROUTER_API_KEY",
				Configured: false,
			},
		},
	}
	root.contextMenu = contextmenu.AssistantMenu(root.assistantMenuOptions())
	selectMenuAction(t, &root, contextmenu.ActionAssistantLLMMode)

	cmd := root.executeContextMenuSelection()
	if cmd != nil {
		t.Fatal("LLM status should not start a command")
	}
	history := strings.Join(root.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "model not configured") {
		t.Fatalf("expected missing model status in history, got %#v", history)
	}
	for _, code := range []string{"agent_remote_model_disabled", "agent_model_missing", "openrouter_api_key_missing"} {
		if !hasDiagnostic(root.Diagnostics(), code) {
			t.Fatalf("expected %s diagnostic, got %#v", code, root.Diagnostics())
		}
	}
}

func TestPreferenceSnapshotDoesNotPersistRawAssistantInput(t *testing.T) {
	root := newTestModel(t)
	root.recordAssistantInteraction(assistant.ResponseAnswer, "api_key=secret", "token=abc123 handled")
	snapshot := root.preferenceSnapshot()
	if snapshot.Assistant.Provider.APIKeyRef != "" {
		t.Fatalf("unexpected API key ref in default snapshot: %#v", snapshot.Assistant.Provider)
	}
}

func TestThemeAndContextMenuPreferencesSurviveRestart(t *testing.T) {
	stateDir := t.TempDir()
	store := preferences.NewStore(stateDir)
	prefs := preferences.Default()
	prefs.Theme = "dark"
	prefs.Keymap.ContextMenu = []string{"ctrl+x", "ctrl+y"}
	prefs.Assistant.BarColor = "#123456"
	if err := store.Save(prefs); err != nil {
		t.Fatalf("save preferences: %v", err)
	}

	root := newTestModelInStateDir(stateDir)
	if root.Theme().Mode != "dark" {
		t.Fatalf("expected dark theme from preferences, got %s", root.Theme().Mode)
	}
	if root.keymap.ContextFallback.Help().Key != "ctrl+y/ctrl+o" {
		t.Fatalf("expected context fallback from preferences, got %s", root.keymap.ContextFallback.Help().Key)
	}
	if root.Preferences().Assistant.BarColor != "#123456" {
		t.Fatalf("expected assistant color to load, got %#v", root.Preferences().Assistant)
	}
	if !hasDiagnostic(root.Diagnostics(), "context_menu_ctrl_z_unavailable") {
		t.Fatalf("expected ctrl-z override diagnostic, got %#v", root.Diagnostics())
	}
}

func TestPanePreferencesSurviveRestart(t *testing.T) {
	stateDir := t.TempDir()
	root := newTestModelWithPanesInStateDir(stateDir, 1)
	root.paneManager.TogglePinSelected()
	paneID := root.paneManager.SelectedPaneID()
	root.paneManager.ApplyPreferences([]string{paneID}, nil, []string{paneID}, map[string]string{paneID: "#abcdef"}, 0)
	if msg := root.persistPreferencesCmd()(); !isPreferencesSavedMsg(msg) {
		t.Fatalf("expected preferences save success, got %T", msg)
	}

	restarted := newTestModelWithPanesInStateDir(stateDir, 1)
	panes := restarted.PaneManager().VisiblePanes()
	if len(panes) != 1 || !panes[0].Pinned || panes[0].Color != "#abcdef" {
		t.Fatalf("pane preferences did not survive restart: %#v", panes)
	}
}

func TestAllSupportedUIPreferencesSurviveRestart(t *testing.T) {
	stateDir := t.TempDir()
	store := preferences.NewStore(stateDir)
	prefs := preferences.Default()
	prefs.Theme = "dark"
	prefs.Keymap.ContextMenu = []string{"ctrl+x", "ctrl+y"}
	prefs.Panes.Pinned = []string{"app-1:app-1-web:frontend:frontend"}
	prefs.Panes.Hidden = []string{"app-2:app-2-web:frontend:frontend"}
	prefs.Panes.Order = []string{
		"app-10:app-10-web:frontend:frontend",
		"app-1:app-1-web:frontend:frontend",
		"app-3:app-3-web:frontend:frontend",
	}
	prefs.Panes.Colors = map[string]string{
		"app-10:app-10-web:frontend:frontend": "#216869",
	}
	prefs.Assistant.BarColor = "#6d4c3d"
	prefs.Layout.LastPage = 1
	if err := store.Save(prefs); err != nil {
		t.Fatalf("save preferences: %v", err)
	}

	root := newTestModelWithPanesInStateDir(stateDir, 10)
	if root.Theme().Mode != "dark" {
		t.Fatalf("expected dark theme from persisted preference, got %s", root.Theme().Mode)
	}
	if root.keymap.ContextFallback.Help().Key != "ctrl+y/ctrl+o" {
		t.Fatalf("expected persisted context fallback binding, got %s", root.keymap.ContextFallback.Help().Key)
	}
	if root.Preferences().Assistant.BarColor != "#6d4c3d" {
		t.Fatalf("expected persisted assistant bar color, got %#v", root.Preferences().Assistant)
	}
	if root.PaneManager().Page() != 1 {
		t.Fatalf("expected persisted last page 1, got %d", root.PaneManager().Page())
	}
	visible := root.PaneManager().VisiblePanes()
	if len(visible) != 9 {
		t.Fatalf("expected one hidden pane among ten, got %#v", visible)
	}
	if visible[0].ID != "app-10:app-10-web:frontend:frontend" {
		t.Fatalf("expected persisted pane order to put app-10 first, got %#v", visible)
	}
	if visible[0].Color != "#216869" {
		t.Fatalf("expected persisted pane color on app-10, got %#v", visible[0])
	}
	pinned := root.PaneManager().PinnedIDs()
	if len(pinned) != 1 || pinned[0] != "app-1:app-1-web:frontend:frontend" {
		t.Fatalf("expected persisted pinned pane, got %#v", pinned)
	}
	hidden := root.PaneManager().HiddenIDs()
	if len(hidden) != 1 || hidden[0] != "app-2:app-2-web:frontend:frontend" {
		t.Fatalf("expected persisted hidden pane, got %#v", hidden)
	}

	if msg := root.persistPreferencesCmd()(); !isPreferencesSavedMsg(msg) {
		t.Fatalf("expected preferences save success, got %T", msg)
	}
	restarted := newTestModelWithPanesInStateDir(stateDir, 10)
	if restarted.Theme().Mode != "dark" ||
		restarted.keymap.ContextFallback.Help().Key != "ctrl+y/ctrl+o" ||
		restarted.Preferences().Assistant.BarColor != "#6d4c3d" ||
		restarted.PaneManager().Page() != 1 {
		t.Fatalf("preferences did not survive second restart: theme=%s fallback=%s assistant=%#v page=%d",
			restarted.Theme().Mode,
			restarted.keymap.ContextFallback.Help().Key,
			restarted.Preferences().Assistant,
			restarted.PaneManager().Page(),
		)
	}
}

func TestHiddenPanePreferenceSurvivesRestart(t *testing.T) {
	stateDir := t.TempDir()
	root := newTestModelWithPanesInStateDir(stateDir, 1)
	root.paneManager.CloseSelected()
	if msg := root.persistPreferencesCmd()(); !isPreferencesSavedMsg(msg) {
		t.Fatalf("expected preferences save success, got %T", msg)
	}

	restarted := newTestModelWithPanesInStateDir(stateDir, 1)
	if len(restarted.PaneManager().VisiblePanes()) != 0 {
		t.Fatalf("expected hidden pane to stay hidden, got %#v", restarted.PaneManager().VisiblePanes())
	}
}

func TestFixtureStateUsesTempDirAndDaemonClient(t *testing.T) {
	stateDir := testfixtures.IsolatedStateDir(t)
	server := testfixtures.NewFakeDaemonServer(testfixtures.GroupedFrontendBackendState(), testfixtures.SampleLogs())
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: stateDir, Token: "test-token", ThemeMode: "auto"}
	client := relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client())
	root := NewRoot(cfg, client)

	msg := commands.FetchStateCmd(context.Background(), client)()
	loaded, ok := msg.(commands.StateLoadedMsg)
	if !ok {
		t.Fatalf("expected StateLoadedMsg from fake daemon, got %T", msg)
	}
	updated, _ := root.Update(loaded)
	model := updated.(RootModel)

	if !strings.HasPrefix(model.preferenceStore.Path(), filepath.Join(stateDir, "tui")) {
		t.Fatalf("preference store escaped temp state dir: %s", model.preferenceStore.Path())
	}
	if panes := model.PaneManager().VisiblePanes(); len(panes) != 2 {
		t.Fatalf("expected grouped frontend/backend panes from fixture, got %#v", panes)
	}

	confirmed, cmd := model.submitSlashCommand("/stop current")
	if cmd != nil {
		t.Fatal("expected stop command to wait for confirmation")
	}
	if !confirmed.PendingConfirmation() {
		t.Fatal("expected pending confirmation")
	}
	updated, cmd = confirmed.Update(keyPress("enter"))
	if cmd == nil {
		t.Fatal("expected confirmed lifecycle request command")
	}
	result := cmd()
	lifecycle, ok := result.(commands.LifecycleRequestedMsg)
	if !ok {
		t.Fatalf("expected LifecycleRequestedMsg, got %T", result)
	}
	if lifecycle.OperationID != "op-fixture-stop" {
		t.Fatalf("expected fake daemon operation id, got %#v", lifecycle)
	}
	_ = updated
}

func TestNoAppsStateRendersSetupOnboardingActions(t *testing.T) {
	root := newTestModel(t)
	root.cfg.CurrentDirectory = "C:/project"
	updated, _ := root.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{}})
	model := updated.(RootModel)
	updated, _ = model.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	model = updated.(RootModel)
	rendered := model.Render()

	for _, expected := range []string{
		"No Apps Registered",
		"Configure current project",
		"Register manifest",
		"Choose project path",
		"Open setup docs",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("expected %q in no-apps render:\n%s", expected, rendered)
		}
	}
}

func TestConfigureDryRunCallsDaemonPreviewOnly(t *testing.T) {
	var requestedPath string
	var requestBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		requestBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","selectedPlan":{"id":"managed","label":"Managed","choice":{"id":"managed"},"writes":[]},"choices":[{"id":"managed","label":"Managed"}],"fileWritePlan":{"root":"C:/project","approvalRequired":true,"writes":[{"path":"C:/project/relaybase.app.json","action":"create","reason":"manifest","diff":{"path":"C:/project/relaybase.app.json","beforeExists":false,"afterExists":true,"changed":true,"hunks":["+ {\"id\":\"app\"}"]}}],"risks":[]},"diagnostics":[]}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto", CurrentDirectory: "C:/project"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	updated, cmd := root.submitSlashCommand("/configure current folder --dry-run")
	model := updated
	if cmd == nil {
		t.Fatal("expected dry-run configure to call daemon preview")
	}
	msg := cmd()
	updatedModel, _ := model.Update(msg)
	model = updatedModel.(RootModel)

	if requestedPath != "/__hub/api/setup/preview" {
		t.Fatalf("expected setup preview path, got %s", requestedPath)
	}
	if !strings.Contains(requestBody, `"cwd":"C:/project"`) {
		t.Fatalf("expected current directory in request body, got %s", requestBody)
	}
	if !strings.Contains(model.Render(), "Setup Preview") || !strings.Contains(model.Render(), "relaybase.app.json") {
		t.Fatalf("expected setup preview render:\n%s", model.Render())
	}
}

func TestAddAppWaitsForConfirmationBeforeDaemonSetupCall(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto", CurrentDirectory: "C:/project"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	updated, cmd := root.submitSlashCommand("/add app C:/project using npm run dev")

	if cmd != nil {
		t.Fatal("expected add app to wait for confirmation")
	}
	if called {
		t.Fatal("add app called daemon before confirmation")
	}
	if !updated.PendingConfirmation() {
		t.Fatal("expected add app confirmation preview")
	}
	if !strings.Contains(updated.Render(), "Daemon may write setup files") {
		t.Fatalf("expected setup risk in confirmation preview:\n%s", updated.Render())
	}
}

func TestSetupSlashMutationsRequireConfirmationBeforeDaemonCall(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		needsState bool
	}{
		{name: "add app", input: "/add app C:/project using npm run dev"},
		{name: "configure", input: "/configure C:/project"},
		{name: "open", input: "/open C:/project"},
		{name: "prove path", input: "/prove C:/project"},
		{name: "health prove", input: "/health notes --prove", needsState: true},
		{name: "manifest edit", input: "/manifest edit healthUrl /healthz", needsState: true},
		{name: "health route", input: "/health route current /ready", needsState: true},
		{name: "pinned port", input: "/port pinned current 5173", needsState: true},
		{name: "component role", input: "/component role current frontend", needsState: true},
		{name: "component group", input: "/component group current notes", needsState: true},
		{name: "component label", input: "/component label current Web", needsState: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			called := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusInternalServerError)
			}))
			defer server.Close()

			cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto", CurrentDirectory: "C:/project"}
			root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
			if test.needsState {
				root = applyState(root, manifestBackedState())
			}

			updated, cmd := root.submitSlashCommand(test.input)
			if cmd != nil {
				t.Fatalf("%s returned daemon command before confirmation", test.input)
			}
			if called {
				t.Fatalf("%s called daemon before confirmation", test.input)
			}
			if !updated.PendingConfirmation() {
				t.Fatalf("%s did not create confirmation preview", test.input)
			}
		})
	}
}

func TestManifestEditConfirmationCallsDaemonPatchApply(t *testing.T) {
	var requestedPath string
	var requestBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		requestBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"setup":{"cwd":"C:/project","manifestPath":"C:/project/relaybase.app.json","app":{"id":"notes","name":"Notes"},"file":{"path":"C:/project/relaybase.app.json","action":"updated"},"diagnostics":[]}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyState(root, manifestBackedState())
	updated, cmd := root.submitSlashCommand("/health route current /ready")
	if cmd != nil {
		t.Fatal("expected health route patch to wait for confirmation")
	}
	if !updated.PendingConfirmation() {
		t.Fatal("expected manifest patch confirmation")
	}

	confirmed, cmd := updated.Update(keyPress("enter"))
	model := confirmed.(RootModel)
	if cmd == nil {
		t.Fatal("expected confirmed manifest patch daemon command")
	}
	msg := cmd()
	updatedModel, _ := model.Update(msg)
	model = updatedModel.(RootModel)

	if requestedPath != "/__hub/api/setup/patch-manifest/apply" {
		t.Fatalf("unexpected setup patch path: %s", requestedPath)
	}
	if !strings.Contains(requestBody, `"healthUrl":"/ready"`) || !strings.Contains(requestBody, `"confirm":true`) {
		t.Fatalf("expected healthUrl patch and confirmation in request body, got %s", requestBody)
	}
	if history := strings.Join(model.assistantHistoryForView(), "\n"); !strings.Contains(history, "Manifest patch applied") {
		t.Fatalf("expected manifest patch result in assistant history, got %#v", history)
	}
}

func TestAgentConfigMissingKeyDiagnosticRenders(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(commands.AgentConfigLoadedMsg{Config: enabledAgentConfig(false)})
	model := updated.(RootModel)

	if !hasDiagnostic(model.Diagnostics(), "openrouter_api_key_missing") {
		t.Fatalf("expected missing OpenRouter key diagnostic, got %#v", model.Diagnostics())
	}
}

func TestAgentConfigRemoteModelDisabledDiagnosticRenders(t *testing.T) {
	root := newTestModel(t)
	config := enabledAgentConfig(true)
	config.Provider.RemoteModelEnabled = false
	updated, _ := root.Update(commands.AgentConfigLoadedMsg{Config: config})
	model := updated.(RootModel)

	if model.agentStatus != "needs_config" {
		t.Fatalf("expected agent status needs_config, got %s", model.agentStatus)
	}
	if !hasDiagnostic(model.Diagnostics(), "agent_remote_model_disabled") {
		t.Fatalf("expected remote model disabled diagnostic, got %#v", model.Diagnostics())
	}
}

func TestAgentConfigLoadsActiveDaemonThread(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/agent/sessions/active" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-active","title":"Existing thread","recoveredApprovalCount":1,"messages":[],"runs":[]}}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.connectionStatus = "connected"
	updated, cmd := root.Update(commands.AgentConfigLoadedMsg{Config: enabledAgentConfig(true)})
	model := updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected enabled agent config to fetch active daemon thread")
	}
	msg := cmd()
	loaded, ok := msg.(commands.AgentActiveSessionLoadedMsg)
	if !ok {
		t.Fatalf("expected AgentActiveSessionLoadedMsg, got %T", msg)
	}
	updated, cmd = model.Update(loaded)
	model = updated.(RootModel)
	if model.agentSession == nil || model.agentSession.ID != "session-active" {
		t.Fatalf("expected active thread to be stored, got %#v", model.agentSession)
	}
	if !strings.Contains(model.Render(), "thread: Existing thread") {
		t.Fatalf("expected active thread in status render:\n%s", model.Render())
	}
	if cmd == nil {
		t.Fatal("expected active thread load to connect agent event stream")
	}
}

func TestFirstModelMessageCreatesDaemonThreadWhenNoneExists(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /__hub/api/agent/sessions":
			_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-created","title":"Relaybase TUI","messages":[],"runs":[]}}}`))
		default:
			t.Fatalf("unexpected path: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)

	updated, cmd := root.submitAssistantInput("hello operator")
	model := updated
	if cmd == nil {
		t.Fatal("expected first model-backed message to create a daemon thread")
	}
	msg := cmd()
	created, ok := msg.(commands.AgentSessionCreatedMsg)
	if !ok {
		t.Fatalf("expected AgentSessionCreatedMsg, got %T", msg)
	}
	updatedModel, batch := model.Update(created)
	model = updatedModel.(RootModel)
	if model.agentSession == nil || model.agentSession.ID != "session-created" {
		t.Fatalf("expected created thread to be active, got %#v", model.agentSession)
	}
	if model.agentPendingInput != "" {
		t.Fatalf("expected pending input to be consumed after thread creation, got %q", model.agentPendingInput)
	}
	if batch == nil {
		t.Fatal("expected created thread to start stream/send batch")
	}
	if len(requests) != 1 || requests[0] != "POST /__hub/api/agent/sessions" {
		t.Fatalf("unexpected requests: %#v", requests)
	}
}

func TestAssistantNewThreadMenuCreatesDaemonThreadWhenAvailable(t *testing.T) {
	var requestBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/agent/sessions" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		requestBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-menu","title":"Relaybase TUI","messages":[],"runs":[]}}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto", CurrentDirectory: "C:/workspace"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)
	root.contextMenu = contextmenu.AssistantMenu(root.assistantMenuOptions())
	selectMenuAction(t, &root, contextmenu.ActionAssistantNewThread)

	cmd := root.executeContextMenuSelection()
	if cmd == nil {
		t.Fatal("expected new thread menu to call daemon session create")
	}
	msg := cmd()
	updated, _ := root.Update(msg)
	model := updated.(RootModel)
	if model.agentSession == nil || model.agentSession.ID != "session-menu" {
		t.Fatalf("expected menu-created daemon thread, got %#v", model.agentSession)
	}
	if !strings.Contains(requestBody, `"currentCwd":"C:/workspace"`) {
		t.Fatalf("expected TUI cwd context in create request, got %s", requestBody)
	}
}

func TestAssistantNewThreadFallsBackLocalWhenAgentDisabled(t *testing.T) {
	root := newTestModel(t)
	root.connectionStatus = "connected"
	root.agentConfig = &relaybaseclient.AgentConfig{Enabled: false}
	root.addAssistantMessage("old message")
	root.contextMenu = contextmenu.AssistantMenu(root.assistantMenuOptions())
	selectMenuAction(t, &root, contextmenu.ActionAssistantNewThread)

	cmd := root.executeContextMenuSelection()
	if cmd != nil {
		t.Fatal("disabled Agent Gateway should not create a daemon thread")
	}
	history := strings.Join(root.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "New local-only assistant thread started") || strings.Contains(history, "old message") {
		t.Fatalf("expected honest local-only reset, got %#v", history)
	}
}

func TestThreadSlashCommandsUseDaemonSessions(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /__hub/api/agent/sessions":
			_, _ = w.Write([]byte(`{"agent":{"sessions":[{"id":"session-1","title":"One","summary":{"messageCount":1},"messages":[],"runs":[]},{"id":"session-2","title":"Two","summary":{"messageCount":2},"messages":[],"runs":[]}]}}`))
		case "POST /__hub/api/agent/sessions/session-2/activate":
			_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-2","title":"Two","messages":[{"id":"message-hidden","sessionId":"session-2","role":"user","content":"do not merge","createdAt":"2026-06-02T00:00:00Z"}],"runs":[]}}}`))
		case "PATCH /__hub/api/agent/sessions/session-2":
			_, _ = w.Write([]byte(`{"agent":{"session":{"id":"session-2","title":"Renamed","titleSource":"user","messages":[],"runs":[]}}}`))
		case "GET /__hub/api/agent/sessions/session-2/export":
			_, _ = w.Write([]byte(`{"agent":{"export":{"exportId":"export-thread","status":"succeeded","format":"json","outputPath":"C:/tmp/thread.json","sessionId":"session-2","messageCount":2,"auditEventCount":1,"redactionReport":{"totalReplacements":3}}}}`))
		case "GET /__hub/api/agent/sessions/session-2/context-preview":
			_, _ = w.Write([]byte(`{"agent":{"contextPreview":{"sessionId":"session-2","active":true,"title":"Renamed","summary":{"messageCount":2,"runCount":1,"eventCount":4,"pendingApprovalCount":0,"recoveredApprovalCount":0},"privacy":{"mode":"standard","advancedRedactedDetailEnabled":false},"recentMessages":[],"pendingApprovals":[],"recallPolicy":{"scope":"active_thread_only","includesRawSecrets":false,"includesRawLogs":false,"includesRawDiffs":false,"extraModelCalls":false}}}}`))
		case "POST /__hub/api/agent/sessions/session-2/clear":
			_, _ = w.Write([]byte(`{"agent":{"session":{"sessionId":"session-2","cleared":true}}}`))
		default:
			t.Fatalf("unexpected path: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)

	updated, cmd := root.submitSlashCommand("/thread list")
	model := updated
	if cmd == nil {
		t.Fatal("expected thread list command")
	}
	updatedModel, _ := model.Update(cmd())
	model = updatedModel.(RootModel)
	if len(model.agentSessions) != 2 || !strings.Contains(strings.Join(model.assistantHistoryForView(), "\n"), "Operator Agent threads") {
		t.Fatalf("expected listed sessions in state/history, sessions=%#v history=%#v", model.agentSessions, model.assistantHistoryForView())
	}

	updated, cmd = model.submitSlashCommand("/thread switch 2")
	model = updated
	if cmd == nil {
		t.Fatal("expected thread switch command")
	}
	updatedModel, _ = model.Update(cmd())
	model = updatedModel.(RootModel)
	if model.agentSession == nil || model.agentSession.ID != "session-2" {
		t.Fatalf("expected switched session-2, got %#v", model.agentSession)
	}
	if strings.Contains(strings.Join(model.assistantHistoryForView(), "\n"), "do not merge") {
		t.Fatalf("switch should not merge daemon transcript into local history: %#v", model.assistantHistoryForView())
	}

	for _, input := range []string{"/thread rename Renamed", "/thread export json", "/thread preview", "/thread clear"} {
		updated, cmd = model.submitSlashCommand(input)
		model = updated
		if cmd == nil {
			t.Fatalf("expected command for %s", input)
		}
		updatedModel, _ = model.Update(cmd())
		model = updatedModel.(RootModel)
	}
	if model.agentSession != nil {
		t.Fatalf("expected clear to drop active session, got %#v", model.agentSession)
	}
	history := strings.Join(model.assistantHistoryForView(), "\n")
	if !strings.Contains(history, "Operator Agent thread cleared session-2") {
		t.Fatalf("expected clear result in history, got %#v", history)
	}
	expected := []string{
		"GET /__hub/api/agent/sessions",
		"POST /__hub/api/agent/sessions/session-2/activate",
		"PATCH /__hub/api/agent/sessions/session-2",
		"GET /__hub/api/agent/sessions/session-2/export",
		"GET /__hub/api/agent/sessions/session-2/context-preview",
		"POST /__hub/api/agent/sessions/session-2/clear",
	}
	if fmt.Sprint(requests) != fmt.Sprint(expected) {
		t.Fatalf("unexpected daemon thread routes: %#v", requests)
	}
}

func TestThreadSwitchNumberNeedsCachedList(t *testing.T) {
	root := newTestModel(t)
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)

	updated, cmd := root.submitSlashCommand("/thread switch 1")
	model := updated
	if cmd != nil {
		t.Fatal("numeric switch without cached thread list should not call daemon")
	}
	if !strings.Contains(strings.Join(model.assistantHistoryForView(), "\n"), "Use /thread list first") {
		t.Fatalf("expected cached-list diagnostic, got %#v", model.assistantHistoryForView())
	}
}

func TestAssistantMenuChatExportEnabledOnlyWithDaemonThread(t *testing.T) {
	root := newTestModel(t)
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)
	root.contextMenu = contextmenu.AssistantMenu(root.assistantMenuOptions())
	if item := findMenuItem(t, root.contextMenu, contextmenu.ActionAssistantExportChat); item.Enabled {
		t.Fatalf("expected export disabled without active thread, got %#v", item)
	}

	root.agentSession = &relaybaseclient.AgentSession{ID: "session-1", Title: "Thread"}
	root.contextMenu = contextmenu.AssistantMenu(root.assistantMenuOptions())
	if item := findMenuItem(t, root.contextMenu, contextmenu.ActionAssistantExportChat); !item.Enabled {
		t.Fatalf("expected export enabled with active daemon thread, got %#v", item)
	}
}

func TestRecoveredAgentApprovalRequiresExplicitResumeReconfirm(t *testing.T) {
	var requestBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/agent/approvals/approval-recovered/approve" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		requestBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"approval":{"id":"approval-recovered","sessionId":"session-1","runId":"run-1","status":"approved","action":"start_app","target":"notes","risk":"medium"}}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.applyAgentRunEvent(rawAgentEvent("tool.approval_required", `{"approval":{"id":"approval-recovered","sessionId":"session-1","runId":"run-1","status":"recovered_pending","createdAt":"2026-06-02T00:00:00Z","action":"start_app","target":"notes","risk":"medium","expectedResult":"Start through daemon.","recoveryState":"requires_reconfirm","rawArgumentsPersisted":true}}`))

	if rendered := root.Render(); !strings.Contains(rendered, "recovered approval") || !strings.Contains(root.assistantPrompt, "recovered agent approval") {
		t.Fatalf("expected recovered approval to render distinctly:\n%s\nprompt=%s", rendered, root.assistantPrompt)
	}
	updated, cmd := root.Update(keyPress("enter"))
	model := updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected recovered approval reconfirm command")
	}
	msg := cmd()
	updated, _ = model.Update(msg)
	model = updated.(RootModel)
	if !strings.Contains(requestBody, `"reconfirm":true`) || !strings.Contains(requestBody, `"resume":true`) {
		t.Fatalf("expected recovered approval reconfirm/resume body, got %s", requestBody)
	}
	if model.pendingAgentApproval != nil {
		t.Fatal("expected pending approval to clear after reconfirm request")
	}
}

func TestAgentMessageSendsSelectedPaneAndCWDContext(t *testing.T) {
	var requestBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/agent/sessions/session-1/messages" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		requestBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"message":{"id":"message-1","sessionId":"session-1","role":"user","content":"please inspect current workspace","createdAt":"2026-06-02T00:00:00Z"},"run":{"id":"run-1","sessionId":"session-1","status":"completed","provider":"openrouter","events":[]},"diagnostics":[]}}`))
	}))
	defer server.Close()

	cfg := config.Config{
		BaseURL:          server.URL,
		StateDir:         t.TempDir(),
		Token:            "test-token",
		ThemeMode:        "auto",
		CurrentDirectory: "C:/workspace/ratemygithub",
	}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root = applyState(root, notesFrontendBackendState())
	root.agentConfig = enabledAgentConfig(true)
	root.agentSession = &relaybaseclient.AgentSession{ID: "session-1"}
	root.agentStream = &relaybaseclient.AgentEventStream{}

	updated, cmd := root.submitAssistantInput("please inspect current workspace")
	model := updated
	if cmd == nil {
		t.Fatal("expected agent message command")
	}
	msg := cmd()
	updatedModel, _ := model.Update(msg)
	model = updatedModel.(RootModel)

	if !strings.Contains(requestBody, `"content":"please inspect current workspace"`) ||
		!strings.Contains(requestBody, `"currentCwd":"C:/workspace/ratemygithub"`) ||
		!strings.Contains(requestBody, `"selectedAppId":"notes-web"`) ||
		!strings.Contains(requestBody, `"selectedGroupId":"notes"`) ||
		!strings.Contains(requestBody, `"selectedComponentRole":"frontend"`) {
		t.Fatalf("agent context missing selected pane/cwd fields: %s", requestBody)
	}
	if history := strings.Join(model.assistantHistoryForView(), "\n"); !strings.Contains(history, "You: please inspect current workspace") {
		t.Fatalf("expected user message in assistant history, got %#v", history)
	}
}

func TestAgentInputCanSubmitAgainAfterFirstSend(t *testing.T) {
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/agent/sessions/session-1/messages" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		requests = append(requests, string(body))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"message":{"id":"message-1","sessionId":"session-1","role":"user","content":"ok","createdAt":"2026-06-02T00:00:00Z"},"run":{"id":"run-1","sessionId":"session-1","status":"completed","provider":"openrouter","events":[]},"diagnostics":[]}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.agentConfig = enabledAgentConfig(true)
	root.agentSession = &relaybaseclient.AgentSession{ID: "session-1"}
	root.agentStream = &relaybaseclient.AgentEventStream{}

	first := typeAssistantText(t, root, "hello agent")
	updated, cmd := first.Update(keyPress("enter"))
	model := updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected first agent message command")
	}
	msg := cmd()
	updated, _ = model.Update(msg)
	model = updated.(RootModel)
	if model.commandActive || model.CommandInput() != "" {
		t.Fatalf("expected input to reset after first send, active=%v input=%q", model.commandActive, model.CommandInput())
	}

	second := typeAssistantText(t, model, "second agent message")
	if !second.commandActive || second.CommandInput() != "second agent message" {
		t.Fatalf("expected second chat to type through same input, active=%v input=%q", second.commandActive, second.CommandInput())
	}
	updated, cmd = second.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected second agent message command")
	}
	msg = cmd()
	updated, _ = model.Update(msg)
	model = updated.(RootModel)

	if len(requests) != 2 {
		t.Fatalf("expected two agent message requests, got %d: %#v", len(requests), requests)
	}
	if !strings.Contains(requests[0], `"content":"hello agent"`) || !strings.Contains(requests[1], `"content":"second agent message"`) {
		t.Fatalf("unexpected request bodies: %#v", requests)
	}
	if history := strings.Join(model.assistantHistoryForView(), "\n"); !strings.Contains(history, "You: second agent message") {
		t.Fatalf("expected second user message in assistant history, got %#v", history)
	}
}

func TestAgentStreamEventRendersApprovalAndEscRejects(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"approval":{"id":"approval-1","sessionId":"session-1","runId":"run-1","status":"rejected","action":"apply_setup_plan","target":"C:/project","risk":"high"}}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 48})
	root = updated.(RootModel)
	root.applyAgentRunEvent(agentApprovalEvent("approval-1"))

	if root.pendingAgentApproval == nil {
		t.Fatal("expected pending agent approval")
	}
	rendered := root.Render()
	details := strings.Join(root.confirmationForView().Details, "\n")
	if !strings.Contains(rendered, "Confirm Action") ||
		!strings.Contains(details, "relaybase.app.json") ||
		!strings.Contains(details, "+ {") ||
		!strings.Contains(details, "runtime python") ||
		!strings.Contains(details, "command python -m uvicorn main:app --host HOST --port PORT") ||
		!strings.Contains(details, "port candidates explicit_host_port_flags, generated_launch_wrapper") ||
		!strings.Contains(details, "setup question Which ASGI module should Relaybase run?") {
		t.Fatalf("expected approval file diff render:\n%s", rendered)
	}

	updated, cmd := root.Update(keyPress("esc"))
	model := updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected reject approval command")
	}
	msg := cmd()
	updated, _ = model.Update(msg)
	model = updated.(RootModel)
	if requestedPath != "/__hub/api/agent/approvals/approval-1/reject" {
		t.Fatalf("unexpected reject path: %s", requestedPath)
	}
	if model.pendingAgentApproval != nil {
		t.Fatal("expected pending approval to be cleared after Esc")
	}
}

func TestAgentApprovalEnterApproves(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"approval":{"id":"approval-2","sessionId":"session-1","runId":"run-1","status":"approved","action":"stop_app","target":"notes","risk":"medium"}}}`))
	}))
	defer server.Close()

	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	root.applyAgentRunEvent(agentSimpleApprovalEvent("approval-2", "stop_app"))

	updated, cmd := root.Update(keyPress("enter"))
	model := updated.(RootModel)
	if cmd == nil {
		t.Fatal("expected approve approval command")
	}
	msg := cmd()
	updated, _ = model.Update(msg)
	model = updated.(RootModel)
	if requestedPath != "/__hub/api/agent/approvals/approval-2/approve" {
		t.Fatalf("unexpected approve path: %s", requestedPath)
	}
	if history := strings.Join(model.assistantHistoryForView(), "\n"); !strings.Contains(history, "approved") {
		t.Fatalf("expected approved result in history, got %#v", history)
	}
}

func TestAgentSetupRepairAndProveEventsRender(t *testing.T) {
	root := newTestModel(t)
	root.applyAgentRunEvent(rawAgentEvent("setup.plan_preview", `{"preview":{"cwd":"C:/project","selectedPlan":{"id":"managed","label":"Managed","choice":{"id":"managed"},"writes":[]},"fileWritePlan":{"root":"C:/project","approvalRequired":true,"writes":[{"path":"C:/project/relaybase.app.json","action":"create","reason":"manifest","diff":{"path":"C:/project/relaybase.app.json","beforeExists":false,"afterExists":true,"changed":true,"hunks":["+ manifest"]}}],"risks":[]},"diagnostics":[]}}`))
	if rendered := root.Render(); !strings.Contains(rendered, "Setup Preview") || !strings.Contains(rendered, "relaybase.app.json") {
		t.Fatalf("expected setup preview render:\n%s", rendered)
	}

	root.applyAgentRunEvent(rawAgentEvent("setup.repair_choices", `{"repair":{"plan":{"cwd":"C:/project","choices":[{"id":"fixed-port","label":"Use fixed port"}],"previews":[],"diagnostics":[]}}}`))
	if rendered := root.Render(); !strings.Contains(rendered, "Setup Repair Choices") || !strings.Contains(rendered, "Use fixed port") {
		t.Fatalf("expected repair choices render:\n%s", rendered)
	}

	root.applyAgentRunEvent(rawAgentEvent("setup.prove_result", `{"prove":{"cwd":"C:/project","result":{"ok":true}}}`))
	if rendered := root.Render(); !strings.Contains(rendered, "Health Proof") || !strings.Contains(rendered, "C:/project") {
		t.Fatalf("expected prove result render:\n%s", rendered)
	}
}

func TestAgentFolderStartApprovalAndResultsRenderFullLoop(t *testing.T) {
	root := newTestModel(t)
	root.height = 80
	root.applyAgentRunEvent(rawAgentEvent("setup.file_write_approval_required", `{"approval":{"id":"approval-setup","sessionId":"session-1","runId":"run-1","status":"pending","createdAt":"2026-06-02T00:00:00Z","toolName":"setup_and_start_project","action":"setup_and_start_project","target":"C:/project","risk":"high","expectedResult":"Apply approved setup writes and register the app.","arguments":{"phase":"apply_setup","cwd":"C:/project","selectedPlanId":"managed","commandHint":"npm run dev","portStrategyHint":"framework_port_flags"},"preview":{"action":"setup_and_start_project","target":"C:/project","expectedResult":"Apply approved setup writes and register the app.","risk":"high","runtimeId":"node","runtimeLabel":"Vite","runtimeConfidence":"high","selectedCommand":{"preview":"npm run dev"},"portStrategy":"framework_port_flags"},"fileWrite":{"kind":"file_write","setupPlanId":"managed","risk":"high","fileWritePlan":{"root":"C:/project","approvalRequired":true,"writes":[{"path":"C:/project/relaybase.app.json","action":"create","reason":"manifest","diff":{"path":"C:/project/relaybase.app.json","beforeExists":false,"afterExists":true,"changed":true,"hunks":["+ {\"id\":\"selection-web\"}"]}}],"risks":[{"code":"manifest_write","severity":"warning","message":"writes manifest","requiresApproval":true}]}}}}`))
	rendered := root.Render()
	for _, expected := range []string{
		"Confirm Action",
		"action: setup_and_start_project",
		"target: C:/project",
		"expected: Apply approved setup writes and register the app.",
		"phase apply_setup",
		"project path C:/project",
		"setup plan managed",
		"command npm run dev",
		"port strategy framework_port_flags",
		"relaybase.app.json",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("expected %q in setup approval render:\n%s", expected, rendered)
		}
	}

	root.applyAgentRunEvent(rawAgentEvent("action_result", `{"kind":"action_result","approvalId":"approval-setup","toolName":"setup_and_start_project","result":{"tool":"setup_and_start_project","status":"succeeded","data":{"phase":"setup_applied","setup":{"cwd":"C:/project","selectedPlan":{"id":"managed","label":"Managed"},"appliedFiles":[{"path":"C:/project/relaybase.app.json","action":"created"}],"registeredApp":{"id":"selection-web","name":"Selection Web","command":"npm run dev","cwd":"C:/project","healthUrl":"/health"},"diagnostics":[]}}}}`))
	rendered = root.Render()
	if !strings.Contains(rendered, "Setup Applied") ||
		!strings.Contains(rendered, "created C:/project/relaybase.app.json") ||
		!strings.Contains(rendered, "registered app: id selection-web") {
		t.Fatalf("expected setup apply summary render:\n%s", rendered)
	}
	if history := strings.Join(root.assistantHistoryForView(), "\n"); !strings.Contains(history, "Setup applied") || !strings.Contains(history, "start still requires a separate approval") {
		t.Fatalf("expected setup applied assistant message, got %#v", history)
	}

	root.applyAgentRunEvent(rawAgentEvent("tool.approval_required", `{"approval":{"id":"approval-start","sessionId":"session-1","runId":"run-1","status":"pending","createdAt":"2026-06-02T00:00:00Z","toolName":"setup_and_start_project","action":"setup_and_start_project","target":"selection-web","risk":"high","expectedResult":"Start the registered app.","arguments":{"phase":"start_registered","cwd":"C:/project","appId":"selection-web"}}}`))
	rendered = root.Render()
	if !strings.Contains(rendered, "expected: Start the registered app.") ||
		!strings.Contains(rendered, "phase start_registered") ||
		!strings.Contains(rendered, "app id selection-web") {
		t.Fatalf("expected start approval render:\n%s", rendered)
	}

	root.applyAgentRunEvent(rawAgentEvent("action_result", `{"kind":"action_result","toolName":"setup_and_start_project","result":{"tool":"setup_and_start_project","status":"succeeded","operationId":"op-start-1","data":{"phase":"started","appId":"selection-web","route":"http://selection.localhost:7777","operation":{"operationId":"op-start-1","status":"succeeded"},"state":{"id":"selection-web","humanUrl":"http://selection.localhost:7777"},"logs":{"events":[{"stream":"stdout","message":"ready on 5173"},{"stream":"stderr","message":"warning text"}],"diagnostics":[]}}}}`))
	if history := strings.Join(root.assistantHistoryForView(), "\n"); !strings.Contains(history, "Start completed") ||
		!strings.Contains(history, "operation op-start-1") ||
		!strings.Contains(history, "route http://selection.localhost:7777") ||
		!strings.Contains(history, "[stdout] ready on 5173") {
		t.Fatalf("expected start route/log assistant message, got %#v", history)
	}

	model := typeAssistantText(t, root, "what is broken?")
	updated, _ := model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if model.commandActive || model.CommandInput() != "" {
		t.Fatalf("expected chatbar to remain usable after setup/start loop, active=%v input=%q", model.commandActive, model.CommandInput())
	}
}

func TestAgentFolderStartFailureRendersRepairChoicesAndDedupesDiagnostics(t *testing.T) {
	root := newTestModel(t)
	failed := rawAgentEvent("action_result", `{"kind":"action_result","toolName":"setup_and_start_project","result":{"tool":"setup_and_start_project","status":"failed","operationId":"op-start-failed","diagnostic":{"code":"SETUP_AND_START_START_FAILED","severity":"error","message":"Daemon lifecycle start failed.","userAction":"Inspect logs and approve repair."},"data":{"phase":"start_failed","appId":"selection-web","operation":{"operationId":"op-start-failed","status":"failed","message":"process exited"},"logs":{"events":[{"stream":"stderr","message":"EADDRINUSE"}],"diagnostics":[]},"repairChoices":{"plan":{"cwd":"C:/project","choices":[{"id":"generated-wrapper","label":"Use generated launch wrapper"},{"id":"pinned-port","label":"Use pinned upstream port"}],"repairCandidates":[{"id":"vite.wrapper","label":"Use framework wrapper","appliesTo":"vite","approvalRequired":true}],"diagnostics":[]}}}}}`)
	root.applyAgentRunEvent(failed)
	root.applyAgentRunEvent(failed)

	rendered := root.Render()
	if !strings.Contains(rendered, "Setup Repair Choices") ||
		!strings.Contains(rendered, "Use generated launch wrapper") ||
		!strings.Contains(rendered, "Use framework wrapper for vite") {
		t.Fatalf("expected repair choices render:\n%s", rendered)
	}
	history := strings.Join(root.assistantHistoryForView(), "\n")
	if strings.Count(history, "Start failed") != 1 {
		t.Fatalf("expected repeated failure message to be deduped, got %#v", history)
	}
	if !strings.Contains(history, "repair choices 2") || !strings.Contains(history, "[stderr] EADDRINUSE") {
		t.Fatalf("expected concise failure, logs, repair choices, got %#v", history)
	}
	model := typeAssistantText(t, root, "show diagnostics")
	updated, _ := model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if model.commandActive || model.CommandInput() != "" {
		t.Fatalf("expected chatbar to remain usable after setup failure, active=%v input=%q", model.commandActive, model.CommandInput())
	}
}

func TestAgentTuiProposedActionsStayLocalAndHonest(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	root.applyAgentRunEvent(rawAgentEvent("tui.proposed_action", `{"action":{"kind":"pin_pane","target":{"appId":"notes-web","groupId":"notes","componentRole":"frontend"},"requiresApproval":false}}`))
	if pinned := root.PaneManager().PinnedIDs(); len(pinned) != 1 {
		t.Fatalf("expected local pin proposed action, got %#v", pinned)
	}

	root.applyAgentRunEvent(rawAgentEvent("tui.proposed_action", `{"action":{"kind":"copy_route","route":"http://notes.localhost:7777","requiresApproval":false}}`))
	if !hasDiagnostic(root.Diagnostics(), "clipboard_unavailable") {
		t.Fatalf("expected clipboard unavailable diagnostic, got %#v", root.Diagnostics())
	}
}

func newTestModel(t *testing.T) RootModel {
	t.Helper()
	return newTestModelInStateDir(t.TempDir())
}

func isPreferencesSavedMsg(msg tea.Msg) bool {
	_, ok := msg.(commands.PreferencesSavedMsg)
	return ok
}

func newTestModelInStateDir(stateDir string) RootModel {
	cfg := config.Config{
		BaseURL:   "http://127.0.0.1:7777",
		StateDir:  stateDir,
		Token:     "test-token",
		ThemeMode: "auto",
	}
	client := relaybaseclient.New(cfg.BaseURL, cfg.Token, nil)
	return NewRoot(cfg, client)
}

func newTestModelWithPanes(t *testing.T, groupCount int) RootModel {
	t.Helper()
	return newTestModelWithPanesInStateDir(t.TempDir(), groupCount)
}

func newTestModelWithPanesInStateDir(stateDir string, groupCount int) RootModel {
	root := newTestModelInStateDir(stateDir)
	return applyTestPanes(root, groupCount)
}

func applyState(root RootModel, state *relaybaseclient.RelaybaseState) RootModel {
	updated, _ := root.Update(commands.StateLoadedMsg{State: state})
	return updated.(RootModel)
}

func notesFrontendBackendState() *relaybaseclient.RelaybaseState {
	return &relaybaseclient.RelaybaseState{
		Apps: []relaybaseclient.AppState{
			{ID: "notes-web", Name: "Notes Web", RuntimeStatus: "running"},
			{ID: "notes-api", Name: "API", RuntimeStatus: "running"},
		},
		Groups: []relaybaseclient.AppGroup{
			{
				GroupID:     "notes",
				DisplayName: "Notes",
				Components: []relaybaseclient.AppComponent{
					{AppID: "notes-web", GroupID: "notes", Role: "frontend", PaneLabel: "frontend", PaneOrder: 10, DisplayName: "Notes", Status: "running"},
					{AppID: "notes-api", GroupID: "notes", Role: "backend", PaneLabel: "backend", PaneOrder: 20, DisplayName: "API", Status: "running"},
				},
			},
		},
		Components: []relaybaseclient.AppComponent{
			{AppID: "notes-web", GroupID: "notes", Role: "frontend", PaneLabel: "frontend", PaneOrder: 10, DisplayName: "Notes", Status: "running"},
			{AppID: "notes-api", GroupID: "notes", Role: "backend", PaneLabel: "backend", PaneOrder: 20, DisplayName: "API", Status: "running"},
		},
	}
}

func manifestBackedState() *relaybaseclient.RelaybaseState {
	return &relaybaseclient.RelaybaseState{
		Apps: []relaybaseclient.AppState{
			{ID: "notes", Name: "Notes", RuntimeStatus: "running", ManifestPath: "C:/project/relaybase.app.json"},
		},
		Components: []relaybaseclient.AppComponent{
			{AppID: "notes", GroupID: "notes", Role: "frontend", PaneLabel: "frontend", DisplayName: "Notes", Status: "running"},
		},
	}
}

func applyTestPanes(root RootModel, groupCount int) RootModel {
	state := paneState(groupCount)
	updated, _ := root.Update(commands.StateLoadedMsg{State: state})
	return updated.(RootModel)
}

func paneState(groupCount int) *relaybaseclient.RelaybaseState {
	state := &relaybaseclient.RelaybaseState{}
	for index := 1; index <= groupCount; index++ {
		groupID := fmt.Sprintf("app-%d", index)
		state.Components = append(state.Components, relaybaseclient.AppComponent{
			AppID:       groupID + "-web",
			GroupID:     groupID,
			Role:        "frontend",
			PaneLabel:   "frontend",
			PaneOrder:   10,
			DisplayName: fmt.Sprintf("App %d", index),
			Status:      "running",
		})
	}
	return state
}

func testLogEvents(appID string, groupID string, role string, count int) []relaybaseclient.LogEvent {
	events := make([]relaybaseclient.LogEvent, 0, count)
	for index := 1; index <= count; index++ {
		events = append(events, relaybaseclient.LogEvent{
			Sequence:      int64(index),
			AppID:         appID,
			GroupID:       groupID,
			ComponentRole: role,
			Stream:        "stdout",
			Message:       fmt.Sprintf("line %02d", index),
		})
	}
	return events
}

func submitPendingSlashInput(t *testing.T, root RootModel, input string) (RootModel, tea.Cmd) {
	t.Helper()
	if !strings.HasPrefix(input, "/") {
		t.Fatalf("pending slash helper requires slash input, got %q", input)
	}
	updated, _ := root.Update(keyPress("/"))
	model := updated.(RootModel)
	if !model.commandActive || model.CommandInput() != "/" {
		t.Fatalf("expected pending confirmation to open slash input, got active=%v input=%q", model.commandActive, model.CommandInput())
	}
	if len(input) > 1 {
		updated, _ = model.Update(tea.KeyPressMsg{Text: strings.TrimPrefix(input, "/"), Code: []rune(input)[1]})
		model = updated.(RootModel)
	}
	updated, cmd := model.Update(keyPress("enter"))
	return updated.(RootModel), cmd
}

func typeAssistantText(t *testing.T, root RootModel, input string) RootModel {
	t.Helper()
	model := root
	for _, char := range input {
		updated, _ := model.Update(tea.KeyPressMsg{Text: string(char), Code: char})
		model = updated.(RootModel)
	}
	return model
}

func ctrlKey(value string) tea.KeyPressMsg {
	switch value {
	case "z":
		return tea.KeyPressMsg{Code: 26}
	case "o":
		return tea.KeyPressMsg{Code: 15}
	default:
		return tea.KeyPressMsg{}
	}
}

func keyPress(value string) tea.KeyPressMsg {
	switch value {
	case "right":
		return tea.KeyPressMsg{Code: tea.KeyRight}
	case "left":
		return tea.KeyPressMsg{Code: tea.KeyLeft}
	case "up":
		return tea.KeyPressMsg{Code: tea.KeyUp}
	case "down":
		return tea.KeyPressMsg{Code: tea.KeyDown}
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEsc}
	case "pgup":
		return tea.KeyPressMsg{Code: tea.KeyPgUp}
	case "pgdown":
		return tea.KeyPressMsg{Code: tea.KeyPgDown}
	default:
		runes := []rune(value)
		if len(runes) == 0 {
			return tea.KeyPressMsg{}
		}
		return tea.KeyPressMsg{Text: value, Code: runes[0]}
	}
}

func hasDiagnostic(diagnostics []Diagnostic, code string) bool {
	for _, diagnostic := range diagnostics {
		if diagnostic.Code == code {
			return true
		}
	}
	return false
}

func countDiagnostics(diagnostics []Diagnostic, code string) int {
	count := 0
	for _, diagnostic := range diagnostics {
		if diagnostic.Code == code {
			count++
		}
	}
	return count
}

func assertModelSelectedPaneID(t *testing.T, model RootModel, expected string) {
	t.Helper()
	if selected := model.PaneManager().SelectedPaneID(); selected != expected {
		t.Fatalf("expected selected pane %s, got %s", expected, selected)
	}
}

func sameColor(left color.Color, right color.Color) bool {
	if left == nil || right == nil {
		return left == right
	}
	leftR, leftG, leftB, leftA := left.RGBA()
	rightR, rightG, rightB, rightA := right.RGBA()
	return leftR == rightR && leftG == rightG && leftB == rightB && leftA == rightA
}

func selectMenuAction(t *testing.T, root *RootModel, action string) {
	t.Helper()
	for index, item := range root.contextMenu.Items {
		if item.Action == action {
			root.contextMenu.Selected = index
			return
		}
	}
	t.Fatalf("missing menu action %s in %#v", action, root.contextMenu.Items)
}

func findMenuItem(t *testing.T, menu contextmenu.Menu, action string) contextmenu.Item {
	t.Helper()
	for _, item := range menu.Items {
		if item.Action == action {
			return item
		}
	}
	t.Fatalf("missing menu action %s in %#v", action, menu.Items)
	return contextmenu.Item{}
}

func enabledAgentConfig(keyConfigured bool) *relaybaseclient.AgentConfig {
	return &relaybaseclient.AgentConfig{
		Enabled: true,
		Provider: relaybaseclient.AgentProviderConfig{
			Provider:  "openrouter",
			ModelSlug: "openrouter/test",
			APIKeySource: relaybaseclient.AgentAPIKeySource{
				Type:       "environment",
				EnvVar:     "OPENROUTER_API_KEY",
				Configured: keyConfigured,
			},
			RemoteModelEnabled: true,
		},
	}
}

func rawAgentEvent(eventType string, data string) relaybaseclient.AgentRunEvent {
	return relaybaseclient.AgentRunEvent{
		ID:        eventType + "-1",
		Sequence:  1,
		SessionID: "session-1",
		RunID:     "run-1",
		Type:      eventType,
		Data:      json.RawMessage(data),
	}
}

func agentSimpleApprovalEvent(approvalID string, action string) relaybaseclient.AgentRunEvent {
	return rawAgentEvent("tool.approval_required", fmt.Sprintf(`{"approval":{"id":%q,"sessionId":"session-1","runId":"run-1","status":"pending","createdAt":"2026-06-02T00:00:00Z","action":%q,"target":"notes","risk":"medium","expectedResult":"Daemon executes the approved tool."}}`, approvalID, action))
}

func agentApprovalEvent(approvalID string) relaybaseclient.AgentRunEvent {
	return rawAgentEvent("setup.file_write_approval_required", fmt.Sprintf(`{"approval":{"id":%q,"sessionId":"session-1","runId":"run-1","status":"pending","createdAt":"2026-06-02T00:00:00Z","action":"apply_setup_plan","target":"C:/project","risk":"high","expectedResult":"Daemon writes approved setup files.","preview":{"action":"apply_setup_plan","target":"C:/project","expectedResult":"Daemon writes approved setup files.","risk":"high","runtimeId":"python","runtimeLabel":"Python","runtimeConfidence":"high","selectedCommand":{"argv":["python","-m","uvicorn","main:app","--host","HOST","--port","PORT"],"preview":"python -m uvicorn main:app --host HOST --port PORT"},"portStrategy":"explicit_host_port_flags","portStrategyCandidates":["explicit_host_port_flags","generated_launch_wrapper"],"setupQuestions":["Which ASGI module should Relaybase run?"],"mayIncludeSensitiveData":true},"fileWrite":{"kind":"file_write","setupPlanId":"managed","risk":"high","fileWritePlan":{"root":"C:/project","approvalRequired":true,"writes":[{"path":"C:/project/relaybase.app.json","action":"create","reason":"manifest","diff":{"path":"C:/project/relaybase.app.json","beforeExists":false,"afterExists":true,"changed":true,"hunks":["+ {"," + \"id\": \"app\"","}"]}}],"risks":[]}}}}`, approvalID))
}
