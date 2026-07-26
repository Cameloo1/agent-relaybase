package model

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/cameloo/relaybase/tui/internal/preferences"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/layout"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func TestOperatorLayoutResynchronizesAfterDynamicComposerGrowth(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 36})
	root = updated.(RootModel)
	before := root.paneManager.Layout().Height

	updated, command := root.Update(tea.PasteMsg{Content: "first line\nsecond line\nthird line"})
	root = updated.(RootModel)
	if command == nil {
		t.Fatal("expected asynchronous paste")
	}
	updated, _ = root.Update(command())
	root = updated.(RootModel)

	want := layout.Compute(root.width, root.height, root.composer.Rows()).Panes.Height
	if got := root.paneManager.Layout().Height; got != want {
		t.Fatalf("pane layout height = %d, want %d after composer reflow", got, want)
	}
	if root.composer.Rows() < 2 || root.paneManager.Layout().Height >= before {
		t.Fatalf("composer/pane geometry did not reflow: rows=%d pane before=%d after=%d", root.composer.Rows(), before, root.paneManager.Layout().Height)
	}
}

func TestOperatorRailCountsDaemonActiveComponentsWithoutCallingRegistrationsActive(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	data := root.shellData()
	if data.RegisteredAppCount != 2 || data.ActiveAppCount != 2 {
		t.Fatalf("unexpected daemon-backed app counts: active=%d registered=%d", data.ActiveAppCount, data.RegisteredAppCount)
	}
	root.state.Apps[0].RuntimeStatus = "stopped"
	root.state.Apps[0].PID = 0
	for componentIndex := range root.state.Components {
		component := &root.state.Components[componentIndex]
		if component.AppID == root.state.Apps[0].ID {
			component.Status = "stopped"
			component.PID = 0
		}
	}
	for groupIndex := range root.state.Groups {
		for componentIndex := range root.state.Groups[groupIndex].Components {
			component := &root.state.Groups[groupIndex].Components[componentIndex]
			if component.AppID == root.state.Apps[0].ID {
				component.Status = "stopped"
				component.PID = 0
			}
		}
	}
	data = root.shellData()
	if data.ActiveAppCount != 1 || data.RegisteredAppCount != 2 {
		t.Fatalf("stopped registration was overclaimed as active: active=%d registered=%d", data.ActiveAppCount, data.RegisteredAppCount)
	}
}

func TestOperatorPointerFocusHasOneAuthoritativeOwner(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 36})
	root = updated.(RootModel)
	root.commandInput = "preserved draft"
	root.composer.SetValue(root.commandInput)
	root.setPrimaryFocus(interaction.FocusComposer)

	responseRegion := mustHitRegion(t, root, components.HitResponse)
	updated, _ = root.Update(clickInside(responseRegion))
	root = updated.(RootModel)
	if root.interaction.Owner() != interaction.OwnerResponse || root.commandActive || root.composer.Focused() || root.commandInput != "preserved draft" {
		t.Fatalf("response click left split focus state: owner=%s active=%v focused=%v draft=%q", root.interaction.Owner(), root.commandActive, root.composer.Focused(), root.commandInput)
	}
	if count := strings.Count(root.Render(), "[focused]"); count != 1 {
		t.Fatalf("response focus rendered %d visible focus markers, want exactly one", count)
	}

	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if root.interaction.Owner() != interaction.OwnerResponse || root.paneManager.Focused() {
		t.Fatalf("Enter fell through response ownership: owner=%s paneFocused=%v", root.interaction.Owner(), root.paneManager.Focused())
	}

	paneRegion := mustHitRegion(t, root, components.HitPaneLogs)
	updated, _ = root.Update(clickInside(paneRegion))
	root = updated.(RootModel)
	if root.interaction.Owner() != interaction.OwnerPanes || root.commandActive || root.composer.Focused() {
		t.Fatalf("pane click did not reclaim primary focus: owner=%s active=%v focused=%v", root.interaction.Owner(), root.commandActive, root.composer.Focused())
	}
	renderedPaneFocus := root.Render()
	plainPaneFocus := ansi.Strip(renderedPaneFocus)
	if !strings.Contains(plainPaneFocus, "status running | focused") || strings.Contains(plainPaneFocus, "[focused]") {
		t.Fatalf("pane focus did not render one pane-local textual indicator:\n%s", renderedPaneFocus)
	}

	composerRegion := mustHitRegion(t, root, components.HitComposer)
	updated, _ = root.Update(clickInside(composerRegion))
	root = updated.(RootModel)
	if root.interaction.Owner() != interaction.OwnerComposer || !root.commandActive || !root.composer.Focused() || root.commandInput != "preserved draft" {
		t.Fatalf("composer click did not atomically restore focus: owner=%s active=%v focused=%v draft=%q", root.interaction.Owner(), root.commandActive, root.composer.Focused(), root.commandInput)
	}
	if count := strings.Count(root.Render(), "[focused]"); count != 1 {
		t.Fatalf("composer focus rendered %d visible focus markers, want exactly one", count)
	}
}

