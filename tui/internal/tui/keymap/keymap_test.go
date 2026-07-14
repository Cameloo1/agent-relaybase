package keymap

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestStopSelectedUsesCtrlRAndAppearsInFullHelp(t *testing.T) {
	keys := Default()
	if !Matches(tea.KeyPressMsg{Code: 'r', Mod: tea.ModCtrl}, keys.StopSelected) {
		t.Fatal("Ctrl+R must match the stop-selected binding")
	}
	if Matches(tea.KeyPressMsg{Text: "r", Code: 'r'}, keys.StopSelected) {
		t.Fatal("plain r must remain printable input")
	}

	want := keys.StopSelected.Help()
	found := false
	for _, binding := range keys.FullHelp() {
		if binding.Help() == want {
			found = true
		}
	}
	if !found {
		t.Fatal("stop-selected binding is missing from full help")
	}
}

func TestAgentPaneUsesCtrlGAndAppearsInFullHelp(t *testing.T) {
	keys := Default()
	if !Matches(tea.KeyPressMsg{Code: 'g', Mod: tea.ModCtrl}, keys.AgentPane) {
		t.Fatal("Ctrl+G must match the Agent-pane binding")
	}
	if Matches(tea.KeyPressMsg{Text: "g", Code: 'g'}, keys.AgentPane) {
		t.Fatal("plain g must remain printable input")
	}

	want := keys.AgentPane.Help()
	for _, binding := range keys.FullHelp() {
		if binding.Help() == want {
			return
		}
	}
	t.Fatal("Agent-pane binding is missing from full help")
}
