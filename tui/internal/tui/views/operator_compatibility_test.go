package views

import (
	"fmt"
	"image/color"
	"slices"
	"strings"
	"testing"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/layout"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
	usagecomponent "github.com/cameloo/relaybase/tui/internal/tui/usage"
)

func TestOperatorPaneGridFitsExactlyWithoutOuterScroll(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	for _, count := range []int{1, 2, 4, 8} {
		t.Run(fmt.Sprintf("%d-panes", count), func(t *testing.T) {
			data := operatorCompatibilityData(160, 48, count)
			if count == 8 {
				data.Page = 1
				data.PageCount = 2
			}
			frame := BuildShell(style, data)
			plain := ansiEscapePattern.ReplaceAllString(frame.Text, "")
			if got := lipgloss.Width(frame.Text); got != data.Width {
				t.Fatalf("width = %d, want %d", got, data.Width)
			}
			if got := lipgloss.Height(frame.Text); got != data.Height {
				t.Fatalf("height = %d, want %d", got, data.Height)
			}
			if strings.Contains(plain, "scroll 0/") {
				t.Fatalf("normal operator grid acquired an outer viewport:\n%s", plain)
			}
			if got := strings.Count(plain, "└"); got != count {
				t.Fatalf("visible closing pane borders = %d, want %d:\n%s", got, count, plain)
			}
			if got := strings.Count(plain, "┘"); got != count {
				t.Fatalf("visible closing right pane borders = %d, want %d:\n%s", got, count, plain)
			}
			if count == 8 && !strings.Contains(plain, "Page 2/2") {
				t.Fatalf("page status moved out of the rail:\n%s", plain)
			}

			metrics := layout.Compute(data.Width, data.Height, data.ComposerRows)
			surfaces := 0
			logs := 0
			for _, region := range frame.HitMap.Regions() {
				switch region.Kind {
				case components.HitPaneSurface:
					surfaces++
				case components.HitPaneLogs:
					logs++
				}
				if region.Kind == components.HitPaneSurface || region.Kind == components.HitPaneLogs {
					if region.Rect.Y < metrics.Panes.Y || region.Rect.Y+region.Rect.Height > metrics.Panes.Y+metrics.Panes.Height {
						t.Fatalf("pane hit region escaped exact pane bounds: region=%#v panes=%#v", region, metrics.Panes)
					}
				}
			}
			if surfaces != count || logs != count {
				t.Fatalf("pane hit regions surfaces=%d logs=%d, want %d each", surfaces, logs, count)
			}
		})
	}
}

func TestOperatorResponsivePagesKeepFullMetadataPanesScrollable(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	tests := []struct {
		name    string
		width   int
		height  int
		visible int
	}{
		{name: "narrow", width: 70, height: 24, visible: 1},
		{name: "narrow_79", width: 79, height: 24, visible: 1},
		{name: "medium_80", width: 80, height: 24, visible: 4},
		{name: "medium_100", width: 100, height: 30, visible: 6},
		{name: "medium_110", width: 110, height: 32, visible: 8},
		{name: "wide_120", width: 120, height: 32, visible: 6},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			const totalPanes = 8
			metrics := layout.Compute(test.width, test.height, 1)
			capacity := panes.CalculatePageCapacity(metrics.Panes.Width, metrics.Panes.Height)
			if capacity != test.visible {
				t.Fatalf("capacity=%d, want %d for pane band %#v", capacity, test.visible, metrics.Panes)
			}
			data := operatorCompatibilityData(test.width, test.height, capacity)
			data.Panes = fullMetadataPaneSnapshots(capacity)
			data.PaneLayout = panes.CalculateLayout(metrics.Panes.Width, metrics.Panes.Height, capacity)
			data.PageCount = (totalPanes + capacity - 1) / capacity

			frame := BuildShell(style, data)
			plain := ansiEscapePattern.ReplaceAllString(frame.Text, "")
			if got := lipgloss.Width(frame.Text); got != test.width {
				t.Fatalf("frame width=%d, want %d", got, test.width)
			}
			if got := lipgloss.Height(frame.Text); got != test.height {
				t.Fatalf("frame height=%d, want %d", got, test.height)
			}
			if got := strings.Count(plain, "└"); got != capacity {
				t.Fatalf("closing left borders=%d, want %d:\n%s", got, capacity, plain)
			}
			if got := strings.Count(plain, "┘"); got != capacity {
				t.Fatalf("closing right borders=%d, want %d:\n%s", got, capacity, plain)
			}

			logHits := 0
			for _, region := range frame.HitMap.Regions() {
				if region.Kind != components.HitPaneLogs {
					continue
				}
				logHits++
				if region.Rect.Height < 1 || region.Rect.Y < metrics.Panes.Y || region.Rect.Y+region.Rect.Height > metrics.Panes.Y+metrics.Panes.Height {
					t.Fatalf("invalid pane-local log hit %#v inside %#v", region, metrics.Panes)
				}
			}
			if logHits != capacity {
				t.Fatalf("pane-local log hits=%d, want %d:\n%s", logHits, capacity, plain)
			}
		})
	}
}

