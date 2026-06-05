package views

import (
	"fmt"
	"regexp"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/contextmenu"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
)

var ansiEscapePattern = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

type DiagnosticLine struct {
	Code     string
	Severity string
	Message  string
}

type ShellData struct {
	Width            int
	Height           int
	BodyScrollOffset int
	ConnectionStatus string
	EventStatus      string
	EventCount       int
	AgentThreadLabel string
	AppCount         int
	GroupCount       int
	Diagnostics      []DiagnosticLine
	ShowHelp         bool
	KeyMap           keymap.KeyMap
	AssistantPrompt  string
	AssistantHistory []string
	SetupPanel       string
	ContextMenu      *contextmenu.Snapshot
	Confirmation     *ConfirmationData
	Panes            []panes.PaneSnapshot
	FocusedPane      *panes.PaneSnapshot
	PaneLayout       panes.Layout
	Page             int
	PageCount        int
}

type ConfirmationData struct {
	Action         string
	Target         string
	Risk           string
	ExpectedResult string
	Details        []string
}

func RenderShell(style styles.Styles, data ShellData) string {
	width := data.Width
	if width <= 0 {
		width = 80
	}
	height := data.Height
	if height <= 0 {
		height = 24
	}

	header := style.Header.Width(width).Render("Relaybase TUI")
	statusLine := fmt.Sprintf(
		"daemon: %s  events: %s  apps: %d  groups: %d",
		valueOr(data.ConnectionStatus, "connecting"),
		valueOr(data.EventStatus, "connecting"),
		data.AppCount,
		data.GroupCount,
	)
	if data.AgentThreadLabel != "" {
		statusLine += "  thread: " + data.AgentThreadLabel
	}
	status := style.Status.Width(width).Render(statusLine)

	body := renderBody(style, data)
	assistantPrompt := truncateText(oneLineText(data.AssistantPrompt), maxInt(width-4, 1))
	assistant := components.RenderAssistantBar(style, assistantPrompt, width)
	bodyHeight := maxInt(1, height-lipgloss.Height(header)-lipgloss.Height(status)-lipgloss.Height(assistant))
	body = renderBodyViewport(body, bodyHeight, data.BodyScrollOffset, width)

	return lipgloss.JoinVertical(lipgloss.Left, header, status, body, assistant)
}

func renderBodyViewport(body string, height int, offset int, width int) string {
	height = maxInt(1, height)
	if width <= 0 {
		width = 80
	}
	lines := strings.Split(body, "\n")
	maxOffset := maxInt(0, len(lines)-height)
	offset = clampInt(offset, 0, maxOffset)
	end := minInt(len(lines), offset+height)
	visible := append([]string(nil), lines[offset:end]...)
	for len(visible) < height {
		visible = append(visible, strings.Repeat(" ", width))
	}
	return strings.Join(visible, "\n")
}

func oneLineText(value string) string {
	value = strings.ReplaceAll(value, "\r\n", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, "\r", " ")
	return value
}

func renderBody(style styles.Styles, data ShellData) string {
	if data.Confirmation != nil {
		return style.Help.Width(maxInt(data.Width-4, 40)).Render(renderConfirmation(*data.Confirmation))
	}
	if data.ContextMenu != nil {
		return style.Help.Width(maxInt(data.Width-4, 40)).Render(renderContextMenu(*data.ContextMenu))
	}
	if data.ShowHelp {
		return style.Help.Width(maxInt(data.Width-4, 40)).Render(renderHelp(data))
	}
	if data.FocusedPane != nil {
		return renderFocusedPane(style, data, *data.FocusedPane)
	}
	if strings.TrimSpace(data.SetupPanel) != "" {
		return style.Body.Width(maxInt(data.Width-4, 40)).Render(data.SetupPanel)
	}
	return renderPaneGrid(style, data)
}

func renderPaneGrid(style styles.Styles, data ShellData) string {
	lines := []string{}
	if len(data.AssistantHistory) > 0 {
		lines = append(lines, renderAssistantHistory(data.AssistantHistory), "")
	}
	if len(data.Diagnostics) > 0 {
		lines = append(lines, renderDiagnostics(data.Diagnostics), "")
	}

	if len(data.Panes) == 0 {
		lines = append(lines, "No active panes")
		lines = append(lines, "")
		lines = append(lines, "Starting or running components open panes automatically. Failed panes stay visible until closed.")
		lines = append(lines, "Use /configure <path> --dry-run, /register <manifest-path>, or /add app <path> using <command> to start setup through the daemon.")
		return style.Body.Width(maxInt(data.Width-4, 40)).Render(strings.Join(lines, "\n"))
	}

	if data.PageCount > 1 {
		lines = append(lines, fmt.Sprintf("Page %d/%d", data.Page+1, data.PageCount), "")
	}

	grid := renderGrid(style, data.Panes, data.PaneLayout)
	lines = append(lines, grid)
	return strings.Join(lines, "\n")
}

