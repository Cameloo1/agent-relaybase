package appcompletion

import (
	"testing"

	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
)

func completionItems() []inventory.Item {
	return []inventory.Item{
		{ID: "credential-manager", Name: "Credential Manager", Status: "running"},
		{ID: "codegraph-website", Name: "CodeGraph Website", Status: "stopped"},
		{ID: "voice-stock-agent", Name: "Voice Stock Agent", Status: "stopped"},
		{ID: "operations-kanban", Name: "Operations Kanban", Status: "degraded"},
		{ID: "notes-api", Name: "Notes Backend", Status: "stopped"},
		{ID: "notes-web", Name: "Notes Frontend", Status: "stopped"},
	}
}

func TestCompletionRanksStableIDPrefixesAndReturnsStableID(t *testing.T) {
	model := New()
	model.SetQueryAndReset("co", completionItems())
	selected, ok := model.Selected()
	if !ok || selected.ID != "codegraph-website" {
		t.Fatalf("id prefix selected %#v, %v", selected, ok)
	}
	if completion, ok := model.Accept(); !ok || completion != "/start codegraph-website" {
		t.Fatalf("Accept() = %q, %v", completion, ok)
	}
}

func TestCompletionMatchesDisplayNameTokensButStillAcceptsID(t *testing.T) {
	model := New()
	model.SetQueryAndReset("stock", completionItems())
	selected, ok := model.Selected()
	if !ok || selected.ID != "voice-stock-agent" {
		t.Fatalf("name token selected %#v, %v", selected, ok)
	}
	completion, _ := model.Accept()
	if completion != "/start voice-stock-agent" {
		t.Fatalf("display-name match inserted unstable value %q", completion)
	}
}

func TestCompletionWindowClampsAndPreservesSelectionOnRefresh(t *testing.T) {
	model := New(3)
	model.SetQueryAndReset("", completionItems())
	model.Move(4)
	selected, ok := model.Selected()
	if !ok || model.SelectedVisibleIndex() != 2 || model.WindowStart() != 2 {
		t.Fatalf("selection window did not follow: selected=%#v visible=%d start=%d", selected, model.SelectedVisibleIndex(), model.WindowStart())
	}
	model.SetQuery("", completionItems())
	after, ok := model.Selected()
	if !ok || after.ID != selected.ID {
		t.Fatalf("daemon refresh lost selection: before=%#v after=%#v", selected, after)
	}
	if model.SelectVisibleRow(-1) || model.SelectVisibleRow(3) {
		t.Fatal("out-of-range rendered row was accepted")
	}
}

func TestCompletionNoMatchIsExplicitAndSafe(t *testing.T) {
	model := New()
	model.SetQueryAndReset("not-registered", completionItems())
	if model.Count() != 0 || len(model.Visible()) != 0 || model.SelectedIndex() != -1 {
		t.Fatalf("unexpected no-match state: count=%d visible=%d selected=%d", model.Count(), len(model.Visible()), model.SelectedIndex())
	}
	if completion, ok := model.Accept(); ok || completion != "" {
		t.Fatalf("no-match Accept() = %q, %v", completion, ok)
	}
}
