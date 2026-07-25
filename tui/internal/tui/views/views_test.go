package views

import (
	"fmt"
	"image/color"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/contextmenu"
	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
	"github.com/cameloo/relaybase/tui/internal/tui/testfixtures"
)

func TestGoldenOnePane(t *testing.T) {
	assertPaneSnapshot(t, 1, "App 1: frontend")
}

func TestTruncateTextRespectsTerminalDisplayWidth(t *testing.T) {
	got := truncateText("\x1b[31m界界界", 5)
	if strings.Contains(got, "\x1b") || lipgloss.Width(got) > 5 || got != "界界." {
		t.Fatalf("wide/ANSI truncation=%q width=%d", got, lipgloss.Width(got))
	}
	if got := truncateText("界", 1); got != "." {
		t.Fatalf("single-cell budget must not overflow with a wide glyph: %q", got)
	}
}

func TestGoldenTwoPanes(t *testing.T) {
	assertPaneSnapshot(t, 2, "App 1: frontend", "App 2: frontend")
}

func TestGoldenFourPanes(t *testing.T) {
	assertPaneSnapshot(t, 4, "App 1: frontend", "App 2: frontend", "App 3: frontend", "App 4: frontend")
}

func TestGoldenEightPanes(t *testing.T) {
	assertPaneSnapshot(
		t,
		8,
		"App 1: frontend",
		"App 2: frontend",
		"App 3: frontend",
		"App 4: frontend",
		"App 5: frontend",
		"App 6: frontend",
		"App 7: frontend",
		"App 8: frontend",
	)
}

func TestGoldenZeroPanesShowsNoAppsGuidance(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            120,
		Height:           24,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		StateKnown:       true,
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		PaneLayout:       panes.CalculateLayout(120, 14, 0),
		PageCount:        1,
	})
	snapshot := compactSnapshot(rendered)
	if !strings.Contains(snapshot, "No monitoring panes are open") ||
		!strings.Contains(snapshot, "/configure <path> --dry-run") ||
		!strings.Contains(snapshot, "> _") {
		t.Fatalf("zero-pane render should give setup guidance and keep assistant bar:\n%s", snapshot)
	}
}

func TestGoldenSixteenPanePageRendersEightVisiblePanes(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            180,
		Height:           48,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		AppCount:         16,
		GroupCount:       8,
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		Panes:            paneSnapshots(8),
		PaneLayout:       panes.CalculateLayout(180, 38, 8),
		Page:             1,
		PageCount:        2,
	})
	snapshot := compactSnapshot(rendered)
	if !strings.Contains(snapshot, "Page 2/2") ||
		!strings.Contains(snapshot, "App 8: frontend") ||
		strings.Contains(snapshot, "App 9: frontend") ||
		!strings.Contains(snapshot, "> _") {
		t.Fatalf("16-pane page render should show one 8-pane page and pinned assistant bar:\n%s", snapshot)
	}
}

func TestGoldenStableTerminalSizes(t *testing.T) {
	for _, size := range testfixtures.TerminalSizes() {
		t.Run(size.Name, func(t *testing.T) {
			theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
			rendered := RenderShell(styles.New(theme), ShellData{
				Width:            size.Width,
				Height:           size.Height,
				ConnectionStatus: "connected",
				EventStatus:      "connected",
				AppCount:         2,
				GroupCount:       1,
				KeyMap:           keymap.Default(),
				AssistantPrompt:  "> _",
				Panes:            paneSnapshots(2),
				PaneLayout:       panes.CalculateLayout(size.Width, maxInt(8, size.Height-10), 2),
				PageCount:        1,
			})
			snapshot := compactSnapshot(rendered)
			if !strings.Contains(snapshot, "> _") {
				t.Fatalf("snapshot missing assistant bar at %dx%d:\n%s", size.Width, size.Height, snapshot)
			}
			if !strings.Contains(snapshot, "connected") {
				t.Fatalf("snapshot missing status strip at %dx%d:\n%s", size.Width, size.Height, snapshot)
			}
		})
	}
}

func TestRenderShellFillsExactViewportInLightAndDarkThemes(t *testing.T) {
	for _, mode := range []string{"light", "dark"} {
		t.Run(mode, func(t *testing.T) {
			theme, _ := styles.ResolveTheme(mode, func(string) string { return "" })
			data := ShellData{
				Width:            96,
				Height:           18,
				ConnectionStatus: "connected",
				EventStatus:      "connected",
				KeyMap:           keymap.Default(),
				AssistantPrompt:  "> _",
				Panes:            paneSnapshots(1),
				PaneLayout:       panes.CalculateLayout(96, 8, 1),
				PageCount:        1,
			}

			rendered := RenderShell(styles.New(theme), data)
			if got := lipgloss.Height(rendered); got != data.Height {
				t.Fatalf("expected %s shell to fill exactly %d rows, got %d:\n%s", mode, data.Height, got, compactSnapshot(rendered))
			}
			if !strings.Contains(compactSnapshot(rendered), "> _") {
				t.Fatalf("expected %s shell to keep assistant bar visible:\n%s", mode, compactSnapshot(rendered))
			}
		})
	}
}