func TestMinimumPaneGeometryRetainsCompleteBorderAndLogHit(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	pane := paneSnapshots(1)[0]
	rendered := renderPane(style, pane, 28, 6, true, true)
	if got := lipgloss.Width(rendered); got != 28 {
		t.Fatalf("minimum pane width = %d, want 28: %q", got, ansiEscapePattern.ReplaceAllString(rendered, ""))
	}
	if got := lipgloss.Height(rendered); got != 6 {
		t.Fatalf("minimum pane height = %d, want 6", got)
	}
	plain := ansiEscapePattern.ReplaceAllString(rendered, "")
	if !strings.Contains(plain, "└") || !strings.Contains(plain, "┘") || !strings.Contains(plain, "ready") {
		t.Fatalf("minimum pane lost its border or log row:\n%s", plain)
	}
	regions := paneRegionsForRendered(style, pane, 0, 0, 28, 6, true, true)
	foundLog := false
	for _, region := range regions {
		if region.Kind == components.HitPaneLogs {
			foundLog = true
			if region.Rect.Y+region.Rect.Height > 6 {
				t.Fatalf("minimum pane log hit escaped pane: %#v", region)
			}
		}
	}
	if !foundLog {
		t.Fatal("minimum pane omitted its visible log hit region")
	}
}

func TestOperatorShellPreservesThemeAndSemanticIndicatorColors(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := operatorCompatibilityData(120, 32, 1)
	data.ConnectionStatus = "connected"
	data.AgentStatus = "waiting"
	data.EventStatus = "failed"
	data.EventCount = 42
	data.ActiveAppCount = 2
	data.RegisteredAppCount = 3
	data.Page = 1
	data.PageCount = 2
	data.PrimaryFocus = "response"
	data.Panes[0].LogLineModels = []panes.PaneLogLine{
		{Text: "completed", Tone: panes.LogToneSuccess},
		{Text: "warning", Tone: panes.LogToneWarning},
		{Text: "failed", Tone: panes.LogToneError},
	}

	rendered := BuildShell(style, data).Text
	plain := ansiEscapePattern.ReplaceAllString(rendered, "")
	for _, expected := range []string{"Apps 2 active", "Events failed", "Page 2/2", "[focused]"} {
		if !strings.Contains(plain, expected) {
			t.Fatalf("operator rail/focus omitted %q:\n%s", expected, plain)
		}
	}
	wide := data
	wide.Width = 240
	widePlain := ansiEscapePattern.ReplaceAllString(BuildShell(style, wide).Text, "")
	for _, expected := range []string{"2 active", "3 registered"} {
		if !strings.Contains(widePlain, expected) {
			t.Fatalf("wide operator rail omitted full app-count wording %q:\n%s", expected, widePlain)
		}
	}
	for _, expected := range []string{
		ansiRGB("38", theme.Border),
		ansiRGB("48", theme.Background),
		ansiRGB("38", theme.Accent),
		ansiRGB("38", theme.Success),
		ansiRGB("38", theme.Warning),
		ansiRGB("38", theme.Error),
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("operator shell omitted ANSI theme sequence %q; codes=%q", expected, ansiEscapePattern.FindAllString(rendered, -1))
		}
	}
}

func TestOperatorComposerDividerIsExactBrownFullWidth(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := operatorCompatibilityData(80, 24, 2)
	frame := BuildShell(style, data)
	metrics := layout.Compute(data.Width, data.Height, data.ComposerRows)
	lines := strings.Split(frame.Text, "\n")
	if metrics.Composer.Y < 0 || metrics.Composer.Y >= len(lines) {
		t.Fatalf("composer divider row %d escaped %d-line frame", metrics.Composer.Y, len(lines))
	}

	divider := lines[metrics.Composer.Y]
	plain := ansiEscapePattern.ReplaceAllString(divider, "")
	if got := lipgloss.Width(divider); got != data.Width {
		t.Fatalf("composer divider width=%d, want %d: %q", got, data.Width, plain)
	}
	if want := strings.Repeat("─", data.Width); plain != want {
		t.Fatalf("composer divider is not one uninterrupted full-width rule:\n%q", plain)
	}
	if expected := ansiRGB("38", theme.Border); !strings.Contains(divider, expected) {
		t.Fatalf("composer divider omitted brown border tone %q; codes=%q", expected, ansiEscapePattern.FindAllString(divider, -1))
	}
}