func renderFocusedPane(style styles.Styles, data ShellData, pane panes.PaneSnapshot) string {
	if len(data.Diagnostics) == 0 {
		return renderPane(style, pane, maxInt(data.Width-4, 40), maxInt(data.PaneLayout.Height, 10))
	}
	return lipgloss.JoinVertical(
		lipgloss.Left,
		renderDiagnostics(data.Diagnostics),
		renderPane(style, pane, maxInt(data.Width-4, 40), maxInt(data.PaneLayout.Height-3, 10)),
	)
}

func renderGrid(style styles.Styles, paneSnapshots []panes.PaneSnapshot, layout panes.Layout) string {
	columns := maxInt(layout.Columns, 1)
	rows := []string{}
	for start := 0; start < len(paneSnapshots); start += columns {
		end := minInt(start+columns, len(paneSnapshots))
		rowPanes := []string{}
		for _, pane := range paneSnapshots[start:end] {
			rowPanes = append(rowPanes, renderPane(style, pane, layout.PaneWidth-2, layout.PaneHeight))
		}
		rows = append(rows, lipgloss.JoinHorizontal(lipgloss.Top, rowPanes...))
	}
	return lipgloss.JoinVertical(lipgloss.Left, rows...)
}

func renderPane(style styles.Styles, pane panes.PaneSnapshot, width int, height int) string {
	width = maxInt(width, 20)
	height = maxInt(height, 6)

	paneStyle := style.Pane.Width(width).Height(height)
	if pane.Selected {
		paneStyle = paneStyle.BorderForeground(style.Theme.Accent)
	}
	if pane.Focused {
		paneStyle = paneStyle.BorderForeground(style.Theme.Accent)
	}
	if pane.Color != "" && pane.Color != "default" {
		paneStyle = paneStyle.BorderForeground(lipgloss.Color(pane.Color))
	}
	if pane.Status == "failed" {
		paneStyle = paneStyle.BorderForeground(style.Theme.Error)
	}

	lines := []string{
		style.PaneTitle.Render(truncateText(pane.Title, width-4)),
		truncateText(statusLine(pane), width-4),
	}
	if pane.RouteLabel != "" {
		lines = append(lines, truncateText("route "+pane.RouteLabel, width-4))
	}
	if pane.PID > 0 || pane.Port > 0 {
		lines = append(lines, truncateText(pidPortLine(pane), width-4))
	}
	if pane.LastError != "" {
		lines = append(lines, truncateText("error "+pane.LastError, width-4))
	}
	lines = append(lines, "")

	logBudget := maxInt(1, height-len(lines)-2)
	logLines := pane.LogLines
	if len(logLines) == 0 {
		logLines = []string{"No logs yet"}
	}
	if pane.LogError != "" {
		logLines = append([]string{"logs unavailable: " + pane.LogError}, logLines...)
	}
	if len(logLines) > logBudget {
		logLines = logLines[len(logLines)-logBudget:]
	}
	for _, line := range logLines {
		lines = append(lines, style.PaneLog.Render(truncateText(line, width-4)))
	}

	return paneStyle.Render(strings.Join(lines, "\n"))
}

func renderDiagnostics(diagnostics []DiagnosticLine) string {
	lines := []string{"Diagnostics"}
	for _, diagnostic := range diagnostics {
		lines = append(lines, fmt.Sprintf("- [%s] %s: %s", diagnostic.Severity, diagnostic.Code, diagnostic.Message))
	}
	return strings.Join(lines, "\n")
}

func renderAssistantHistory(history []string) string {
	lines := []string{"Assistant"}
	for _, entry := range history {
		lines = append(lines, "- "+entry)
	}
	return strings.Join(lines, "\n")
}

func renderContextMenu(menu contextmenu.Snapshot) string {
	lines := []string{menu.Title}
	for index, item := range menu.Items {
		prefix := "  "
		if index == menu.Selected {
			prefix = "> "
		}
		label := item.Label
		if !item.Enabled {
			if item.DisabledReason != "" {
				label += " (unavailable: " + item.DisabledReason + ")"
			} else {
				label += " (unavailable)"
			}
		}
		lines = append(lines, prefix+label)
	}
	return strings.Join(lines, "\n")
}

func renderConfirmation(confirmation ConfirmationData) string {
	lines := []string{
		"Confirm Action",
		"action: " + confirmation.Action,
		"target: " + confirmation.Target,
		"risk: " + confirmation.Risk,
		"expected: " + confirmation.ExpectedResult,
	}
	if len(confirmation.Details) > 0 {
		lines = append(lines, "details:")
		for _, detail := range confirmation.Details {
			lines = append(lines, "- "+detail)
		}
	}
	lines = append(lines,
		"",
		"Press Enter to confirm or Esc to cancel.",
	)
	return strings.Join(lines, "\n")
}

