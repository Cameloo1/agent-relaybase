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

func TestPaneReopenChooserShowsRecentClosesAndRestoresExactSelection(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{
		Apps: []relaybaseclient.AppState{
			{ID: "alpha", Name: "Alpha", RuntimeStatus: "running", ManifestPath: `C:\work\alpha\relaybase.json`},
			{ID: "beta", Name: "Beta", RuntimeStatus: "running", ManifestPath: `C:\work\beta\relaybase.json`},
		},
		Components: []relaybaseclient.AppComponent{
			{AppID: "alpha", GroupID: "alpha", Role: "frontend", PaneLabel: "web", DisplayName: "Alpha", Status: "running"},
			{AppID: "beta", GroupID: "beta", Role: "backend", PaneLabel: "api", DisplayName: "Beta", Status: "running"},
		},
	}
	root := applyState(newTestModel(t), state)
	first := root.paneManager.SelectedPaneID()
	root.paneManager.CloseSelected()
	second := root.paneManager.SelectedPaneID()
	root.paneManager.CloseSelected()
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 90, Height: 26})
	root = updated.(RootModel)
	if !root.openPaneReopen("") {
		t.Fatal("expected recently closed panes to open the chooser")
	}
	candidates := root.paneReopenCandidates()
	if len(candidates) != 2 || candidates[0].PaneID != second || candidates[1].PaneID != first {
		t.Fatalf("chooser order=%#v, want most recent close first", candidates)
	}
	if root.interaction.Transient != interaction.TransientPaneReopen || !strings.Contains(root.Render(), "Name") || !strings.Contains(root.Render(), "Project") || !strings.Contains(root.Render(), "Status") {
		t.Fatalf("dedicated pane chooser did not render its table: transient=%s\n%s", root.interaction.Transient, root.Render())
	}

	row := mustHitRegion(t, root, components.HitPaneReopenRow)
	updated, command := root.Update(tea.MouseClickMsg{X: row.Rect.X, Y: row.Rect.Y, Button: tea.MouseLeft})
	root = updated.(RootModel)
	if command != nil || root.paneReopenSelected != row.Index {
		t.Fatalf("reopen row click did not select its absolute candidate: selected=%d row=%d command=%v", root.paneReopenSelected, row.Index, command)
	}
	updated, command = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || root.paneReopenVisible || !root.paneManager.Focused() || root.paneManager.SelectedPaneID() != candidates[row.Index].PaneID {
		t.Fatalf("chooser did not restore exact pane: visible=%v focused=%v selected=%q command=%v", root.paneReopenVisible, root.paneManager.Focused(), root.paneManager.SelectedPaneID(), command)
	}
}

func TestListRunningAppWithMultiplePanesOpensFilteredChooser(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{
		Apps: []relaybaseclient.AppState{{ID: "suite", Name: "Suite", RuntimeStatus: "running", ManifestPath: `C:\work\suite\relaybase.json`}},
		Components: []relaybaseclient.AppComponent{
			{AppID: "suite", GroupID: "suite", Role: "frontend", PaneLabel: "web", DisplayName: "Suite", Status: "running"},
			{AppID: "suite", GroupID: "suite", Role: "worker", PaneLabel: "worker", DisplayName: "Suite", Status: "running"},
		},
	}
	root := applyState(newTestModel(t), state)
	root, _ = root.submitSlashCommand("/list")
	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.pendingConfirm != nil || root.appListVisible || !root.paneReopenVisible || root.paneReopenAppID != "suite" || root.interaction.Transient != interaction.TransientPaneReopen {
		t.Fatalf("multi-pane running app did not switch to filtered chooser: pending=%#v list=%v reopen=%v filter=%q transient=%s command=%v", root.pendingConfirm, root.appListVisible, root.paneReopenVisible, root.paneReopenAppID, root.interaction.Transient, command)
	}
	if candidates := root.paneReopenCandidates(); len(candidates) != 2 {
		t.Fatalf("filtered chooser candidates=%#v, want both running app panes", candidates)
	}
}

