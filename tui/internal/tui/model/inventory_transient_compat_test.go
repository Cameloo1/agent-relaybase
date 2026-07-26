package model

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/layout"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func TestLongRegisteredInventoryKeepsKeyboardSelectionVisibleAndSupportsWheel(t *testing.T) {
	state := &relaybaseclient.RelaybaseState{}
	for index := 1; index <= 20; index++ {
		state.Apps = append(state.Apps, relaybaseclient.AppState{
			ID:            fmt.Sprintf("inventory-%02d", index),
			Name:          fmt.Sprintf("Inventory App %02d", index),
			RuntimeStatus: "stopped",
		})
	}
	root := applyState(newTestModel(t), state)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	root = updated.(RootModel)
	if !root.inventoryVisible() || len(root.paneManager.CurrentPagePanes()) != 0 {
		t.Fatalf("expected the no-pane registered-app inventory, visible=%v panes=%d", root.inventoryVisible(), len(root.paneManager.CurrentPagePanes()))
	}
	if scrollMax := views.BodyScrollMax(root.styles, root.shellData()); scrollMax <= 0 {
		t.Fatalf("long inventory has no bounded scroll range: %d", scrollMax)
	}

	for index := 0; index < 15; index++ {
		updated, _ = root.Update(keyPress("down"))
		root = updated.(RootModel)
	}
	selected := root.appInventory.Selected()
	if selected == nil || selected.ID != "inventory-16" || root.bodyScrollOffset == 0 {
		t.Fatalf("selection did not advance into the scrolled viewport: selected=%#v offset=%d", selected, root.bodyScrollOffset)
	}
	if rendered := root.Render(); !strings.Contains(rendered, selected.Name) {
		t.Fatalf("selected inventory row moved off-screen: %s\n%s", selected.Name, rendered)
	}

	root.bodyScrollOffset = 0
	metrics := layout.Compute(root.width, root.height, root.composer.Rows())
	updated, _ = root.Update(tea.MouseWheelMsg{
		X:      metrics.Panes.X + 1,
		Y:      metrics.Panes.Y + metrics.Panes.Height - 1,
		Button: tea.MouseWheelDown,
	})
	root = updated.(RootModel)
	if root.bodyScrollOffset == 0 {
		t.Fatal("wheel over the inventory pane band did not move its bounded viewport")
	}
}

func TestTransientOutsideClickClosesWithoutActivatingBackground(t *testing.T) {
	t.Run("code_picker", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		updated, _ := root.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
		root = updated.(RootModel)
		root.addAssistantMessage("```go\nfmt.Println(\"safe\")\n```")
		root.commandInput = "preserved draft"
		root.composer.SetValue(root.commandInput)
		root.setPrimaryFocus(interaction.FocusResponse)
		root, _ = root.openCodePicker()
		if !root.codePickerVisible {
			t.Fatal("code picker did not open")
		}
		root = assertTransientInteriorIsInert(t, root, "code picker")

		composer := mustHitRegion(t, root, components.HitComposer)
		modal := mustHitRegion(t, root, components.HitModal)
		click := tea.MouseClickMsg{X: composer.Rect.X + 1, Y: composer.Rect.Y + composer.Rect.Height - 1, Button: tea.MouseLeft}
		if modal.Rect.Contains(click.X, click.Y) {
			t.Fatalf("test background point unexpectedly falls inside code picker: modal=%#v click=%#v", modal.Rect, click)
		}
		updated, command := root.Update(click)
		root = updated.(RootModel)
		if command != nil || root.codePickerVisible || root.interaction.Owner() != interaction.OwnerResponse || root.commandInput != "preserved draft" {
			t.Fatalf("outside click leaked into background: visible=%v owner=%s draft=%q command=%v", root.codePickerVisible, root.interaction.Owner(), root.commandInput, command)
		}
	})

	t.Run("thread_switcher", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		updated, _ := root.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
		root = updated.(RootModel)
		root.agentConfig = &relaybaseclient.AgentConfig{Enabled: true}
		root.agentSession = &relaybaseclient.AgentSession{ID: "thread-1", Title: "Current"}
		for index := 1; index <= 5; index++ {
			root.agentSessions = append(root.agentSessions, relaybaseclient.AgentSession{ID: fmt.Sprintf("thread-%d", index), Title: fmt.Sprintf("Thread %d", index)})
		}
		root.commandInput = "thread draft"
		root.composer.SetValue(root.commandInput)
		root.setPrimaryFocus(interaction.FocusResponse)
		root, command := root.openThreadSwitcher()
		if command != nil || !root.threadSwitcherVisible {
			t.Fatalf("thread switcher did not open from cached sessions: visible=%v command=%v", root.threadSwitcherVisible, command)
		}
		root = assertTransientInteriorIsInert(t, root, "thread switcher")

		composer := mustHitRegion(t, root, components.HitComposer)
		modal := mustHitRegion(t, root, components.HitModal)
		click := tea.MouseClickMsg{X: composer.Rect.X + 1, Y: composer.Rect.Y + composer.Rect.Height - 1, Button: tea.MouseLeft}
		if modal.Rect.Contains(click.X, click.Y) {
			t.Fatalf("test background point unexpectedly falls inside thread switcher: modal=%#v click=%#v", modal.Rect, click)
		}
		updated, command = root.Update(click)
		root = updated.(RootModel)
		if command != nil || root.threadSwitcherVisible || root.interaction.Owner() != interaction.OwnerResponse || root.commandInput != "thread draft" {
			t.Fatalf("outside click leaked into background: visible=%v owner=%s draft=%q command=%v", root.threadSwitcherVisible, root.interaction.Owner(), root.commandInput, command)
		}
	})
}

