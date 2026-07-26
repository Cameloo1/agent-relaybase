package composer

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

func TestComposerGrowsToThreeRowsWithoutCappingContent(t *testing.T) {
	model := New(12)
	model.SetValue("one\ntwo\nthree\nfour\nfive")
	if model.Rows() != 3 || model.LineCount() != 5 {
		t.Fatalf("expected three-row viewport with five logical lines, got rows=%d lines=%d", model.Rows(), model.LineCount())
	}
}

func TestComposerSupportsCtrlWordNavigationAndDeletion(t *testing.T) {
	model := New(40)
	_ = model.Focus()
	model.SetValue("alpha beta")
	model.Update(tea.KeyPressMsg{Code: tea.KeyLeft, Mod: tea.ModCtrl})
	model.Insert("|")
	if got := model.Value(); got != "alpha |beta" {
		t.Fatalf("Ctrl+Left did not move by one word: %q", got)
	}

	model.SetValue("alpha beta")
	model.Update(tea.KeyPressMsg{Code: tea.KeyHome, Mod: tea.ModCtrl})
	model.Update(tea.KeyPressMsg{Code: tea.KeyDelete, Mod: tea.ModCtrl})
	if got := model.Value(); got != " beta" {
		t.Fatalf("Ctrl+Delete did not delete the next word: %q", got)
	}

	model.SetValue("alpha beta")
	model.Update(tea.KeyPressMsg{Code: tea.KeyBackspace, Mod: tea.ModCtrl})
	if got := model.Value(); got != "alpha " {
		t.Fatalf("Ctrl+Backspace did not delete the previous word: %q", got)
	}
}

func TestPasteIsAtomicAndInert(t *testing.T) {
	model := New(40)
	model.SetValue("safe")
	if err := model.Paste("\x1b]52;c;secret\a\n/stop\r\ntext"); err != nil {
		t.Fatal(err)
	}
	if got := model.Value(); got != "safe\n/stop\ntext" {
		t.Fatalf("unexpected sanitised paste: %q", got)
	}
	old := model.Value()
	if err := model.Paste(strings.Repeat("x", MaxPasteBytes+1)); !errorsIs(err, ErrPasteTooLarge) || model.Value() != old {
		t.Fatalf("over-limit paste must preserve draft: %v %q", err, model.Value())
	}
}

func TestPasteStripsC1TerminalControls(t *testing.T) {
	model := New(40)
	if err := model.Paste("before\u009bafter"); err != nil {
		t.Fatalf("paste failed: %v", err)
	}
	if model.Value() != "beforeafter" {
		t.Fatalf("expected C1 control removal, got %q", model.Value())
	}
}

func TestHistoryKeepsEntriesImmutableAndRestoresDraft(t *testing.T) {
	model := New(40)
	model.AddHistory(HistoryEntry{ID: "one", Value: "first", CreatedAt: time.Now()})
	model.AddHistory(HistoryEntry{ID: "two", Value: "second"})
	model.SetValue("draft")
	if !model.PreviousHistory() || model.Value() != "second" {
		t.Fatalf("expected newest history, got %q", model.Value())
	}
	model.SetValue("edited second")
	if !model.PreviousHistory() || model.Value() != "first" {
		t.Fatalf("expected previous history, got %q", model.Value())
	}
	if !model.NextHistory() || model.Value() != "edited second" {
		t.Fatalf("expected working copy, got %q", model.Value())
	}
	if !model.NextHistory() || model.Value() != "draft" {
		t.Fatalf("expected draft restoration, got %q", model.Value())
	}
}

func TestHistoryNavigationIsScopedByStableThreadIdentity(t *testing.T) {
	model := New(40)
	model.SetHistoryScope("agent:one")
	model.AddHistory(HistoryEntry{ID: "one:1", Value: "thread one", ThreadID: "agent:one"})
	model.AddHistory(HistoryEntry{ID: "two:1", Value: "thread two", ThreadID: "agent:two"})
	model.AddHistory(HistoryEntry{ID: "one:2", Value: "thread one newest", ThreadID: "agent:one"})

	model.SetValue("one draft")
	if !model.PreviousHistory() || model.Value() != "thread one newest" {
		t.Fatalf("thread one adopted cross-thread history: %q", model.Value())
	}
	if !model.PreviousHistory() || model.Value() != "thread one" {
		t.Fatalf("thread one did not reach its older entry: %q", model.Value())
	}

	model.SetHistoryScope("agent:two")
	model.SetValue("two draft")
	if !model.PreviousHistory() || model.Value() != "thread two" {
		t.Fatalf("thread two adopted the wrong scoped entry: %q", model.Value())
	}
	if model.PreviousHistory() {
		t.Fatalf("thread two unexpectedly reached another thread's history: %q", model.Value())
	}
}

func errorsIs(value, target error) bool { return value == target }
