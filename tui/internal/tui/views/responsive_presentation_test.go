package views

import (
	"fmt"
	"strings"
	"testing"

	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/layout"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
)

func TestNarrowOperatorRailKeepsMandatoryFieldsBeforeOptionalStatus(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	for _, width := range []int{40, 60} {
		t.Run(fmt.Sprintf("width-%d", width), func(t *testing.T) {
			data := ShellData{
				ConnectionStatus:   "connected",
				AgentStatus:        "disabled",
				EventStatus:        "reconnecting",
				EventCount:         42,
				StateKnown:         true,
				ActiveAppCount:     8,
				RegisteredAppCount: 8,
				Page:               1,
				PageCount:          3,
				Diagnostics: []DiagnosticLine{
					{Severity: "error"},
					{Severity: "info"},
				},
			}
			rendered := fixedRegion(style.Status, renderOperatorRail(style, data, width), width, 2)
			plain := ansiEscapePattern.ReplaceAllString(rendered, "")
			if lipgloss.Width(rendered) != width || lipgloss.Height(rendered) != 2 {
				t.Fatalf("narrow rail escaped %dx2: %dx%d\n%s", width, lipgloss.Width(rendered), lipgloss.Height(rendered), plain)
			}
			for _, required := range []string{"Relaybase", "Agent", "Apps", "active", "Attention", operatorRailDivider} {
				if !strings.Contains(plain, required) {
					t.Fatalf("%d-column rail lost mandatory field %q:\n%s", width, required, plain)
				}
			}
			if width >= 60 && !strings.Contains(plain, "registered") {
				t.Fatalf("%d-column rail omitted full registered count when it fits:\n%s", width, plain)
			}
			if strings.Contains(plain, "•") {
				t.Fatalf("%d-column rail retained the dot separator:\n%s", width, plain)
			}
		})
	}
}

func TestThreadSwitcherBoundsKeepFourAndFiveSessionsPlusFooterVisible(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	tests := []struct {
		width int
		count int
	}{
		{width: 40, count: 5},
		{width: 80, count: 4},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("%d-sessions-%d-columns", test.count, test.width), func(t *testing.T) {
			entries := make([]ThreadSwitcherEntry, 0, test.count)
			for index := 0; index < test.count; index++ {
				entries = append(entries, ThreadSwitcherEntry{Index: index, Title: fmt.Sprintf("Session %d", index+1), Active: index == 0})
			}
			data := responsivePresentationShellData(test.width, 18, 1)
			data.ThreadSwitcher = &ThreadSwitcherData{Entries: entries, Selected: test.count - 1}
			frame := BuildShell(style, data)
			plain := ansiEscapePattern.ReplaceAllString(frame.Text, "")
			modal := responsivePresentationHit(frame, components.HitModal)
			content := overlayContentBounds(style.Help, modal.Rect)
			if !modal.Rect.Valid() || content.Height < test.count+2 || modal.Rect.Y+modal.Rect.Height > data.Height {
				t.Fatalf("thread switcher clipped vertical content: modal=%#v content=%#v\n%s", modal.Rect, content, plain)
			}
			for index := 1; index <= test.count; index++ {
				if !strings.Contains(plain, fmt.Sprintf("Session %d", index)) {
					t.Fatalf("thread switcher omitted session %d:\n%s", index, plain)
				}
			}
			for _, footerPart := range []string{"select", "Enter", "Esc"} {
				if !strings.Contains(plain, footerPart) {
					t.Fatalf("thread switcher footer omitted %q:\n%s", footerPart, plain)
				}
			}
			rows := 0
			for _, region := range frame.HitMap.Regions() {
				if region.Kind != components.HitThreadSwitcherRow {
					continue
				}
				rows++
				if region.Rect.Y < content.Y || region.Rect.Y+region.Rect.Height > content.Y+content.Height {
					t.Fatalf("thread row escaped visible modal content: region=%#v content=%#v", region, content)
				}
			}
			if rows != test.count {
				t.Fatalf("visible thread hit rows=%d, want %d", rows, test.count)
			}
		})
	}
}

func TestMinimumHeightThreeRowComposerKeepsPaneLogAndExactFrame(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	for _, width := range []int{40, 80} {
		t.Run(fmt.Sprintf("%dx18", width), func(t *testing.T) {
			data := responsivePresentationShellData(width, 18, 3)
			data.ComposerView = "> draft one\n  draft two\n  draft three"
			frame := BuildShell(style, data)
			plain := ansiEscapePattern.ReplaceAllString(frame.Text, "")
			if lipgloss.Width(frame.Text) != width || lipgloss.Height(frame.Text) != 18 {
				t.Fatalf("%dx18 frame escaped exact geometry: %dx%d\n%s", width, lipgloss.Width(frame.Text), lipgloss.Height(frame.Text), plain)
			}
			for _, required := range []string{"visible pane log", "draft one", "draft two", "draft three", "└", "┘"} {
				if !strings.Contains(plain, required) {
					t.Fatalf("%dx18 frame clipped %q:\n%s", width, required, plain)
				}
			}
			metrics := layout.Compute(width, 18, 3)
			logRegion := responsivePresentationHit(frame, components.HitPaneLogs)
			if !logRegion.Rect.Valid() || logRegion.Rect.Height < 1 || logRegion.Rect.Y < metrics.Panes.Y || logRegion.Rect.Y+logRegion.Rect.Height > metrics.Panes.Y+metrics.Panes.Height {
				t.Fatalf("%dx18 pane log hit is not visibly usable: region=%#v panes=%#v", width, logRegion.Rect, metrics.Panes)
			}
		})
	}
}

func responsivePresentationShellData(width int, height int, composerRows int) ShellData {
	metrics := layout.Compute(width, height, composerRows)
	return ShellData{
		OperatorConsole:    true,
		Width:              width,
		Height:             height,
		ConnectionStatus:   "connected",
		AgentStatus:        "disabled",
		EventStatus:        "connected",
		StateKnown:         true,
		ActiveAppCount:     1,
		RegisteredAppCount: 1,
		KeyMap:             keymap.Default(),
		Panes: []panes.PaneSnapshot{{
			ID:            "service:service-api:backend:backend",
			AppID:         "service-api",
			GroupID:       "service",
			Role:          "backend",
			Title:         "Service: backend",
			Status:        "running",
			RouteLabel:    "http://service-api.localhost:7777",
			PID:           4200,
			Port:          8400,
			Follow:        true,
			Selected:      true,
			LogLineModels: []panes.PaneLogLine{{Text: "visible pane log", Tone: panes.LogToneSuccess}},
		}},
		PaneLayout:     panes.CalculateLayout(metrics.Panes.Width, metrics.Panes.Height, 1),
		PageCount:      1,
		ComposerRows:   composerRows,
		ComposerView:   "> draft",
		ResponseSource: "Agent response",
	}
}

func responsivePresentationHit(frame ShellFrame, kind components.HitKind) components.HitRegion {
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == kind {
			return region
		}
	}
	return components.HitRegion{}
}
