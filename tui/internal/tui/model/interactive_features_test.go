package model

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func TestSlashPaletteFiltersAndCompletesWithoutSubmitting(t *testing.T) {
	root := newTestModel(t)
	updated, cmd := root.Update(keyPress("/"))
	model := updated.(RootModel)
	if cmd != nil || !model.commandPaletteVisible() {
		t.Fatalf("slash should open a local palette without a command, visible=%v cmd=%v", model.commandPaletteVisible(), cmd)
	}
	if rendered := model.Render(); !strings.Contains(rendered, "/launch") {
		t.Fatalf("full command palette was not rendered:\n%s", rendered)
	}

	updated, _ = model.Update(keyPress("h"))
	model = updated.(RootModel)
	updated, _ = model.Update(keyPress("e"))
	model = updated.(RootModel)
	if model.commandPalette.Count() == 0 {
		t.Fatal("expected filtered help/health matches")
	}
	updated, cmd = model.Update(tea.KeyPressMsg{Code: tea.KeyTab})
	model = updated.(RootModel)
	if cmd != nil || model.CommandInput() != "/help" {
		t.Fatalf("tab should insert but not execute /help, input=%q cmd=%v", model.CommandInput(), cmd)
	}
	if model.HelpVisible() {
		t.Fatal("completion executed help instead of waiting for submit")
	}
	updated, cmd = model.Update(keyPress("enter"))
	model = updated.(RootModel)
	if cmd != nil || !model.HelpVisible() {
		t.Fatalf("second enter should submit local help, visible=%v cmd=%v", model.HelpVisible(), cmd)
	}
}

func TestSlashPaletteRefiltersAfterBackspace(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(keyPress("/"))
	model := updated.(RootModel)
	updated, _ = model.Update(keyPress("l"))
	model = updated.(RootModel)
	updated, _ = model.Update(keyPress("a"))
	model = updated.(RootModel)
	if model.commandPalette.Query() != "/la" {
		t.Fatalf("palette query did not track typed input: %q", model.commandPalette.Query())
	}
	updated, _ = model.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
	model = updated.(RootModel)
	if model.CommandInput() != "/l" || model.commandPalette.Query() != "/l" {
		t.Fatalf("palette did not refilter after backspace: input=%q query=%q", model.CommandInput(), model.commandPalette.Query())
	}
}

func TestSearchableHelpOwnsPrintableKeysAndClosesInOneStep(t *testing.T) {
	root := newTestModel(t)
	updated, cmd := root.Update(keyPress("?"))
	model := updated.(RootModel)
	if cmd != nil || !model.HelpVisible() {
		t.Fatalf("help should open locally, visible=%v cmd=%v", model.HelpVisible(), cmd)
	}
	updated, _ = model.Update(keyPress("q"))
	model = updated.(RootModel)
	if model.helpSearch.Value() != "q" || !model.HelpVisible() {
		t.Fatalf("help should own q as search input, query=%q visible=%v", model.helpSearch.Value(), model.HelpVisible())
	}
	updated, _ = model.Update(keyPress("esc"))
	model = updated.(RootModel)
	if model.HelpVisible() || model.commandActive {
		t.Fatalf("one escape should restore dashboard, help=%v input=%v", model.HelpVisible(), model.commandActive)
	}
}