func TestRenderShellClipsScrollableBodyAndPinsAssistantBar(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	diagnostics := []DiagnosticLine{}
	for index := 1; index <= 20; index++ {
		diagnostics = append(diagnostics, DiagnosticLine{
			Code:     fmt.Sprintf("diagnostic-%02d", index),
			Severity: "warning",
			Message:  "overflow body line",
		})
	}

	data := ShellData{
		Width:            120,
		Height:           12,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> pinned",
		Diagnostics:      diagnostics,
		DiagnosticsOpen:  true,
		StateKnown:       true,
		PageCount:        1,
	}

	rendered := RenderShell(styles.New(theme), data)
	snapshot := compactSnapshot(rendered)
	if got := lipgloss.Height(rendered); got != data.Height {
		t.Fatalf("expected shell to render exactly %d rows, got %d:\n%s", data.Height, got, snapshot)
	}
	if !strings.Contains(snapshot, "> pinned") {
		t.Fatalf("assistant bar was not pinned in clipped render:\n%s", snapshot)
	}
	if strings.Contains(snapshot, "diagnostic-20") {
		t.Fatalf("unscrolled body should be clipped before late diagnostics:\n%s", snapshot)
	}

	data.BodyScrollOffset = 14
	scrolled := RenderShell(styles.New(theme), data)
	scrolledSnapshot := compactSnapshot(scrolled)
	if got := lipgloss.Height(scrolled); got != data.Height {
		t.Fatalf("expected scrolled shell to render exactly %d rows, got %d:\n%s", data.Height, got, scrolledSnapshot)
	}
	if !strings.Contains(scrolledSnapshot, "> pinned") {
		t.Fatalf("assistant bar was not pinned after body scroll:\n%s", scrolledSnapshot)
	}
	if !strings.Contains(scrolledSnapshot, "diagnostic-12") && !strings.Contains(scrolledSnapshot, "diagnostic-13") {
		t.Fatalf("expected scrolled body diagnostics while assistant stays visible:\n%s", scrolledSnapshot)
	}
}

func TestContextMenuRendersDisabledReason(t *testing.T) {
	rendered := renderContextMenu(contextmenu.Snapshot{
		Title: "Pane Menu",
		Items: []contextmenu.Item{
			{Label: "Show route", Action: contextmenu.ActionPaneCopyRoute, Enabled: false, DisabledReason: "selected pane has no route"},
		},
	})
	if !strings.Contains(rendered, "Show route (unavailable: selected pane has no route)") {
		t.Fatalf("expected disabled reason in rendered menu, got %q", rendered)
	}
}

func TestPaneStatusShowsSelectedAndFocusedIndicators(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            120,
		Height:           30,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		Panes: []panes.PaneSnapshot{{
			ID:       "pane-1",
			Title:    "App 1: frontend",
			Status:   "running",
			Follow:   true,
			Selected: true,
			LogLines: []string{"[stdout] ready"},
		}},
		PaneLayout: panes.CalculateLayout(120, 20, 1),
		PageCount:  1,
	})
	snapshot := compactSnapshot(rendered)
	if !strings.Contains(snapshot, "status running | selected | follow on") {
		t.Fatalf("selected pane marker missing:\n%s", snapshot)
	}

	focused := RenderShell(styles.New(theme), ShellData{
		Width:            120,
		Height:           30,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		FocusedPane: &panes.PaneSnapshot{
			ID:       "pane-1",
			Title:    "App 1: frontend",
			Status:   "running",
			Follow:   true,
			Focused:  true,
			Selected: true,
			LogLines: []string{"[stdout] ready"},
		},
		PaneLayout: panes.CalculateLayout(120, 20, 1),
		PageCount:  1,
	})
	focusedSnapshot := compactSnapshot(focused)
	if !strings.Contains(focusedSnapshot, "status running | focused | follow on") {
		t.Fatalf("focused pane marker missing:\n%s", focusedSnapshot)
	}
	if !strings.Contains(focusedSnapshot, "> _") {
		t.Fatalf("focused pane render lost assistant bar:\n%s", focusedSnapshot)
	}
}

func TestPaneLogIndicatorsRender(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            120,
		Height:           30,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		Panes: []panes.PaneSnapshot{{
			ID:           "pane-1",
			Title:        "App 1: frontend",
			Status:       "running",
			Follow:       false,
			Selected:     true,
			HasMore:      true,
			ScrollOffset: 7,
			LogError:     "temporary outage",
		}},
		PaneLayout: panes.CalculateLayout(120, 20, 1),
		PageCount:  1,
	})
	snapshot := compactSnapshot(rendered)
	for _, expected := range []string{
		"follow off",
		"older unavailable",
		"scroll +7",
		"logs unavailable: temporary outage",
		"No logs yet",
	} {
		if !strings.Contains(snapshot, expected) {
			t.Fatalf("expected %q in pane log indicators:\n%s", expected, snapshot)
		}
	}

	withCursor := statusLine(panes.PaneSnapshot{Status: "running", Follow: true, NextBefore: "40", HasMore: true})
	if !strings.Contains(withCursor, "older available") {
		t.Fatalf("expected older available indicator, got %q", withCursor)
	}
}

