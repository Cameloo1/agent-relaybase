package model

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
)

func TestAppManagerActionProjectionEligibilityMatrixAndOrder(t *testing.T) {
	wantOrder := []appManagerActionID{
		appManagerActionOpen, appManagerActionStart, appManagerActionStop, appManagerActionRestart,
		appManagerActionRename, appManagerActionCopyRoute, appManagerActionExportLogs, appManagerActionRepair, appManagerActionUnregister, appManagerActionAddPackage,
	}
	tests := []struct {
		name       string
		status     string
		connected  bool
		stateKnown bool
		panes      int
		route      string
		enabled    []appManagerActionID
	}{
		{name: "running", status: "running", connected: true, stateKnown: true, panes: 1, route: "http://notes.localhost:7777", enabled: []appManagerActionID{appManagerActionOpen, appManagerActionStop, appManagerActionRestart, appManagerActionRename, appManagerActionCopyRoute, appManagerActionExportLogs, appManagerActionRepair, appManagerActionAddPackage}},
		{name: "stopped", status: "stopped", connected: true, stateKnown: true, route: "http://notes.localhost:7777", enabled: []appManagerActionID{appManagerActionStart, appManagerActionRename, appManagerActionCopyRoute, appManagerActionExportLogs, appManagerActionRepair, appManagerActionUnregister, appManagerActionAddPackage}},
		{name: "failed with pane", status: "failed", connected: true, stateKnown: true, panes: 1, route: "http://notes.localhost:7777", enabled: []appManagerActionID{appManagerActionOpen, appManagerActionRestart, appManagerActionRename, appManagerActionCopyRoute, appManagerActionExportLogs, appManagerActionRepair, appManagerActionAddPackage}},
		{name: "degraded without pane", status: "degraded", connected: true, stateKnown: true, route: "http://notes.localhost:7777", enabled: []appManagerActionID{appManagerActionRestart, appManagerActionRename, appManagerActionCopyRoute, appManagerActionExportLogs, appManagerActionRepair, appManagerActionAddPackage}},
		{name: "transition", status: "starting", connected: true, stateKnown: true, route: "http://notes.localhost:7777", enabled: []appManagerActionID{appManagerActionCopyRoute, appManagerActionExportLogs, appManagerActionRepair, appManagerActionAddPackage}},
		{name: "offline last known", status: "stopped", connected: false, stateKnown: true, route: "http://notes.localhost:7777", enabled: []appManagerActionID{appManagerActionCopyRoute}},
		{name: "connected stale", status: "stopped", connected: true, stateKnown: false, route: "http://notes.localhost:7777", enabled: []appManagerActionID{appManagerActionCopyRoute}},
		{name: "no route", status: "stopped", connected: true, stateKnown: true, enabled: []appManagerActionID{appManagerActionStart, appManagerActionRename, appManagerActionExportLogs, appManagerActionRepair, appManagerActionUnregister, appManagerActionAddPackage}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			actions := projectAppManagerActions(appManagerActionContext{
				Item:      inventory.Item{ID: "notes", Status: test.status, Route: test.route, ManifestPath: `C:\work\notes\relaybase.app.json`},
				Connected: test.connected, StateKnown: test.stateKnown, PaneCount: test.panes, PackagesKnown: true,
			})
			gotOrder := make([]appManagerActionID, 0, len(actions))
			gotEnabled := make([]appManagerActionID, 0, len(actions))
			for _, action := range actions {
				gotOrder = append(gotOrder, action.ID)
				if action.Enabled {
					gotEnabled = append(gotEnabled, action.ID)
				} else if strings.TrimSpace(action.DisabledReason) == "" {
					t.Fatalf("disabled action %s has no text reason", action.ID)
				}
			}
			if !reflect.DeepEqual(gotOrder, wantOrder) {
				t.Fatalf("action order=%v want=%v", gotOrder, wantOrder)
			}
			if !reflect.DeepEqual(gotEnabled, test.enabled) {
				t.Fatalf("enabled=%v want=%v", gotEnabled, test.enabled)
			}
		})
	}
}