func TestPaneCopyRestartAndRemainingPlaceholderControls(t *testing.T) {
	previousWriter := writeClipboardText
	previousCapability := clipboardWriteAvailable
	defer func() {
		writeClipboardText = previousWriter
		clipboardWriteAvailable = previousCapability
	}()
	var copied string
	writeClipboardText = func(value string) error {
		copied = value
		return nil
	}
	clipboardWriteAvailable = func() bool { return true }

	model := newTestModelWithPanes(t, 1)
	model.clipboardWriteReady = true
	pane := model.paneManager.SelectedPane()
	if pane == nil {
		t.Fatal("missing selected pane")
	}
	for index := 1; index <= 21; index++ {
		model.paneManager.AppendLog(relaybaseclient.LogEvent{
			Sequence: int64(index), AppID: pane.AppID, GroupID: pane.GroupID,
			ComponentRole: pane.Role, Stream: "stdout", Message: fmt.Sprintf("line %02d", index),
		})
	}
	frame := views.BuildShell(model.styles, model.shellData())
	copyRegion, ok := firstHit(frame, components.HitPaneCopyLogs)
	if !ok {
		t.Fatal("copy control has no hit region")
	}
	updated, cmd := model.Update(tea.MouseClickMsg{X: copyRegion.Rect.X, Y: copyRegion.Rect.Y, Button: tea.MouseLeft})
	model = updated.(RootModel)
	if cmd == nil {
		t.Fatal("copy control did not return clipboard command")
	}
	updated, _ = model.Update(cmd())
	model = updated.(RootModel)
	lines := strings.Split(copied, "\n")
	if len(lines) != 20 || !strings.HasSuffix(lines[0], "line 02") || !strings.HasSuffix(lines[19], "line 21") || strings.HasSuffix(copied, "\n") {
		t.Fatalf("unexpected copied tail (%d): %q", len(lines), copied)
	}

	restartRegion, ok := firstHit(views.BuildShell(model.styles, model.shellData()), components.HitPaneRestart)
	if !ok {
		t.Fatal("restart control has no hit region")
	}
	updated, restartCmd := model.Update(tea.MouseClickMsg{X: restartRegion.Rect.X, Y: restartRegion.Rect.Y, Button: tea.MouseLeft})
	model = updated.(RootModel)
	if restartCmd != nil || !model.PendingConfirmation() || model.pendingConfirm.Command.Kind != slash.KindRestart {
		t.Fatalf("restart must open the existing confirmation gate, cmd=%v pending=%#v", restartCmd, model.pendingConfirm)
	}
	updated, _ = model.Update(keyPress("esc"))
	model = updated.(RootModel)

	updated, placeholderCmd := model.Update(tea.MouseClickMsg{X: restartRegion.Rect.X + 5, Y: restartRegion.Rect.Y, Button: tea.MouseLeft})
	model = updated.(RootModel)
	if placeholderCmd != nil || model.PendingConfirmation() {
		t.Fatalf("remaining placeholder must be inert, cmd=%v pending=%v", placeholderCmd, model.PendingConfirmation())
	}
}

func TestMouseWheelOverOnePaneScrollsOnlyThatPane(t *testing.T) {
	model := newTestModelWithPanes(t, 2)
	panes := model.paneManager.CurrentPagePanes()
	for _, pane := range panes {
		for index := 1; index <= 40; index++ {
			model.paneManager.AppendLog(relaybaseclient.LogEvent{Sequence: int64(index), AppID: pane.AppID, GroupID: pane.GroupID, ComponentRole: pane.Role, Message: fmt.Sprintf("line %02d", index)})
		}
	}
	frame := views.BuildShell(model.styles, model.shellData())
	regions := frame.HitMap.Regions()
	var target components.HitRegion
	for _, region := range regions {
		if region.Kind == components.HitPaneLogs && region.PaneID == panes[1].ID {
			target = region
			break
		}
	}
	if !target.Rect.Valid() {
		t.Fatal("second pane has no log hit region")
	}
	updated, _ := model.Update(tea.MouseWheelMsg{X: target.Rect.X, Y: target.Rect.Y, Button: tea.MouseWheelUp})
	model = updated.(RootModel)
	first := model.paneManager.PaneSnapshot(panes[0].ID)
	second := model.paneManager.PaneSnapshot(panes[1].ID)
	if first == nil || second == nil || first.ScrollOffset != 0 || second.ScrollOffset == 0 || model.bodyScrollOffset != 0 {
		t.Fatalf("wheel should change only hovered pane: first=%#v second=%#v body=%d", first, second, model.bodyScrollOffset)
	}
}

func TestPaneSurfaceWheelIsInertOutsideTheLogViewport(t *testing.T) {
	model := newTestModelWithPanes(t, 1)
	model.bodyScrollOffset = 1
	frame := views.BuildShell(model.styles, model.shellData())
	surface, ok := firstHit(frame, components.HitPaneSurface)
	if !ok {
		t.Fatal("pane surface has no hit region")
	}
	updated, cmd := model.Update(tea.MouseWheelMsg{X: surface.Rect.X, Y: surface.Rect.Y, Button: tea.MouseWheelDown})
	model = updated.(RootModel)
	if cmd != nil || model.bodyScrollOffset != 1 {
		t.Fatalf("wheel over pane metadata must not scroll the body: cmd=%v body=%d", cmd, model.bodyScrollOffset)
	}
}

