package model

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
)

func TestStartPickerOpensDedicatedRegisteredAppTransientWithActivePanes(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	root = updated.(RootModel)

	root, refresh := root.submitSlashCommand("/start")
	if refresh == nil || !root.appManagerVisible || root.helpVisible {
		t.Fatalf("start picker did not open independently: visible=%v help=%v refresh=%v", root.appManagerVisible, root.helpVisible, refresh)
	}
	if root.interaction.Transient != interaction.TransientAppManager || root.interaction.Owner() != interaction.OwnerTransient {
		t.Fatalf("start picker did not own its dedicated transient: %#v", root.interaction)
	}
	if data := root.appManagerDataForView(); data == nil || data.Mode != string(appManagerModeStartPicker) || len(data.Items) != root.appInventory.Count() || len(data.Items) != 2 {
		t.Fatalf("list projection diverged from registered inventory: %#v", data)
	}
	rendered := root.Render()
	for _, required := range []string{"Start app", "Notes", "API", "Refreshing registered apps"} {
		if !strings.Contains(rendered, required) {
			t.Fatalf("registered app modal missing %q:\n%s", required, rendered)
		}
	}
	if strings.Contains(rendered, "Search:") {
		t.Fatalf("registered app modal leaked help search state:\n%s", rendered)
	}
	selectedID := root.appInventory.SelectedID()
	updated, _ = root.Update(commands.StateLoadedMsg{State: notesFrontendBackendState()})
	root = updated.(RootModel)
	if root.appManagerRefreshing || root.appInventory.SelectedID() != selectedID || !strings.Contains(root.Render(), "Current daemon-backed") {
		t.Fatalf("daemon refresh did not preserve selection/currentness: refreshing=%v before=%q after=%q\n%s", root.appManagerRefreshing, selectedID, root.appInventory.SelectedID(), root.Render())
	}
}

func TestListStartUsesExistingConfirmationAndCancelRestoresList(t *testing.T) {
	root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "api", Name: "API", RuntimeStatus: "running"},
		{ID: "worker", Name: "Worker", RuntimeStatus: "stopped"},
	}})
	root, _ = root.submitSlashCommand("/start")

	updated, command := root.Update(keyPress("down"))
	root = updated.(RootModel)
	if command != nil || root.appInventory.SelectedID() != "worker" {
		t.Fatalf("down did not select stopped worker: selected=%q command=%v", root.appInventory.SelectedID(), command)
	}
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm == nil || !root.appManagerVisible || root.interaction.Owner() != interaction.OwnerModal {
		t.Fatalf("enter did not open confirmation over picker: pending=%#v visible=%v owner=%s command=%v", root.pendingConfirm, root.appManagerVisible, root.interaction.Owner(), command)
	}
	if root.pendingConfirm.Target.AppIDs[0] != "worker" {
		t.Fatalf("confirmation targeted wrong app: %#v", root.pendingConfirm.Target)
	}

	updated, command = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm != nil || !root.appManagerVisible || root.appInventory.SelectedID() != "worker" || root.interaction.Owner() != interaction.OwnerTransient {
		t.Fatalf("cancel did not restore picker selection: pending=%#v visible=%v selected=%q owner=%s command=%v", root.pendingConfirm, root.appManagerVisible, root.appInventory.SelectedID(), root.interaction.Owner(), command)
	}
	if !strings.Contains(root.appManagerNotice, "no request was sent") {
		t.Fatalf("cancel did not provide modal-local recovery notice: %q", root.appManagerNotice)
	}

	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || root.pendingConfirm != nil || root.appManagerVisible || root.interaction.Transient != interaction.TransientNone {
		t.Fatalf("confirmed start did not close picker and issue daemon command: pending=%#v visible=%v transient=%s command=%v", root.pendingConfirm, root.appManagerVisible, root.interaction.Transient, command)
	}
}

func TestListRefusesImplicitRestartAndUnsafeLaunchStates(t *testing.T) {
	for _, status := range []string{"starting", "stopping", "failed", "degraded", "unknown"} {
		t.Run(status, func(t *testing.T) {
			root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "notes", Name: "Notes", RuntimeStatus: status}}})
			root, _ = root.submitSlashCommand("/start")
			updated, command := root.Update(keyPress("enter"))
			root = updated.(RootModel)
			if command != nil || root.pendingConfirm != nil || !root.appManagerVisible || strings.TrimSpace(root.appManagerNotice) == "" {
				t.Fatalf("state %s should fail closed in picker: pending=%#v visible=%v notice=%q command=%v", status, root.pendingConfirm, root.appManagerVisible, root.appManagerNotice, command)
			}
		})
	}
}