func TestOperatorFinalFrameUsesResolvedLightDarkAndAutoColors(t *testing.T) {
	for _, mode := range []string{"light", "dark", "auto"} {
		t.Run(mode, func(t *testing.T) {
			theme, _ := styles.ResolveTheme(mode, func(string) string { return "" })
			rendered := BuildShell(styles.New(theme), operatorCompatibilityData(80, 24, 2)).Text
			for _, expected := range []string{
				ansiRGB("38", theme.Text),
				ansiRGB("38", theme.Border),
				ansiRGB("38", theme.Accent),
				ansiRGB("48", theme.Background),
			} {
				if !strings.Contains(rendered, expected) {
					t.Fatalf("%s final frame omitted resolved theme sequence %q", mode, expected)
				}
			}
			if got := lipgloss.Width(rendered); got != 80 {
				t.Fatalf("%s frame width=%d, want 80", mode, got)
			}
			if got := lipgloss.Height(rendered); got != 24 {
				t.Fatalf("%s frame height=%d, want 24", mode, got)
			}
		})
	}
}

func TestOperatorPaneLogLinesKeepTheirSemanticToneAssociation(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := operatorCompatibilityData(100, 32, 1)
	startLine, ok := panes.ProjectLogEvent(relaybaseclient.LogEvent{
		Stream: "system", Source: "lifecycle_starting", Level: "info", Message: "start-marker",
	})
	if !ok {
		t.Fatal("daemon start event did not project")
	}
	stopLine, ok := panes.ProjectLogEvent(relaybaseclient.LogEvent{
		Stream: "system", Source: "lifecycle_stopped", Level: "info", Message: "stop-marker",
	})
	if !ok {
		t.Fatal("daemon stop event did not project")
	}
	data.Panes[0].LogLineModels = []panes.PaneLogLine{
		{Text: "success-marker", Tone: panes.LogToneSuccess},
		{Text: "warning-marker", Tone: panes.LogToneWarning},
		{Text: "error-marker", Tone: panes.LogToneError},
		startLine,
		stopLine,
	}
	tests := []struct {
		marker string
		color  color.Color
	}{
		{marker: "success-marker", color: theme.Success},
		{marker: "warning-marker", color: theme.Warning},
		{marker: "error-marker", color: theme.Error},
		{marker: "start-marker", color: theme.Success},
		{marker: "stop-marker", color: theme.Error},
	}
	for _, mode := range []string{"dashboard", "expanded"} {
		modeData := data
		if mode == "expanded" {
			focused := modeData.Panes[0]
			modeData.FocusedPane = &focused
		}
		rendered := BuildShell(style, modeData).Text
		for _, test := range tests {
			line := ""
			for _, candidate := range strings.Split(rendered, "\n") {
				if strings.Contains(candidate, test.marker) {
					line = candidate
					break
				}
			}
			if line == "" {
				t.Fatalf("%s operator pane omitted %q from the final frame", mode, test.marker)
			}
			if expected := ansiRGB("38", test.color); !strings.Contains(line, expected) {
				t.Fatalf("%s log %q lost tone %q on its rendered line; codes=%q", mode, test.marker, expected, ansiEscapePattern.FindAllString(line, -1))
			}
		}
	}
}

func TestOperatorAgentStatusesUseDeliberateSemanticTones(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	tests := []struct {
		name     string
		statuses []string
		color    color.Color
	}{
		{name: "success", statuses: []string{"connected", "running", "ready", "healthy", "active", "session", "streaming"}, color: theme.Success},
		{name: "warning", statuses: []string{"waiting", "degraded", "connecting", "checking", "pending", "stale", "starting", "stopping", "sending", "reconnecting", "needs_config"}, color: theme.Warning},
		{name: "error", statuses: []string{"offline", "failed", "error", "disconnected", "unavailable"}, color: theme.Error},
		{name: "muted", statuses: []string{"idle", "ready_no_thread", "disabled", "unknown"}, color: theme.Muted},
	}

	for _, test := range tests {
		for _, status := range test.statuses {
			t.Run(test.name+"/"+status, func(t *testing.T) {
				rendered := operatorRailField(style, "Agent", status)
				expected := ansiRGB("38", test.color)
				if !strings.Contains(rendered, expected) {
					t.Fatalf("Agent status %q omitted %s tone %q; codes=%q", status, test.name, expected, ansiEscapePattern.FindAllString(rendered, -1))
				}
				if plain := ansiEscapePattern.ReplaceAllString(rendered, ""); !strings.Contains(plain, "Agent "+status) {
					t.Fatalf("Agent status %q lost its explicit text label: %q", status, plain)
				}
			})
		}
	}
}

