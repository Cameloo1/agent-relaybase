package model

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func TestAgentPaneTogglePreservesLastPageSelectionAndFocus(t *testing.T) {
	for _, paneCount := range []int{8, 9, 16} {
		t.Run(fmt.Sprintf("%d-panes", paneCount), func(t *testing.T) {
			root := newTestModelWithPanes(t, paneCount)
			updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
			root = updated.(RootModel)
			lastID := fmt.Sprintf("app-%d:app-%d-web:frontend:frontend", paneCount, paneCount)
			if !root.paneManager.SelectPane(lastID) {
				t.Fatalf("could not select last pane %q", lastID)
			}
			root.paneManager.FocusSelected()

			updated, command := root.Update(agentPaneKey())
			root = updated.(RootModel)
			if command == nil || !root.preferences.Layout.AgentPaneCollapsed || root.operatorMetrics().AgentDocked {
				t.Fatalf("Ctrl+G did not collapse and persist the Agent pane: collapsed=%v metrics=%#v command=%v", root.preferences.Layout.AgentPaneCollapsed, root.operatorMetrics(), command)
			}
			assertAgentPaneIdentity(t, root, lastID, true)

			updated, command = root.Update(agentPaneKey())
			root = updated.(RootModel)
			if command == nil || root.preferences.Layout.AgentPaneCollapsed || !root.operatorMetrics().AgentDocked || root.interaction.Owner() != interaction.OwnerResponse {
				t.Fatalf("Ctrl+G did not reopen and focus the Agent pane: collapsed=%v metrics=%#v owner=%s command=%v", root.preferences.Layout.AgentPaneCollapsed, root.operatorMetrics(), root.interaction.Owner(), command)
			}
			assertAgentPaneIdentity(t, root, lastID, true)

			updated, _ = root.Update(keyPress("esc"))
			root = updated.(RootModel)
			if root.interaction.Owner() != interaction.OwnerPanes {
				t.Fatalf("Escape restored %s, want pane input ownership", root.interaction.Owner())
			}
			assertAgentPaneIdentity(t, root, lastID, true)
		})
	}
}

func TestAgentPaneRestoresComposerDraftAndFocus(t *testing.T) {
	root := newTestModelWithPanes(t, 3)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 36})
	root = updated.(RootModel)
	updated, _ = root.Update(agentPaneKey())
	root = updated.(RootModel)
	root.commandInput = "keep this draft"
	root.composer.SetValue(root.commandInput)
	root.setPrimaryFocus(interaction.FocusComposer)

	updated, _ = root.Update(agentPaneKey())
	root = updated.(RootModel)
	if root.interaction.Owner() != interaction.OwnerResponse || root.commandInput != "keep this draft" {
		t.Fatalf("opening Agent lost composer state: owner=%s draft=%q", root.interaction.Owner(), root.commandInput)
	}
	updated, _ = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if root.interaction.Owner() != interaction.OwnerComposer || !root.commandActive || !root.composer.Focused() || root.commandInput != "keep this draft" {
		t.Fatalf("Escape did not restore Composer atomically: owner=%s active=%v focused=%v draft=%q", root.interaction.Owner(), root.commandActive, root.composer.Focused(), root.commandInput)
	}
}

func TestAgentModalFallbackOwnsInputAndDoesNotMovePanePage(t *testing.T) {
	root := newTestModelWithPanes(t, 9)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	root = updated.(RootModel)
	if root.operatorMetrics().AgentDockable {
		t.Fatalf("100-column terminal unexpectedly docked Agent: %#v", root.operatorMetrics())
	}
	root.assistantTimeline = make([]string, 60)
	for index := range root.assistantTimeline {
		root.assistantTimeline[index] = fmt.Sprintf("modal response line %02d with wrapped output", index+1)
	}
	root.historyExpanded = true
	root.responseFollow = true
	pageBefore := root.paneManager.Page()

	updated, _ = root.Update(agentPaneKey())
	root = updated.(RootModel)
	if !root.responseDetailsVisible() || root.interaction.Owner() != interaction.OwnerTransient {
		t.Fatalf("narrow Ctrl+G did not open the dedicated Agent modal: transient=%q owner=%s", root.interaction.Transient, root.interaction.Owner())
	}
	frame := views.BuildShell(root.styles, root.shellData())
	if !hasHitKind(frame.HitMap.Regions(), components.HitModal) || !hasHitKind(frame.HitMap.Regions(), components.HitResponse) || hasHitKind(frame.HitMap.Regions(), components.HitPaneLogs) {
		t.Fatalf("Agent modal hit ownership is not exclusive: %#v", frame.HitMap.Regions())
	}

	updated, _ = root.Update(keyPress("pgup"))
	root = updated.(RootModel)
	if root.responseFollow || root.responseOffset >= views.ResponseScrollMax(root.styles, root.shellData()) || root.paneManager.Page() != pageBefore {
		t.Fatalf("Agent modal PageUp escaped response ownership: follow=%v offset=%d page=%d want-page=%d", root.responseFollow, root.responseOffset, root.paneManager.Page(), pageBefore)
	}

	updated, _ = root.Update(agentPaneKey())
	root = updated.(RootModel)
	if root.responseDetailsVisible() || root.paneManager.Page() != pageBefore {
		t.Fatalf("closing Agent modal changed pane pagination: visible=%v page=%d want=%d", root.responseDetailsVisible(), root.paneManager.Page(), pageBefore)
	}
}