func TestOperatorWheelChangesOnlyHoveredPaneVisibleLogs(t *testing.T) {
	for _, paneCount := range []int{2, 8} {
		t.Run(fmt.Sprintf("%d-panes", paneCount), func(t *testing.T) {
			root := newTestModelWithPanes(t, paneCount)
			updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 48})
			root = updated.(RootModel)
			paneSnapshots := root.paneManager.CurrentPagePanes()
			for paneIndex, pane := range paneSnapshots {
				for line := 1; line <= 40; line++ {
					root.paneManager.AppendLog(relaybaseclient.LogEvent{
						Sequence:      int64(line),
						AppID:         pane.AppID,
						GroupID:       pane.GroupID,
						ComponentRole: pane.Role,
						Message:       fmt.Sprintf("pane-%02d-line-%02d", paneIndex+1, line),
					})
				}
			}

			target := paneSnapshots[len(paneSnapshots)-1].ID
			other := paneSnapshots[0].ID
			beforeTarget := visiblePaneLogText(root.paneManager.PaneSnapshot(target))
			beforeOther := visiblePaneLogText(root.paneManager.PaneSnapshot(other))
			logRegion := mustPaneHitRegion(t, root, components.HitPaneLogs, target)
			updated, _ = root.Update(tea.MouseWheelMsg{X: logRegion.Rect.X, Y: logRegion.Rect.Y, Button: tea.MouseWheelUp})
			root = updated.(RootModel)
			afterTarget := visiblePaneLogText(root.paneManager.PaneSnapshot(target))
			afterOther := visiblePaneLogText(root.paneManager.PaneSnapshot(other))
			if reflect.DeepEqual(beforeTarget, afterTarget) {
				t.Fatalf("hovered pane's visible logs did not change: %#v", afterTarget)
			}
			if !reflect.DeepEqual(beforeOther, afterOther) {
				t.Fatalf("unhovered pane's visible logs changed: before=%#v after=%#v", beforeOther, afterOther)
			}
			if rendered := root.Render(); !strings.Contains(rendered, afterTarget[len(afterTarget)-1]) {
				t.Fatalf("updated visible log was not rendered: %q", afterTarget[len(afterTarget)-1])
			}

			surface := mustPaneHitRegion(t, root, components.HitPaneSurface, target)
			beforeSurface := visiblePaneLogText(root.paneManager.PaneSnapshot(target))
			updated, _ = root.Update(tea.MouseWheelMsg{X: surface.Rect.X, Y: surface.Rect.Y, Button: tea.MouseWheelUp})
			root = updated.(RootModel)
			if afterSurface := visiblePaneLogText(root.paneManager.PaneSnapshot(target)); !reflect.DeepEqual(beforeSurface, afterSurface) {
				t.Fatalf("pane metadata/surface wheel changed logs: before=%#v after=%#v", beforeSurface, afterSurface)
			}
		})
	}
}

func TestOperatorWheelRemainsUsableOnResponsiveFullMetadataPages(t *testing.T) {
	tests := []struct {
		name          string
		width         int
		height        int
		visiblePanes  int
		expectedPages int
	}{
		{name: "medium_80", width: 80, height: 24, visiblePanes: 4, expectedPages: 3},
		{name: "medium_100", width: 100, height: 30, visiblePanes: 6, expectedPages: 2},
		{name: "medium_110", width: 110, height: 32, visiblePanes: 8, expectedPages: 2},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := applyState(newTestModel(t), fullMetadataModelState(9))
			updated, _ := root.Update(tea.WindowSizeMsg{Width: test.width, Height: test.height})
			root = updated.(RootModel)
			root.responseFollow = false
			root.responseOffset = 2
			page := root.paneManager.CurrentPagePanes()
			if len(page) != test.visiblePanes || root.paneManager.PageCount() != test.expectedPages || root.paneManager.Layout().PaneHeight < 9 {
				t.Fatalf("responsive page is not scrollable: panes=%d pages=%d layout=%#v", len(page), root.paneManager.PageCount(), root.paneManager.Layout())
			}
			for paneIndex, pane := range page {
				for line := 1; line <= 40; line++ {
					root.paneManager.AppendLog(relaybaseclient.LogEvent{
						Sequence:      int64(line),
						AppID:         pane.AppID,
						GroupID:       pane.GroupID,
						ComponentRole: pane.Role,
						Message:       fmt.Sprintf("medium-pane-%02d-line-%02d", paneIndex+1, line),
					})
				}
			}

			target := page[len(page)-1].ID
			other := page[0].ID
			beforeTarget := visiblePaneLogText(root.paneManager.PaneSnapshot(target))
			beforeOther := visiblePaneLogText(root.paneManager.PaneSnapshot(other))
			region := mustPaneHitRegion(t, root, components.HitPaneLogs, target)
			if region.Rect.Height < 1 {
				t.Fatalf("responsive pane has no log hit rows: %#v", region)
			}
			updated, _ = root.Update(tea.MouseWheelMsg{X: region.Rect.X, Y: region.Rect.Y, Button: tea.MouseWheelUp})
			root = updated.(RootModel)
			afterTarget := visiblePaneLogText(root.paneManager.PaneSnapshot(target))
			if reflect.DeepEqual(beforeTarget, afterTarget) || !reflect.DeepEqual(beforeOther, visiblePaneLogText(root.paneManager.PaneSnapshot(other))) {
				t.Fatalf("medium wheel routing failed: target before=%#v after=%#v other before=%#v after=%#v", beforeTarget, afterTarget, beforeOther, visiblePaneLogText(root.paneManager.PaneSnapshot(other)))
			}
			if root.responseOffset != 2 || root.responseFollow {
				t.Fatalf("pane wheel changed response viewport ownership: offset=%d follow=%v", root.responseOffset, root.responseFollow)
			}
			if rendered := root.Render(); !strings.Contains(rendered, afterTarget[len(afterTarget)-1]) {
				t.Fatalf("scrolled medium pane did not render its new visible log: %#v", afterTarget)
			}
		})
	}
}