func TestHelpHitRegionsSelectAndScrollDetail(t *testing.T) {
	root := newTestModel(t)
	updated, _ := root.Update(keyPress("?"))
	model := updated.(RootModel)
	frame := views.BuildShell(model.styles, model.shellData())
	var result, detail components.HitRegion
	for _, region := range frame.HitMap.Regions() {
		switch region.Kind {
		case components.HitHelpResult:
			if region.Index > 0 {
				result = region
			}
		case components.HitHelpDetail:
			detail = region
		}
	}
	if !result.Rect.Valid() || !detail.Rect.Valid() {
		t.Fatalf("help hit regions missing: %#v", frame.HitMap.Regions())
	}
	updated, _ = model.Update(tea.MouseClickMsg{X: result.Rect.X, Y: result.Rect.Y, Button: tea.MouseLeft})
	model = updated.(RootModel)
	if model.helpSelected != result.Index {
		t.Fatalf("help result click did not select row %d: %d", result.Index, model.helpSelected)
	}
	updated, _ = model.Update(tea.MouseWheelMsg{X: detail.Rect.X, Y: detail.Rect.Y, Button: tea.MouseWheelDown})
	model = updated.(RootModel)
	if model.helpDetailOffset == 0 {
		t.Fatal("help detail wheel did not advance the Bubbles viewport request")
	}
}

func TestPackageRunPollingIsDeduplicatedAndRecoversAfterTransientFailures(t *testing.T) {
	model := newTestModel(t)
	if cmd := model.beginPackageRunPolling("pkg-run"); cmd == nil {
		t.Fatal("initial package run poll was not scheduled")
	}
	if cmd := model.beginPackageRunPolling("pkg-run"); cmd != nil {
		t.Fatal("duplicate package run poll was scheduled")
	}
	for attempt := 0; attempt < packageRunPollWarningThreshold; attempt++ {
		if cmd := model.recoverPackageRunPoll("pkg-run", attempt, errors.New("temporary")); cmd == nil {
			t.Fatal("transient poll failure stopped bounded retry")
		}
	}
	if !hasDiagnosticCode(model.Diagnostics(), "app_package_run_poll_retry") {
		t.Fatal("repeated transient failures did not produce a safe retry diagnostic")
	}
	run := relaybaseclient.AppPackageRun{ID: "pkg-run", PackageName: "stack", Status: "running"}
	updated, _ := model.Update(commands.AppPackageRunLoadedMsg{Run: &run})
	model = updated.(RootModel)
	if model.packageRunPollFailures[run.ID] != 0 || hasDiagnosticCode(model.Diagnostics(), "app_package_run_poll_retry") {
		t.Fatalf("successful poll did not clear retry state: failures=%d diagnostics=%#v", model.packageRunPollFailures[run.ID], model.Diagnostics())
	}
	terminal := run
	terminal.Status = "succeeded"
	updated, _ = model.Update(commands.AppPackageRunLoadedMsg{Run: &terminal})
	model = updated.(RootModel)
	finishedCount := strings.Count(strings.Join(model.assistantHistory, "\n"), "Package stack finished succeeded")
	updated, cmd := model.Update(commands.AppPackageRunLoadedMsg{Run: &terminal})
	model = updated.(RootModel)
	if cmd != nil || strings.Count(strings.Join(model.assistantHistory, "\n"), "Package stack finished succeeded") != finishedCount {
		t.Fatal("late terminal poll duplicated the package completion summary")
	}
}

func TestPackageLaunchWaitsForConfirmation(t *testing.T) {
	root := newTestModel(t)
	root.appPackages = []relaybaseclient.AppPackageDefinition{{ID: "pkg_ops", Name: "operations-stack", MemberAppIDs: []string{"operations", "credential-manager"}}}
	updated, cmd := root.submitSlashCommand(`/launch-package 'operations-stack'`)
	if cmd != nil || !updated.PendingConfirmation() {
		t.Fatalf("package launch should stop at confirmation, pending=%v cmd=%v", updated.PendingConfirmation(), cmd)
	}
	if updated.pendingConfirm.PackageID != "pkg_ops" || len(updated.pendingConfirm.Details) != 2 {
		t.Fatalf("confirmation did not retain package identity/members: %#v", updated.pendingConfirm)
	}
}

func firstHit(frame views.ShellFrame, kind components.HitKind) (components.HitRegion, bool) {
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == kind {
			return region, true
		}
	}
	return components.HitRegion{}, false
}

func hasDiagnosticCode(diagnostics []Diagnostic, code string) bool {
	for _, diagnostic := range diagnostics {
		if diagnostic.Code == code {
			return true
		}
	}
	return false
}
