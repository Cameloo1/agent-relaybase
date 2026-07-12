package panes

import (
	"fmt"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func TestPaneManagerMapsSingleAppToOnePane(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(&relaybaseclient.RelaybaseState{
		Apps: []relaybaseclient.AppState{{ID: "notes", Name: "Notes", RuntimeStatus: "running"}},
	})

	panes := manager.VisiblePanes()
	if len(panes) != 1 {
		t.Fatalf("expected one pane, got %d", len(panes))
	}
	if panes[0].Title != "Notes: app" {
		t.Fatalf("unexpected title: %s", panes[0].Title)
	}
}

func TestPaneManagerMapsFrontendBackendGroupToTwoPanes(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(groupedState(1))

	panes := manager.VisiblePanes()
	if len(panes) != 2 {
		t.Fatalf("expected two panes, got %d", len(panes))
	}
	if panes[0].Title != "App 1: frontend" || panes[1].Title != "App 1: backend" {
		t.Fatalf("unexpected pane titles: %#v", panes)
	}
}

func TestPaneManagerRendersFourGroupsAsEightPanes(t *testing.T) {
	manager := NewManager()
	manager.Resize(160, 40)
	manager.ApplyState(groupedState(4))

	panes := manager.VisiblePanes()
	if len(panes) != 8 {
		t.Fatalf("expected eight panes, got %d", len(panes))
	}
	if manager.PageCount() != 1 {
		t.Fatalf("expected one page for eight panes, got %d", manager.PageCount())
	}
}

func TestPaneManagerPageNavigationWorks(t *testing.T) {
	manager := NewManager()
	manager.Resize(160, 40)
	manager.ApplyState(groupedState(5))

	if manager.PageCount() != 2 {
		t.Fatalf("expected two pages, got %d", manager.PageCount())
	}
	manager.NextPage()
	if manager.Page() != 1 {
		t.Fatalf("expected page 1, got %d", manager.Page())
	}
	manager.PreviousPage()
	if manager.Page() != 0 {
		t.Fatalf("expected page 0, got %d", manager.Page())
	}
}

func TestPaneManagerAppliesPersistedLastPage(t *testing.T) {
	manager := NewManager()
	manager.ApplyPreferences(nil, nil, nil, nil, 1)
	// Bubble Tea normally reports terminal geometry before daemon state arrives.
	manager.Resize(120, 23)
	manager.ApplyState(groupedState(5))

	if manager.Page() != 1 {
		t.Fatalf("expected persisted page 1, got %d", manager.Page())
	}
}

func TestPaneManagerSelectionMovementWorks(t *testing.T) {
	manager := NewManager()
	manager.Resize(100, 24)
	manager.ApplyState(groupedState(2))

	first := manager.SelectedPaneID()
	manager.MoveSelection(1, 0)
	right := manager.SelectedPaneID()
	if right == first {
		t.Fatal("expected selection to move right")
	}
	manager.MoveSelection(0, 1)
	down := manager.SelectedPaneID()
	if down == right {
		t.Fatal("expected selection to move down")
	}
}

func TestPaneManagerArrowMovementAcrossOnePane(t *testing.T) {
	manager := NewManager()
	manager.Resize(120, 30)
	manager.ApplyState(componentState("notes", "notes", "frontend", "running"))
	expected := manager.SelectedPaneID()

	for _, move := range []struct {
		name string
		dx   int
		dy   int
	}{
		{name: "left", dx: -1},
		{name: "right", dx: 1},
		{name: "up", dy: -1},
		{name: "down", dy: 1},
	} {
		t.Run(move.name, func(t *testing.T) {
			manager.MoveSelection(move.dx, move.dy)
			if selected := manager.SelectedPaneID(); selected != expected {
				t.Fatalf("expected one-pane selection to stay on %s, got %s", expected, selected)
			}
		})
	}
}

func TestPaneManagerArrowMovementAcrossTwoPanes(t *testing.T) {
	manager := NewManager()
	manager.Resize(120, 30)
	manager.ApplyState(groupedState(1))

	assertSelectedPaneID(t, manager, "app-1:app-1-web:frontend:frontend")
	manager.MoveSelection(1, 0)
	assertSelectedPaneID(t, manager, "app-1:app-1-api:backend:backend")
	manager.MoveSelection(0, 1)
	assertSelectedPaneID(t, manager, "app-1:app-1-api:backend:backend")
	manager.MoveSelection(-1, 0)
	assertSelectedPaneID(t, manager, "app-1:app-1-web:frontend:frontend")
}

func TestPaneManagerArrowMovementAcrossFourPanes(t *testing.T) {
	manager := NewManager()
	manager.Resize(120, 30)
	manager.ApplyState(groupedState(2))

	assertSelectedPaneID(t, manager, "app-1:app-1-web:frontend:frontend")
	manager.MoveSelection(1, 0)
	assertSelectedPaneID(t, manager, "app-1:app-1-api:backend:backend")
	manager.MoveSelection(0, 1)
	assertSelectedPaneID(t, manager, "app-2:app-2-api:backend:backend")
	manager.MoveSelection(-1, 0)
	assertSelectedPaneID(t, manager, "app-2:app-2-web:frontend:frontend")
	manager.MoveSelection(0, -1)
	assertSelectedPaneID(t, manager, "app-1:app-1-web:frontend:frontend")
}

func TestPaneManagerArrowMovementAcrossEightPanes(t *testing.T) {
	manager := NewManager()
	manager.Resize(160, 40)
	manager.ApplyState(groupedState(4))

	assertSelectedPaneID(t, manager, "app-1:app-1-web:frontend:frontend")
	manager.MoveSelection(1, 0)
	assertSelectedPaneID(t, manager, "app-1:app-1-api:backend:backend")
	manager.MoveSelection(1, 0)
	assertSelectedPaneID(t, manager, "app-2:app-2-web:frontend:frontend")
	manager.MoveSelection(1, 0)
	assertSelectedPaneID(t, manager, "app-2:app-2-api:backend:backend")
	manager.MoveSelection(0, 1)
	assertSelectedPaneID(t, manager, "app-4:app-4-api:backend:backend")
}

func TestPaneManagerNinePlusPanesUseMultiplePages(t *testing.T) {
	manager := NewManager()
	manager.Resize(160, 40)
	manager.ApplyState(groupedState(5))

	if manager.PageCount() != 2 {
		t.Fatalf("expected two pages for ten panes, got %d", manager.PageCount())
	}
	if count := len(manager.CurrentPagePanes()); count != MaxPanesPerPage {
		t.Fatalf("expected eight panes on first page, got %d", count)
	}
	manager.NextPage()
	if manager.Page() != 1 {
		t.Fatalf("expected page 1, got %d", manager.Page())
	}
	if count := len(manager.CurrentPagePanes()); count != 2 {
		t.Fatalf("expected two panes on second page, got %d", count)
	}
	assertSelectedPaneID(t, manager, "app-5:app-5-web:frontend:frontend")
	manager.PreviousPage()
	assertSelectedPaneID(t, manager, "app-1:app-1-web:frontend:frontend")
}

func TestPaneManagerSixteenPanesUseTwoFullPages(t *testing.T) {
	manager := NewManager()
	manager.Resize(180, 48)
	manager.ApplyState(groupedState(8))

	if manager.PageCount() != 2 {
		t.Fatalf("expected two pages for sixteen panes, got %d", manager.PageCount())
	}
	if count := len(manager.CurrentPagePanes()); count != MaxPanesPerPage {
		t.Fatalf("expected first page to show %d panes, got %d", MaxPanesPerPage, count)
	}
	manager.NextPage()
	if count := len(manager.CurrentPagePanes()); count != MaxPanesPerPage {
		t.Fatalf("expected second page to show %d panes, got %d", MaxPanesPerPage, count)
	}
	assertSelectedPaneID(t, manager, "app-5:app-5-web:frontend:frontend")
}

func TestPaneManagerSelectionPersistsAfterPageRefresh(t *testing.T) {
	manager := NewManager()
	manager.Resize(160, 40)
	manager.ApplyState(groupedState(5))
	if !manager.SelectPane("app-5:app-5-api:backend:backend") {
		t.Fatal("expected page-two pane to be selectable")
	}

	manager.ApplyState(groupedState(5))

	if manager.Page() != 1 {
		t.Fatalf("expected selection to keep page 1 after refresh, got %d", manager.Page())
	}
	assertSelectedPaneID(t, manager, "app-5:app-5-api:backend:backend")
}

func TestPaneManagerFailedStoppedAndHiddenPanesHaveExpectedVisibility(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(&relaybaseclient.RelaybaseState{
		Components: []relaybaseclient.AppComponent{
			{AppID: "running-web", GroupID: "suite", Role: "frontend", PaneLabel: "frontend", DisplayName: "Suite", Status: "running"},
			{AppID: "failed-api", GroupID: "suite", Role: "backend", PaneLabel: "backend", DisplayName: "Suite", Status: "failed", LastError: "health check failed"},
			{AppID: "stopped-worker", GroupID: "suite", Role: "worker", PaneLabel: "worker", DisplayName: "Suite", Status: "stopped"},
		},
	})

	panes := manager.VisiblePanes()
	if len(panes) != 2 {
		t.Fatalf("expected running and failed panes visible while stopped pane stays hidden, got %#v", panes)
	}
	ids := []string{panes[0].ID, panes[1].ID}
	if !containsString(ids, "suite:running-web:frontend:frontend") ||
		!containsString(ids, "suite:failed-api:backend:backend") {
		t.Fatalf("expected running and failed panes, got %#v", panes)
	}

	if !manager.SelectPane("suite:failed-api:backend:backend") {
		t.Fatal("expected failed pane to remain selectable")
	}
	manager.CloseSelected()
	if containsString(snapshotIDs(manager.VisiblePanes()), "suite:failed-api:backend:backend") {
		t.Fatalf("expected user-hidden failed pane to stay hidden after close, got %#v", manager.VisiblePanes())
	}
}

func TestPaneManagerNarrowTerminalUsesOneUsablePanePerPage(t *testing.T) {
	manager := NewManager()
	manager.Resize(50, 20)
	manager.ApplyState(groupedState(4))

	layout := manager.Layout()
	if layout.Columns != 1 || layout.Rows != 1 || len(manager.CurrentPagePanes()) != 1 || manager.PageCount() != 8 {
		t.Fatalf("expected narrow layout to page one usable pane at a time, layout=%#v visible=%d pages=%d", layout, len(manager.CurrentPagePanes()), manager.PageCount())
	}
}

func TestPaneManagerCapacityPreservesScrollableFullMetadataGeometry(t *testing.T) {
	tests := []struct {
		name       string
		width      int
		height     int
		capacity   int
		pageCount  int
		secondPage int
	}{
		{name: "narrow", width: 70, height: 13, capacity: 1, pageCount: 8, secondPage: 1},
		{name: "medium_80", width: 80, height: 13, capacity: 2, pageCount: 4, secondPage: 2},
		{name: "medium_100", width: 100, height: 18, capacity: 6, pageCount: 2, secondPage: 2},
		{name: "medium_110", width: 110, height: 19, capacity: 6, pageCount: 2, secondPage: 2},
		{name: "wide_120", width: 120, height: 23, capacity: 8, pageCount: 1, secondPage: 0},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manager := NewManager()
			manager.Resize(test.width, test.height)
			manager.ApplyState(fullMetadataState(8))

			if got := CalculatePageCapacity(test.width, test.height); got != test.capacity {
				t.Fatalf("capacity=%d, want %d", got, test.capacity)
			}
			if got := len(manager.CurrentPagePanes()); got != test.capacity {
				t.Fatalf("visible panes=%d, want %d", got, test.capacity)
			}
			if got := manager.PageCount(); got != test.pageCount {
				t.Fatalf("page count=%d, want %d", got, test.pageCount)
			}
			if manager.Layout().PaneHeight < 9 {
				t.Fatalf("pane height=%d cannot hold full metadata plus a log row", manager.Layout().PaneHeight)
			}
			if test.secondPage > 0 {
				manager.NextPage()
				if got := len(manager.CurrentPagePanes()); got != test.secondPage {
					t.Fatalf("second page panes=%d, want %d", got, test.secondPage)
				}
			}
		})
	}
}