func TestOperatorCommandPaletteClickCompletesWithoutMovingResponse(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	root = updated.(RootModel)
	root.commandInput = "/usa"
	root.composer.SetValue(root.commandInput)
	root.setPrimaryFocus(interaction.FocusComposer)
	root.syncCommandPalette()
	root.responseOffset = 3
	root.responseFollow = false

	row := mustHitRegion(t, root, components.HitCommandPaletteRow)
	updated, command := root.Update(clickInside(row))
	root = updated.(RootModel)
	if command != nil || root.commandInput != "/usage" || root.responseOffset != 3 || root.usage.IsOpen() {
		t.Fatalf("palette click changed the wrong state: command=%v input=%q responseOffset=%d usageOpen=%v", command, root.commandInput, root.responseOffset, root.usage.IsOpen())
	}
}

func TestBlockingSurfacesConsumePasteClipboardAndBackgroundClicks(t *testing.T) {
	root := applyState(newTestModel(t), notesFrontendBackendState())
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 36})
	root = updated.(RootModel)
	pending, _ := root.submitAssistantInput("stop backend")

	updated, command := pending.Update(tea.PasteMsg{Content: "must not appear"})
	root = updated.(RootModel)
	if command != nil || root.commandInput != "" || root.paste != nil {
		t.Fatalf("confirmation leaked bracketed paste: command=%v input=%q pending=%v", command, root.commandInput, root.paste != nil)
	}
	updated, command = root.Update(clipboardPasteLoadedMsg{Text: "also blocked"})
	root = updated.(RootModel)
	if command != nil || root.commandInput != "" || root.paste != nil {
		t.Fatalf("confirmation leaked clipboard completion: command=%v input=%q pending=%v", command, root.commandInput, root.paste != nil)
	}

	root.pendingConfirm = nil
	root.interaction.CloseModal()
	root.usage.Open()
	root.interaction.OpenModal(interaction.ModalUsage)
	responseRegion := mustHitRegion(t, root, components.HitResponse)
	updated, _ = root.Update(clickInside(responseRegion))
	root = updated.(RootModel)
	if root.interaction.Owner() != interaction.OwnerModal || root.commandInput != "" {
		t.Fatalf("usage click leaked to background: owner=%s input=%q", root.interaction.Owner(), root.commandInput)
	}
	updated, command = root.Update(tea.PasteMsg{Content: "hidden paste"})
	root = updated.(RootModel)
	if command != nil || root.commandInput != "" || root.paste != nil {
		t.Fatalf("usage leaked paste: command=%v input=%q pending=%v", command, root.commandInput, root.paste != nil)
	}
}

func TestHelpPasteSanitizesTerminalActionsBeforeRendering(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	_ = root.openHelp()
	updated, _ := root.Update(tea.PasteMsg{Content: "usage\x1b[2J\x1b]52;c;attack\a"})
	root = updated.(RootModel)
	if strings.Contains(root.helpSearch.Value(), "\x1b") || strings.Contains(root.Render(), "\x1b[2J") || strings.Contains(root.Render(), "\x1b]52") {
		t.Fatalf("help paste retained terminal action: query=%q", root.helpSearch.Value())
	}
}

func TestLongConfirmationOwnsVisibleKeyboardAndWheelScrolling(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	root = updated.(RootModel)
	details := make([]string, 40)
	for index := range details {
		details[index] = fmt.Sprintf("detail-%02d", index+1)
	}
	root.pendingConfirm = &confirmationRequest{Action: "test", Details: details}
	root.refreshAssistantPrompt()
	modal := mustHitRegion(t, root, components.HitModal)
	updated, _ = root.Update(tea.MouseWheelMsg{X: modal.Rect.X + 1, Y: modal.Rect.Y + 1, Button: tea.MouseWheelDown})
	root = updated.(RootModel)
	if root.bodyScrollOffset == 0 {
		t.Fatal("modal wheel did not move the visible confirmation viewport")
	}
	updated, _ = root.Update(keyPress("end"))
	root = updated.(RootModel)
	if !strings.Contains(root.Render(), "detail-40") {
		t.Fatalf("modal End did not reveal final detail:\n%s", root.Render())
	}
}

func TestExternalApprovalResolutionReleasesModalOwnership(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.commandInput = "draft"
	root.composer.SetValue(root.commandInput)
	root.setPrimaryFocus(interaction.FocusComposer)
	root.pendingAgentApproval = &relaybaseclient.AgentApproval{ID: "approval-1", Status: "pending"}
	root.interaction.OpenModal(interaction.ModalAgentApproval)

	root.applyAgentRunEvent(relaybaseclient.AgentRunEvent{Type: "tool.rejected", Data: json.RawMessage(`{"id":"approval-1"}`)})
	if root.pendingAgentApproval != nil || root.interaction.Owner() != interaction.OwnerComposer {
		t.Fatalf("external resolution left modal stuck: pending=%v owner=%s", root.pendingAgentApproval != nil, root.interaction.Owner())
	}
}

