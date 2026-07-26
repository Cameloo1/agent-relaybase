package commandpalette

import (
	"testing"

	"github.com/cameloo/relaybase/tui/internal/tui/slash"
)

func TestPaletteShowsAtMostFiveRowsAndTracksSixthSelection(t *testing.T) {
	model := New()
	model.SetQuery("/")
	if got := len(model.Visible()); got != 5 {
		t.Fatalf("visible rows = %d, want 5", got)
	}
	model.Move(5)
	if model.SelectedIndex() != 5 || model.WindowStart() != 1 {
		t.Fatalf("sixth selection did not advance window: selected=%d start=%d", model.SelectedIndex(), model.WindowStart())
	}
	if model.SelectedVisibleIndex() != 4 {
		t.Fatalf("selected visible row = %d, want 4", model.SelectedVisibleIndex())
	}
	model.Move(-5)
	if model.SelectedIndex() != 0 || model.WindowStart() != 0 {
		t.Fatalf("reversing did not restore first window: selected=%d start=%d", model.SelectedIndex(), model.WindowStart())
	}
}

func TestPaletteMovementClampsWithoutWrapping(t *testing.T) {
	model := New()
	model.SetQuery("/")
	model.Move(-1)
	if model.SelectedIndex() != 0 {
		t.Fatalf("up from first wrapped to %d", model.SelectedIndex())
	}
	model.End()
	last := model.Count() - 1
	model.Move(1)
	if model.SelectedIndex() != last {
		t.Fatalf("down from last wrapped to %d", model.SelectedIndex())
	}
	model.Home()
	if model.SelectedIndex() != 0 {
		t.Fatalf("home selected %d", model.SelectedIndex())
	}
}

func TestPalettePageAndResponsiveRowCount(t *testing.T) {
	model := New()
	model.SetQuery("/")
	model.Page(1)
	if model.SelectedIndex() != 5 {
		t.Fatalf("page down selected %d, want 5", model.SelectedIndex())
	}
	model.SetMaxRows(2)
	if got := len(model.Visible()); got != 2 {
		t.Fatalf("responsive visible rows = %d, want 2", got)
	}
	model.Page(-1)
	if model.SelectedIndex() != 3 {
		t.Fatalf("responsive page up selected %d, want 3", model.SelectedIndex())
	}
}

func TestPaletteQueryPreservesSelectionWhenStillMatched(t *testing.T) {
	model := New()
	model.SetQuery("thread")
	for {
		selected, ok := model.Selected()
		if !ok {
			t.Fatal("thread query returned no selection")
		}
		if selected.Kind == slash.KindThreadSwitch {
			break
		}
		previous := model.SelectedIndex()
		model.Move(1)
		if model.SelectedIndex() == previous {
			t.Fatal("thread switch descriptor not found")
		}
	}
	model.SetQuery("thread sw")
	selected, ok := model.Selected()
	if !ok || selected.Kind != slash.KindThreadSwitch {
		t.Fatalf("selection was not preserved: %#v, %v", selected, ok)
	}
	model.SetQuery("manifest")
	selected, ok = model.Selected()
	if !ok || selected.Kind == slash.KindThreadSwitch {
		t.Fatalf("invalid prior selection was preserved: %#v, %v", selected, ok)
	}
}

func TestPaletteAcceptReturnsInsertionWithoutExecutionState(t *testing.T) {
	model := New()
	model.SetQuery("th sw")
	insertion, ok := model.Accept()
	if !ok || insertion != "/thread switch " {
		t.Fatalf("Accept() = %q, %v", insertion, ok)
	}
	if model.Query() != "th sw" || model.SelectedIndex() < 0 {
		t.Fatal("Accept mutated palette state")
	}
}

func TestPaletteFindsUsageIncrementally(t *testing.T) {
	for _, query := range []string{"/u", "/us", "/usa", "/usage", "tokens", "cost", "model usage"} {
		model := New()
		model.SetQueryAndReset(query)
		selected, ok := model.Selected()
		if !ok || selected.Kind != slash.KindUsage {
			t.Fatalf("query %q selected %#v, %v", query, selected, ok)
		}
	}
}

func TestPaletteVisibleRowSelectionIsBounded(t *testing.T) {
	model := New()
	model.SetQuery("/")
	if model.SelectVisibleRow(-1) || model.SelectVisibleRow(5) {
		t.Fatal("out-of-range visible row was accepted")
	}
	if !model.SelectVisibleRow(3) || model.SelectedIndex() != 3 {
		t.Fatalf("visible row selection failed: %d", model.SelectedIndex())
	}
}

func TestPaletteNoResultStateIsExplicit(t *testing.T) {
	model := New()
	model.SetQuery("words-not-present-anywhere")
	if model.Count() != 0 || len(model.Visible()) != 0 || model.SelectedIndex() != -1 {
		t.Fatalf("unexpected no-result state: count=%d visible=%d selected=%d", model.Count(), len(model.Visible()), model.SelectedIndex())
	}
	if insertion, ok := model.Accept(); ok || insertion != "" {
		t.Fatalf("no-result Accept() = %q, %v", insertion, ok)
	}
}