func TestManageRenameEditorPreservesDraftAcrossPreviewCancelFailureAndRefresh(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{
		ID: "notes", Name: "Notes", RuntimeStatus: "running", ManifestPath: `C:\work\notes\relaybase.app.json`, Route: "http://notes.localhost:7777",
	}}}
	root := applyState(newTestModel(t), state)
	root, _ = root.submitSlashCommand("/manage")
	updated, _ := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	root.appManagerSelectedActionID = appManagerActionRename
	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.appManagerSurface != appManagerSurfaceRename || root.appManagerRenameAppID != "notes" {
		t.Fatalf("rename action did not open dedicated editor: surface=%s app=%q command=%v", root.appManagerSurface, root.appManagerRenameAppID, command)
	}
	root.appManagerRenameInput.SetValue("Notes API")
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || root.appManagerPendingAppID != "notes" || root.appManagerPendingAction != appManagerActionRename {
		t.Fatalf("rename editor did not request exact daemon preview: pending=%q action=%s command=%v", root.appManagerPendingAppID, root.appManagerPendingAction, command)
	}

	preview := &relaybaseclient.AppRenamePreview{PreviewID: "rename-1", CanRename: true, RuntimeStatus: "running"}
	preview.App.ID = "notes"
	preview.App.CurrentName = "Notes"
	preview.App.ProposedName = "Notes API"
	preview.Manifest.Path = `C:\work\notes\relaybase.app.json`
	preview.Manifest.DisplayNameBehavior = "inherited"
	preview.Preserved.StableAppID = "notes"
	preview.Preserved.Route = "http://notes.localhost:7777"
	preview.Preserved.RunningProcess = true
	updated, command = root.Update(commands.AppRenamePreviewedMsg{AppID: "notes", Preview: preview})
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm == nil || root.pendingConfirm.RenamePreview == nil || root.interaction.Owner() != interaction.OwnerModal {
		t.Fatalf("rename preview did not open existing confirmation: pending=%#v owner=%s command=%v", root.pendingConfirm, root.interaction.Owner(), command)
	}
	updated, command = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm != nil || root.appManagerSurface != appManagerSurfaceRename || root.appManagerRenameInput.Value() != "Notes API" || root.appInventory.SelectedID() != "notes" {
		t.Fatalf("rename cancel lost editor recovery path: surface=%s draft=%q selected=%q command=%v", root.appManagerSurface, root.appManagerRenameInput.Value(), root.appInventory.SelectedID(), command)
	}

	root.appManagerPendingAppID = "notes"
	root.appManagerPendingAction = appManagerActionRename
	updated, _ = root.Update(commands.AppRenameFailedMsg{AppID: "notes", Err: fmt.Errorf("manifest drift")})
	root = updated.(RootModel)
	if root.appManagerSurface != appManagerSurfaceRename || root.appManagerRenameInput.Value() != "Notes API" || !strings.Contains(root.appManagerNotice, "draft is preserved") {
		t.Fatalf("rename failure lost draft: surface=%s draft=%q notice=%q", root.appManagerSurface, root.appManagerRenameInput.Value(), root.appManagerNotice)
	}

	root.appManagerPendingAppID = "notes"
	root.appManagerPendingAction = appManagerActionRename
	result := &relaybaseclient.AppRenameResult{Renamed: true}
	result.App.ID = "notes"
	result.App.OldName = "Notes"
	result.App.NewName = "Notes API"
	updated, refresh := root.Update(commands.AppRenamedMsg{AppID: "notes", Result: result})
	root = updated.(RootModel)
	if refresh == nil || root.appManagerSurface != appManagerSurfaceActions || root.appManagerSelectedActionID != appManagerActionRename {
		t.Fatalf("rename success did not return to exact action view: surface=%s action=%s refresh=%v", root.appManagerSurface, root.appManagerSelectedActionID, refresh)
	}
	updated, _ = root.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{
		ID: "notes", Name: "Notes API", RuntimeStatus: "running", ManifestPath: `C:\work\notes\relaybase.app.json`, Route: "http://notes.localhost:7777",
	}}}})
	root = updated.(RootModel)
	if root.appInventory.SelectedID() != "notes" || root.appInventory.Selected().Name != "Notes API" || root.appManagerPendingAction != "" {
		t.Fatalf("renamed refresh lost stable selection or pending cleanup: selected=%q item=%#v pending=%s", root.appInventory.SelectedID(), root.appInventory.Selected(), root.appManagerPendingAction)
	}
}