func TestPaneReopenRefreshClosesSafelyWhenCandidatesDisappear(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{
		Apps:       []relaybaseclient.AppState{{ID: "alpha", Name: "Alpha", RuntimeStatus: "running"}},
		Components: []relaybaseclient.AppComponent{{AppID: "alpha", GroupID: "alpha", Role: "frontend", PaneLabel: "web", DisplayName: "Alpha", Status: "running"}},
	}
	root := applyState(newTestModel(t), state)
	root.paneManager.CloseSelected()
	if !root.openPaneReopen("") {
		t.Fatal("expected hidden pane chooser")
	}
	updated, _ := root.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{}})
	root = updated.(RootModel)
	if root.paneReopenVisible || root.interaction.Transient != interaction.TransientNone {
		t.Fatalf("empty refresh did not close chooser: visible=%v transient=%s", root.paneReopenVisible, root.interaction.Transient)
	}
	if history := strings.Join(root.assistantHistoryForView(), "\n"); !strings.Contains(history, "No hidden pane remains available") {
		t.Fatalf("empty refresh did not report safe recovery notice: %q", history)
	}
}

func TestPaneReopenRefreshPreservesSelectionByPaneID(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{Components: []relaybaseclient.AppComponent{
		{AppID: "alpha", GroupID: "alpha", Role: "frontend", PaneLabel: "web", DisplayName: "Alpha", Status: "running"},
		{AppID: "beta", GroupID: "beta", Role: "backend", PaneLabel: "api", DisplayName: "Beta", Status: "running"},
	}}
	root := applyState(newTestModel(t), state)
	root.paneManager.CloseSelected()
	root.paneManager.CloseSelected()
	if !root.openPaneReopen("") {
		t.Fatal("expected hidden pane chooser")
	}
	updated, _ := root.Update(keyPress("down"))
	root = updated.(RootModel)
	selectedID := root.paneReopenSelectedID
	selected := root.paneManager.PaneSnapshot(selectedID)
	if selected == nil {
		t.Fatalf("selected candidate %q is missing", selectedID)
	}
	updated, _ = root.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{Components: []relaybaseclient.AppComponent{
		{AppID: selected.AppID, GroupID: selected.GroupID, Role: selected.Role, PaneLabel: selected.PaneLabel, DisplayName: selected.DisplayName, Status: selected.Status},
	}}})
	root = updated.(RootModel)
	if !root.paneReopenVisible || root.paneReopenSelectedID != selectedID || root.paneReopenCandidates()[root.paneReopenSelected].PaneID != selectedID {
		t.Fatalf("refresh did not preserve exact selected pane: visible=%v selectedID=%q index=%d candidates=%#v", root.paneReopenVisible, root.paneReopenSelectedID, root.paneReopenSelected, root.paneReopenCandidates())
	}
}

func TestPaneReopenChooserNavigationWheelPagingAndEscape(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{}
	for index := 1; index <= 16; index++ {
		id := fmt.Sprintf("app-%02d", index)
		state.Apps = append(state.Apps, relaybaseclient.AppState{ID: id, Name: "App " + id, RuntimeStatus: "running"})
		state.Components = append(state.Components, relaybaseclient.AppComponent{AppID: id, GroupID: id, Role: "other", PaneLabel: "app", DisplayName: "App " + id, Status: "running"})
	}
	root := applyState(newTestModel(t), state)
	for root.paneManager.SelectedPane() != nil {
		root.paneManager.CloseSelected()
	}
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	root = updated.(RootModel)
	if !root.openPaneReopen("") {
		t.Fatal("expected reopen chooser")
	}
	updated, _ = root.Update(keyPress("end"))
	root = updated.(RootModel)
	if root.paneReopenSelected != 15 || root.paneReopenOffset == 0 {
		t.Fatalf("End did not keep final candidate visible: selected=%d offset=%d", root.paneReopenSelected, root.paneReopenOffset)
	}
	modal := mustHitRegion(t, root, components.HitModal)
	updated, command := root.Update(tea.MouseWheelMsg{X: modal.Rect.X + 1, Y: modal.Rect.Y + 1, Button: tea.MouseWheelUp})
	root = updated.(RootModel)
	if command != nil || root.paneReopenSelected != 12 {
		t.Fatalf("modal wheel did not move reopen selection: selected=%d command=%v", root.paneReopenSelected, command)
	}
	updated, _ = root.Update(keyPress("home"))
	root = updated.(RootModel)
	updated, _ = root.Update(keyPress("pgdown"))
	root = updated.(RootModel)
	if root.paneReopenSelected != root.paneReopenPageSize() {
		t.Fatalf("PageDown moved to %d, want one page %d", root.paneReopenSelected, root.paneReopenPageSize())
	}
	updated, command = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if command != nil || root.paneReopenVisible || root.interaction.Transient != interaction.TransientNone || len(root.paneManager.VisiblePanes()) != 0 {
		t.Fatalf("Esc changed pane state or failed to close chooser: visible=%v transient=%s panes=%#v command=%v", root.paneReopenVisible, root.interaction.Transient, root.paneManager.VisiblePanes(), command)
	}
}
