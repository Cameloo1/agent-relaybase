package model

import (
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
)

func TestCtrlWordEditingIsOwnedOnlyByActiveComposer(t *testing.T) {
	composer := typeAssistantText(t, newTestModel(t), "alpha beta")
	updated, _ := composer.Update(tea.KeyPressMsg{Code: tea.KeyBackspace, Mod: tea.ModCtrl})
	composer = updated.(RootModel)
	if composer.CommandInput() != "alpha " {
		t.Fatalf("active composer did not apply Ctrl+Backspace: input=%q", composer.CommandInput())
	}
	forward := typeAssistantText(t, newTestModel(t), "alpha beta")
	updated, _ = forward.Update(tea.KeyPressMsg{Code: tea.KeyHome, Mod: tea.ModCtrl})
	forward = updated.(RootModel)
	updated, _ = forward.Update(tea.KeyPressMsg{Code: tea.KeyDelete, Mod: tea.ModCtrl})
	forward = updated.(RootModel)
	if forward.CommandInput() != " beta" {
		t.Fatalf("active composer did not apply Ctrl+Delete: input=%q", forward.CommandInput())
	}

	panes := newTestModelWithPanes(t, 1)
	updated, command := panes.Update(tea.KeyPressMsg{Code: tea.KeyDelete, Mod: tea.ModCtrl})
	panes = updated.(RootModel)
	if command != nil || panes.CommandInput() != "" || panes.interaction.Owner() != interaction.OwnerPanes {
		t.Fatalf("pane owner leaked Ctrl+Delete into composer: input=%q owner=%s command=%v", panes.CommandInput(), panes.interaction.Owner(), command)
	}

	response := newTestModel(t)
	response.setPrimaryFocus(interaction.FocusResponse)
	updated, command = response.Update(tea.KeyPressMsg{Code: tea.KeyLeft, Mod: tea.ModCtrl})
	response = updated.(RootModel)
	if command != nil || response.CommandInput() != "" || response.interaction.Owner() != interaction.OwnerResponse {
		t.Fatalf("response owner leaked Ctrl+Left into composer: input=%q owner=%s command=%v", response.CommandInput(), response.interaction.Owner(), command)
	}
}