func TestQuitWithDraftRequiresExplicitConfirmationAndPreservesDraftOnCancel(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.commandInput = "unsent\noperator draft"
	root.composer.SetValue(root.commandInput)
	root.setPrimaryFocus(interaction.FocusPanes)

	updated, command := root.Update(keyPress("q"))
	root = updated.(RootModel)
	if command != nil || !root.quitConfirmation || root.interaction.Owner() != interaction.OwnerModal || !strings.Contains(root.Render(), "memory-only composer draft will be lost") {
		t.Fatalf("quit did not open a blocking draft warning: command=%v pending=%v owner=%s", command, root.quitConfirmation, root.interaction.Owner())
	}
	updated, command = root.Update(tea.PasteMsg{Content: "hidden"})
	root = updated.(RootModel)
	if command != nil || root.commandInput != "unsent\noperator draft" {
		t.Fatalf("quit confirmation leaked paste: command=%v draft=%q", command, root.commandInput)
	}
	updated, _ = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if root.quitConfirmation || root.commandInput != "unsent\noperator draft" || root.interaction.Owner() != interaction.OwnerPanes {
		t.Fatalf("quit cancellation lost state: pending=%v draft=%q owner=%s", root.quitConfirmation, root.commandInput, root.interaction.Owner())
	}
}

func TestThreadActivationKeepsResponseTimelineAndViewportIsolated(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.agentSession = &relaybaseclient.AgentSession{ID: "thread-one", Title: "One"}
	root.assistantTimeline = []string{"thread one response"}
	root.lastAssistantLine = "thread one response"
	root.responseOffset = 2
	root.responseFollow = false
	root.responseNewOutput = 3
	root.captureThreadResponse()
	root.threadResponses["thread-two"] = threadResponseState{
		AssistantTimeline: []string{"thread two response"},
		LastAssistantLine: "thread two response",
		ResponseFollow:    true,
	}

	updated, _ := root.Update(commands.AgentSessionActivatedMsg{Session: &relaybaseclient.AgentSession{ID: "thread-two", Title: "Two"}})
	root = updated.(RootModel)
	joined := strings.Join(root.assistantTimeline, "\n")
	if strings.Contains(joined, "thread one response") || !strings.Contains(joined, "thread two response") {
		t.Fatalf("thread responses blended after activation: %q", joined)
	}

	before := joined
	updated, _ = root.Update(commands.AgentEventMsg{Event: relaybaseclient.AgentRunEvent{
		SessionID: "thread-one",
		Type:      "answer",
		Data:      json.RawMessage(`{"content":"late stale response"}`),
	}})
	root = updated.(RootModel)
	if got := strings.Join(root.assistantTimeline, "\n"); got != before {
		t.Fatalf("stale thread event mutated active response: %q", got)
	}

	root.captureThreadResponse()
	updated, _ = root.Update(commands.AgentSessionActivatedMsg{Session: &relaybaseclient.AgentSession{ID: "thread-one", Title: "One"}})
	root = updated.(RootModel)
	joined = strings.Join(root.assistantTimeline, "\n")
	if !strings.Contains(joined, "thread one response") || strings.Contains(joined, "thread two response") || root.responseOffset != 2 || root.responseFollow || root.responseNewOutput != 4 {
		t.Fatalf("source response state was not restored exactly: timeline=%q offset=%d follow=%v new=%d", joined, root.responseOffset, root.responseFollow, root.responseNewOutput)
	}
}

func TestActiveSessionLoadRestoresOrClearsThreadLocalUIState(t *testing.T) {
	t.Run("restores cached target", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		root.agentSession = &relaybaseclient.AgentSession{ID: "thread-old", Title: "Old"}
		root.assistantTimeline = []string{"old response"}
		root.lastAssistantLine = "old response"
		root.commandInput = "old draft"
		root.composer.SetValue(root.commandInput)
		root.commandActive = true

		targetComposer := root.composer
		targetComposer.SetValue("target draft")
		root.threadDrafts["thread-target"] = threadDraftState{Snapshot: targetComposer.Snapshot(), Active: true}
		root.threadResponses["thread-target"] = threadResponseState{
			AssistantTimeline: []string{"target response"},
			LastAssistantLine: "target response",
			ResponseOffset:    2,
			ResponseFollow:    false,
			ResponseNewOutput: 4,
		}

		updated, command := root.Update(commands.AgentActiveSessionLoadedMsg{Session: &relaybaseclient.AgentSession{ID: "thread-target", Title: "Target"}})
		root = updated.(RootModel)
		joined := strings.Join(root.assistantTimeline, "\n")
		if command == nil || root.agentSessionID() != "thread-target" || root.commandInput != "target draft" || !root.commandActive ||
			!strings.Contains(joined, "target response") || strings.Contains(joined, "old response") || root.responseOffset != 2 || root.responseFollow || root.responseNewOutput != 5 {
			t.Fatalf("active load did not restore target state: command=%v session=%q draft=%q active=%v timeline=%q offset=%d follow=%v new=%d", command, root.agentSessionID(), root.commandInput, root.commandActive, joined, root.responseOffset, root.responseFollow, root.responseNewOutput)
		}
		if root.threadDrafts["thread-old"].Snapshot.Value != "old draft" || !strings.Contains(strings.Join(root.threadResponses["thread-old"].AssistantTimeline, "\n"), "old response") {
			t.Fatalf("active load did not preserve source state: draft=%#v response=%#v", root.threadDrafts["thread-old"], root.threadResponses["thread-old"])
		}
	})

	t.Run("clears uncached target", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		root.agentSession = &relaybaseclient.AgentSession{ID: "thread-old"}
		root.assistantTimeline = []string{"must not blend"}
		root.lastAssistantLine = "must not blend"
		root.commandInput = "must not cross threads"
		root.composer.SetValue(root.commandInput)
		root.responseOffset = 7
		root.responseFollow = false
		root.responseNewOutput = 3

		updated, _ := root.Update(commands.AgentActiveSessionLoadedMsg{Session: &relaybaseclient.AgentSession{ID: "thread-new", Title: "New"}})
		root = updated.(RootModel)
		if root.commandInput != "" || root.composer.Value() != "" || strings.Contains(strings.Join(root.assistantTimeline, "\n"), "must not blend") ||
			root.responseOffset != 0 || !root.responseFollow || root.responseNewOutput != 0 {
			t.Fatalf("uncached active thread inherited old UI state: draft=%q timeline=%q offset=%d follow=%v new=%d", root.commandInput, strings.Join(root.assistantTimeline, "\n"), root.responseOffset, root.responseFollow, root.responseNewOutput)
		}
	})
}