func TestPaneManagerResizeKeepsSelectedPaneAcrossCapacityChanges(t *testing.T) {
	manager := NewManager()
	manager.Resize(120, 23)
	manager.ApplyState(fullMetadataState(8))
	want := manager.VisiblePanes()[7].ID
	if !manager.SelectPane(want) {
		t.Fatalf("could not select %q", want)
	}

	manager.Resize(70, 13)
	if got := manager.SelectedPaneID(); got != want {
		t.Fatalf("resize changed selected pane to %q, want %q", got, want)
	}
	if manager.Page() != 7 || len(manager.CurrentPagePanes()) != 1 {
		t.Fatalf("narrow resize did not move selection to its single-pane page: page=%d panes=%d", manager.Page(), len(manager.CurrentPagePanes()))
	}
}

func TestPaneManagerCloseAndUnpinReflowCurrentPage(t *testing.T) {
	manager := NewManager()
	manager.Resize(100, 18)
	manager.ApplyState(groupedState(2))
	if manager.Layout().Rows != 2 {
		t.Fatalf("four-pane fixture rows=%d, want 2", manager.Layout().Rows)
	}
	manager.CloseSelected()
	manager.CloseSelected()
	if len(manager.CurrentPagePanes()) != 2 || manager.Layout().Rows != 1 || manager.Layout().PaneHeight != 18 {
		t.Fatalf("closing panes did not reflow the page: panes=%d layout=%#v", len(manager.CurrentPagePanes()), manager.Layout())
	}

	stopped := NewManager()
	stopped.Resize(80, 14)
	stopped.ApplyState(componentState("notes", "notes", "frontend", "running"))
	stopped.TogglePinSelected()
	state := componentState("notes", "notes", "frontend", "stopped")
	stopped.ApplyState(state)
	stopped.TogglePinSelected()
	if len(stopped.CurrentPagePanes()) != 0 {
		t.Fatalf("unpinning a stopped pane left it visible: %#v", stopped.CurrentPagePanes())
	}
}

