package inventory

import (
	"strings"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func TestManagerKeepsRegisteredStoppedAppsDiscoverable(t *testing.T) {
	manager := Manager{}
	manager.ApplyState(&relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "worker", Name: "Worker", RuntimeStatus: "stopped"},
		{ID: "api", Name: "API", RuntimeStatus: "running", Route: "http://api.localhost:7777", CWD: `C:\workspace\api`, ManifestPath: `C:\work\api\relaybase.json`},
	}})

	items := manager.Items()
	if len(items) != 2 || items[0].ID != "api" || items[1].ID != "worker" {
		t.Fatalf("unexpected inventory ordering: %#v", items)
	}
	if items[0].Directory != `C:\workspace\api` {
		t.Fatalf("project directory did not prefer daemon cwd metadata: %#v", items[0])
	}
	if found, ok := manager.ItemByID("api"); !ok || found.Directory != items[0].Directory {
		t.Fatalf("app lookup did not return the inventory projection: found=%#v ok=%v", found, ok)
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

func TestManagerSelectIndexClampsMouseSelections(t *testing.T) {
	manager := Manager{}
	manager.ApplyState(&relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "alpha", Name: "Alpha", RuntimeStatus: "stopped"},
		{ID: "beta", Name: "Beta", RuntimeStatus: "stopped"},
	}})
	manager.SelectIndex(99)
	if selected := manager.Selected(); selected == nil || selected.ID != "beta" {
		t.Fatalf("expected high index to clamp to beta: %#v", selected)
	}
	manager.SelectIndex(-1)
	if selected := manager.Selected(); selected == nil || selected.ID != "alpha" {
		t.Fatalf("expected low index to clamp to alpha: %#v", selected)
	}
}

func TestManagerSelectIDAndResolveAppPreferStableIDs(t *testing.T) {
	manager := Manager{}
	manager.ApplyState(&relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "service-api", Name: "Service", RuntimeStatus: "stopped"},
		{ID: "service-worker", Name: "Service", RuntimeStatus: "stopped"},
		{ID: "service", Name: "Canonical Service", RuntimeStatus: "stopped"},
	}})

	if !manager.SelectID("service-worker") || manager.SelectedID() != "service-worker" {
		t.Fatalf("stable id selection failed: %q", manager.SelectedID())
	}
	if manager.SelectID("missing") || manager.SelectedID() != "service-worker" {
		t.Fatalf("missing id changed selection: %q", manager.SelectedID())
	}
	resolved, err := manager.ResolveApp("SERVICE")
	if err != nil || resolved.ID != "service" {
		t.Fatalf("exact id did not outrank duplicate display names: item=%#v err=%v", resolved, err)
	}
	if _, err := manager.ResolveApp("Service"); err != nil {
		// The exact service id intentionally wins before display-name ambiguity.
		t.Fatalf("exact id should remain resolvable: %v", err)
	}
	if _, err := manager.ResolveApp("missing"); err == nil || !strings.Contains(err.Error(), "Tab") {
		t.Fatalf("unknown target did not provide completion recovery: %v", err)
	}
}

func TestManagerResolveAppRejectsAmbiguousDisplayNames(t *testing.T) {
	manager := Manager{}
	manager.ApplyState(&relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "service-api", Name: "Service", RuntimeStatus: "stopped"},
		{ID: "service-worker", Name: "Service", RuntimeStatus: "stopped"},
	}})

	_, err := manager.ResolveApp("service")
	if err == nil || !strings.Contains(err.Error(), "service-api, service-worker") {
		t.Fatalf("duplicate display name did not fail with stable options: %v", err)
	}
}
