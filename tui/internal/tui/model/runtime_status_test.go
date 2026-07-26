package model

import (
	"errors"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
)

func TestRuntimeChangedRefreshAndDegradedActiveSemantics(t *testing.T) {
	if !shouldRefreshState("app.runtime_changed") {
		t.Fatal("runtime transition did not request authoritative state refresh")
	}
	if daemonStatusIsActive("degraded", 0) {
		t.Fatal("unowned degraded port was counted as an active app")
	}
	if !daemonStatusIsActive("degraded", 42) {
		t.Fatal("daemon-reported process ID was not treated as active")
	}
}

func TestCanonicalComponentStateOverridesOlderRawAppStatus(t *testing.T) {
	root := newTestModel(t)
	root.state = &relaybaseclient.RelaybaseState{
		Apps:       []relaybaseclient.AppState{{ID: "notes", RuntimeStatus: "running", PID: 0}},
		Components: []relaybaseclient.AppComponent{{AppID: "notes", Status: "stopped", PID: 0}},
	}
	if got := root.activeAppCount(); got != 0 {
		t.Fatalf("active app count = %d, want 0", got)
	}
}

func TestOlderStateSnapshotCannotOverwriteNewerRuntimeState(t *testing.T) {
	root := newTestModel(t)
	newer := &relaybaseclient.RelaybaseState{
		GeneratedAt: "2026-07-18T12:00:01.000Z",
		Apps:        []relaybaseclient.AppState{{ID: "notes", RuntimeStatus: "stopped"}},
	}
	root.state = newer
	root.stateGeneratedAt = newer.GeneratedAt
	root.stateFetchGeneration = 2

	updated, _ := root.Update(commands.StateLoadedMsg{State: &relaybaseclient.RelaybaseState{
		GeneratedAt: "2026-07-18T12:00:00.000Z",
		Apps:        []relaybaseclient.AppState{{ID: "notes", RuntimeStatus: "running"}},
	}, Generation: 1})
	result := updated.(RootModel)
	if result.state != newer || result.state.Apps[0].RuntimeStatus != "stopped" {
		t.Fatalf("older snapshot replaced newer state: %#v", result.state)
	}
}

func TestOlderStateFailureCannotMarkNewerSuccessfulConnectionOffline(t *testing.T) {
	root := newTestModel(t)
	root.connectionStatus = "connected"
	root.stateFetchGeneration = 4

	updated, _ := root.Update(commands.StateFailedMsg{Err: errors.New("daemon unavailable"), Generation: 3})
	result := updated.(RootModel)
	if result.connectionStatus != "connected" {
		t.Fatalf("older failure changed connection status to %q", result.connectionStatus)
	}
}
