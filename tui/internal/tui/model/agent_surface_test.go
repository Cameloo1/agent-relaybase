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

func TestAgentPaneReopenRestoresArrowAndWheelScrolling(t *testing.T) {
	root := newTestModelWithPanes(t, 3)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 36})
	root = updated.(RootModel)
	root.historyExpanded = true
	for index := 0; index < 60; index++ {
		root.assistantTimeline = append(root.assistantTimeline, fmt.Sprintf("response line %02d with wrapped output", index+1))
	}
	root.responseFollow = true
	bottom := views.ResponseScrollMax(root.styles, root.shellData())
	if bottom == 0 {
		t.Fatal("test response is not scrollable")
	}

	updated, _ = root.Update(agentPaneKey())
	root = updated.(RootModel)
	updated, _ = root.Update(agentPaneKey())
	root = updated.(RootModel)
	if root.interaction.Owner() != interaction.OwnerResponse {
		t.Fatalf("reopened Agent pane owner = %s, want response", root.interaction.Owner())
	}

	updated, _ = root.Update(keyPress("up"))
	root = updated.(RootModel)
	if root.responseFollow || root.responseOffset != bottom-1 {
		t.Fatalf("arrow scroll after reopen: follow=%v offset=%d want=%d", root.responseFollow, root.responseOffset, bottom-1)
	}

	region := mustHitRegion(t, root, components.HitResponse)
	beforeWheel := root.responseOffset
	updated, _ = root.Update(tea.MouseWheelMsg{X: region.Rect.X + 1, Y: region.Rect.Y + 1, Button: tea.MouseWheelUp})
	root = updated.(RootModel)
	if root.responseOffset >= beforeWheel {
		t.Fatalf("wheel scroll after reopen did not move upward: before=%d after=%d", beforeWheel, root.responseOffset)
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

func TestFullAgentChatRestoresWorkspaceComposerAndIndependentScroll(t *testing.T) {
	root := newTestModelWithPanes(t, 9)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	selectedID := root.paneManager.SelectedPaneID()
	page := root.paneManager.Page()
	root.commandInput = "preserve this draft"
	root.composer.SetValue(root.commandInput)
	root.setPrimaryFocus(interaction.FocusComposer)
	root.responseOffset = 3
	root.responseFollow = false
	root.agentFullResponseOffset = 0
	root.agentFullResponseFollow = true

	updated, _ = root.Update(agentChatKey())
	root = updated.(RootModel)
	if !root.agentChatFull || root.interaction.Owner() != interaction.OwnerResponse {
		t.Fatalf("F6 did not open full Agent Chat: full=%v owner=%s", root.agentChatFull, root.interaction.Owner())
	}
	frame := views.BuildShell(root.styles, root.shellData())
	if hasHitKind(frame.HitMap.Regions(), components.HitPaneLogs) || !hasHitKind(frame.HitMap.Regions(), components.HitResponse) {
		t.Fatalf("full Agent Chat did not exclusively own the upper surface: %#v", frame.HitMap.Regions())
	}

	updated, _ = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if root.agentChatFull || root.interaction.Owner() != interaction.OwnerComposer || root.commandInput != "preserve this draft" {
		t.Fatalf("workspace restoration failed: full=%v owner=%s draft=%q", root.agentChatFull, root.interaction.Owner(), root.commandInput)
	}
	if root.responseOffset != 3 || root.responseFollow || root.paneManager.SelectedPaneID() != selectedID || root.paneManager.Page() != page {
		t.Fatalf("workspace identity changed: offset=%d follow=%v selected=%q page=%d", root.responseOffset, root.responseFollow, root.paneManager.SelectedPaneID(), root.paneManager.Page())
	}
}

func TestAgentTranscriptClickAndKeyboardExpansion(t *testing.T) {
	root := newTestModelWithPanes(t, 3)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	root.agentTranscript = []views.AgentTranscriptItem{{
		ID: "tool:1", Kind: "tool", State: "completed", Label: "Inspected project",
		Output: "one\ntwo\nthree\nfour\nfive\nsix", OutputLineCount: 6, Sequence: 1, UpdatedSequence: 2,
	}}
	root.agentTranscriptSelected = "tool:1"
	updated, _ = root.Update(agentChatKey())
	root = updated.(RootModel)
	frame := views.BuildShell(root.styles, root.shellData())
	var trace components.HitRegion
	found := false
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == components.HitAgentTranscript && region.ItemID == "tool:1" {
			trace, found = region, true
			break
		}
	}
	if !found {
		t.Fatalf("trace hit region missing: %#v", frame.HitMap.Regions())
	}
	updated, _ = root.Update(tea.MouseClickMsg{X: trace.Rect.X, Y: trace.Rect.Y, Button: tea.MouseLeft})
	root = updated.(RootModel)
	if !root.agentTranscriptExpanded["tool:1"] {
		t.Fatal("click did not expand selected trace")
	}
	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if root.agentTranscriptExpanded["tool:1"] {
		t.Fatal("Enter did not collapse selected trace")
	}
	updated, _ = root.Update(tea.KeyPressMsg{Code: tea.KeySpace, Text: " "})
	root = updated.(RootModel)
	if !root.agentTranscriptExpanded["tool:1"] {
		t.Fatal("Space did not expand selected trace")
	}
	root.agentTranscriptExpanded["tool:1"] = false
	updated, _ = root.Update(tea.KeyPressMsg{Code: 'e', Mod: tea.ModCtrl})
	root = updated.(RootModel)
	if !root.agentTranscriptExpanded["tool:1"] {
		t.Fatal("Ctrl+E did not expand trace details")
	}
}

