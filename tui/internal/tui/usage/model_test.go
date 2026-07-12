package usage

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func TestUsageModelStatesAndStaleRefresh(t *testing.T) {
	m := New()
	m.Open()
	if got := m.Snapshot(); got == nil || got.Status != StatusLoading {
		t.Fatalf("open state = %#v", got)
	}
	m.Loaded(&relaybaseclient.AgentUsageSnapshot{})
	if m.Snapshot().Status != StatusEmpty {
		t.Fatalf("empty state = %s", m.Snapshot().Status)
	}
	value := usageFixture()
	m.Loaded(value)
	m.Failed(errors.New("daemon offline"))
	if got := m.Snapshot(); got.Status != StatusStale || got.Usage != value {
		t.Fatalf("stale state lost snapshot: %#v", got)
	}
	m.Close()
	if m.Snapshot() != nil {
		t.Fatal("closed model exposed snapshot")
	}
}

func TestClosedUsageModelIgnoresLateCompletion(t *testing.T) {
	m := New()
	m.Open()
	original := usageFixture()
	m.Loaded(original)
	m.Close()

	late := usageFixture()
	late.LastRequest.ModelSlug = "late/model"
	m.Loaded(late)
	m.Failed(errors.New("late failure"))
	if m.IsOpen() || m.Snapshot() != nil || m.snapshot != original || m.err != "" {
		t.Fatalf("closed model accepted late completion: open=%v snapshot=%p err=%q", m.IsOpen(), m.snapshot, m.err)
	}
}

func TestUsageRenderShowsExactValuesAndProvenance(t *testing.T) {
	value := usageFixture()
	rendered := Render(Snapshot{Status: StatusReady, Usage: value}, 52, time.Date(2026, 7, 11, 19, 41, 24, 0, time.UTC))
	for _, want := range []string{"openai/gpt-5.6-luna", "12,480 in", "2,106 out", "14,586 total", "$0.123456 reported", "91,204 total", "$0.842731 reported + estimated"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("missing %q:\n%s", want, rendered)
		}
	}
}

func TestUsageCompactRenderKeepsExactValuesWithinMinimumViewport(t *testing.T) {
	value := usageFixture()
	now := time.Date(2026, 7, 11, 19, 41, 24, 0, time.UTC)
	rendered := Render(Snapshot{Status: StatusReady, Usage: value}, 30, now)
	if got := len(strings.Split(rendered, "\n")); got > 12 {
		t.Fatalf("compact ready usage needs %d rows, want at most 12:\n%s", got, rendered)
	}
	for _, want := range []string{
		"openai/gpt-5.6-luna",
		"In 12,480 · Out 2,106",
		"Total 14,586",
		"Cost $0.123456 reported",
		"Tokens 91,204 total",
		"Cost $0.842731",
		"Source reported + estimated",
		"Esc close · R refresh",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("compact usage omitted %q:\n%s", want, rendered)
		}
	}

	stale := Render(Snapshot{Status: StatusStale, Usage: value, Error: "daemon offline"}, 30, now)
	if got := len(strings.Split(stale, "\n")); got > 12 {
		t.Fatalf("compact stale usage needs %d rows, want at most 12:\n%s", got, stale)
	}
	if !strings.Contains(stale, "Usage · stale") {
		t.Fatalf("compact stale usage omitted its state badge:\n%s", stale)
	}
}

func TestUsageRenderStripsTerminalActionsFromDaemonLabels(t *testing.T) {
	value := usageFixture()
	value.LastRequest.ModelSlug = "openai/safe\x1b[2J\x1b]52;c;attack\a"
	value.LastRequest.Cost.Source = "provider_reported\u009b31m"
	rendered := Render(Snapshot{Status: StatusReady, Usage: value}, 52, time.Now())
	for _, forbidden := range []string{"\x1b[2J", "\x1b]52", "\u009b"} {
		if strings.Contains(rendered, forbidden) {
			t.Fatalf("usage retained terminal action %q: %q", forbidden, rendered)
		}
	}
}

func usageFixture() *relaybaseclient.AgentUsageSnapshot {
	cost := "0.1234567"
	updated := "2026-07-11T19:41:12Z"
	value := &relaybaseclient.AgentUsageSnapshot{UpdatedAt: &updated}
	value.LastRequest = &relaybaseclient.AgentUsageLastRequest{ModelSlug: "openai/gpt-5.6-luna", Tokens: relaybaseclient.AgentUsageTokens{Input: 12480, Output: 2106, Total: 14586}, Cost: relaybaseclient.AgentUsageCost{USD: &cost, Source: "provider_reported"}}
	value.ThreadTotals.Tokens.Total = 91204
	value.ThreadTotals.Cost.KnownUSD = "0.842731"
	value.ThreadTotals.Cost.Sources = []string{"provider_reported", "estimated"}
	return value
}