func TestPaneStatusToneIsSemanticAndTextRemainsVisible(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)

	for _, testCase := range []struct {
		status string
		color  color.Color
	}{
		{status: "running", color: theme.Success},
		{status: "starting", color: theme.Warning},
		{status: "degraded", color: theme.Warning},
		{status: "stopped", color: theme.Error},
		{status: "failed", color: theme.Error},
	} {
		rendered := renderPaneStatusLine(style, panes.PaneSnapshot{Status: testCase.status, Follow: true}, 80)
		if !strings.Contains(compactSnapshot(rendered), "status "+testCase.status) {
			t.Fatalf("status %q lost its text label: %q", testCase.status, compactSnapshot(rendered))
		}
		want := lipgloss.NewStyle().Foreground(testCase.color).Render(testCase.status)
		if !strings.Contains(rendered, want) {
			t.Fatalf("status %q did not use semantic color", testCase.status)
		}
	}
}

func TestPaneLogRenderingStripsAnsiAndTruncatesLongLines(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            80,
		Height:           30,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		Panes: []panes.PaneSnapshot{{
			ID:       "pane-1",
			Title:    "\x1b[31mApp 1: frontend\x1b[0m",
			Status:   "running",
			Follow:   true,
			Selected: true,
			LogLines: []string{
				"\x1b[32m" + strings.Repeat("ready ", 40) + "\x1b[0m",
			},
		}},
		PaneLayout: panes.CalculateLayout(80, 10, 1),
		PageCount:  1,
	})

	if strings.Contains(rendered, "\x1b[32m") || strings.Contains(rendered, "\x1b[31m") {
		t.Fatalf("pane render should not pass app log ANSI escapes through:\n%q", rendered)
	}
	snapshot := compactSnapshot(rendered)
	if !strings.Contains(snapshot, "App 1: frontend") || !strings.Contains(snapshot, "ready") {
		t.Fatalf("expected cleaned pane title and log content:\n%s", snapshot)
	}
}

func TestHelpExplainsDashboardAndFocusedPaging(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := ShellData{
		Width:            120,
		Height:           30,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		StateKnown:       true,
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		ShowHelp:         true,
		PageCount:        1,
	}
	rendered := RenderShell(style, data)
	snapshot := compactSnapshot(rendered)
	if !strings.Contains(snapshot, "Dashboard PageUp/PageDown changes pane pages.") {
		t.Fatalf("help missing dashboard paging guidance:\n%s", snapshot)
	}
	data.BodyScrollOffset = 1
	snapshot = compactSnapshot(RenderShell(style, data))
	if !strings.Contains(snapshot, "Focused pane PageUp/PageDown scrolls logs and fetches older logs when available.") {
		t.Fatalf("help missing focused-pane paging guidance after scrolling:\n%s", snapshot)
	}
	data.BodyScrollOffset = BodyScrollMax(style, data)
	snapshot = compactSnapshot(RenderShell(style, data))
	if !strings.Contains(snapshot, "/component label <app> <label>") {
		t.Fatalf("help did not reach the final command at maximum scroll:\n%s", snapshot)
	}
}

func TestRegisteredStoppedInventoryIsDiscoverableAndStartable(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            64,
		Height:           20,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		AgentStatus:      "idle",
		StateKnown:       true,
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		Inventory: []inventory.Item{
			{ID: "api", Name: "API", Directory: `C:\work\api`, Status: "running"},
			{ID: "worker", Name: "Worker", Directory: `C:\work\worker`, Status: "stopped", Readiness: "ready", LastError: "previous exit", Selected: true},
		},
		PageCount: 1,
	})
	snapshot := compactSnapshot(rendered)
	for _, expected := range []string{"Registered apps", "Name Project Status", "API C:/work/api running", "Worker C:/work/worker stopped", "Selected: Worker", "Readiness: ready", "Enter: review start", "Last error: previous exit", "> _"} {
		if !strings.Contains(snapshot, expected) {
			t.Fatalf("inventory missing %q:\n%s", expected, snapshot)
		}
	}
}

