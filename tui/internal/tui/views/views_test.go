package views

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/contextmenu"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
	"github.com/cameloo/relaybase/tui/internal/tui/testfixtures"
)

func TestGoldenOnePane(t *testing.T) {
	assertPaneSnapshot(t, 1, "App 1: frontend")
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
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		PaneLayout:       panes.CalculateLayout(120, 14, 0),
		PageCount:        1,
	})
	snapshot := compactSnapshot(rendered)
	if !strings.Contains(snapshot, "No active panes") ||
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

func TestPaneLogRenderingStripsAnsiAndTruncatesLongLines(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            80,
		Height:           20,
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
	rendered := RenderShell(styles.New(theme), ShellData{
		Width:            120,
		Height:           30,
		ConnectionStatus: "connected",
		EventStatus:      "connected",
		KeyMap:           keymap.Default(),
		AssistantPrompt:  "> _",
		ShowHelp:         true,
		PageCount:        1,
	})
	snapshot := compactSnapshot(rendered)
	if !strings.Contains(snapshot, "Dashboard PageUp/PageDown changes pane pages.") {
		t.Fatalf("help missing dashboard paging text:\n%s", snapshot)
	}
	if !strings.Contains(snapshot, "Focused pane PageUp/PageDown scrolls logs and fetches older logs when available.") {
		t.Fatalf("help missing focused paging text:\n%s", snapshot)
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
