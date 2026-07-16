package model

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func TestBareStartOpensRegisteredAppStartPicker(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	root, refresh := root.submitSlashCommand("/start")
	if refresh == nil || !root.appManagerVisible || root.interaction.Transient != interaction.TransientAppManager {
		t.Fatalf("bare start did not open registered-app transient: visible=%v transient=%s refresh=%v", root.appManagerVisible, root.interaction.Transient, refresh)
	}
	data := root.appManagerDataForView()
	if data == nil || data.Mode != string(appManagerModeStartPicker) || len(data.Items) != root.appInventory.Count() {
		t.Fatalf("bare start did not reuse complete list projection: %#v", data)
	}
	rendered := root.Render()
	for _, required := range []string{"Start app", "Name", "Project", "Status"} {
		if !strings.Contains(rendered, required) {
			t.Fatalf("bare start table missing %q:\n%s", required, rendered)
		}
	}
}

func TestTargetedStartResolvesOneAppAndUsesExistingConfirmationGate(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "notes-api", Name: "Notes API", RuntimeStatus: "stopped"},
		{ID: "notes-web", Name: "Notes Web", RuntimeStatus: "stopped"},
	}}
	root := applyState(newTestModel(t), state)
	root, command := root.submitSlashCommand("/start notes-web")
	if command != nil || root.pendingConfirm == nil || root.pendingConfirm.Command.Kind != slash.KindStart {
		t.Fatalf("targeted start bypassed confirmation: command=%v pending=%#v", command, root.pendingConfirm)
	}
	if apps := root.pendingConfirm.Target.AppIDs; len(apps) != 1 || apps[0] != "notes-web" {
		t.Fatalf("targeted start resolved the wrong app: %#v", root.pendingConfirm.Target)
	}

	confirmed := applyState(newTestModel(t), state)
	confirmed, command = confirmed.submitSlashCommand("/start 'Notes Web' --confirm")
	if command == nil || confirmed.pendingConfirm != nil {
		t.Fatalf("explicitly confirmed unique display name did not issue one daemon request: command=%v pending=%#v", command, confirmed.pendingConfirm)
	}
}

func TestTargetedStartOpensRunningAppPaneInsteadOfStartingAgain(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{
		Apps:       []relaybaseclient.AppState{{ID: "notes", Name: "Notes", RuntimeStatus: "running"}},
		Components: []relaybaseclient.AppComponent{{AppID: "notes", GroupID: "notes", Role: "frontend", PaneLabel: "web", DisplayName: "Notes", Status: "running"}},
	}
	root := applyState(newTestModel(t), state)
	paneID := root.paneManager.SelectedPaneID()
	root.paneManager.CloseSelected()
	root, command := root.submitSlashCommand("/start notes")
	if command == nil || root.pendingConfirm != nil || !root.paneManager.Focused() || root.paneManager.SelectedPaneID() != paneID {
		t.Fatalf("running target did not reveal its pane: command=%v pending=%#v focused=%v selected=%q", command, root.pendingConfirm, root.paneManager.Focused(), root.paneManager.SelectedPaneID())
	}
}

func TestTargetedStartFailsClosedForOfflineAndUnsafeStates(t *testing.T) {
	for _, test := range []struct {
		name    string
		status  string
		offline bool
	}{
		{name: "offline", status: "stopped", offline: true},
		{name: "starting", status: "starting"},
		{name: "failed", status: "failed"},
		{name: "degraded", status: "degraded"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "notes", Name: "Notes", RuntimeStatus: test.status}}})
			if test.offline {
				root.connectionStatus = "offline"
			}
			root, command := root.submitSlashCommand("/start notes")
			if command != nil || root.pendingConfirm != nil || len(root.assistantHistoryForView()) == 0 {
				t.Fatalf("unsafe target produced lifecycle work: command=%v pending=%#v history=%#v", command, root.pendingConfirm, root.assistantHistoryForView())
			}
		})
	}
}

func TestStartCompletionTransitionsFromCommandPaletteToRegisteredAppTable(t *testing.T) {
	root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "codegraph-website", Name: "CodeGraph Website", RuntimeStatus: "running", CWD: `C:\work\codegraph`},
		{ID: "voice-stock-agent", Name: "Voice Stock Agent", RuntimeStatus: "stopped", CWD: `C:\work\voice-stock-agent`},
	}})
	root = typeAssistantText(t, root, "/sta")
	if !root.commandPaletteVisible() || root.startCompletionVisible() {
		t.Fatalf("partial command did not remain in command palette: command=%v start=%v", root.commandPaletteVisible(), root.startCompletionVisible())
	}
	updated, command := root.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	root = updated.(RootModel)
	if command != nil || root.CommandInput() != "/start " || !root.startCompletionVisible() || root.commandPaletteVisible() {
		t.Fatalf("command completion did not transfer ownership: input=%q start=%v command=%v", root.CommandInput(), root.startCompletionVisible(), command)
	}
	plain := root.Render()
	for _, required := range []string{"Registered apps for /start", "CodeGraph Website", "Voice Stock Agent", "Project", "Status"} {
		if !strings.Contains(plain, required) {
			t.Fatalf("completion table missing %q:\n%s", required, plain)
		}
	}

	root = typeAssistantText(t, root, "vo")
	selected, ok := root.startCompletion.Selected()
	if !ok || selected.ID != "voice-stock-agent" {
		t.Fatalf("prefix did not select voice app: selected=%#v ok=%v", selected, ok)
	}
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.CommandInput() != "/start voice-stock-agent" || root.pendingConfirm != nil {
		t.Fatalf("first enter should complete only: input=%q pending=%#v command=%v", root.CommandInput(), root.pendingConfirm, command)
	}
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm == nil || root.pendingConfirm.Target.AppIDs[0] != "voice-stock-agent" {
		t.Fatalf("second enter did not submit confirmation-gated target: pending=%#v command=%v", root.pendingConfirm, command)
	}
}

func TestStartCompletionMouseRowOnlyCompletesInput(t *testing.T) {
	root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "alpha", Name: "Alpha", RuntimeStatus: "stopped"},
		{ID: "beta", Name: "Beta", RuntimeStatus: "stopped"},
	}})
	root = typeAssistantText(t, root, "/start ")
	frame := views.BuildShell(root.styles, root.shellData())
	region := components.HitRegion{}
	for _, candidate := range frame.HitMap.Regions() {
		if candidate.Kind == components.HitStartCompletionRow && candidate.Index == 1 {
			region = candidate
			break
		}
	}
	if !region.Rect.Valid() {
		t.Fatalf("completion table has no second-row hit target: %#v", frame.HitMap.Regions())
	}
	updated, command := root.Update(tea.MouseClickMsg{X: region.Rect.X, Y: region.Rect.Y, Button: tea.MouseLeft})
	root = updated.(RootModel)
	if command != nil || root.CommandInput() != "/start beta" || root.pendingConfirm != nil {
		t.Fatalf("completion row click executed instead of inserting: input=%q pending=%#v command=%v", root.CommandInput(), root.pendingConfirm, command)
	}
}