func TestStaleAgentMessageCompletionCannotMutateAnotherThread(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.agentSession = &relaybaseclient.AgentSession{ID: "thread-a"}
	root.agentMessageGeneration = 7
	root.agentStatus = "sending"
	root.authorizedProjectRoots = []string{"C:/keep"}
	root.pendingSubmissionDraft = &submissionDraftState{
		Snapshot:   root.composer.Snapshot(),
		Focus:      interaction.FocusComposer,
		SessionID:  "thread-a",
		Generation: 7,
	}
	targetComposer := root.composer
	targetComposer.SetValue("thread b draft")
	root.threadDrafts["thread-b"] = threadDraftState{Snapshot: targetComposer.Snapshot(), Active: true}
	root.threadResponses["thread-b"] = threadResponseState{AssistantTimeline: []string{"thread b response"}, LastAssistantLine: "thread b response", ResponseFollow: true}

	updated, _ := root.Update(commands.AgentSessionActivatedMsg{Session: &relaybaseclient.AgentSession{ID: "thread-b"}})
	root = updated.(RootModel)
	baselineTimeline := strings.Join(root.assistantTimeline, "\n")
	baselineStatus := root.agentStatus

	staleResult := &relaybaseclient.AgentMessageResult{Run: relaybaseclient.AgentRun{
		SessionID: "thread-a",
		Events: []relaybaseclient.AgentRunEvent{{
			SessionID: "thread-a",
			Type:      "answer",
			Data:      json.RawMessage(`{"content":"stale answer"}`),
		}},
	}}
	updated, _ = root.Update(commands.AgentMessageSentMsg{Result: staleResult, SessionID: "thread-a", Generation: 7})
	root = updated.(RootModel)
	updated, _ = root.Update(commands.AgentMessageSendFailedMsg{Err: fmt.Errorf("stale failure"), SessionID: "thread-a", Generation: 7})
	root = updated.(RootModel)

	if root.agentSessionID() != "thread-b" || root.commandInput != "thread b draft" || strings.Join(root.assistantTimeline, "\n") != baselineTimeline ||
		root.agentStatus != baselineStatus || root.pendingSubmissionDraft == nil || len(root.authorizedProjectRoots) != 1 || hasDiagnostic(root.Diagnostics(), "agent_message_failed") {
		t.Fatalf("stale completion mutated active thread: session=%q draft=%q timeline=%q status=%q pending=%v roots=%#v diagnostics=%#v", root.agentSessionID(), root.commandInput, strings.Join(root.assistantTimeline, "\n"), root.agentStatus, root.pendingSubmissionDraft != nil, root.authorizedProjectRoots, root.Diagnostics())
	}
}

func TestResponseFollowAnchorsWrappedOutputAndUnreadState(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 36})
	root = updated.(RootModel)
	root.historyExpanded = true
	for index := 0; index < 30; index++ {
		root.assistantTimeline = append(root.assistantTimeline, "a long response line that wraps in the operator response viewport")
	}
	root.responseFollow = true
	bottom := views.ResponseScrollMax(root.styles, root.shellData())
	if bottom == 0 || root.shellData().ResponseOffset != bottom {
		t.Fatalf("follow did not project to the rendered bottom: got=%d bottom=%d", root.shellData().ResponseOffset, bottom)
	}

	root.setPrimaryFocus(interaction.FocusResponse)
	updated, _ = root.Update(keyPress("up"))
	root = updated.(RootModel)
	pausedOffset := root.responseOffset
	if root.responseFollow || pausedOffset >= bottom {
		t.Fatalf("manual upward scroll did not pause follow: follow=%v offset=%d bottom=%d", root.responseFollow, pausedOffset, bottom)
	}
	root.addAssistantMessage("new output while paused")
	if root.responseOffset != pausedOffset || root.responseNewOutput != 1 {
		t.Fatalf("paused response did not preserve offset/unread: offset=%d new=%d", root.responseOffset, root.responseNewOutput)
	}

	updated, _ = root.Update(keyPress("end"))
	root = updated.(RootModel)
	if !root.responseFollow || root.responseNewOutput != 0 || root.shellData().ResponseOffset != views.ResponseScrollMax(root.styles, root.shellData()) {
		t.Fatalf("End did not restore follow: follow=%v new=%d offset=%d", root.responseFollow, root.responseNewOutput, root.shellData().ResponseOffset)
	}
}