func TestManageRenameValidationPasteResizeAndStartIsolation(t *testing.T) {
	items := []inventory.Item{{ID: "notes", Name: "Notes"}, {ID: "worker", Name: "Worker"}}
	for _, test := range []struct {
		name  string
		value string
		ok    bool
	}{
		{name: "trim unicode", value: "  Notes API ✓  ", ok: true},
		{name: "empty", value: "   "},
		{name: "overlong", value: strings.Repeat("a", 81)},
		{name: "newline", value: "Notes\nAPI"},
		{name: "terminal", value: "Notes\x1b[2J"},
		{name: "invisible", value: "Notes\u200b"},
		{name: "name collision", value: "worker"},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := validateAppRenameName(test.value, items, "notes")
			if (err == nil) != test.ok {
				t.Fatalf("validation err=%v ok=%v", err, test.ok)
			}
		})
	}

	state := &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "notes", Name: "Notes", RuntimeStatus: "stopped", ManifestPath: `C:\work\notes\relaybase.app.json`}}}
	root := applyState(newTestModel(t), state)
	root, _ = root.submitSlashCommand("/manage")
	updated, _ := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	root.appManagerSelectedActionID = appManagerActionRename
	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	root.appManagerRenameInput.SetValue("")
	updated, _ = root.Update(tea.PasteMsg{Content: "Notes API ✓"})
	root = updated.(RootModel)
	if root.appManagerRenameInput.Value() != "Notes API ✓" {
		t.Fatalf("rename paste did not stay in editor: %q", root.appManagerRenameInput.Value())
	}
	updated, _ = root.Update(tea.WindowSizeMsg{Width: 72, Height: 20})
	root = updated.(RootModel)
	if root.appManagerSurface != appManagerSurfaceRename || root.appManagerRenameInput.Value() != "Notes API ✓" || !strings.Contains(root.Render(), "Stable ID") {
		t.Fatalf("resize/render lost rename editor: surface=%s draft=%q\n%s", root.appManagerSurface, root.appManagerRenameInput.Value(), root.Render())
	}
	updated, _ = root.Update(tea.PasteMsg{Content: "bad\x1b[2J"})
	root = updated.(RootModel)
	if root.appManagerRenameInput.Value() != "Notes API ✓" || !strings.Contains(root.appManagerNotice, "terminal controls") {
		t.Fatalf("unsafe paste changed rename draft: draft=%q notice=%q", root.appManagerRenameInput.Value(), root.appManagerNotice)
	}
	selectedApp := root.appInventory.SelectedID()
	updated, command := root.Update(tea.MouseWheelMsg{X: 1, Y: 1, Button: tea.MouseWheelDown})
	root = updated.(RootModel)
	if command != nil || root.appInventory.SelectedID() != selectedApp || root.appManagerRenameInput.Value() != "Notes API ✓" {
		t.Fatalf("rename editor allowed background wheel mutation: selected=%q draft=%q command=%v", root.appInventory.SelectedID(), root.appManagerRenameInput.Value(), command)
	}

	startRoot := applyState(newTestModel(t), state)
	startRoot, _ = startRoot.submitSlashCommand("/start")
	updated, _ = startRoot.Update(keyPress("enter"))
	startRoot = updated.(RootModel)
	if startRoot.appManagerSurface == appManagerSurfaceRename {
		t.Fatal("bare /start exposed rename editor")
	}
}

func TestManageAndListAliasOpenManageModeWhileStartKeepsPickerMode(t *testing.T) {
	for _, command := range []string{"/manage", "/list"} {
		root := applyState(newTestModel(t), notesFrontendBackendState())
		root, refresh := root.submitSlashCommand(command)
		if refresh == nil || !root.appManagerVisible || root.appManagerMode != appManagerModeManage || root.appManagerSurface != appManagerSurfaceTable {
			t.Fatalf("%s did not open canonical manage mode: visible=%v mode=%s surface=%s refresh=%v", command, root.appManagerVisible, root.appManagerMode, root.appManagerSurface, refresh)
		}
	}
	root := applyState(newTestModel(t), notesFrontendBackendState())
	root, _ = root.submitSlashCommand("/start")
	if root.appManagerMode != appManagerModeStartPicker {
		t.Fatalf("bare /start mode=%s want start-picker", root.appManagerMode)
	}
}