func TestNoPaneInventoryAndListModalShareRegisteredAppTableProjection(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	items := []inventory.Item{
		{ID: "service-api", Name: "Service", Directory: `C:\very\long\workspace\relaybase\examples\api`, Status: "running", Selected: true},
		{ID: "service-worker", Name: "Service", Directory: `C:\work\worker`, Status: "degraded"},
	}
	base := ShellData{
		OperatorConsole: true, Width: 100, Height: 30, ComposerRows: 1,
		ConnectionStatus: "connected", EventStatus: "connected", AgentStatus: "idle", StateKnown: true,
		KeyMap: keymap.Default(), AssistantPrompt: "> _", PageCount: 1,
	}
	noPane := base
	noPane.Inventory = items
	modal := base
	modal.AppManager = &AppManagerData{Items: items, Selected: 0, Mode: "manage", Surface: "table", ConnectionStatus: "connected", StateKnown: true}

	noPaneSnapshot := compactSnapshot(RenderShell(style, noPane))
	modalSnapshot := compactSnapshot(RenderShell(style, modal))
	for _, expected := range []string{"Name Project Status", "Service [service-api]", "Service [service-wor.]", "running", "degraded", "examples/api"} {
		if !strings.Contains(noPaneSnapshot, expected) {
			t.Fatalf("no-pane inventory missing shared table projection %q:\n%s", expected, noPaneSnapshot)
		}
		if !strings.Contains(modalSnapshot, expected) {
			t.Fatalf("/manage modal missing shared table projection %q:\n%s", expected, modalSnapshot)
		}
	}
}

func TestRegisteredAppsModalIsDedicatedAndInteractive(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := ShellData{
		OperatorConsole:  true,
		Width:            100,
		Height:           30,
		ComposerRows:     1,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		AgentStatus:      "idle",
		StateKnown:       true,
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		AppManager: &AppManagerData{
			Items: []inventory.Item{
				{ID: "api", Name: "API", Directory: `C:\work\api`, Status: "running", Route: "http://api.localhost:7777"},
				{ID: "worker", Name: "Worker", Directory: `C:\work\worker`, Status: "stopped", Readiness: "ready", LastError: "previous exit", Selected: true},
			},
			Selected:         1,
			Mode:             "manage",
			Surface:          "table",
			ConnectionStatus: "connected",
			StateKnown:       true,
		},
		PageCount: 1,
	}
	snapshot := compactSnapshot(RenderShell(style, data))
	for _, required := range []string{"Manage apps 2 registered", "Name Project Status", "API C:/work/api running", "Worker C:/work/worker stopped", "Enter opens management actions", "actions"} {
		if !strings.Contains(snapshot, required) {
			t.Fatalf("registered app modal missing %q:\n%s", required, snapshot)
		}
	}
	for _, excluded := range []string{"http://api.localhost:7777", "previous exit", "Readiness"} {
		if strings.Contains(snapshot, excluded) {
			t.Fatalf("registered app table leaked secondary detail %q:\n%s", excluded, snapshot)
		}
	}
	if strings.Contains(snapshot, "Search:") {
		t.Fatalf("registered app modal reused help content:\n%s", snapshot)
	}
	frame := BuildShell(style, data)
	rowRegions := 0
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == components.HitRegisteredAppRow {
			rowRegions++
		}
	}
	if rowRegions != 2 {
		t.Fatalf("registered app modal has %d row hit regions, want 2: %#v", rowRegions, frame.HitMap.Regions())
	}
}

func TestAppManagerActionViewIsReadableSanitizedAndTextExplicit(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := ShellData{
		OperatorConsole: true, Width: 110, Height: 32, ComposerRows: 1,
		ConnectionStatus: "connected", EventStatus: "connected", AgentStatus: "idle", StateKnown: true,
		KeyMap: keymap.Default(), AssistantPrompt: "> _", PageCount: 1,
		AppManager: &AppManagerData{
			Mode: "manage", Surface: "actions", Selected: 0, SelectedAction: 1,
			ConnectionStatus: "connected", StateKnown: true,
			Items: []inventory.Item{{
				ID: "worker", Name: "Worker\nInjected", Directory: "C:\\work\\worker\x1b[31m", Status: "stopped",
				Readiness: "ready\rspoof", Route: "http://worker.localhost:7777\nsecret",
			}},
			Actions: []AppManagerAction{
				{ID: "open", Label: "Open monitoring pane", DisabledReason: "No monitoring pane is available."},
				{ID: "start", Label: "Start app", Enabled: true},
				{ID: "unregister", Label: "Unregister app", Enabled: true},
			},
		},
	}
	snapshot := compactSnapshot(RenderShell(style, data))
	for _, required := range []string{
		"Manage Worker Injected", "Status stopped", "Project C:/work/worker", "Route http://worker.localhost:7777 secret",
		"Readiness ready spoof", "Open monitoring pane unavailable: No monitoring pane is available.", "Start app", "Unregister app", "Enter select", "back",
	} {
		if !strings.Contains(snapshot, required) {
			t.Fatalf("manager action view missing %q:\n%s", required, snapshot)
		}
	}
	if strings.Contains(snapshot, "\x1b") || strings.Contains(snapshot, "\nsecret") {
		t.Fatalf("manager action view retained unsafe control text:\n%s", snapshot)
	}
	frame := BuildShell(style, data)
	actionRegions := 0
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == components.HitAppManagerAction {
			actionRegions++
		}
	}
	if actionRegions != 3 {
		t.Fatalf("manager action view has %d action hit regions, want 3: %#v", actionRegions, frame.HitMap.Regions())
	}
}

