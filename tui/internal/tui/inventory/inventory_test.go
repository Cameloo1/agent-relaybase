package inventory

import (
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func TestManagerKeepsRegisteredStoppedAppsDiscoverable(t *testing.T) {
	manager := Manager{}
	manager.ApplyState(&relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "worker", Name: "Worker", RuntimeStatus: "stopped"},
		{ID: "api", Name: "API", RuntimeStatus: "running", Route: "http://api.localhost:7777"},
	}})

	items := manager.Items()
	if len(items) != 2 || items[0].ID != "api" || items[1].ID != "worker" {
		t.Fatalf("unexpected inventory ordering: %#v", items)
	}
	manager.Move(1)
	selected := manager.Selected()
	if selected == nil || selected.ID != "worker" || !selected.CanStart() {
		t.Fatalf("expected stopped worker to be selected and startable: %#v", selected)
	}
}

func TestManagerIncludesComponentOnlyStateAndPreservesSelection(t *testing.T) {
	manager := Manager{}
	state := &relaybaseclient.RelaybaseState{Components: []relaybaseclient.AppComponent{
		{AppID: "web", DisplayName: "Web", Status: "stopped"},
		{AppID: "api", DisplayName: "API", Status: "failed", LastError: "health failed"},
	}}
	manager.ApplyState(state)
	manager.Move(1)
	if selected := manager.Selected(); selected == nil || selected.ID != "web" {
		t.Fatalf("expected web selection before refresh: %#v", selected)
	}

	state.Components[0].Status = "starting"
	manager.ApplyState(state)
	if selected := manager.Selected(); selected == nil || selected.ID != "web" || selected.CanStart() {
		t.Fatalf("expected selection to survive and starting app to be non-startable: %#v", selected)
	}
}
