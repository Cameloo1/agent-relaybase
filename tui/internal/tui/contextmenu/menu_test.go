package contextmenu

import (
	"testing"

	"github.com/cameloo/relaybase/tui/internal/tui/panes"
)

func TestPaneMenuNavigation(t *testing.T) {
	menu := PaneMenu(
		&panes.PaneSnapshot{ID: "pane-1", Title: "Notes: backend", RouteLabel: "http://notes.localhost:7777"},
		PaneMenuOptions{CanReopen: true},
	)
	if !menu.IsOpen() {
		t.Fatal("expected pane menu to be open")
	}
	if item := menu.SelectedItem(); item == nil || item.Action != ActionPaneClose {
		t.Fatalf("unexpected initial item: %#v", item)
	}
	menu.Move(1)
	if item := menu.SelectedItem(); item == nil || item.Action != ActionPanePinToggle {
		t.Fatalf("unexpected selected item after move: %#v", item)
	}
}

func TestPaneMenuCoversEveryItem(t *testing.T) {
	menu := PaneMenu(
		&panes.PaneSnapshot{ID: "pane-1", Title: "Notes: backend", RouteLabel: "http://notes.localhost:7777"},
		PaneMenuOptions{CanReopen: true},
	)
	expected := []string{
		ActionPaneClose,
		ActionPanePinToggle,
		ActionPaneReopen,
		ActionPaneColor,
		ActionPaneCopyRoute,
		ActionPaneExportLogs,
		ActionPaneStop,
		ActionPaneRestart,
		ActionPaneDiagnostics,
	}
	if len(menu.Items) != len(expected) {
		t.Fatalf("expected %d pane menu items, got %#v", len(expected), menu.Items)
	}
	for index, action := range expected {
		item := menu.Items[index]
		if item.Action != action {
			t.Fatalf("expected action %s at %d, got %#v", action, index, item)
		}
		if !item.Enabled {
			t.Fatalf("expected %s to be enabled with full pane state, got %#v", action, item)
		}
		if item.DisabledReason != "" {
			t.Fatalf("enabled item %s should not carry a disabled reason: %#v", action, item)
		}
	}
}

func TestAssistantMenuNavigation(t *testing.T) {
	menu := AssistantMenu()
	if !menu.IsOpen() {
		t.Fatal("expected assistant menu to be open")
	}
	menu.Move(3)
	if item := menu.SelectedItem(); item == nil || item.Action != ActionAssistantBarColor {
		t.Fatalf("unexpected assistant item: %#v", item)
	}
}

func TestAssistantMenuCoversEveryItem(t *testing.T) {
	menu := AssistantMenu()
	expected := []struct {
		action  string
		enabled bool
		reason  string
	}{
		{ActionAssistantHistory, true, ""},
		{ActionAssistantNewThread, true, ""},
		{ActionAssistantClearInput, true, ""},
		{ActionAssistantBarColor, true, ""},
		{ActionAssistantExportChat, false, "no daemon-backed active thread"},
		{ActionAssistantCommandHelp, true, ""},
		{ActionAssistantLLMMode, true, ""},
	}
	if len(menu.Items) != len(expected) {
		t.Fatalf("expected %d assistant menu items, got %#v", len(expected), menu.Items)
	}
	for index, want := range expected {
		item := menu.Items[index]
		if item.Action != want.action {
			t.Fatalf("expected action %s at %d, got %#v", want.action, index, item)
		}
		if item.Enabled != want.enabled || item.DisabledReason != want.reason {
			t.Fatalf("unexpected state for %s: %#v", want.action, item)
		}
	}
}

func TestAssistantMenuEnablesExportWhenDaemonThreadExists(t *testing.T) {
	menu := AssistantMenu(AssistantMenuOptions{CanExportChat: true})
	item := findItem(t, menu, ActionAssistantExportChat)
	if !item.Enabled || item.DisabledReason != "" {
		t.Fatalf("expected export chat to be enabled with daemon-backed active thread, got %#v", item)
	}
}

func TestPaneMenuDisablesRouteWhenUnavailable(t *testing.T) {
	menu := PaneMenu(&panes.PaneSnapshot{ID: "pane-1", Title: "Notes: backend"})
	item := findItem(t, menu, ActionPaneCopyRoute)
	if item.Enabled {
		t.Fatal("expected show route action to be unavailable without route")
	}
	if item.DisabledReason != "selected pane has no route" {
		t.Fatalf("expected route disabled reason, got %#v", item)
	}
}

func TestPaneMenuDisablesImpossibleActionsWithoutPane(t *testing.T) {
	menu := PaneMenu(nil)
	for _, action := range []string{
		ActionPaneClose,
		ActionPanePinToggle,
		ActionPaneColor,
		ActionPaneCopyRoute,
		ActionPaneExportLogs,
		ActionPaneStop,
		ActionPaneRestart,
	} {
		item := findItem(t, menu, action)
		if item.Enabled {
			t.Fatalf("expected %s to be disabled without pane", action)
		}
		if item.DisabledReason == "" {
			t.Fatalf("expected %s to explain why it is unavailable", action)
		}
	}
	if !findItem(t, menu, ActionPaneDiagnostics).Enabled {
		t.Fatal("diagnostics should remain available without a selected pane")
	}
}

func TestPaneMenuReopenReflectsAvailability(t *testing.T) {
	menu := PaneMenu(&panes.PaneSnapshot{ID: "pane-1", Title: "Notes: backend"})
	item := findItem(t, menu, ActionPaneReopen)
	if item.Enabled || item.DisabledReason == "" {
		t.Fatalf("expected reopen to be disabled with reason when no candidate exists, got %#v", item)
	}

	menu = PaneMenu(&panes.PaneSnapshot{ID: "pane-1", Title: "Notes: backend"}, PaneMenuOptions{CanReopen: true})
	item = findItem(t, menu, ActionPaneReopen)
	if !item.Enabled || item.DisabledReason != "" {
		t.Fatalf("expected reopen to be enabled when candidate exists, got %#v", item)
	}
}

func TestPaneMenuDisablesDaemonOwnedActionsWhenOffline(t *testing.T) {
	menu := PaneMenu(
		&panes.PaneSnapshot{ID: "pane-1", Title: "Notes: backend", RouteLabel: "http://notes.localhost:7777"},
		PaneMenuOptions{DaemonStateKnown: true, DaemonConnected: false},
	)

	for _, action := range []string{ActionPaneExportLogs, ActionPaneStop, ActionPaneRestart} {
		item := findItem(t, menu, action)
		if item.Enabled {
			t.Fatalf("expected daemon-owned %s to be disabled while offline", action)
		}
		if item.DisabledReason != "daemon is offline" {
			t.Fatalf("expected daemon offline disabled reason for %s, got %#v", action, item)
		}
	}

	for _, action := range []string{ActionPaneClose, ActionPanePinToggle, ActionPaneColor, ActionPaneCopyRoute, ActionPaneDiagnostics} {
		item := findItem(t, menu, action)
		if !item.Enabled {
			t.Fatalf("expected local/read-only %s to remain enabled while offline, got %#v", action, item)
		}
	}
}

func findItem(t *testing.T, menu Menu, action string) Item {
	t.Helper()
	for _, item := range menu.Items {
		if item.Action == action {
			return item
		}
	}
	t.Fatalf("missing menu action %s in %#v", action, menu.Items)
	return Item{}
}