func TestWholeResponseCopyRemovesTerminalActions(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.historyExpanded = true
	root.assistantTimeline = []string{"safe\x1b]52;c;clipboard-attack\a text"}
	root.setPrimaryFocus(interaction.FocusResponse)
	copied := ""
	writeClipboardText = func(value string) error { copied = value; return nil }
	t.Cleanup(func() { writeClipboardText = writeSystemClipboardText })

	updated, command := root.Update(tea.KeyPressMsg{Text: "c", Code: 'c', Mod: tea.ModCtrl})
	root = updated.(RootModel)
	if command == nil {
		t.Fatal("expected clipboard command")
	}
	updated, _ = root.Update(command())
	_ = updated.(RootModel)
	if strings.Contains(copied, "\x1b") || strings.Contains(copied, "clipboard-attack") || copied != "safe text" {
		t.Fatalf("unsafe whole-response clipboard payload: %q", copied)
	}
}

func TestResponseFocusHonorsGlobalBindingsBeforePrintableAdoption(t *testing.T) {
	t.Run("help", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		root.setPrimaryFocus(interaction.FocusResponse)
		updated, _ := root.Update(keyPress("?"))
		root = updated.(RootModel)
		if !root.helpVisible || root.commandInput != "" || root.interaction.Owner() != interaction.OwnerTransient || root.interaction.Transient != interaction.TransientHelp {
			t.Fatalf("response help binding was adopted as text: help=%v input=%q owner=%s", root.helpVisible, root.commandInput, root.interaction.Owner())
		}
	})

	t.Run("diagnostics", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		root.addDiagnostic("test", "warning", "visible")
		root.setPrimaryFocus(interaction.FocusResponse)
		updated, _ := root.Update(tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl})
		root = updated.(RootModel)
		if !root.diagnosticsExpanded || root.commandInput != "" {
			t.Fatalf("response diagnostics binding was adopted as text: open=%v input=%q", root.diagnosticsExpanded, root.commandInput)
		}
	})

	t.Run("quit", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		root.setPrimaryFocus(interaction.FocusResponse)
		updated, command := root.Update(keyPress("q"))
		root = updated.(RootModel)
		if command == nil || root.commandInput != "" || root.commandActive {
			t.Fatalf("response quit binding was adopted as text: command=%v input=%q active=%v", command, root.commandInput, root.commandActive)
		}
	})

	t.Run("ordinary printable", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		root.setPrimaryFocus(interaction.FocusResponse)
		updated, _ := root.Update(keyPress("x"))
		root = updated.(RootModel)
		if root.commandInput != "x" || root.interaction.Owner() != interaction.OwnerComposer {
			t.Fatalf("ordinary printable did not adopt composer ownership: input=%q owner=%s", root.commandInput, root.interaction.Owner())
		}
	})
}

func TestApprovalResolutionRequiresExactIDAndResetsModalScroll(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.bodyScrollOffset = 9
	root.applyAgentRunEvent(relaybaseclient.AgentRunEvent{
		Type: "tool.approval_required",
		Data: json.RawMessage(`{"approval":{"id":"approval-current","status":"pending"}}`),
	})
	if root.pendingAgentApproval == nil || root.bodyScrollOffset != 0 || root.interaction.Owner() != interaction.OwnerModal {
		t.Fatalf("approval open did not establish a fresh modal viewport: pending=%v offset=%d owner=%s", root.pendingAgentApproval != nil, root.bodyScrollOffset, root.interaction.Owner())
	}

	root.bodyScrollOffset = 5
	root.applyAgentRunEvent(relaybaseclient.AgentRunEvent{Type: "tool.rejected", Data: json.RawMessage(`{"id":"approval-stale"}`)})
	if root.pendingAgentApproval == nil || root.pendingAgentApproval.ID != "approval-current" || root.bodyScrollOffset != 5 || root.interaction.Owner() != interaction.OwnerModal {
		t.Fatalf("mismatched rejection released the active approval: pending=%#v offset=%d owner=%s", root.pendingAgentApproval, root.bodyScrollOffset, root.interaction.Owner())
	}

	root.applyAgentRunEvent(relaybaseclient.AgentRunEvent{Type: "tool.rejected", Data: json.RawMessage(`{"id":"approval-current"}`)})
	if root.pendingAgentApproval != nil || root.bodyScrollOffset != 0 || root.interaction.Owner() == interaction.OwnerModal {
		t.Fatalf("matching rejection did not release/reset modal state: pending=%v offset=%d owner=%s", root.pendingAgentApproval != nil, root.bodyScrollOffset, root.interaction.Owner())
	}
}

func TestAgentEventLifecycleRejectsStaleGenerationAfterThreadClear(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	root.agentSession = &relaybaseclient.AgentSession{ID: "thread-old"}
	_ = root.connectAgentEventsCmd("thread-old")
	oldGeneration := root.agentStreamGeneration
	oldStream := &relaybaseclient.AgentEventStream{}
	updated, _ := root.Update(commands.AgentEventsConnectedMsg{Stream: oldStream, SessionID: "thread-old", Generation: oldGeneration})
	root = updated.(RootModel)
	if root.agentStream != oldStream || root.agentStatus != "idle" {
		t.Fatalf("current stream did not connect: stream=%p status=%s", root.agentStream, root.agentStatus)
	}

	updated, _ = root.Update(commands.AgentSessionClearedMsg{Result: &relaybaseclient.AgentSessionClearResult{SessionID: "thread-old", Cleared: true}})
	root = updated.(RootModel)
	if root.agentSession != nil || root.agentStream != nil {
		t.Fatalf("thread clear did not invalidate stream identity: session=%#v stream=%p", root.agentSession, root.agentStream)
	}
	statusAfterClear := root.agentStatus
	updated, command := root.Update(commands.AgentEventsConnectedMsg{Stream: &relaybaseclient.AgentEventStream{}, SessionID: "thread-old", Generation: oldGeneration})
	root = updated.(RootModel)
	if command != nil || root.agentStream != nil || root.agentStatus != statusAfterClear {
		t.Fatalf("stale connection mutated cleared thread: command=%v stream=%p status=%s", command, root.agentStream, root.agentStatus)
	}
	updated, _ = root.Update(commands.AgentEventsDisconnectedMsg{SessionID: "thread-old", Generation: oldGeneration, Err: fmt.Errorf("late close")})
	root = updated.(RootModel)
	if root.agentStatus != statusAfterClear || hasDiagnostic(root.Diagnostics(), agentEventDisconnectedCode) {
		t.Fatalf("stale disconnect mutated cleared thread: status=%s diagnostics=%#v", root.agentStatus, root.Diagnostics())
	}
}