func renderHelp(data ShellData) string {
	lines := []string{"Help"}
	for _, binding := range data.KeyMap.FullHelp() {
		lines = append(lines, "- "+binding.Help().Key+": "+binding.Help().Desc)
	}
	lines = append(lines, "")
	lines = append(lines, "Ctrl+O opens the pane menu from the dashboard; while slash input is active it opens the assistant menu.")
	lines = append(lines, "Ctrl+O is the fallback when Ctrl+Z is intercepted by the terminal.")
	lines = append(lines, "Dashboard PageUp/PageDown changes pane pages.")
	lines = append(lines, "Focused pane PageUp/PageDown scrolls logs and fetches older logs when available.")
	lines = append(lines, "")
	lines = append(lines, "Slash Commands")
	lines = append(lines, "- /launch <app|group|role>")
	lines = append(lines, "- /stop <app|group|role>")
	lines = append(lines, "- /restart <app|group|role>")
	lines = append(lines, "- /logs export <pane|app|group|page|all>")
	lines = append(lines, "- /page <next|prev|number>")
	lines = append(lines, "- /pane color <pane> <color>")
	lines = append(lines, "- /pin <pane>")
	lines = append(lines, "- /unpin <pane>")
	lines = append(lines, "- /theme <light|dark|auto>")
	lines = append(lines, "- /help")
	lines = append(lines, "- /daemon status")
	lines = append(lines, "- /daemon repair")
	lines = append(lines, "- /thread list")
	lines = append(lines, "- /thread new [title]")
	lines = append(lines, "- /thread switch <id|number>")
	lines = append(lines, "- /thread rename <title>")
	lines = append(lines, "- /thread clear")
	lines = append(lines, "- /thread export <json|markdown>")
	lines = append(lines, "- /thread preview")
	lines = append(lines, "- /add app")
	lines = append(lines, "- /add app <path> using <command>")
	lines = append(lines, "- /register <manifest-path>")
	lines = append(lines, "- /configure current folder --dry-run")
	lines = append(lines, "- /configure <path>")
	lines = append(lines, "- /open <path-or-app>")
	lines = append(lines, "- /prove <app>")
	lines = append(lines, "- /health <app> --prove")
	lines = append(lines, "- /repair <app-or-path>")
	lines = append(lines, "- /manifest inspect <app-or-path>")
	lines = append(lines, "- /manifest edit <field> <value>")
	lines = append(lines, "- /health route <app> <route>")
	lines = append(lines, "- /port pinned <app> <port>")
	lines = append(lines, "- /component role <app> <role>")
	lines = append(lines, "- /component group <app> <groupId>")
	lines = append(lines, "- /component label <app> <label>")
	return strings.Join(lines, "\n")
}

func statusLine(pane panes.PaneSnapshot) string {
	parts := []string{"status " + pane.Status}
	if pane.Focused {
		parts = append(parts, "focused")
	} else if pane.Selected {
		parts = append(parts, "selected")
	}
	if pane.Follow {
		parts = append(parts, "follow on")
	} else {
		parts = append(parts, "follow off")
	}
	if pane.Pinned {
		parts = append(parts, "pinned")
	}
	if pane.NextBefore != "" {
		parts = append(parts, "older available")
	} else if pane.HasMore {
		parts = append(parts, "older unavailable")
	}
	if pane.ScrollOffset > 0 {
		parts = append(parts, fmt.Sprintf("scroll +%d", pane.ScrollOffset))
	}
	return strings.Join(parts, " | ")
}

func pidPortLine(pane panes.PaneSnapshot) string {
	parts := []string{}
	if pane.PID > 0 {
		parts = append(parts, fmt.Sprintf("pid %d", pane.PID))
	}
	if pane.Port > 0 {
		parts = append(parts, fmt.Sprintf("port %d", pane.Port))
	}
	return strings.Join(parts, " | ")
}

func truncateText(value string, width int) string {
	if width <= 0 {
		return ""
	}
	value = cleanInlineText(value)
	runes := []rune(value)
	if len(runes) <= width {
		return value
	}
	if width == 1 {
		return string(runes[:1])
	}
	return string(runes[:width-1]) + "."
}

func cleanInlineText(value string) string {
	value = ansiEscapePattern.ReplaceAllString(value, "")
	value = oneLineText(value)
	return strings.Map(func(char rune) rune {
		if char < 32 && char != '\t' {
			return ' '
		}
		return char
	}, value)
}

func valueOr(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampInt(value int, minimum int, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