func TestPaneManagerFocusAndEscapeFlow(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(groupedState(1))
	manager.FocusSelected()
	if !manager.Focused() {
		t.Fatal("expected focused pane")
	}
	manager.BlurFocus()
	if manager.Focused() {
		t.Fatal("expected dashboard mode after blur")
	}
}

func TestPaneManagerAutoOpenBehavior(t *testing.T) {
	manager := NewManager()
	state := componentState("notes", "notes", "frontend", "stopped")
	manager.ApplyState(state)
	if len(manager.VisiblePanes()) != 0 {
		t.Fatalf("expected stopped pane to be hidden")
	}

	state.Components[0].Status = "starting"
	manager.ApplyState(state)
	if len(manager.VisiblePanes()) != 1 {
		t.Fatalf("expected starting pane to auto-open")
	}
}

func TestPaneManagerAutoCloseBehavior(t *testing.T) {
	manager := NewManager()
	state := componentState("notes", "notes", "frontend", "running")
	manager.ApplyState(state)
	if len(manager.VisiblePanes()) != 1 {
		t.Fatalf("expected running pane")
	}

	state.Components[0].Status = "stopped"
	manager.ApplyState(state)
	if len(manager.VisiblePanes()) != 0 {
		t.Fatalf("expected stopped pane to auto-close")
	}
}