func TestSubmissionDraftRestoresOnParseRefusalAndSendFailure(t *testing.T) {
	t.Run("parse refusal", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		const draft = "/definitely-not-a-command --exact"
		root.commandInput = draft
		root.composer.SetValue(draft)
		root.composer.SetSelection(1, 7)
		before := root.composer.Snapshot()
		root.setPrimaryFocus(interaction.FocusComposer)

		updated, command := root.Update(keyPress("enter"))
		root = updated.(RootModel)
		after := root.composer.Snapshot()
		if command != nil || root.commandInput != draft || !root.commandActive || root.interaction.Owner() != interaction.OwnerComposer ||
			after.Value != before.Value || after.Cursor != before.Cursor || after.SelectionStart != before.SelectionStart || after.SelectionEnd != before.SelectionEnd {
			t.Fatalf("parse refusal lost exact draft state: command=%v input=%q active=%v owner=%s before=%#v after=%#v", command, root.commandInput, root.commandActive, root.interaction.Owner(), before, after)
		}
	})

	t.Run("asynchronous send failure", func(t *testing.T) {
		root := newTestModelWithPanes(t, 1)
		root.agentConfig = &relaybaseclient.AgentConfig{Enabled: true, Provider: relaybaseclient.AgentProviderConfig{
			RemoteModelEnabled: true,
			ModelSlug:          "test/model",
			APIKeySource:       relaybaseclient.AgentAPIKeySource{Configured: true},
		}}
		root.agentSession = &relaybaseclient.AgentSession{ID: "thread-send"}
		root.syncComposerHistoryScope()
		const draft = "send this exact operator message"
		root.commandInput = draft
		root.composer.SetValue(draft)
		root.setPrimaryFocus(interaction.FocusComposer)

		updated, command := root.Update(keyPress("enter"))
		root = updated.(RootModel)
		if command == nil || root.pendingSubmissionDraft == nil || root.commandInput != "" {
			t.Fatalf("agent submission did not retain a recoverable draft: command=%v pending=%v input=%q", command, root.pendingSubmissionDraft != nil, root.commandInput)
		}
		updated, _ = root.Update(commands.AgentMessageSendFailedMsg{
			Err:        fmt.Errorf("send refused"),
			SessionID:  root.agentSessionID(),
			Generation: root.agentMessageGeneration,
		})
		root = updated.(RootModel)
		if root.pendingSubmissionDraft != nil || root.commandInput != draft || root.composer.Value() != draft || root.interaction.Owner() != interaction.OwnerComposer {
			t.Fatalf("send failure did not restore draft: pending=%v input=%q composer=%q owner=%s", root.pendingSubmissionDraft != nil, root.commandInput, root.composer.Value(), root.interaction.Owner())
		}
	})
}

func TestNonAgentAsyncCommandDoesNotBorrowAnotherRunSubmissionDraft(t *testing.T) {
	root := newTestModel(t)
	root.agentStatus = "sending"
	root.commandInput = "/usage"
	root.composer.SetValue(root.commandInput)
	root.setPrimaryFocus(interaction.FocusComposer)
	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command == nil || !root.usage.IsOpen() {
		t.Fatalf("usage command did not start its read-only fetch: command=%v open=%v", command, root.usage.IsOpen())
	}
	if root.pendingSubmissionDraft != nil {
		t.Fatal("non-Agent async command retained a draft owned by an unrelated sending Agent run")
	}
}

func TestComposerHistoryUsesStableScopeAndMonotonicIDs(t *testing.T) {
	root := newTestModelWithPanes(t, 1)
	for _, draft := range []string{"what is broken?", "show diagnostics"} {
		root.commandInput = draft
		root.composer.SetValue(draft)
		root.setPrimaryFocus(interaction.FocusComposer)
		updated, _ := root.Update(keyPress("enter"))
		root = updated.(RootModel)
		// Reproduce the response clearing that made the old length-derived IDs
		// collide without changing composer history.
		root.naturalHistory = nil
		root.assistantTimeline = nil
	}
	entries := root.composer.History().Entries()
	if len(entries) != 2 || entries[0].ID == entries[1].ID || entries[0].ThreadID != "local:1" || entries[1].ThreadID != "local:1" {
		t.Fatalf("history identity is not stable/monotonic: %#v", entries)
	}

	root.agentSession = &relaybaseclient.AgentSession{ID: "daemon-session"}
	root.syncComposerHistoryScope()
	if got := root.composer.History().Scope(); got != "agent:daemon-session" {
		t.Fatalf("history scope does not use daemon session identity: %q", got)
	}
	root.composer.SetValue("daemon draft")
	if root.composer.PreviousHistory() {
		t.Fatalf("daemon session reached local-thread history: %q", root.composer.Value())
	}
}