func TestClickingDeepInsideVirtualizedToolOutputCollapsesWithoutJumpingAway(t *testing.T) {
	root := newTestModelWithPanes(t, 3)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	root.agentTranscript = []views.AgentTranscriptItem{{
		ID: "tool:large", Kind: "tool", State: "completed", Label: "Read output",
		Output: strings.Repeat("virtualized output row\n", 2_000), OutputLineCount: 2_000, Sequence: 1, UpdatedSequence: 1,
	}}
	root.agentTranscriptExpanded["tool:large"] = true
	root.agentTranscriptSelected = "tool:large"
	root.preferences.Layout.AgentPaneCollapsed = true
	updated, _ = root.Update(agentPaneKey())
	root = updated.(RootModel)
	root.responseFollow = false
	root.responseOffset = 1_000
	frame := views.BuildShell(root.styles, root.shellData())
	var trace components.HitRegion
	found := false
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == components.HitAgentTranscript && region.ItemID == "tool:large" {
			trace, found = region, true
			break
		}
	}
	if !found {
		t.Fatalf("deep expanded result had no visible hit region: %#v", frame.HitMap.Regions())
	}
	updated, _ = root.Update(tea.MouseClickMsg{X: trace.Rect.X, Y: trace.Rect.Y, Button: tea.MouseLeft})
	root = updated.(RootModel)
	if root.agentTranscriptExpanded["tool:large"] || root.responseOffset != 0 || root.responseFollow {
		t.Fatalf("deep collapse lost its stable anchor: expanded=%v offset=%d follow=%v", root.agentTranscriptExpanded["tool:large"], root.responseOffset, root.responseFollow)
	}
}

func TestVirtualTranscriptResizePreservesLogicalAnchorInDockAndFullChat(t *testing.T) {
	for _, full := range []bool{false, true} {
		name := "dock"
		if full {
			name = "full"
		}
		t.Run(name, func(t *testing.T) {
			root := newTestModelWithPanes(t, 3)
			updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
			root = updated.(RootModel)
			root.agentTranscript = []views.AgentTranscriptItem{{
				ID: "tool:resize", Kind: "tool", State: "completed", Label: "Read output",
				Output: strings.Repeat("short row\n", 500), OutputLineCount: 500, Sequence: 1, UpdatedSequence: 1,
			}}
			root.agentTranscriptExpanded["tool:resize"] = true
			root.agentTranscriptSelected = "tool:resize"
			if full {
				updated, _ = root.Update(agentChatKey())
				root = updated.(RootModel)
				root.agentFullResponseFollow = false
				root.agentFullResponseOffset = 120
			} else {
				root.preferences.Layout.AgentPaneCollapsed = true
				updated, _ = root.Update(agentPaneKey())
				root = updated.(RootModel)
				root.responseFollow = false
				root.responseOffset = 120
			}
			before, ok := views.ResponseTranscriptAnchor(root.styles, root.shellData())
			if !ok {
				t.Fatal("missing transcript anchor before resize")
			}
			updated, _ = root.Update(tea.WindowSizeMsg{Width: 190, Height: 44})
			root = updated.(RootModel)
			after, ok := views.ResponseTranscriptAnchor(root.styles, root.shellData())
			if !ok || after != before {
				t.Fatalf("resize changed transcript anchor: before=%#v after=%#v ok=%v", before, after, ok)
			}
		})
	}
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

func agentChatKey() tea.KeyPressMsg {
	return tea.KeyPressMsg{Code: tea.KeyF6}
}