func TestPaneManagerPinPreventsAutoClose(t *testing.T) {
	manager := NewManager()
	state := componentState("notes", "notes", "frontend", "running")
	manager.ApplyState(state)
	manager.TogglePinSelected()

	state.Components[0].Status = "stopped"
	manager.ApplyState(state)
	panes := manager.VisiblePanes()
	if len(panes) != 1 || !panes[0].Pinned {
		t.Fatalf("expected pinned stopped pane to remain visible: %#v", panes)
	}
}

func TestPaneManagerAppliesPersistedOrderAndColor(t *testing.T) {
	manager := NewManager()
	state := groupedState(2)
	firstPreferredID := "app-2:app-2-api:backend:backend"
	manager.ApplyPreferences(nil, nil, []string{firstPreferredID}, map[string]string{firstPreferredID: "#123456"}, 0)
	manager.ApplyState(state)

	panes := manager.VisiblePanes()
	if len(panes) != 4 {
		t.Fatalf("expected four panes, got %#v", panes)
	}
	if panes[0].ID != firstPreferredID {
		t.Fatalf("expected preferred pane first, got %s", panes[0].ID)
	}
	if panes[0].Color != "#123456" {
		t.Fatalf("expected pane color to apply, got %#v", panes[0])
	}
}

func TestPaneManagerAppliesPersistedHiddenPane(t *testing.T) {
	manager := NewManager()
	state := componentState("notes", "notes", "frontend", "running")
	hiddenID := "notes:notes:frontend:frontend"
	manager.ApplyPreferences(nil, []string{hiddenID}, nil, nil, 0)
	manager.ApplyState(state)

	if len(manager.VisiblePanes()) != 0 {
		t.Fatalf("expected hidden pane to stay hidden, got %#v", manager.VisiblePanes())
	}
}