func TestNewLocalThreadDetachesOldAgentHistoryAndStreamIdentity(t *testing.T) {
	root := newTestModel(t)
	root.agentSession = &relaybaseclient.AgentSession{ID: "old-thread"}
	root.syncComposerHistoryScope()
	root.agentStreamSessionID = "old-thread"
	root.agentStreamGeneration = 4
	if got := root.composer.History().Scope(); got != "agent:old-thread" {
		t.Fatalf("initial history scope=%q", got)
	}

	command := root.startNewAssistantThread("local replacement")
	if command != nil {
		t.Fatal("gateway-unavailable local thread unexpectedly returned a daemon command")
	}
	if root.agentSession != nil || root.agentStreamSessionID != "" || root.agentStreamGeneration <= 4 {
		t.Fatalf("new local thread retained stale Agent identity: session=%#v stream=%q generation=%d", root.agentSession, root.agentStreamSessionID, root.agentStreamGeneration)
	}
	if got := root.composer.History().Scope(); !strings.HasPrefix(got, "local:") {
		t.Fatalf("new local thread retained old history scope %q", got)
	}
}

func TestRegisteredAndActiveCountsShareUniqueAppInventory(t *testing.T) {
	state := notesFrontendBackendState()
	state.Apps = append(state.Apps, state.Apps[0])
	state.Components = append(state.Components, state.Components[0])
	extra := state.Components[0]
	extra.AppID = "component-only"
	extra.Status = "running"
	extra.PID = 999
	state.Components = append(state.Components, extra)
	root := applyState(newTestModel(t), state)
	data := root.shellData()
	if data.RegisteredAppCount != 3 || data.ActiveAppCount != 3 || data.AppCount != 3 {
		t.Fatalf("rail counts did not share unique app inventory: app=%d registered=%d active=%d", data.AppCount, data.RegisteredAppCount, data.ActiveAppCount)
	}
}

func TestAssistantBarColorPropagatesToComposerOnLoadThemeAndCycle(t *testing.T) {
	stateDir := t.TempDir()
	store := preferences.NewStore(stateDir)
	prefs := preferences.Default()
	prefs.Assistant.BarColor = "#123456"
	if err := store.Save(prefs); err != nil {
		t.Fatalf("save preferences: %v", err)
	}
	root := newTestModelInStateDir(stateDir)
	if !sameColor(root.composer.AssistantColor(), lipgloss.Color("#123456")) {
		t.Fatalf("persisted assistant color did not reach composer: %#v", root.composer.AssistantColor())
	}
	root.applyTheme("dark")
	if !sameColor(root.composer.AssistantColor(), lipgloss.Color("#123456")) {
		t.Fatalf("theme change dropped assistant composer color: %#v", root.composer.AssistantColor())
	}
	root.preferences.Assistant.BarColor = "default"
	root.composer.ApplyTheme(root.theme, "default")
	if got := root.cycleAssistantBarColor(); got != "#216869" || !sameColor(root.composer.AssistantColor(), lipgloss.Color("#216869")) {
		t.Fatalf("color cycle did not reach composer: preference=%q color=%#v", got, root.composer.AssistantColor())
	}
}

func mustHitRegion(t *testing.T, root RootModel, kind components.HitKind) components.HitRegion {
	t.Helper()
	for _, region := range views.BuildShell(root.styles, root.shellData()).HitMap.Regions() {
		if region.Kind == kind {
			return region
		}
	}
	t.Fatalf("missing %s hit region", kind)
	return components.HitRegion{}
}

func mustPaneHitRegion(t *testing.T, root RootModel, kind components.HitKind, paneID string) components.HitRegion {
	t.Helper()
	for _, region := range views.BuildShell(root.styles, root.shellData()).HitMap.Regions() {
		if region.Kind == kind && region.PaneID == paneID {
			return region
		}
	}
	t.Fatalf("missing %s hit region for %s", kind, paneID)
	return components.HitRegion{}
}

func visiblePaneLogText(snapshot *panes.PaneSnapshot) []string {
	if snapshot == nil {
		return nil
	}
	lines := make([]string, 0, len(snapshot.LogLineModels))
	for _, line := range snapshot.LogLineModels {
		lines = append(lines, line.Text)
	}
	if len(lines) == 0 {
		lines = append(lines, snapshot.LogLines...)
	}
	return lines
}

func clickInside(region components.HitRegion) tea.MouseClickMsg {
	return tea.MouseClickMsg{X: region.Rect.X + region.Rect.Width/2, Y: region.Rect.Y + region.Rect.Height/2, Button: tea.MouseLeft}
}

func fullMetadataModelState(componentCount int) *relaybaseclient.RelaybaseState {
	state := &relaybaseclient.RelaybaseState{}
	for index := 1; index <= componentCount; index++ {
		appID := fmt.Sprintf("full-app-%d", index)
		role := "frontend"
		if index%2 == 0 {
			role = "backend"
		}
		state.Components = append(state.Components, relaybaseclient.AppComponent{
			AppID:       appID,
			GroupID:     appID,
			Role:        role,
			PaneLabel:   role,
			PaneOrder:   index,
			DisplayName: fmt.Sprintf("Full App %d", index),
			Status:      "failed",
			Route:       relaybaseclient.RouteInfo{HumanURL: fmt.Sprintf("http://full-app-%d.localhost:7777", index), Reachable: true},
			PID:         3000 + index,
			Port:        9000 + index,
			LastError:   "health check failed",
		})
	}
	return state
}