func TestAgentApprovalWheelCannotScrollBackgroundResponse(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 36})
	root = updated.(RootModel)
	root.responseFollow = false
	root.responseOffset = 4
	root.pendingAgentApproval = &relaybaseclient.AgentApproval{ID: "approval-wheel", Status: "pending"}
	root.interaction.OpenModal(interaction.ModalAgentApproval)
	responseRegion := mustHitRegion(t, root, components.HitResponse)
	modal := mustHitRegion(t, root, components.HitModal)
	pointY := responseRegion.Rect.Y + responseRegion.Rect.Height - 1
	if modal.Rect.Contains(responseRegion.Rect.X+1, pointY) {
		t.Fatalf("test response point unexpectedly falls inside approval modal: modal=%#v response=%#v", modal.Rect, responseRegion.Rect)
	}
	updated, command := root.Update(tea.MouseWheelMsg{X: responseRegion.Rect.X + 1, Y: pointY, Button: tea.MouseWheelDown})
	root = updated.(RootModel)
	if command != nil || root.responseOffset != 4 || root.bodyScrollOffset != 0 {
		t.Fatalf("approval wheel leaked to background: response=%d body=%d command=%v", root.responseOffset, root.bodyScrollOffset, command)
	}
}

func TestRealSearchableHelpRetainsGlobalAndPanePagingLegend(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	root = updated.(RootModel)
	updated, command := root.Update(keyPress("?"))
	root = updated.(RootModel)
	if command != nil || !root.helpVisible || root.helpDataForView() == nil {
		t.Fatalf("real searchable help did not open: visible=%v command=%v", root.helpVisible, command)
	}
	for _, required := range []string{"Ctrl+O", "PgUp/PgDn: pages", "focused logs/older"} {
		if rendered := root.Render(); !strings.Contains(rendered, required) {
			t.Fatalf("real searchable help omitted legacy guidance %q:\n%s", required, rendered)
		}
	}

	root.helpDetailOffset = 10_000
	rendered := root.Render()
	for _, required := range []string{"q/ctrl+c: quit", "Dashboard PageUp/PageDown", "Focused pane PageUp/PageDown"} {
		if !strings.Contains(rendered, required) {
			t.Fatalf("scrollable real help detail omitted full-key/paging guidance %q:\n%s", required, rendered)
		}
	}
}

func assertTransientInteriorIsInert(t *testing.T, root RootModel, name string) RootModel {
	t.Helper()
	modal := mustHitRegion(t, root, components.HitModal)
	updated, command := root.Update(tea.MouseClickMsg{X: modal.Rect.X, Y: modal.Rect.Y, Button: tea.MouseLeft})
	root = updated.(RootModel)
	if command != nil {
		t.Fatalf("%s border click returned a command", name)
	}
	if name == "code picker" && !root.codePickerVisible || name == "thread switcher" && !root.threadSwitcherVisible {
		t.Fatalf("%s interior/border click closed the transient", name)
	}
	return root
}