func TestPaneManagerFollowModeAppendsAndScrolls(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(componentState("notes", "notes", "frontend", "running"))
	manager.AppendLog(relaybaseclient.LogEvent{Sequence: 1, AppID: "notes", GroupID: "notes", ComponentRole: "frontend", Stream: "stdout", Message: "ready"})

	pane := manager.VisiblePanes()[0]
	if pane.ScrollOffset != 0 {
		t.Fatalf("expected follow mode at bottom, got offset %d", pane.ScrollOffset)
	}
	if pane.LogLines[len(pane.LogLines)-1] != "[stdout] ready" {
		t.Fatalf("unexpected log lines: %#v", pane.LogLines)
	}
}

func TestPaneManagerNonFollowModePreservesScrollPosition(t *testing.T) {
	manager := NewManager()
	manager.Resize(80, 12)
	manager.ApplyState(componentState("notes", "notes", "frontend", "running"))
	for sequence := 1; sequence <= 10; sequence++ {
		manager.AppendLog(relaybaseclient.LogEvent{Sequence: int64(sequence), AppID: "notes", GroupID: "notes", ComponentRole: "frontend", Stream: "stdout", Message: fmt.Sprintf("line %d", sequence)})
	}
	manager.ToggleFollowSelected()
	manager.AppendLog(relaybaseclient.LogEvent{Sequence: 11, AppID: "notes", GroupID: "notes", ComponentRole: "frontend", Stream: "stdout", Message: "eleven"})

	pane := manager.VisiblePanes()[0]
	if pane.ScrollOffset != 1 {
		t.Fatalf("expected scroll offset to preserve viewport, got %d", pane.ScrollOffset)
	}
}