func TestWideOperatorRailRetainsLegacyGroupCountWhenItFits(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := operatorCompatibilityData(180, 40, 1)
	data.GroupCount = 4
	rendered := fixedRegion(style.Status, renderOperatorRail(style, data, data.Width), data.Width, 1)
	plain := ansiEscapePattern.ReplaceAllString(rendered, "")
	if !strings.Contains(plain, "Groups 4") {
		t.Fatalf("wide operator rail dropped the compatible group count:\n%s", plain)
	}
}

func TestOperatorRailColumnsStayFixedAcrossStatusUpdates(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	for _, width := range []int{80, 81, 119, 120, 121, 160} {
		t.Run(fmt.Sprintf("width-%d", width), func(t *testing.T) {
			before := operatorCompatibilityData(width, 32, 1)
			before.AgentStatus = "waiting"
			before.ActiveAppCount = 2
			before.RegisteredAppCount = 3
			before.EventStatus = "waiting"

			after := before
			after.ConnectionStatus = "reconnecting"
			after.AgentStatus = "ready_no_thread"
			after.ActiveAppCount = 42
			after.RegisteredAppCount = 105
			after.EventStatus = "failed"
			after.EventCount = 999
			after.Diagnostics = []DiagnosticLine{{Severity: "error"}, {Severity: "warning"}, {Severity: "info"}}

			beforeLine := ansiEscapePattern.ReplaceAllString(renderOperatorRail(style, before, width), "")
			afterLine := ansiEscapePattern.ReplaceAllString(renderOperatorRail(style, after, width), "")
			beforeDividers := visibleColumnsOf(beforeLine, operatorRailDivider)
			afterDividers := visibleColumnsOf(afterLine, operatorRailDivider)
			if !slices.Equal(beforeDividers, afterDividers) {
				t.Fatalf("divider columns moved after an update: before=%v after=%v\n%s\n%s", beforeDividers, afterDividers, beforeLine, afterLine)
			}
			if len(beforeDividers) != 4 {
				t.Fatalf("divider count=%d, want 4: %q", len(beforeDividers), beforeLine)
			}
			spans := []int{beforeDividers[0]}
			for index := 1; index < len(beforeDividers); index++ {
				spans = append(spans, beforeDividers[index]-beforeDividers[index-1])
			}
			spans = append(spans, width-beforeDividers[len(beforeDividers)-1])
			minimum, maximum := spans[0], spans[0]
			for _, span := range spans[1:] {
				minimum = minInt(minimum, span)
				maximum = maxInt(maximum, span)
			}
			if maximum-minimum > 1 {
				t.Fatalf("rail columns are not evenly distributed: width=%d dividers=%v spans=%v", width, beforeDividers, spans)
			}
			for _, label := range []string{"Relaybase", "Agent", "Apps", "Events", "Attention"} {
				beforeColumn := visibleColumnOf(beforeLine, label)
				afterColumn := visibleColumnOf(afterLine, label)
				if beforeColumn < 0 || beforeColumn != afterColumn {
					t.Fatalf("%s column moved after an update: before=%d after=%d\n%s\n%s", label, beforeColumn, afterColumn, beforeLine, afterLine)
				}
			}
			if strings.Contains(beforeLine, "•") || strings.Contains(afterLine, "•") {
				t.Fatalf("operator rail retained the dot separator:\n%s\n%s", beforeLine, afterLine)
			}
		})
	}
}

func visibleColumnsOf(value string, target string) []int {
	columns := []int{}
	searchFrom := 0
	for searchFrom < len(value) {
		relative := strings.Index(value[searchFrom:], target)
		if relative < 0 {
			break
		}
		index := searchFrom + relative
		columns = append(columns, lipgloss.Width(value[:index]))
		searchFrom = index + len(target)
	}
	return columns
}

func visibleColumnOf(value string, target string) int {
	index := strings.Index(value, target)
	if index < 0 {
		return -1
	}
	return lipgloss.Width(value[:index])
}

