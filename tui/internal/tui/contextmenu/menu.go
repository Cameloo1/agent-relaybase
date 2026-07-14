package contextmenu

import "github.com/cameloo/relaybase/tui/internal/tui/panes"

const (
	ContextPane      = "pane"
	ContextAssistant = "assistant"

	ActionPaneClose       = "pane.close"
	ActionPanePinToggle   = "pane.pin_toggle"
	ActionPaneReopen      = "pane.reopen"
	ActionPaneColor       = "pane.color"
	ActionPaneCopyRoute   = "pane.copy_route"
	ActionPaneExportLogs  = "pane.export_logs"
	ActionPaneStop        = "pane.stop"
	ActionPaneRestart     = "pane.restart"
	ActionPaneDiagnostics = "pane.diagnostics"

	ActionAssistantHistory     = "assistant.history"
	ActionAssistantNewThread   = "assistant.new_thread"
	ActionAssistantClearInput  = "assistant.clear_input"
	ActionAssistantBarColor    = "assistant.bar_color"
	ActionAssistantExportChat  = "assistant.export_chat"
	ActionAssistantCommandHelp = "assistant.command_help"
	ActionAssistantLLMMode     = "assistant.llm_mode"
)

type Item struct {
	Label          string
	Action         string
	Enabled        bool
	DisabledReason string
}

type Menu struct {
	Title    string
	Context  string
	Items    []Item
	Selected int
}

type PaneMenuOptions struct {
	CanReopen        bool
	DaemonStateKnown bool
	DaemonConnected  bool
}

type AssistantMenuOptions struct {
	CanExportChat        bool
	ExportDisabledReason string
}

func PaneMenu(pane *panes.PaneSnapshot, options ...PaneMenuOptions) Menu {
	opts := PaneMenuOptions{}
	if len(options) > 0 {
		opts = options[0]
	}
	daemonConnected := true
	if opts.DaemonStateKnown {
		daemonConnected = opts.DaemonConnected
	}
	hasPane := pane != nil && pane.ID != ""
	hasRoute := hasPane && pane.RouteLabel != ""
	pinnedLabel := "Pin pane"
	if hasPane && pane.Pinned {
		pinnedLabel = "Unpin pane"
	}
	return Menu{
		Title:   "Pane Menu",
		Context: ContextPane,
		Items: []Item{
			{Label: "Restart app/component", Action: ActionPaneRestart, Enabled: hasPane && daemonConnected, DisabledReason: reasonDaemonAction(hasPane, daemonConnected)},
			{Label: "Stop app/component", Action: ActionPaneStop, Enabled: hasPane && daemonConnected, DisabledReason: reasonDaemonAction(hasPane, daemonConnected)},
			{Label: "Close pane", Action: ActionPaneClose, Enabled: hasPane, DisabledReason: reasonNoSelectedPane(hasPane)},
			{Label: "Reopen pane…", Action: ActionPaneReopen, Enabled: opts.CanReopen, DisabledReason: reasonNoReopenCandidate(opts.CanReopen)},
			{Label: pinnedLabel, Action: ActionPanePinToggle, Enabled: hasPane, DisabledReason: reasonNoSelectedPane(hasPane)},
			{Label: "Show route", Action: ActionPaneCopyRoute, Enabled: hasRoute, DisabledReason: reasonNoRoute(hasPane, hasRoute)},
			{Label: "Export pane logs", Action: ActionPaneExportLogs, Enabled: hasPane && daemonConnected, DisabledReason: reasonDaemonAction(hasPane, daemonConnected)},
			{Label: "Change pane color", Action: ActionPaneColor, Enabled: hasPane, DisabledReason: reasonNoSelectedPane(hasPane)},
			{Label: "Show diagnostics", Action: ActionPaneDiagnostics, Enabled: true},
		},
	}
}

func AssistantMenu(options ...AssistantMenuOptions) Menu {
	opts := AssistantMenuOptions{
		ExportDisabledReason: "no daemon-backed active thread",
	}
	if len(options) > 0 {
		opts = options[0]
	}
	if opts.CanExportChat {
		opts.ExportDisabledReason = ""
	}
	return Menu{
		Title:   "Assistant Menu",
		Context: ContextAssistant,
		Items: []Item{
			{Label: "Expand history", Action: ActionAssistantHistory, Enabled: true},
			{Label: "New thread", Action: ActionAssistantNewThread, Enabled: true},
			{Label: "Clear current input", Action: ActionAssistantClearInput, Enabled: true},
			{Label: "Change bar color", Action: ActionAssistantBarColor, Enabled: true},
			{Label: "Export chat", Action: ActionAssistantExportChat, Enabled: opts.CanExportChat, DisabledReason: opts.ExportDisabledReason},
			{Label: "Show command help", Action: ActionAssistantCommandHelp, Enabled: true},
			{Label: "LLM mode status", Action: ActionAssistantLLMMode, Enabled: true},
		},
	}
}

func (m Menu) IsOpen() bool {
	return len(m.Items) > 0
}

func (m Menu) SelectedItem() *Item {
	if len(m.Items) == 0 {
		return nil
	}
	selected := clamp(m.Selected, 0, len(m.Items)-1)
	return &m.Items[selected]
}

func (m *Menu) Move(delta int) {
	if len(m.Items) == 0 {
		m.Selected = 0
		return
	}
	m.Selected = clamp(m.Selected+delta, 0, len(m.Items)-1)
}

func (m Menu) Snapshot() Snapshot {
	items := make([]Item, len(m.Items))
	copy(items, m.Items)
	return Snapshot{
		Title:    m.Title,
		Context:  m.Context,
		Items:    items,
		Selected: clamp(m.Selected, 0, maxInt(0, len(m.Items)-1)),
	}
}

type Snapshot struct {
	Title    string
	Context  string
	Items    []Item
	Selected int
}

func clamp(value int, low int, high int) int {
	if high < low {
		return low
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func reasonNoSelectedPane(enabled bool) string {
	if enabled {
		return ""
	}
	return "no selected pane"
}

func reasonNoReopenCandidate(enabled bool) string {
	if enabled {
		return ""
	}
	return "no hidden or stopped pane is available"
}

func reasonNoRoute(hasPane bool, hasRoute bool) string {
	if hasRoute {
		return ""
	}
	if !hasPane {
		return "no selected pane"
	}
	return "selected pane has no route"
}

func reasonDaemonAction(hasPane bool, daemonConnected bool) string {
	if !hasPane {
		return "no selected pane"
	}
	if !daemonConnected {
		return "daemon is offline"
	}
	return ""
}