func TestPaneManagerScrollingBackToBottomReenablesFollow(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(componentState("notes", "notes", "frontend", "running"))
	target := LogTarget{PaneID: manager.SelectedPaneID(), AppID: "notes"}
	manager.MergeSnapshot(target, &relaybaseclient.LogSnapshot{Events: testEvents("notes", "notes", "frontend", 20)})

	manager.ScrollSelected(5)
	pane := manager.SelectedPane()
	if pane == nil || pane.Follow || pane.ScrollOffset == 0 {
		t.Fatalf("expected scrolling up to disable follow, got %#v", pane)
	}

	manager.ScrollSelected(-100)
	pane = manager.SelectedPane()
	if pane == nil || !pane.Follow || pane.ScrollOffset != 0 {
		t.Fatalf("expected scrolling to bottom to re-enable follow, got %#v", pane)
	}
}

func TestPaneManagerMarksLogFetchFailureAndClearsOnSuccess(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(componentState("notes", "notes", "frontend", "running"))
	target := LogTarget{PaneID: manager.SelectedPaneID(), AppID: "notes"}

	manager.MarkLogFetchFailed(target, "temporary outage")
	pane := manager.SelectedPane()
	if pane == nil || pane.LogError != "temporary outage" {
		t.Fatalf("expected pane log error, got %#v", pane)
	}

	manager.MergeSnapshot(target, &relaybaseclient.LogSnapshot{
		Events: []relaybaseclient.LogEvent{{
			Sequence:      1,
			AppID:         "notes",
			GroupID:       "notes",
			ComponentRole: "frontend",
			Stream:        "stdout",
			Message:       "ready",
		}},
		Page: relaybaseclient.LogPage{NextBefore: "1", HasOlder: true},
	})
	pane = manager.SelectedPane()
	if pane == nil || pane.LogError != "" || !pane.HasMore || pane.NextBefore != "1" {
		t.Fatalf("expected successful snapshot to clear error and expose older cursor, got %#v", pane)
	}
}

func TestPaneManagerOlderLogTargetRequiresCursor(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(componentState("notes", "notes", "frontend", "running"))
	target := LogTarget{PaneID: manager.SelectedPaneID(), AppID: "notes"}
	manager.MergeSnapshot(target, &relaybaseclient.LogSnapshot{
		Page: relaybaseclient.LogPage{HasOlder: true},
	})

	pane := manager.SelectedPane()
	if pane == nil || !pane.HasMore || pane.NextBefore != "" {
		t.Fatalf("expected older logs without a usable cursor, got %#v", pane)
	}
	if older := manager.OlderLogTarget(); older != nil {
		t.Fatalf("expected no older-log target without cursor, got %#v", older)
	}
}

func TestPaneManagerHighVolumeLogsStayBounded(t *testing.T) {
	manager := NewManager()
	manager.ApplyState(componentState("notes", "notes", "frontend", "running"))
	target := LogTarget{PaneID: manager.SelectedPaneID(), AppID: "notes"}
	events := make([]relaybaseclient.LogEvent, 0, DefaultMaxScrollback+100)
	for index := 1; index <= DefaultMaxScrollback+100; index++ {
		events = append(events, relaybaseclient.LogEvent{
			Sequence:      int64(index),
			AppID:         "notes",
			GroupID:       "notes",
			ComponentRole: "frontend",
			Stream:        "stdout",
			Message:       fmt.Sprintf("line %03d", index),
		})
	}

	manager.MergeSnapshot(target, &relaybaseclient.LogSnapshot{Events: events})

	pane := manager.panes[target.PaneID]
	if pane == nil {
		t.Fatal("expected pane")
	}
	if len(pane.Logs) != DefaultMaxScrollback {
		t.Fatalf("expected bounded scrollback of %d, got %d", DefaultMaxScrollback, len(pane.Logs))
	}
	if pane.Logs[0].Sequence != 101 {
		t.Fatalf("expected oldest retained sequence 101, got %d", pane.Logs[0].Sequence)
	}
}

