package model

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/config"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
)

func TestUsageCommandLoadsModalBlocksComposerRefreshesAndCloses(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.RequestURI() != "/__hub/api/agent/usage?scope=active-thread" {
			t.Fatalf("unexpected path %s", r.URL.RequestURI())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"usage":{"scope":"active-thread","sessionId":"session-1","lastRequest":{"runId":"run-1","modelSlug":"openai/gpt-5.6-luna","provider":"openrouter","completedAt":"2026-07-11T19:41:12Z","tokens":{"input":12480,"output":2106,"total":14586,"totalSource":"provider_reported"},"cost":{"usd":"0.123456","source":"provider_reported"}},"threadTotals":{"requestCount":1,"tokens":{"input":12480,"output":2106,"total":14586},"cost":{"knownUsd":"0.123456","knownRequestCount":1,"unavailableRequestCount":0,"sources":["provider_reported"]}},"updatedAt":"2026-07-11T19:41:12Z"}}}`))
	}))
	defer server.Close()
	cfg := config.Config{BaseURL: server.URL, StateDir: t.TempDir(), Token: "test-token", ThemeMode: "auto"}
	root := NewRoot(cfg, relaybaseclient.New(cfg.BaseURL, cfg.Token, server.Client()))
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	root = updated.(RootModel)
	root, cmd := root.submitSlashCommand("/usage")
	if cmd == nil || !root.usage.IsOpen() {
		t.Fatalf("usage did not open: cmd=%v", cmd)
	}
	updated, _ = root.Update(cmd())
	root = updated.(RootModel)
	rendered := root.Render()
	for _, want := range []string{"Relaybase", "Usage", "openai/gpt-5.6-luna", "12,480 in", "$0.123456 reported"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("missing %q:\n%s", want, rendered)
		}
	}
	updated, cmd = root.Update(keyPress("x"))
	root = updated.(RootModel)
	if cmd != nil || root.commandActive || root.CommandInput() != "" {
		t.Fatal("usage modal leaked typing into composer")
	}
	updated, cmd = root.Update(keyPress("r"))
	root = updated.(RootModel)
	if cmd == nil {
		t.Fatal("refresh did not return fetch command")
	}
	updated, _ = root.Update(cmd())
	root = updated.(RootModel)
	if requests != 2 {
		t.Fatalf("usage requests = %d, want 2", requests)
	}
	updated, _ = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if root.usage.IsOpen() || strings.Contains(root.Render(), "12,480 in") {
		t.Fatal("Esc did not close usage modal")
	}
}

func TestUsageCompletionIdentityCannotReopenOrOverwriteModal(t *testing.T) {
	root := newTestModel(t)
	root, command := root.submitSlashCommand("/usage")
	if command == nil || !root.usage.IsOpen() || root.usageRequestGeneration == 0 {
		t.Fatalf("usage request did not establish identity: command=%v open=%v generation=%d", command, root.usage.IsOpen(), root.usageRequestGeneration)
	}
	closedGeneration := root.usageRequestGeneration

	updated, _ := root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if root.usage.IsOpen() || root.usageRequestGeneration == closedGeneration {
		t.Fatalf("Esc did not close and invalidate usage: open=%v generation=%d", root.usage.IsOpen(), root.usageRequestGeneration)
	}

	late := &relaybaseclient.AgentUsageSnapshot{LastRequest: &relaybaseclient.AgentUsageLastRequest{ModelSlug: "late/model"}}
	updated, _ = root.Update(commands.AgentUsageLoadedMsg{Usage: late, Generation: closedGeneration})
	root = updated.(RootModel)
	updated, _ = root.Update(commands.AgentUsageFailedMsg{Err: errors.New("late failure"), Generation: closedGeneration})
	root = updated.(RootModel)
	if root.usage.IsOpen() || strings.Contains(root.Render(), "late/model") {
		t.Fatalf("late usage completion reacquired the closed modal: open=%v", root.usage.IsOpen())
	}

	root, _ = root.submitSlashCommand("/usage")
	firstGeneration := root.usageRequestGeneration
	updated, refresh := root.Update(keyPress("r"))
	root = updated.(RootModel)
	secondGeneration := root.usageRequestGeneration
	if refresh == nil || secondGeneration == firstGeneration {
		t.Fatalf("refresh did not rotate request identity: first=%d second=%d command=%v", firstGeneration, secondGeneration, refresh)
	}
	updated, _ = root.Update(commands.AgentUsageLoadedMsg{Usage: late, Generation: firstGeneration})
	root = updated.(RootModel)
	if snapshot := root.usage.Snapshot(); snapshot == nil || snapshot.Status != "loading" || snapshot.Usage != nil {
		t.Fatalf("stale refresh completion changed current loading state: %#v", snapshot)
	}
	current := &relaybaseclient.AgentUsageSnapshot{LastRequest: &relaybaseclient.AgentUsageLastRequest{ModelSlug: "current/model"}}
	updated, _ = root.Update(commands.AgentUsageLoadedMsg{Usage: current, Generation: secondGeneration})
	root = updated.(RootModel)
	if snapshot := root.usage.Snapshot(); snapshot == nil || snapshot.Usage != current {
		t.Fatalf("current usage completion was not accepted: %#v", snapshot)
	}
}
