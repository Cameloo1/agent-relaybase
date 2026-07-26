package model

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/composer"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
)

func TestOperatorConsoleProjectsRailPanesResponseAndMultilineComposer(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	model := updated.(RootModel)
	updated, command := model.Update(tea.PasteMsg{Content: "inspect\nthese logs"})
	model = updated.(RootModel)
	if command == nil || !model.shellData().ComposerPasting {
		t.Fatalf("expected asynchronous paste to enter a pending state, command=%v pending=%v", command, model.shellData().ComposerPasting)
	}
	updated, _ = model.Update(command())
	model = updated.(RootModel)
	if model.CommandInput() != "inspect\nthese logs" || !model.commandActive {
		t.Fatalf("expected multiline draft preservation, active=%v input=%q", model.commandActive, model.CommandInput())
	}
	rendered := model.Render()
	for _, label := range []string{"Relaybase", "Agent", "Apps", "Attention", "Composer", "Ctrl+J"} {
		if !strings.Contains(rendered, label) {
			t.Fatalf("operator console omitted %q:\n%s", label, rendered)
		}
	}
	if got := lipgloss.Height(rendered); got != 32 {
		t.Fatalf("operator console must fill the terminal exactly: got %d rows", got)
	}
}

func TestOperatorConsolePasteCanCancelWithoutLosingTheDraft(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.commandInput = "existing draft"
	root.commandActive = true
	root.composer.SetValue(root.commandInput)

	updated, command := root.Update(tea.PasteMsg{Content: "replacement"})
	model := updated.(RootModel)
	if command == nil || !model.shellData().ComposerPasting {
		t.Fatalf("expected pending paste, command=%v pending=%v", command, model.shellData().ComposerPasting)
	}
	updated, _ = model.Update(keyPress("esc"))
	model = updated.(RootModel)
	if model.CommandInput() != "existing draft" || !model.commandActive || model.shellData().ComposerPasting {
		t.Fatalf("Esc must restore the prior draft, active=%v pending=%v input=%q", model.commandActive, model.shellData().ComposerPasting, model.CommandInput())
	}
	updated, _ = model.Update(command())
	model = updated.(RootModel)
	if model.CommandInput() != "existing draft" {
		t.Fatalf("stale paste completion changed the draft: %q", model.CommandInput())
	}
}

func TestOperatorConsoleHistoryNavigationRestoresExactDraft(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.commandActive = true
	root.commandInput = "working draft"
	root.composer.SetValue(root.commandInput)
	root.composer.AddHistory(composer.HistoryEntry{ID: "prior", Value: "prior prompt"})

	updated, _ := root.Update(keyPress("up"))
	model := updated.(RootModel)
	if model.CommandInput() != "prior prompt" {
		t.Fatalf("expected previous prompt, got %q", model.CommandInput())
	}
	updated, _ = model.Update(keyPress("down"))
	model = updated.(RootModel)
	if model.CommandInput() != "working draft" {
		t.Fatalf("expected exact draft restoration, got %q", model.CommandInput())
	}
}

func TestOperatorConsoleConfirmationBlocksBackgroundDraftEditing(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	resized, _ := root.Update(tea.WindowSizeMsg{Width: 120, Height: 32})
	root = resized.(RootModel)
	pending, command := root.submitAssistantInput("stop backend")
	if command != nil || !pending.PendingConfirmation() {
		t.Fatalf("expected a pending confirmation, command=%v pending=%v", command, pending.PendingConfirmation())
	}
	updated, command := pending.Update(tea.KeyPressMsg{Text: "x", Code: 'x'})
	model := updated.(RootModel)
	if command != nil || model.CommandInput() != "" || model.commandActive || !model.PendingConfirmation() {
		t.Fatalf("modal must consume background typing: input=%q active=%v pending=%v command=%v", model.CommandInput(), model.commandActive, model.PendingConfirmation(), command)
	}
	rendered := model.Render()
	for _, label := range []string{"Relaybase", "Confirm Action", "Composer"} {
		if !strings.Contains(rendered, label) {
			t.Fatalf("composited modal omitted %q:\n%s", label, rendered)
		}
	}
	if lipgloss.Width(rendered) != 120 || lipgloss.Height(rendered) != 32 {
		t.Fatalf("composited modal changed terminal bounds: %dx%d", lipgloss.Width(rendered), lipgloss.Height(rendered))
	}
}

func TestOperatorConsoleKeepsExactSizeAcrossSupportedBreakpoints(t *testing.T) {
	for _, size := range [][2]int{{160, 48}, {120, 32}, {100, 30}, {80, 24}, {60, 24}, {40, 18}} {
		root := newTestModelWithPanes(t, 1)
		updated, _ := root.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		model := updated.(RootModel)
		rendered := model.Render()
		if got := lipgloss.Height(rendered); got != size[1] {
			t.Fatalf("%dx%d rendered %d rows:\n%s", size[0], size[1], got, rendered)
		}
		if got := lipgloss.Width(rendered); got != size[0] {
			t.Fatalf("%dx%d rendered %d columns:\n%s", size[0], size[1], got, rendered)
		}
	}
}