func TestPackageTableAndEveryManagerSurfaceRenderAtNarrowHeights(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	base := ShellData{
		OperatorConsole: true, Width: 88, Height: 18, ComposerRows: 1,
		ConnectionStatus: "connected", EventStatus: "connected", AgentStatus: "idle", StateKnown: true,
		KeyMap: keymap.Default(), AssistantPrompt: "> _", PageCount: 1,
	}
	rows := []PackageTableRow{
		{ID: "pkg_web", Name: "Web\nstack", MemberCount: 3, Revision: 2, LastRun: "succeeded", Enabled: true},
		{ID: "pkg_api", Name: "API services\x1b[31m", MemberCount: 4, Revision: 5, LastRun: "running", Enabled: true},
	}

	t.Run("manager table", func(t *testing.T) {
		data := base
		data.PackageManager = &PackageManagerData{Surface: "table", ConnectionStatus: "connected", Table: PackageTableData{Rows: rows}}
		snapshot := compactSnapshot(RenderShell(style, data))
		for _, required := range []string{"Packages 2 saved", "Name Apps Last run", "Web stack", "succeeded", "N new"} {
			if !strings.Contains(snapshot, required) {
				t.Fatalf("package table missing %q:\n%s", required, snapshot)
			}
		}
		if strings.Contains(snapshot, "\x1b[31m") {
			t.Fatalf("package table retained daemon-provided terminal control text")
		}
	})

	t.Run("short actions", func(t *testing.T) {
		data := base
		data.PackageManager = &PackageManagerData{
			Surface: "actions", ConnectionStatus: "connected", Table: PackageTableData{Rows: rows}, SelectedPackage: &rows[0],
			Actions: []AppManagerAction{{ID: "launch", Label: "Launch package", Enabled: true}, {ID: "delete", Label: "Delete package", Enabled: true}},
		}
		snapshot := compactSnapshot(RenderShell(style, data))
		for _, required := range []string{"Manage Web stack", "Revision 2", "Actions 1", "Launch package", "more"} {
			if !strings.Contains(snapshot, required) {
				t.Fatalf("short package actions missing %q:\n%s", required, snapshot)
			}
		}
		frame := BuildShell(style, data)
		count := 0
		for _, region := range frame.HitMap.Regions() {
			if region.Kind == components.HitPackageAction {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("short package actions exposed %d hit rows, want visible slice of 1: %#v", count, frame.HitMap.Regions())
		}
	})

	t.Run("name editor", func(t *testing.T) {
		data := base
		data.PackageManager = &PackageManagerData{Surface: "name", ConnectionStatus: "connected", NameCurrent: "Web stack", NameInput: "Web workspace", Notice: "Stable id preserved."}
		snapshot := compactSnapshot(RenderShell(style, data))
		for _, required := range []string{"Rename package", "Current name Web stack", "New name Web workspace", "Enter preview"} {
			if !strings.Contains(snapshot, required) {
				t.Fatalf("package name editor missing %q:\n%s", required, snapshot)
			}
		}
	})

	t.Run("membership editor", func(t *testing.T) {
		data := base
		data.PackageManager = &PackageManagerData{
			Surface: "members", ConnectionStatus: "connected", SelectedMember: 1,
			Members: []PackageMemberRow{{AppID: "notes", Name: "Notes", Included: true, Ordinal: 1}, {AppID: "missing", Name: "missing", Included: true, Ordinal: 2, Missing: true}, {AppID: "worker", Name: "Worker"}},
		}
		snapshot := compactSnapshot(RenderShell(style, data))
		for _, required := range []string{"Edit package apps and launch order", "Notes [notes]", "more", "Space add/remove"} {
			if !strings.Contains(snapshot, required) {
				t.Fatalf("package membership editor missing %q:\n%s", required, snapshot)
			}
		}
		data.PackageManager.MemberOffset = 1
		scrolled := compactSnapshot(RenderShell(style, data))
		if !strings.Contains(scrolled, "missing registration") || !strings.Contains(scrolled, "above") {
			t.Fatalf("scrolled membership editor lost missing stored member or range state:\n%s", scrolled)
		}
	})

	t.Run("scrollable run", func(t *testing.T) {
		data := base
		members := make([]PackageRunMemberData, 0, 8)
		for index := 0; index < 8; index++ {
			members = append(members, PackageRunMemberData{AppID: fmt.Sprintf("app-%d", index+1), State: "started"})
		}
		data.PackageManager = &PackageManagerData{Surface: "run", ConnectionStatus: "connected", Run: &PackageRunData{ID: "run-1", Status: "partial", Members: members}}
		snapshot := compactSnapshot(RenderShell(style, data))
		for _, required := range []string{"Latest package run", "Run ID run-1", "Members 1", "more", "wheel scroll"} {
			if !strings.Contains(snapshot, required) {
				t.Fatalf("package run surface missing %q:\n%s", required, snapshot)
			}
		}
	})

	t.Run("app add picker", func(t *testing.T) {
		data := base
		pickerRows := append([]PackageTableRow(nil), rows...)
		pickerRows[0].Enabled = false
		pickerRows[0].DisabledReason = "already included"
		data.AppManager = &AppManagerData{
			Mode: "manage", Surface: "package-picker", Selected: 0, Items: []inventory.Item{{ID: "notes", Name: "Notes"}},
			PackagePicker: &PackageTableData{Rows: pickerRows, PickerMode: true}, ConnectionStatus: "connected", StateKnown: true,
		}
		snapshot := compactSnapshot(RenderShell(style, data))
		for _, required := range []string{"Add Notes to a package", "Membership", "already included", "N new package"} {
			if !strings.Contains(snapshot, required) {
				t.Fatalf("app package picker missing %q:\n%s", required, snapshot)
			}
		}
	})
}

func TestRegistrationRepairModalShowsReadableOrderedChoices(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := ShellData{
		OperatorConsole: true, Width: 100, Height: 30, ComposerRows: 1,
		ConnectionStatus: "connected", EventStatus: "connected", AgentStatus: "idle", StateKnown: true,
		KeyMap: keymap.Default(), AssistantPrompt: "> _", PageCount: 1,
		RegistrationRepairs: &RegistrationRepairData{
			AppID: "static-repair", Selected: 1,
			Choices: []RegistrationRepairChoice{
				{ID: "setup", Label: "Use Static build preview", Reason: "Serve the detected static assets.", Recommended: true},
				{ID: "pinned", Label: "Use pinned upstream port", Reason: "Keep the explicitly configured port."},
			},
		},
	}
	snapshot := compactSnapshot(RenderShell(style, data))
	for _, required := range []string{
		"Registration repairs static-repair",
		"Use Static build preview [recommended]",
		"Use pinned upstream port",
		"Enter preview",
	} {
		if !strings.Contains(snapshot, required) {
			t.Fatalf("registration repair modal missing %q:\n%s", required, snapshot)
		}
	}
}

func TestPaneReopenModalUsesDedicatedReadableTable(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := ShellData{
		OperatorConsole:  true,
		Width:            100,
		Height:           30,
		ComposerRows:     1,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		AgentStatus:      "idle",
		StateKnown:       true,
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		PaneReopen: &PaneReopenData{Items: []PaneReopenItem{
			{PaneID: "api:web", Name: "API / web", Project: `C:\workspace\api`, Status: "running", UserClosed: true},
			{PaneID: "worker:job", Name: "Worker / job", Project: `C:\workspace\worker`, Status: "stopped"},
		}, Selected: 1},
		PageCount: 1,
	}
	snapshot := compactSnapshot(RenderShell(style, data))
	for _, required := range []string{"Reopen pane 2 available", "Recently closed panes are listed first", "Name Project Status", "API / web C:/workspace/api running", "Worker / job C:/workspace/worker stopped", "open pane"} {
		if !strings.Contains(snapshot, required) {
			t.Fatalf("pane reopen modal missing %q:\n%s", required, snapshot)
		}
	}
	frame := BuildShell(style, data)
	rows := 0
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == components.HitPaneReopenRow {
			rows++
		}
	}
	if rows != 2 {
		t.Fatalf("pane reopen modal has %d row hit regions, want 2: %#v", rows, frame.HitMap.Regions())
	}
}

