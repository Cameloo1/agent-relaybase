package model

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func TestCtrlRStopsSelectedPaneThroughConfirmation(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	selected := root.paneManager.SelectedPane()
	if selected == nil {
		t.Fatal("missing selected pane")
	}

	updated, command := root.Update(ctrlKey("r"))
	model := updated.(RootModel)
	if command != nil || model.pendingConfirm == nil {
		t.Fatalf("Ctrl+R must prepare, not execute, stop: command=%v pending=%#v", command, model.pendingConfirm)
	}
	if model.pendingConfirm.Command.Kind != slash.KindStop {
		t.Fatalf("Ctrl+R prepared the wrong lifecycle action: %#v", model.pendingConfirm.Command)
	}
	if apps := model.pendingConfirm.Target.AppIDs; len(apps) != 1 || apps[0] != selected.AppID {
		t.Fatalf("Ctrl+R targeted the wrong selected app: %#v", model.pendingConfirm.Target)
	}
}

func TestPlainRRemainsComposerInput(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, command := root.Update(keyPress("r"))
	model := updated.(RootModel)
	if command != nil || model.pendingConfirm != nil || model.CommandInput() != "r" {
		t.Fatalf("plain r must remain input: command=%v pending=%#v input=%q", command, model.pendingConfirm, model.CommandInput())
	}
	if model.interaction.Owner() != interaction.OwnerComposer {
		t.Fatalf("plain r should transfer ownership to the composer, got %s", model.interaction.Owner())
	}
}

func TestCtrlRRespectsResponseComposerAndModalOwnership(t *testing.T) {
	response := newTestModelWithPanes(t, 1)
	response.setPrimaryFocus(interaction.FocusResponse)
	updated, command := response.Update(ctrlKey("r"))
	response = updated.(RootModel)
	if command != nil || response.pendingConfirm != nil || response.interaction.Owner() != interaction.OwnerResponse {
		t.Fatalf("response ownership must retain Ctrl+R: command=%v pending=%#v owner=%s", command, response.pendingConfirm, response.interaction.Owner())
	}

	composer := typeAssistantText(t, newTestModelWithPanes(t, 1), "draft")
	updated, command = composer.Update(ctrlKey("r"))
	composer = updated.(RootModel)
	if command != nil || composer.pendingConfirm != nil || composer.CommandInput() != "draft" {
		t.Fatalf("composer ownership must retain Ctrl+R: command=%v pending=%#v input=%q", command, composer.pendingConfirm, composer.CommandInput())
	}

	modal := newTestModelWithPanes(t, 1)
	updated, _ = modal.Update(ctrlKey("r"))
	modal = updated.(RootModel)
	if modal.pendingConfirm == nil {
		t.Fatal("test setup did not open stop confirmation")
	}
	updated, command = modal.Update(ctrlKey("r"))
	modal = updated.(RootModel)
	if command != nil || modal.pendingConfirm == nil || modal.pendingConfirm.Command.Kind != slash.KindStop {
		t.Fatalf("modal ownership must retain the original confirmation: command=%v pending=%#v", command, modal.pendingConfirm)
	}
}

func TestPaneLifecycleControlsFailClosedOfflineAndWithoutPane(t *testing.T) {
	offline := newTestModelWithPanes(t, 1)
	offline.connectionStatus = "offline"
	updated, command := offline.Update(ctrlKey("r"))
	offline = updated.(RootModel)
	if command != nil || offline.pendingConfirm != nil || !strings.Contains(strings.Join(offline.assistantHistoryForView(), "\n"), "unavailable") {
		t.Fatalf("offline shortcut must fail closed with guidance: command=%v pending=%#v history=%#v", command, offline.pendingConfirm, offline.assistantHistoryForView())
	}

	selectedID := offline.paneManager.SelectedPaneID()
	command = offline.confirmPaneLifecycle(slash.KindRestart, selectedID)
	if command != nil || offline.pendingConfirm != nil {
		t.Fatalf("offline restart gate must not create lifecycle work: command=%v pending=%#v", command, offline.pendingConfirm)
	}

	empty := newTestModel(t)
	empty.connectionStatus = "connected"
	updated, command = empty.Update(ctrlKey("r"))
	empty = updated.(RootModel)
	if command != nil || empty.pendingConfirm != nil || !strings.Contains(strings.Join(empty.assistantHistoryForView(), "\n"), "no pane is selected") {
		t.Fatalf("no-pane shortcut must fail closed with guidance: command=%v pending=%#v history=%#v", command, empty.pendingConfirm, empty.assistantHistoryForView())
	}
}

func TestRestartHitTargetsContainingPane(t *testing.T) {
	root := newTestModelWithPanes(t, 2)
	selectedID := root.paneManager.SelectedPaneID()
	frame := views.BuildShell(root.styles, root.shellData())
	var restart components.HitRegion
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == components.HitPaneRestart && region.PaneID != selectedID {
			restart = region
			break
		}
	}
	if !restart.Rect.Valid() {
		t.Fatal("non-selected pane has no restart hit target")
	}

	updated, command := root.Update(tea.MouseClickMsg{X: restart.Rect.X, Y: restart.Rect.Y, Button: tea.MouseLeft})
	model := updated.(RootModel)
	selected := model.paneManager.SelectedPane()
	if command != nil || model.pendingConfirm == nil || model.pendingConfirm.Command.Kind != slash.KindRestart {
		t.Fatalf("restart hit must prepare confirmation: command=%v pending=%#v", command, model.pendingConfirm)
	}
	if selected == nil || selected.ID != restart.PaneID {
		t.Fatalf("restart hit selected the wrong pane: selected=%#v region=%#v", selected, restart)
	}
	if apps := model.pendingConfirm.Target.AppIDs; len(apps) != 1 || apps[0] != selected.AppID {
		t.Fatalf("restart hit targeted the wrong app: %#v", model.pendingConfirm.Target)
	}
}