func TestManageActionsCancelAndApprovalPreserveExactSelection(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "api", Name: "API", RuntimeStatus: "running"},
		{ID: "worker", Name: "Worker", RuntimeStatus: "stopped"},
	}}
	root := applyState(newTestModel(t), state)
	root, _ = root.submitSlashCommand("/manage")
	updated, _ := root.Update(keyPress("down"))
	root = updated.(RootModel)
	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if root.appManagerSurface != appManagerSurfaceActions || root.appInventory.SelectedID() != "worker" {
		t.Fatalf("manage did not enter actions for exact app: surface=%s selected=%q", root.appManagerSurface, root.appInventory.SelectedID())
	}
	root.appManagerSelectedActionID = appManagerActionStart
	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm == nil || root.pendingConfirm.Target.AppIDs[0] != "worker" || root.interaction.Owner() != interaction.OwnerModal {
		t.Fatalf("start action did not open exact confirmation: pending=%#v owner=%s command=%v", root.pendingConfirm, root.interaction.Owner(), command)
	}

	updated, command = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm != nil || !root.appManagerVisible || root.appManagerSurface != appManagerSurfaceActions || root.appManagerSelectedActionID != appManagerActionStart || root.appInventory.SelectedID() != "worker" {
		t.Fatalf("cancel did not restore exact manage recovery path: pending=%#v visible=%v surface=%s action=%s selected=%q command=%v", root.pendingConfirm, root.appManagerVisible, root.appManagerSurface, root.appManagerSelectedActionID, root.appInventory.SelectedID(), command)
	}
	if !strings.Contains(root.appManagerNotice, "no mutation request") {
		t.Fatalf("cancel notice=%q", root.appManagerNotice)
	}

	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || root.pendingConfirm != nil || !root.appManagerVisible || root.appManagerSurface != appManagerSurfaceActions || root.appManagerPendingAppID != "worker" {
		t.Fatalf("approved manage action did not keep manager available: pending=%#v visible=%v surface=%s pendingApp=%q command=%v", root.pendingConfirm, root.appManagerVisible, root.appManagerSurface, root.appManagerPendingAppID, command)
	}
}

func TestManageLifecycleFeedbackAndRefreshKeepSelection(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "worker", Name: "Worker", RuntimeStatus: "stopped"}}}
	root := applyState(newTestModel(t), state)
	root, _ = root.submitSlashCommand("/manage")
	root.appManagerSurface = appManagerSurfaceActions
	root.appManagerPendingAppID = "worker"
	root.appManagerPendingAction = appManagerActionStart

	updated, refresh := root.Update(commands.LifecycleRequestedMsg{Action: "start", AppID: "worker", OperationID: "op-1"})
	root = updated.(RootModel)
	if refresh == nil || !root.appManagerRefreshing || root.appInventory.SelectedID() != "worker" || !strings.Contains(root.appManagerNotice, "op-1") {
		t.Fatalf("lifecycle feedback lost manage state: refreshing=%v selected=%q notice=%q refresh=%v", root.appManagerRefreshing, root.appInventory.SelectedID(), root.appManagerNotice, refresh)
	}
	updated, _ = root.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "worker", Name: "Worker", RuntimeStatus: "starting"}}}})
	root = updated.(RootModel)
	if root.appInventory.SelectedID() != "worker" || root.appManagerSurface != appManagerSurfaceActions || !strings.Contains(root.appManagerNotice, "starting") {
		t.Fatalf("transition refresh lost selection/recovery: selected=%q surface=%s notice=%q", root.appInventory.SelectedID(), root.appManagerSurface, root.appManagerNotice)
	}
}