func TestOperatorConsoleThreadSwitcherIsTransientAndCancellable(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.connectionStatus = "connected"
	root.agentConfig = enabledAgentConfig(true)
	root.agentSession = &relaybaseclient.AgentSession{ID: "thread-one", Title: "Operations"}
	root.agentSessions = []relaybaseclient.AgentSession{
		*root.agentSession,
		{ID: "thread-two", Title: "Deploy follow-up", RecoveredApprovalCount: 1},
	}

	updated, command := root.Update(tea.KeyPressMsg{Code: 20})
	model := updated.(RootModel)
	if command != nil || !model.threadSwitcherVisible || model.interaction.Owner() != interaction.OwnerTransient {
		t.Fatalf("expected Ctrl+T transient switcher, visible=%v owner=%s command=%v", model.threadSwitcherVisible, model.interaction.Owner(), command)
	}
	rendered := model.Render()
	for _, label := range []string{"Relaybase", "Thread switcher", "Operations", "Deploy follow-up", "Esc cancel", "Composer"} {
		if !strings.Contains(rendered, label) {
			t.Fatalf("thread switcher omitted %q:\n%s", label, rendered)
		}
	}

	updated, _ = model.Update(keyPress("right"))
	model = updated.(RootModel)
	if model.threadSwitcherSelected != 1 {
		t.Fatalf("expected second thread selection, got %d", model.threadSwitcherSelected)
	}
	updated, _ = model.Update(tea.PasteMsg{Content: "must stay inert"})
	model = updated.(RootModel)
	if model.CommandInput() != "" || !model.threadSwitcherVisible {
		t.Fatalf("thread transient must consume paste, input=%q visible=%v", model.CommandInput(), model.threadSwitcherVisible)
	}
	updated, _ = model.Update(keyPress("esc"))
	model = updated.(RootModel)
	if model.threadSwitcherVisible || model.interaction.Owner() != interaction.OwnerPanes {
		t.Fatalf("Esc must cancel the transient and restore panes, visible=%v owner=%s", model.threadSwitcherVisible, model.interaction.Owner())
	}
}

func TestOperatorConsoleThreadActivationRestoresMemoryOnlyDraft(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.agentSession = &relaybaseclient.AgentSession{ID: "thread-one", Title: "Operations"}
	root.commandInput = "draft for operations"
	root.commandActive = true
	root.composer.SetValue(root.commandInput)
	root.captureThreadDraft()
	root.threadDrafts["thread-two"] = threadDraftState{Snapshot: composer.Snapshot{Value: "draft for deploy", Cursor: len([]rune("draft for deploy"))}, Active: true}

	updated, _ := root.Update(commands.AgentSessionActivatedMsg{Session: &relaybaseclient.AgentSession{ID: "thread-two", Title: "Deploy"}})
	model := updated.(RootModel)
	if model.CommandInput() != "draft for deploy" || !model.commandActive {
		t.Fatalf("expected target-thread draft restoration, active=%v input=%q", model.commandActive, model.CommandInput())
	}
	if original := model.threadDrafts["thread-one"].Snapshot.Value; original != "draft for operations" {
		t.Fatalf("source-thread draft changed: %q", original)
	}
}

func TestOperatorConsoleCodePickerCopiesSanitizedSource(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.assistantHistory = []string{"```go\nfmt.Println(\"safe\")\n```\n\x1b]52;c;secret\a"}
	root.interaction.SetFocus(interaction.FocusResponse)
	copied := ""
	writeClipboardText = func(value string) error {
		copied = value
		return nil
	}
	t.Cleanup(func() { writeClipboardText = writeSystemClipboardText })

	updated, command := root.Update(tea.KeyPressMsg{Text: "b", Code: 'b'})
	model := updated.(RootModel)
	if command != nil || !model.codePickerVisible || !strings.Contains(model.Render(), "Code blocks") {
		t.Fatalf("expected code picker, visible=%v command=%v\n%s", model.codePickerVisible, command, model.Render())
	}
	updated, command = model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if command == nil || model.codePickerVisible {
		t.Fatalf("expected explicit code copy and picker close, visible=%v command=%v", model.codePickerVisible, command)
	}
	updated, _ = model.Update(command())
	model = updated.(RootModel)
	if copied != `fmt.Println("safe")` || strings.Contains(copied, "\x1b") || strings.Contains(copied, "secret") {
		t.Fatalf("unexpected clipboard payload: %q", copied)
	}
}