func TestOperatorUsageOverlayShowsCompleteRowsFooterAndBox(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	cost := "0.123456"
	updated := "2026-07-11T19:41:12Z"
	usage := &relaybaseclient.AgentUsageSnapshot{UpdatedAt: &updated}
	usage.LastRequest = &relaybaseclient.AgentUsageLastRequest{
		ModelSlug: "openai/gpt-5.6-luna",
		Tokens:    relaybaseclient.AgentUsageTokens{Input: 12480, Output: 2106, Total: 14586},
		Cost:      relaybaseclient.AgentUsageCost{USD: &cost, Source: "provider_reported"},
	}
	usage.ThreadTotals.Tokens.Total = 91204
	usage.ThreadTotals.Cost.KnownUSD = "0.842731"
	usage.ThreadTotals.Cost.Sources = []string{"provider_reported", "estimated"}

	data := operatorCompatibilityData(120, 40, 1)
	data.Usage = &usagecomponent.Snapshot{Status: usagecomponent.StatusReady, Usage: usage}
	frame := BuildShell(style, data)
	modal := findHitRect(frame.HitMap, components.HitModal)
	if !modal.Valid() {
		t.Fatal("usage overlay omitted its modal hit region")
	}

	overlay := renderedTerminalRect(frame.Text, modal)
	plain := ansiEscapePattern.ReplaceAllString(overlay, "")
	if got := lipgloss.Width(overlay); got != modal.Width {
		t.Fatalf("usage box width=%d, modal hit width=%d:\n%s", got, modal.Width, plain)
	}
	if got := lipgloss.Height(overlay); got != modal.Height {
		t.Fatalf("usage box height=%d, modal hit height=%d:\n%s", got, modal.Height, plain)
	}
	lines := strings.Split(plain, "\n")
	if len(lines) < 2 || !strings.HasPrefix(lines[0], "╭") || !strings.HasSuffix(lines[0], "╮") || !strings.HasPrefix(lines[len(lines)-1], "╰") || !strings.HasSuffix(lines[len(lines)-1], "╯") {
		t.Fatalf("usage overlay omitted a complete rounded border:\n%s", plain)
	}
	for _, expected := range []string{
		"Usage",
		"Last request",
		"Model     openai/gpt-5.6-luna",
		"12,480 in · 2,106 out · 14,586 total",
		"$0.123456 reported",
		"Active thread",
		"91,204 total",
		"$0.842731 reported + estimated",
		"Updated",
		"Esc close · R refresh",
	} {
		if !strings.Contains(plain, expected) {
			t.Fatalf("usage overlay clipped %q:\n%s", expected, plain)
		}
	}
}

func TestOperatorUsageOverlayFitsMinimumSupportedTerminal(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	cost := "0.123456"
	updated := time.Now().Add(-12 * time.Second).UTC().Format(time.RFC3339)
	usage := &relaybaseclient.AgentUsageSnapshot{UpdatedAt: &updated}
	usage.LastRequest = &relaybaseclient.AgentUsageLastRequest{
		ModelSlug: "openai/gpt-5.6-luna",
		Tokens:    relaybaseclient.AgentUsageTokens{Input: 12480, Output: 2106, Total: 14586},
		Cost:      relaybaseclient.AgentUsageCost{USD: &cost, Source: "provider_reported"},
	}
	usage.ThreadTotals.Tokens.Total = 91204
	usage.ThreadTotals.Cost.KnownUSD = "0.842731"
	usage.ThreadTotals.Cost.Sources = []string{"provider_reported", "estimated"}

	data := operatorCompatibilityData(40, 18, 1)
	data.Usage = &usagecomponent.Snapshot{Status: usagecomponent.StatusReady, Usage: usage}
	frame := BuildShell(style, data)
	modal := findHitRect(frame.HitMap, components.HitModal)
	overlay := renderedTerminalRect(frame.Text, modal)
	plain := ansiEscapePattern.ReplaceAllString(overlay, "")
	if lipgloss.Width(frame.Text) != 40 || lipgloss.Height(frame.Text) != 18 || !modal.Valid() || modal.Y+modal.Height > 18 {
		t.Fatalf("minimum usage geometry escaped the terminal: frame=%dx%d modal=%#v", lipgloss.Width(frame.Text), lipgloss.Height(frame.Text), modal)
	}
	lines := strings.Split(plain, "\n")
	if len(lines) < 2 || !strings.HasPrefix(lines[0], "╭") || !strings.HasSuffix(lines[0], "╮") || !strings.HasPrefix(lines[len(lines)-1], "╰") || !strings.HasSuffix(lines[len(lines)-1], "╯") {
		t.Fatalf("minimum usage overlay lost its complete box:\n%s", plain)
	}
	for _, expected := range []string{
		"openai/gpt-5.6-luna",
		"In 12,480 · Out 2,106",
		"Total 14,586",
		"Cost $0.123456 reported",
		"Tokens 91,204 total",
		"Cost $0.842731",
		"Source reported + estimated",
		"Esc close · R refresh",
	} {
		if !strings.Contains(plain, expected) {
			t.Fatalf("minimum usage overlay clipped %q:\n%s", expected, plain)
		}
	}
}