func TestListRunningAppOpensItsExistingPaneWithoutLifecycleConfirmation(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{
		Apps:       []relaybaseclient.AppState{{ID: "notes", Name: "Notes", RuntimeStatus: "running", ManifestPath: `C:\work\notes\relaybase.json`}},
		Components: []relaybaseclient.AppComponent{{AppID: "notes", GroupID: "notes", Role: "frontend", PaneLabel: "web", DisplayName: "Notes", Status: "running"}},
	}
	root := applyState(newTestModel(t), state)
	paneID := root.paneManager.SelectedPaneID()
	root.paneManager.CloseSelected()
	root, _ = root.submitSlashCommand("/start")

	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || root.pendingConfirm != nil || root.appManagerVisible || !root.paneManager.Focused() || root.paneManager.SelectedPaneID() != paneID {
		t.Fatalf("running app did not reveal and focus its exact pane: pending=%#v picker=%v focused=%v selected=%q command=%v", root.pendingConfirm, root.appManagerVisible, root.paneManager.Focused(), root.paneManager.SelectedPaneID(), command)
	}
}

func TestListRunningAppWithoutPaneRefreshesOnceAndStaysOpen(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "notes", Name: "Notes", RuntimeStatus: "running"}}}
	root := newTestModel(t)
	root.state = state
	root.connectionStatus = "connected"
	root.appInventory.ApplyState(state)
	root, _ = root.submitSlashCommand("/start")

	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || root.pendingConfirm != nil || !root.appManagerVisible || root.appManagerPaneRefreshID != "notes" || !strings.Contains(root.appManagerNotice, "Refreshing") {
		t.Fatalf("running app without pane did not request a bounded refresh: pending=%#v visible=%v refresh=%q notice=%q command=%v", root.pendingConfirm, root.appManagerVisible, root.appManagerPaneRefreshID, root.appManagerNotice, command)
	}
	updated, _ = root.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{}})
	root = updated.(RootModel)
	if !root.appManagerVisible || root.appManagerPaneRefreshID != "" || !strings.Contains(root.appManagerNotice, "no monitoring pane") {
		t.Fatalf("missing pane refresh did not remain safely in the picker: visible=%v refresh=%q notice=%q", root.appManagerVisible, root.appManagerPaneRefreshID, root.appManagerNotice)
	}
}

func TestListLongInventoryKeepsSelectionVisibleAndSupportsMouseSelection(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{}
	for index := 1; index <= 30; index++ {
		state.Apps = append(state.Apps, relaybaseclient.AppState{ID: fmt.Sprintf("app-%02d", index), Name: fmt.Sprintf("App %02d", index), RuntimeStatus: "stopped"})
	}
	root := applyState(newTestModel(t), state)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	root = updated.(RootModel)
	root, _ = root.submitSlashCommand("/start")

	updated, _ = root.Update(keyPress("end"))
	root = updated.(RootModel)
	if root.appInventory.SelectedID() != "app-30" || root.appManagerOffset == 0 || !strings.Contains(root.Render(), "App 30") {
		t.Fatalf("end selection was not kept visible: selected=%q offset=%d\n%s", root.appInventory.SelectedID(), root.appManagerOffset, root.Render())
	}

	built := mustHitRegion(t, root, components.HitRegisteredAppRow)
	updated, command := root.Update(tea.MouseClickMsg{X: built.Rect.X, Y: built.Rect.Y, Button: tea.MouseLeft})
	root = updated.(RootModel)
	if command != nil || root.appInventory.SelectedIndex() != built.Index {
		t.Fatalf("row click did not select absolute inventory index: selected=%d hit=%d command=%v", root.appInventory.SelectedIndex(), built.Index, command)
	}
	modal := mustHitRegion(t, root, components.HitModal)
	beforeWheel := root.appInventory.SelectedIndex()
	updated, command = root.Update(tea.MouseWheelMsg{X: modal.Rect.X + 1, Y: modal.Rect.Y + 1, Button: tea.MouseWheelUp})
	root = updated.(RootModel)
	if command != nil || root.appInventory.SelectedIndex() != maxInt(0, beforeWheel-3) {
		t.Fatalf("wheel inside modal did not move selection: before=%d after=%d command=%v", beforeWheel, root.appInventory.SelectedIndex(), command)
	}
}

func TestListShowsOfflineEmptyAndRefreshFailureStates(t *testing.T) {
	root := newTestModel(t)
	root.connectionStatus = "offline"
	root.appManagerVisible = true
	root.appManagerMode = appManagerModeStartPicker
	root.appManagerSurface = appManagerSurfaceTable
	root.interaction.OpenTransient(interaction.TransientAppManager)
	if rendered := root.Render(); !strings.Contains(rendered, "Daemon offline") || !strings.Contains(rendered, "/daemon repair") {
		t.Fatalf("offline list guidance missing:\n%s", rendered)
	}
	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm != nil || !strings.Contains(root.appManagerNotice, "unavailable") {
		t.Fatalf("offline picker must not prepare lifecycle work: pending=%#v notice=%q command=%v", root.pendingConfirm, root.appManagerNotice, command)
	}

	updated, _ = root.Update(commands.StateFailedMsg{Err: fmt.Errorf("connection refused")})
	root = updated.(RootModel)
	if root.appManagerRefreshing || !strings.Contains(root.appManagerNotice, "Could not refresh") {
		t.Fatalf("refresh failure was not retained in modal state: refreshing=%v notice=%q", root.appManagerRefreshing, root.appManagerNotice)
	}
}