func TestPaneManagerResizeLayout(t *testing.T) {
	layout := CalculateLayout(120, 30, 8)
	if layout.Columns != 4 || layout.Rows != 2 {
		t.Fatalf("expected 4x2 layout, got %dx%d", layout.Columns, layout.Rows)
	}
	narrow := CalculateLayout(50, 30, 4)
	if !narrow.Narrow || narrow.Columns != 1 {
		t.Fatalf("expected single-column narrow layout, got %#v", narrow)
	}
}

func TestPaneManagerMalformedComponentDiagnostic(t *testing.T) {
	manager := NewManager()
	diagnostics := manager.ApplyState(&relaybaseclient.RelaybaseState{
		Components: []relaybaseclient.AppComponent{{Role: "surprise", Status: "running"}},
	})
	if len(diagnostics) == 0 || diagnostics[0].Code != "component_app_id_missing" {
		t.Fatalf("expected malformed component diagnostic, got %#v", diagnostics)
	}
}

func groupedState(groupCount int) *relaybaseclient.RelaybaseState {
	state := &relaybaseclient.RelaybaseState{}
	for index := 1; index <= groupCount; index++ {
		groupID := fmt.Sprintf("app-%d", index)
		displayName := fmt.Sprintf("App %d", index)
		frontend := relaybaseclient.AppComponent{
			AppID:       groupID + "-web",
			GroupID:     groupID,
			Role:        "frontend",
			PaneLabel:   "frontend",
			PaneOrder:   10,
			DisplayName: displayName,
			Status:      "running",
			Route:       relaybaseclient.RouteInfo{HumanURL: "http://" + groupID + ".localhost:7777", Reachable: true},
		}
		backend := relaybaseclient.AppComponent{
			AppID:       groupID + "-api",
			GroupID:     groupID,
			Role:        "backend",
			PaneLabel:   "backend",
			PaneOrder:   20,
			DisplayName: displayName,
			Status:      "running",
		}
		state.Groups = append(state.Groups, relaybaseclient.AppGroup{GroupID: groupID, DisplayName: displayName})
		state.Components = append(state.Components, frontend, backend)
	}
	return state
}

func fullMetadataState(componentCount int) *relaybaseclient.RelaybaseState {
	state := &relaybaseclient.RelaybaseState{}
	for index := 1; index <= componentCount; index++ {
		appID := fmt.Sprintf("app-%d", index)
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
			DisplayName: fmt.Sprintf("App %d", index),
			Status:      "failed",
			Route:       relaybaseclient.RouteInfo{HumanURL: fmt.Sprintf("http://app-%d.localhost:7777", index), Reachable: true},
			PID:         2000 + index,
			Port:        8000 + index,
			LastError:   "health check failed",
		})
	}
	return state
}

func componentState(appID string, groupID string, role string, status string) *relaybaseclient.RelaybaseState {
	return &relaybaseclient.RelaybaseState{
		Components: []relaybaseclient.AppComponent{{
			AppID:       appID,
			GroupID:     groupID,
			Role:        role,
			PaneLabel:   role,
			DisplayName: "Notes",
			Status:      status,
		}},
	}
}

func testEvents(appID string, groupID string, role string, count int) []relaybaseclient.LogEvent {
	events := make([]relaybaseclient.LogEvent, 0, count)
	for index := 1; index <= count; index++ {
		events = append(events, relaybaseclient.LogEvent{
			Sequence:      int64(index),
			AppID:         appID,
			GroupID:       groupID,
			ComponentRole: role,
			Stream:        "stdout",
			Message:       fmt.Sprintf("line %02d", index),
		})
	}
	return events
}

func snapshotIDs(panes []PaneSnapshot) []string {
	ids := make([]string, 0, len(panes))
	for _, pane := range panes {
		ids = append(ids, pane.ID)
	}
	return ids
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func assertSelectedPaneID(t *testing.T, manager Manager, expected string) {
	t.Helper()
	if selected := manager.SelectedPaneID(); selected != expected {
		t.Fatalf("expected selected pane %s, got %s", expected, selected)
	}
}