func TestOperatorANSIStylesNeverPreserveUntrustedTerminalActions(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	attack := "visible\x1b[2J\x1b]52;c;clipboard\a\u009b31mhidden"

	data := operatorCompatibilityData(100, 30, 1)
	data.AgentThreadLabel = attack
	rendered := BuildShell(style, data).Text
	for _, forbidden := range []string{"\x1b[2J", "\x1b]52", "\u009b"} {
		if strings.Contains(rendered, forbidden) {
			t.Fatalf("rail preserved untrusted terminal action %q", forbidden)
		}
	}

	data.Confirmation = &ConfirmationData{Action: attack, Target: attack, Risk: attack, ExpectedResult: attack, Details: []string{attack}}
	rendered = BuildShell(style, data).Text
	for _, forbidden := range []string{"\x1b[2J", "\x1b]52", "\u009b"} {
		if strings.Contains(rendered, forbidden) {
			t.Fatalf("confirmation preserved untrusted terminal action %q", forbidden)
		}
	}

	data.Confirmation = nil
	data.SetupPanel = "Setup\n" + attack
	rendered = BuildShell(style, data).Text
	for _, forbidden := range []string{"\x1b[2J", "\x1b]52", "\u009b"} {
		if strings.Contains(rendered, forbidden) {
			t.Fatalf("setup overlay preserved untrusted terminal action %q", forbidden)
		}
	}
}

func TestOperatorCommandPaletteIsAnchoredAboveComposer(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := operatorCompatibilityData(120, 32, 1)
	matches := slash.SearchCatalog("")[:5]
	data.CommandPalette = &CommandPaletteData{Matches: matches, Total: len(slash.Catalog())}
	frame := BuildShell(style, data)
	metrics := layout.Compute(data.Width, data.Height, data.ComposerRows)

	var palette components.HitRegion
	found := false
	for _, region := range frame.HitMap.Regions() {
		if region.Kind == components.HitCommandPalette {
			palette = region
			found = true
			break
		}
	}
	if !found {
		t.Fatal("command palette surface was not hit-testable")
	}
	if palette.Rect.Y+palette.Rect.Height != metrics.Composer.Y {
		t.Fatalf("palette is not anchored immediately above composer: palette=%#v composer=%#v", palette.Rect, metrics.Composer)
	}
	if got := lipgloss.Height(frame.Text); got != data.Height {
		t.Fatalf("palette overlay changed terminal height to %d", got)
	}
	if plain := ansiEscapePattern.ReplaceAllString(frame.Text, ""); !strings.Contains(plain, "/launch") || !strings.Contains(plain, "Composer") {
		t.Fatalf("dedicated palette/composer content missing:\n%s", plain)
	}
}

func TestOperatorScrollableOverlayUsesBodyOffsetAndAccurateHelpHits(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := operatorCompatibilityData(100, 30, 1)
	for index := 1; index <= 40; index++ {
		data.Diagnostics = append(data.Diagnostics, DiagnosticLine{Code: fmt.Sprintf("diag-%02d", index), Severity: "warning", Message: "detail"})
	}
	data.DiagnosticsOpen = true
	maximum := BodyScrollMax(style, data)
	if maximum <= 0 {
		t.Fatal("long operator diagnostics did not expose a body scroll range")
	}
	data.BodyScrollOffset = maximum
	plain := ansiEscapePattern.ReplaceAllString(BuildShell(style, data).Text, "")
	if !strings.Contains(plain, "diag-40") || strings.Contains(plain, "diag-01") {
		t.Fatalf("operator overlay did not apply its body offset:\n%s", plain)
	}

	helpData := operatorCompatibilityData(100, 30, 1)
	helpData.Help = &HelpData{SearchView: "usage", Query: "usage", Matches: slash.SearchCatalog("usage")}
	helpFrame := BuildShell(style, helpData)
	var modal components.Rect
	var result components.Rect
	for _, region := range helpFrame.HitMap.Regions() {
		switch region.Kind {
		case components.HitModal:
			modal = region.Rect
		case components.HitHelpResult:
			result = region.Rect
		}
	}
	if !modal.Valid() || !result.Valid() {
		t.Fatalf("help overlay regions missing: modal=%#v result=%#v", modal, result)
	}
	if result.X <= modal.X || result.Y <= modal.Y+2 || result.X+result.Width > modal.X+modal.Width || result.Y+result.Height > modal.Y+modal.Height {
		t.Fatalf("help result hit rect does not match visible padded content: modal=%#v result=%#v", modal, result)
	}
}