func TestAppTableStatusToneAndProjectPathStaySemanticAndBounded(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	tests := []struct {
		status string
		want   any
	}{
		{status: "running", want: theme.Success},
		{status: "stopped", want: theme.Warning},
		{status: "degraded", want: theme.Warning},
		{status: "failed", want: theme.Error},
		{status: "unknown", want: theme.Muted},
	}
	for _, test := range tests {
		if got := appStatusTone(style, test.status).GetForeground(); fmt.Sprint(got) != fmt.Sprint(test.want) {
			t.Fatalf("status %q color=%v, want %v", test.status, got, test.want)
		}
	}
	windowsProject := shortProjectPath(`C:\very\long\workspace\relaybase\examples\dashboard`, 24)
	unixProject := shortProjectPath(`/very/long/workspace/relaybase/examples/dashboard`, 24)
	for _, project := range []string{windowsProject, unixProject} {
		if lipgloss.Width(project) > 24 || !strings.Contains(project, "dashboard") {
			t.Fatalf("short project path=%q width=%d", project, lipgloss.Width(project))
		}
	}
	if strings.Contains(windowsProject, `\`) {
		t.Fatalf("Windows project path was not normalized for display: %q", windowsProject)
	}
}

func TestShortProjectPathNormalizesForeignSeparatorsDeterministically(t *testing.T) {
	windowsPath := shortProjectPath(`C:\work\relaybase\examples\api`, 80)
	forwardSlashPath := shortProjectPath(`C:/work/relaybase/examples/api`, 80)
	if windowsPath != forwardSlashPath || windowsPath != "C:/work/relaybase/examples/api" {
		t.Fatalf("foreign path projections differ: windows=%q forward=%q", windowsPath, forwardSlashPath)
	}
}

func TestRegisteredAppTableDisambiguatesDuplicateNames(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	data := ShellData{
		OperatorConsole: true, Width: 100, Height: 30, ComposerRows: 1,
		ConnectionStatus: "connected", EventStatus: "connected", AgentStatus: "idle", StateKnown: true,
		KeyMap: keymap.Default(), AssistantPrompt: "> _", PageCount: 1,
		AppManager: &AppManagerData{Mode: "manage", Surface: "table", ConnectionStatus: "connected", StateKnown: true, Items: []inventory.Item{
			{ID: "service-api", Name: "Service", Status: "running"},
			{ID: "service-worker", Name: "Service", Status: "stopped"},
		}},
	}
	snapshot := compactSnapshot(RenderShell(styles.New(theme), data))
	for _, expected := range []string{"Service [service-api]", "Service [service-wor.]"} {
		if !strings.Contains(snapshot, expected) {
			t.Fatalf("duplicate app names were not disambiguated with stable ids; missing %q:\n%s", expected, snapshot)
		}
	}
}

func TestRegisteredAppsModalHasExplicitEmptyAndOfflineState(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	data := ShellData{
		OperatorConsole:  true,
		Width:            80,
		Height:           24,
		ComposerRows:     1,
		ConnectionStatus: "offline",
		EventStatus:      "waiting",
		AgentStatus:      "waiting",
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		AppManager: &AppManagerData{
			Mode:             "manage",
			Surface:          "table",
			ConnectionStatus: "offline",
		},
		PageCount: 1,
	}
	snapshot := compactSnapshot(RenderShell(styles.New(theme), data))
	for _, required := range []string{"Manage apps 0 registered", "Daemon offline", "/daemon repair", "cannot be loaded"} {
		if !strings.Contains(snapshot, required) {
			t.Fatalf("offline empty registered-app modal missing %q:\n%s", required, snapshot)
		}
	}
}

func TestConnectionAndDiagnosticStatesAreDistinct(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	base := ShellData{OperatorConsole: true, Width: 80, Height: 24, EventStatus: "connecting", AgentStatus: "checking", KeyMap: keymap.Default(), AssistantPrompt: "> _"}

	base.ConnectionStatus = "connecting"
	if rendered := compactSnapshot(RenderShell(style, base)); !strings.Contains(rendered, "Connecting to Relaybase daemon") {
		t.Fatalf("missing connecting state:\n%s", rendered)
	}
	base.ConnectionStatus = "connected"
	if rendered := compactSnapshot(RenderShell(style, base)); !strings.Contains(rendered, "Loading Relaybase daemon state") {
		t.Fatalf("missing loading state:\n%s", rendered)
	}
	base.ConnectionStatus = "auth_needed"
	base.EventStatus = "auth_needed"
	base.StateKnown = true
	base.Panes = paneSnapshots(1)
	base.PaneLayout = panes.CalculateLayout(base.Width, 6, 1)
	if rendered := compactSnapshot(RenderShell(style, base)); !strings.Contains(rendered, "Relaybase auth") || !strings.Contains(rendered, "Events auth") || strings.Contains(rendered, "auth_n.") || !strings.Contains(rendered, "App 1: frontend") || strings.Contains(rendered, "daemon is offline") {
		t.Fatalf("auth-needed state should remain yellow/degraded and preserve last-known panes:\n%s", rendered)
	}
	base.Panes = nil
	base.StateKnown = false
	base.ConnectionStatus = "offline"
	base.Diagnostics = []DiagnosticLine{{Code: "daemon", Severity: "error", Message: "unreachable"}}
	if rendered := compactSnapshot(RenderShell(style, base)); !strings.Contains(rendered, "daemon is offline") || strings.Contains(rendered, "unreachable") {
		t.Fatalf("offline state should show compact diagnostics only:\n%s", rendered)
	}
	base.DiagnosticsOpen = true
	if rendered := compactSnapshot(RenderShell(style, base)); !strings.Contains(rendered, "unreachable") || !strings.Contains(rendered, "Esc to return") {
		t.Fatalf("diagnostics drawer missing detail and exit hint:\n%s", rendered)
	}
}

func TestConnectionLabelsAndColorsShareOneProjection(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	tests := []struct {
		state      string
		label      string
		compact    string
		foreground any
	}{
		{state: "connected", label: "online", compact: "online", foreground: theme.Success},
		{state: "auth_needed", label: "auth needed", compact: "auth", foreground: theme.Warning},
		{state: "connecting", label: "connecting", compact: "wait", foreground: theme.Warning},
		{state: "offline", label: "offline", compact: "offline", foreground: theme.Error},
	}
	for _, test := range tests {
		t.Run(test.state, func(t *testing.T) {
			if got := displayConnectionStatus(test.state); got != test.label {
				t.Fatalf("display label=%q want=%q", got, test.label)
			}
			if got := compactConnectionStatus(test.state); got != test.compact {
				t.Fatalf("compact label=%q want=%q", got, test.compact)
			}
			if got := operatorRailTone(style, test.state).GetForeground(); !reflect.DeepEqual(got, test.foreground) {
				t.Fatalf("foreground=%v want=%v", got, test.foreground)
			}
		})
	}
}

func TestConnectedHeaderNeverFallsBackToAnOfflineLabelAtNarrowWidths(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	for _, width := range []int{40, 52, 64, 80, 120} {
		t.Run(fmt.Sprintf("width-%d", width), func(t *testing.T) {
			rendered := compactSnapshot(RenderShell(style, ShellData{
				OperatorConsole:  true,
				Width:            width,
				Height:           24,
				ConnectionStatus: "connected",
				EventStatus:      "connected",
				AgentStatus:      "waiting",
				StateKnown:       true,
				KeyMap:           keymap.Default(),
				AssistantPrompt:  "> _",
				PageCount:        1,
			}))
			if !strings.Contains(rendered, "Relaybase online") || strings.Contains(rendered, "Relaybase offline") {
				t.Fatalf("connected header changed semantic label at width %d:\n%s", width, rendered)
			}
		})
	}
}

func TestRequiredTerminalSizesStayWithinViewport(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	for _, size := range []struct{ width, height int }{{40, 12}, {52, 24}, {64, 20}, {80, 24}, {120, 40}} {
		t.Run(fmt.Sprintf("%dx%d", size.width, size.height), func(t *testing.T) {
			rendered := RenderShell(style, ShellData{
				Width: size.width, Height: size.height, ConnectionStatus: "connected", EventStatus: "connected", AgentStatus: "running", StateKnown: true,
				KeyMap: keymap.Default(), AssistantPrompt: "> _", Panes: paneSnapshots(4), PaneLayout: panes.CalculateLayout(size.width, maxInt(6, size.height-10), 4), PageCount: 1,
			})
			if got := lipgloss.Height(rendered); got != size.height {
				t.Fatalf("height %d, want %d", got, size.height)
			}
			for index, line := range strings.Split(rendered, "\n") {
				if got := lipgloss.Width(line); got > size.width {
					t.Fatalf("line %d width %d exceeds %d:\n%s", index, got, size.width, compactSnapshot(rendered))
				}
			}
			if snapshot := compactSnapshot(rendered); !strings.Contains(snapshot, "a:running") && !strings.Contains(snapshot, "agent: running") {
				t.Fatalf("agent status not visible at %dx%d:\n%s", size.width, size.height, snapshot)
			}
		})
	}
}

func assertPaneSnapshot(t *testing.T, count int, expectedTitles ...string) {
	t.Helper()
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            120,
		Height:           40,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		AppCount:         count,
		GroupCount:       count,
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		Panes:            paneSnapshots(count),
		PaneLayout:       panes.CalculateLayout(120, 30, count),
		PageCount:        1,
	})
	snapshot := compactSnapshot(rendered)
	for _, title := range expectedTitles {
		if !strings.Contains(snapshot, title) {
			t.Fatalf("snapshot missing %q:\n%s", title, snapshot)
		}
	}
	if !strings.Contains(snapshot, "> _") {
		t.Fatalf("snapshot missing assistant bar:\n%s", snapshot)
	}
}

func paneSnapshots(count int) []panes.PaneSnapshot {
	result := make([]panes.PaneSnapshot, 0, count)
	for index := 1; index <= count; index++ {
		result = append(result, panes.PaneSnapshot{
			ID:       fmt.Sprintf("pane-%d", index),
			AppID:    fmt.Sprintf("app-%d", index),
			GroupID:  fmt.Sprintf("group-%d", index),
			Role:     "frontend",
			Title:    fmt.Sprintf("App %d: frontend", index),
			Status:   "running",
			Follow:   true,
			Selected: index == 1,
			LogLines: []string{"[stdout] ready"},
		})
	}
	return result
}

func compactSnapshot(value string) string {
	ansi := regexp.MustCompile(`\x1b\[[0-9;]*m`)
	value = ansi.ReplaceAllString(value, "")
	lines := []string{}
	for _, line := range strings.Split(value, "\n") {
		ascii := make([]rune, 0, len(line))
		for _, char := range line {
			if char >= 32 && char < 127 {
				ascii = append(ascii, char)
			} else {
				ascii = append(ascii, ' ')
			}
		}
		normalized := strings.Join(strings.Fields(string(ascii)), " ")
		if normalized != "" {
			lines = append(lines, normalized)
		}
	}
	return strings.Join(lines, "\n")
}