func TestManageDelegatesExportRepairAndUnregisterToExactApp(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{
		ID: "worker", Name: "Worker", RuntimeStatus: "stopped", CWD: `C:\work\worker`, Route: "http://worker.localhost:7777",
	}}}
	root := applyState(newTestModel(t), state)
	root, _ = root.submitSlashCommand("/manage")
	root.appManagerSurface = appManagerSurfaceActions

	root.appManagerSelectedActionID = appManagerActionExportLogs
	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm == nil || root.pendingConfirm.ExportRequest == nil || root.pendingConfirm.ExportRequest.AppID != "worker" {
		t.Fatalf("export did not delegate exact app scope: pending=%#v command=%v", root.pendingConfirm, command)
	}
	updated, _ = root.Update(keyPress("esc"))
	root = updated.(RootModel)

	root.appManagerSelectedActionID = appManagerActionUnregister
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || !root.appManagerVisible || root.appManagerPendingAppID != "worker" || root.appManagerPendingAction != appManagerActionUnregister {
		t.Fatalf("unregister did not delegate preview for exact app: visible=%v pendingApp=%q action=%s command=%v", root.appManagerVisible, root.appManagerPendingAppID, root.appManagerPendingAction, command)
	}

	root.appManagerPendingAppID = ""
	root.appManagerPendingAction = ""
	root.appManagerSelectedActionID = appManagerActionRepair
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || root.appManagerVisible {
		t.Fatalf("repair did not delegate to the daemon setup surface: visible=%v command=%v", root.appManagerVisible, command)
	}
}

func TestManageRefreshAndConfirmationIsolateBackgroundInput(t *testing.T) {
	root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "worker", Name: "Worker", RuntimeStatus: "stopped"}}})
	root, _ = root.submitSlashCommand("/manage")
	updated, refresh := root.Update(keyPress("r"))
	root = updated.(RootModel)
	if refresh == nil || !root.appManagerRefreshing || !strings.Contains(root.appManagerNotice, "Refreshing") {
		t.Fatalf("R did not request bounded manager refresh: refreshing=%v notice=%q command=%v", root.appManagerRefreshing, root.appManagerNotice, refresh)
	}
	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	root.appManagerSelectedActionID = appManagerActionStart
	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if root.pendingConfirm == nil {
		t.Fatal("start action did not open confirmation")
	}
	selectedApp := root.appInventory.SelectedID()
	selectedAction := root.appManagerSelectedActionID
	updated, command := root.Update(tea.MouseWheelMsg{X: 1, Y: 1, Button: tea.MouseWheelDown})
	root = updated.(RootModel)
	if command != nil || root.appInventory.SelectedID() != selectedApp || root.appManagerSelectedActionID != selectedAction || root.pendingConfirm == nil {
		t.Fatalf("confirmation allowed background wheel mutation: app=%q action=%s pending=%#v command=%v", root.appInventory.SelectedID(), root.appManagerSelectedActionID, root.pendingConfirm, command)
	}
	updated, command = root.Update(tea.MouseClickMsg{X: 1, Y: 1, Button: tea.MouseLeft})
	root = updated.(RootModel)
	if command != nil || root.appInventory.SelectedID() != selectedApp || root.appManagerSelectedActionID != selectedAction || root.pendingConfirm == nil {
		t.Fatalf("confirmation allowed background click mutation: app=%q action=%s pending=%#v command=%v", root.appInventory.SelectedID(), root.appManagerSelectedActionID, root.pendingConfirm, command)
	}
}

func TestManageActionMouseAndResizeStayInsideModal(t *testing.T) {
	root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{{ID: "worker", Name: "Worker", RuntimeStatus: "stopped", Route: "http://worker.localhost:7777"}}})
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	root = updated.(RootModel)
	root, _ = root.submitSlashCommand("/manage")
	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	region := mustHitRegion(t, root, components.HitAppManagerAction)
	updated, command := root.Update(tea.MouseClickMsg{X: region.Rect.X, Y: region.Rect.Y, Button: tea.MouseLeft})
	root = updated.(RootModel)
	if command != nil || root.selectedAppManagerActionIndex() != region.Index {
		t.Fatalf("action click escaped modal ownership: selected=%d hit=%d command=%v", root.selectedAppManagerActionIndex(), region.Index, command)
	}
	selectedApp := root.appInventory.SelectedID()
	selectedAction := root.appManagerSelectedActionID
	updated, _ = root.Update(tea.WindowSizeMsg{Width: 72, Height: 20})
	root = updated.(RootModel)
	if root.appInventory.SelectedID() != selectedApp || root.appManagerSelectedActionID != selectedAction || !root.appManagerVisible {
		t.Fatalf("resize reset manage state: app=%q action=%s visible=%v", root.appInventory.SelectedID(), root.appManagerSelectedActionID, root.appManagerVisible)
	}
}