func TestOperatorThreadSwitcherRowsMatchVisiblePaddedContent(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := operatorCompatibilityData(100, 30, 1)
	data.ThreadSwitcher = &ThreadSwitcherData{Entries: []ThreadSwitcherEntry{{Index: 7, Title: "Operations"}}}
	frame := BuildShell(style, data)
	var modal components.Rect
	var row components.HitRegion
	for _, region := range frame.HitMap.Regions() {
		switch region.Kind {
		case components.HitModal:
			modal = region.Rect
		case components.HitThreadSwitcherRow:
			row = region
		}
	}
	expectedX := modal.X + style.Help.GetBorderLeftSize() + style.Help.GetPaddingLeft()
	expectedY := modal.Y + style.Help.GetBorderTopSize() + style.Help.GetPaddingTop() + 1
	if row.Index != 7 || row.Rect.X != expectedX || row.Rect.Y != expectedY {
		t.Fatalf("thread row does not match visible entry: modal=%#v row=%#v expected=(%d,%d)", modal, row, expectedX, expectedY)
	}
	if plain := ansiEscapePattern.ReplaceAllString(frame.Text, ""); strings.Contains(plain, "scroll 0/") {
		t.Fatalf("owned inert thread switcher acquired a scroll indicator:\n%s", plain)
	}
}

func TestResponseBottomOffsetMatchesRenderedSafeMarkdownViewport(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	data := operatorCompatibilityData(160, 36, 1)
	lines := make([]string, 40)
	for index := range lines {
		lines[index] = fmt.Sprintf("response line %02d", index+1)
	}
	data.ResponseSource = strings.Join(lines, "\n\n")
	data.ResponseOffset = ResponseBottomOffset(style, data)
	if data.ResponseOffset <= 0 || data.ResponseOffset != ResponseScrollMax(style, data) {
		t.Fatalf("invalid response bottom offset %d", data.ResponseOffset)
	}
	plain := ansiEscapePattern.ReplaceAllString(BuildShell(style, data).Text, "")
	if !strings.Contains(plain, "response line 40") {
		t.Fatalf("bottom response offset did not reveal final rendered line:\n%s", plain)
	}
}

func TestAgentDockUsesUpperThirdWithoutGrowingComposer(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	data := operatorCompatibilityData(160, 30, 1)
	rows := make([]string, 20)
	for index := range rows {
		rows[index] = fmt.Sprintf("response-row-%02d", index+1)
	}
	data.ResponseSource = strings.Join(rows, "\n")
	data.ResponseOffset = 0
	frame := BuildShell(styles.New(theme), data)
	metrics := layout.Compute(data.Width, data.Height, data.ComposerRows)
	if !metrics.AgentDocked || metrics.Agent.Width != data.Width/3 || metrics.Panes.Width != data.Width-data.Width/3 || metrics.Composer.Height != data.ComposerRows+2 {
		t.Fatalf("Agent/composer geometry diverged: %#v", metrics)
	}
	if lipgloss.Width(frame.Text) != data.Width || lipgloss.Height(frame.Text) != data.Height {
		t.Fatalf("Agent dock escaped terminal geometry: %dx%d", lipgloss.Width(frame.Text), lipgloss.Height(frame.Text))
	}
	plain := ansiEscapePattern.ReplaceAllString(frame.Text, "")
	if !strings.Contains(plain, "response-row-20") || !strings.Contains(plain, "Ctrl+G agent pane") {
		t.Fatalf("Agent dock or Composer pointer is missing:\n%s", plain)
	}
}