func TestAgentSurfaceTransitionsBetweenDockAndModalOnResize(t *testing.T) {
	root := newTestModelWithPanes(t, 16)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	lastID := "app-16:app-16-web:frontend:frontend"
	if !root.paneManager.SelectPane(lastID) {
		t.Fatalf("could not select %q", lastID)
	}
	root.paneManager.FocusSelected()
	root.setPrimaryFocus(interaction.FocusResponse)

	updated, _ = root.Update(tea.WindowSizeMsg{Width: 100, Height: 40})
	root = updated.(RootModel)
	if root.operatorMetrics().AgentDocked || !root.responseDetailsVisible() || root.interaction.Owner() != interaction.OwnerTransient {
		t.Fatalf("dock did not become modal on shrink: metrics=%#v transient=%q owner=%s", root.operatorMetrics(), root.interaction.Transient, root.interaction.Owner())
	}
	assertAgentPaneIdentity(t, root, lastID, true)

	updated, _ = root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	if !root.operatorMetrics().AgentDocked || root.responseDetailsVisible() || root.interaction.Owner() != interaction.OwnerResponse {
		t.Fatalf("modal did not become dock on grow: metrics=%#v transient=%q owner=%s", root.operatorMetrics(), root.interaction.Transient, root.interaction.Owner())
	}
	assertAgentPaneIdentity(t, root, lastID, true)
}

func TestAgentOutputRefreshDoesNotRemapPaneLayoutOrPage(t *testing.T) {
	root := newTestModelWithPanes(t, 16)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	lastID := "app-16:app-16-web:frontend:frontend"
	root.paneManager.SelectPane(lastID)
	root.paneManager.FocusSelected()
	beforeLayout := root.paneManager.Layout()
	beforePage := root.paneManager.Page()

	root.addAssistantMessage(strings.Repeat("status output ", 8))
	if root.paneManager.Layout() != beforeLayout || root.paneManager.Page() != beforePage {
		t.Fatalf("Agent output refresh remapped panes: before=%#v/page%d after=%#v/page%d", beforeLayout, beforePage, root.paneManager.Layout(), root.paneManager.Page())
	}
	assertAgentPaneIdentity(t, root, lastID, true)
}

func assertAgentPaneIdentity(t *testing.T, root RootModel, paneID string, focused bool) {
	t.Helper()
	if root.paneManager.SelectedPaneID() != paneID {
		t.Fatalf("selected pane = %q, want %q", root.paneManager.SelectedPaneID(), paneID)
	}
	if root.paneManager.Page() < 0 || root.paneManager.Page() >= root.paneManager.PageCount() {
		t.Fatalf("pane page escaped bounds: page=%d count=%d", root.paneManager.Page(), root.paneManager.PageCount())
	}
	if focused {
		pane := root.paneManager.FocusedPane()
		if pane == nil || pane.ID != paneID {
			t.Fatalf("focused pane = %#v, want %q", pane, paneID)
		}
	}
}

func hasHitKind(regions []components.HitRegion, kind components.HitKind) bool {
	for _, region := range regions {
		if region.Kind == kind {
			return true
		}
	}
	return false
}

func agentPaneKey() tea.KeyPressMsg {
	return tea.KeyPressMsg{Code: 'g', Mod: tea.ModCtrl}
}