func TestAgentModalUsesTheDockResponseRendererAndExclusiveHitMap(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	style := styles.New(theme)
	dock := operatorCompatibilityData(160, 30, 2)
	dock.ResponseSource = "shared-agent-token\n\nsecond line"
	dockPlain := ansiEscapePattern.ReplaceAllString(BuildShell(style, dock).Text, "")

	modal := dock
	modal.Width = 100
	modal.ResponseDetails = true
	modalPlain := ansiEscapePattern.ReplaceAllString(BuildShell(style, modal).Text, "")
	for _, expected := range []string{"shared-agent-token", "[c] copy", "[b] code"} {
		if !strings.Contains(dockPlain, expected) || !strings.Contains(modalPlain, expected) {
			t.Fatalf("shared Agent renderer omitted %q: dock=%q modal=%q", expected, dockPlain, modalPlain)
		}
	}
	frame := BuildShell(style, modal)
	foundModal := false
	foundResponse := false
	for _, region := range frame.HitMap.Regions() {
		switch region.Kind {
		case components.HitModal:
			foundModal = true
		case components.HitResponse:
			foundResponse = true
		case components.HitPaneSurface, components.HitPaneLogs:
			t.Fatalf("Agent modal leaked background pane hit region: %#v", region)
		}
	}
	if !foundModal || !foundResponse {
		t.Fatalf("Agent modal omitted owned regions: modal=%v response=%v", foundModal, foundResponse)
	}
}

func TestAgentComposerPointerRemainsVisibleInModalFallback(t *testing.T) {
	theme, _ := styles.ResolveTheme("light", func(string) string { return "" })
	data := operatorCompatibilityData(100, 30, 2)
	frame := BuildShell(styles.New(theme), data)
	metrics := layout.Compute(data.Width, data.Height, data.ComposerRows)
	plain := ansiEscapePattern.ReplaceAllString(frame.Text, "")
	if metrics.AgentDockable || !strings.Contains(plain, "Ctrl+G agent pane") {
		t.Fatalf("fallback layout lost the Composer Agent pointer: metrics=%#v\n%s", metrics, plain)
	}
	if lipgloss.Width(frame.Text) != data.Width || lipgloss.Height(frame.Text) != data.Height {
		t.Fatalf("fallback shell escaped terminal geometry: %dx%d", lipgloss.Width(frame.Text), lipgloss.Height(frame.Text))
	}
}

func operatorCompatibilityData(width int, height int, paneCount int) ShellData {
	metrics := layout.Compute(width, height, 1)
	return ShellData{
		OperatorConsole:   true,
		Width:             width,
		Height:            height,
		ConnectionStatus:  "connected",
		EventStatus:       "connected",
		AgentStatus:       "running",
		StateKnown:        true,
		AppCount:          paneCount,
		KeyMap:            keymap.Default(),
		Panes:             paneSnapshots(paneCount),
		PaneLayout:        panes.CalculateLayout(metrics.Panes.Width, metrics.Panes.Height, paneCount),
		PageCount:         1,
		ComposerRows:      1,
		ComposerView:      "> inspect logs",
		ResponseSource:    "Agent response",
		AgentPaneExpanded: true,
		ResponseFollow:    true,
	}
}

func fullMetadataPaneSnapshots(count int) []panes.PaneSnapshot {
	result := make([]panes.PaneSnapshot, 0, count)
	for index := 1; index <= count; index++ {
		result = append(result, panes.PaneSnapshot{
			ID:         fmt.Sprintf("full-pane-%d", index),
			AppID:      fmt.Sprintf("full-app-%d", index),
			GroupID:    fmt.Sprintf("full-group-%d", index),
			Role:       "backend",
			Title:      fmt.Sprintf("App %d: backend", index),
			Status:     "failed",
			RouteLabel: fmt.Sprintf("http://app-%d.localhost:7777", index),
			PID:        2000 + index,
			Port:       8000 + index,
			LastError:  "health check failed",
			Follow:     true,
			Selected:   index == 1,
			LogLines:   []string{"[stdout] ready"},
			LogLineModels: []panes.PaneLogLine{{
				Text: "[stdout] ready",
				Tone: panes.LogToneSuccess,
			}},
		})
	}
	return result
}

func ansiRGB(prefix string, value color.Color) string {
	red, green, blue, _ := value.RGBA()
	return fmt.Sprintf("%s;2;%d;%d;%d", prefix, red>>8, green>>8, blue>>8)
}

func findHitRect(hitMap components.HitMap, kind components.HitKind) components.Rect {
	for _, region := range hitMap.Regions() {
		if region.Kind == kind {
			return region.Rect
		}
	}
	return components.Rect{}
}

func renderedTerminalRect(rendered string, rect components.Rect) string {
	lines := strings.Split(rendered, "\n")
	if rect.Y < 0 || rect.Y+rect.Height > len(lines) {
		return ""
	}
	visible := make([]string, 0, rect.Height)
	for _, line := range lines[rect.Y : rect.Y+rect.Height] {
		visible = append(visible, ansi.Cut(line, rect.X, rect.X+rect.Width))
	}
	return strings.Join(visible, "\n")
}
