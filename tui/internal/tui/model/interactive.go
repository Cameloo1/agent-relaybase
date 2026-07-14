package model

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/response"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func (m *RootModel) openHelp() tea.Cmd {
	m.interaction.OpenTransient(interaction.TransientHelp)
	m.helpVisible = true
	m.helpSelected = 0
	m.helpDetailOffset = 0
	m.helpSearch.SetValue("")
	m.helpMatches = slash.SearchCatalog("")
	m.resetBodyScroll()
	// Focus ownership is stateful; cursor blinking is optional and must not make
	// opening local help look like an executable command to the supervisor.
	_ = m.helpSearch.Focus()
	return nil
}

func (m *RootModel) closeHelp() {
	m.interaction.CloseTransient()
	m.helpVisible = false
	m.helpSelected = 0
	m.helpDetailOffset = 0
	m.helpSearch.Blur()
	m.resetBodyScroll()
}

func (m *RootModel) syncHelpMatches() {
	selectedKind := ""
	if descriptor, ok := m.selectedHelpDescriptor(); ok {
		selectedKind = descriptor.Kind
	}
	m.helpMatches = slash.SearchCatalog(m.helpSearch.Value())
	m.helpSelected = 0
	if selectedKind != "" {
		for index, match := range m.helpMatches {
			if match.Descriptor.Kind == selectedKind {
				m.helpSelected = index
				break
			}
		}
	}
	m.clampHelpSelection()
	m.helpDetailOffset = 0
}

func (m *RootModel) clampHelpSelection() {
	if len(m.helpMatches) == 0 {
		m.helpSelected = -1
		return
	}
	if m.helpSelected < 0 {
		m.helpSelected = 0
	}
	if m.helpSelected >= len(m.helpMatches) {
		m.helpSelected = len(m.helpMatches) - 1
	}
}

func (m *RootModel) moveHelpSelection(delta int) {
	if len(m.helpMatches) == 0 {
		return
	}
	m.helpSelected += delta
	m.clampHelpSelection()
	m.helpDetailOffset = 0
}

func (m *RootModel) scrollHelpDetail(delta int) {
	// The Bubbles viewport owns its exact wrapped content limit. Keeping only a
	// non-negative requested offset lets narrow/wrapped help details reach their
	// final line without duplicating viewport wrap calculations in the model.
	m.helpDetailOffset = maxInt(0, m.helpDetailOffset+delta)
}

func (m RootModel) selectedHelpDescriptor() (slash.CommandDescriptor, bool) {
	if m.helpSelected < 0 || m.helpSelected >= len(m.helpMatches) {
		return slash.CommandDescriptor{}, false
	}
	return m.helpMatches[m.helpSelected].Descriptor, true
}

func (m RootModel) handleHelpKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	if keymap.Matches(msg, m.keymap.Escape) || keymap.Matches(msg, m.keymap.Help) {
		m.closeHelp()
		return m, nil
	}
	if msg.String() == "ctrl+up" {
		m.scrollHelpDetail(-3)
		return m, nil
	}
	if msg.String() == "ctrl+down" {
		m.scrollHelpDetail(3)
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Up) {
		m.moveHelpSelection(-1)
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Down) {
		m.moveHelpSelection(1)
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.PageUp) {
		m.moveHelpSelection(-5)
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.PageDown) {
		m.moveHelpSelection(5)
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Home) {
		m.helpSelected = 0
		m.clampHelpSelection()
		m.helpDetailOffset = 0
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.End) {
		m.helpSelected = len(m.helpMatches) - 1
		m.clampHelpSelection()
		m.helpDetailOffset = 0
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Enter) {
		if descriptor, ok := m.selectedHelpDescriptor(); ok {
			m.closeHelp()
			m.commandInput = descriptor.Insertion
			m.setPrimaryFocus(interaction.FocusComposer)
			m.syncCommandPalette()
			m.refreshAssistantPrompt()
		}
		return m, nil
	}
	if msg.String() == "ctrl+u" {
		m.helpSearch.SetValue("")
		m.syncHelpMatches()
		return m, nil
	}
	before := m.helpSearch.Value()
	updated, cmd := m.helpSearch.Update(msg)
	m.helpSearch = updated
	if m.helpSearch.Value() != before {
		m.syncHelpMatches()
	}
	return m, cmd
}

func (m *RootModel) syncCommandPalette() {
	if query, ok := startCompletionQuery(m.commandInput); ok {
		m.commandPalette.SetQueryAndReset("")
		m.startCompletion.SetQueryAndReset(query, m.appInventory.Items())
		return
	}
	m.startCompletion.Clear()
	if !strings.HasPrefix(strings.TrimSpace(m.commandInput), "/") {
		m.commandPalette.SetQueryAndReset("")
		return
	}
	m.commandPalette.SetQueryAndReset(m.commandInput)
}

func (m *RootModel) refreshStartCompletion() {
	query, ok := startCompletionQuery(m.commandInput)
	if !ok {
		m.startCompletion.Clear()
		return
	}
	m.startCompletion.SetQuery(query, m.appInventory.Items())
}

func startCompletionQuery(input string) (string, bool) {
	if strings.Contains(input, "\n") {
		return "", false
	}
	trimmed := strings.TrimLeft(input, " \t")
	const command = "/start"
	if len(trimmed) < len(command) || !strings.EqualFold(trimmed[:len(command)], command) {
		return "", false
	}
	if len(trimmed) == len(command) {
		return "", true
	}
	if trimmed[len(command)] != ' ' && trimmed[len(command)] != '\t' {
		return "", false
	}
	return strings.TrimSpace(trimmed[len(command)+1:]), true
}

func (m RootModel) startCompletionVisible() bool {
	_, isStart := startCompletionQuery(m.commandInput)
	return isStart && m.commandActive &&
		!m.appListVisible && !m.paneReopenVisible && !m.helpVisible && !m.contextMenu.IsOpen() &&
		m.pendingConfirm == nil && m.pendingAgentApproval == nil && !m.usage.IsOpen() &&
		!m.threadSwitcherVisible && !m.codePickerVisible
}

func (m *RootModel) completeStartApp() {
	completion, ok := m.startCompletion.Accept()
	if !ok {
		return
	}
	m.commandInput = completion
	m.composer.SetValue(completion)
	m.setPrimaryFocus(interaction.FocusComposer)
	m.syncCommandPalette()
	m.refreshAssistantPrompt()
}

func (m RootModel) shouldCompleteStartOnEnter() bool {
	query, ok := startCompletionQuery(m.commandInput)
	if !ok || strings.TrimSpace(query) == "" || m.startCompletion.Count() == 0 {
		return false
	}
	_, err := m.appInventory.ResolveApp(query)
	return err != nil
}

func (m RootModel) commandPaletteVisible() bool {
	return m.commandActive && strings.HasPrefix(strings.TrimSpace(m.commandInput), "/") &&
		!strings.Contains(m.commandInput, "\n") &&
		!m.startCompletionVisible() &&
		!m.appListVisible && !m.paneReopenVisible && !m.helpVisible && !m.contextMenu.IsOpen() && m.pendingConfirm == nil && m.pendingAgentApproval == nil
}

func (m *RootModel) openAppList() tea.Cmd {
	m.interaction.OpenTransient(interaction.TransientAppList)
	m.appListVisible = true
	m.appListNotice = ""
	m.appListRefreshing = m.connectionStatus == "connected"
	m.followAppListSelection()
	if m.connectionStatus == "connected" {
		return commands.FetchStateCmd(m.ctx, m.client)
	}
	return nil
}

func (m *RootModel) closeAppList() {
	if !m.appListVisible {
		return
	}
	m.appListVisible = false
	m.appListRefreshing = false
	m.appListNotice = ""
	m.appListOffset = 0
	m.appListPaneRefreshID = ""
	m.interaction.CloseTransient()
}

func (m RootModel) handleAppListKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		m.closeAppList()
		return m, nil
	case keymap.Matches(msg, m.keymap.Up):
		m.appInventory.Move(-1)
	case keymap.Matches(msg, m.keymap.Down):
		m.appInventory.Move(1)
	case keymap.Matches(msg, m.keymap.PageUp):
		m.appInventory.Move(-m.appListPageSize())
	case keymap.Matches(msg, m.keymap.PageDown):
		m.appInventory.Move(m.appListPageSize())
	case keymap.Matches(msg, m.keymap.Home):
		m.appInventory.SelectIndex(0)
	case keymap.Matches(msg, m.keymap.End):
		m.appInventory.SelectIndex(m.appInventory.Count() - 1)
	case keymap.Matches(msg, m.keymap.Enter):
		return m.reviewSelectedAppListStart()
	default:
		return m, nil
	}
	m.appListNotice = ""
	m.followAppListSelection()
	return m, nil
}

func (m RootModel) reviewSelectedAppListStart() (RootModel, tea.Cmd) {
	if m.connectionStatus != "connected" {
		m.appListNotice = "Start is unavailable until the Relaybase daemon is connected; use /daemon repair if it remains offline."
		return m, nil
	}
	item := m.appInventory.Selected()
	if item == nil {
		m.appListNotice = "No registered app is selected."
		return m, nil
	}
	status := strings.ToLower(strings.TrimSpace(item.Status))
	switch status {
	case "running":
		return m.openRunningAppPane(item.ID)
	case "starting", "stopping":
		m.appListNotice = "App " + item.ID + " is " + valueOr(item.Status, status) + "; wait for the daemon transition to finish."
		return m, nil
	}
	if !item.CanStart() {
		m.appListNotice = registeredAppUnavailableMessage(*item)
		return m, nil
	}
	m.appListNotice = ""
	cmd := m.requestSelectedInventoryStart()
	if m.pendingConfirm != nil {
		m.interaction.OpenModal(interaction.ModalConfirmation)
	}
	return m, cmd
}

func registeredAppUnavailableMessage(item inventory.Item) string {
	status := strings.ToLower(strings.TrimSpace(item.Status))
	switch status {
	case "running":
		return "App " + item.ID + " is already running; Enter opens its monitoring pane."
	case "starting", "stopping":
		return "App " + item.ID + " is " + item.Status + "; wait for the daemon transition to finish."
	case "failed", "degraded":
		return "App " + item.ID + " is " + item.Status + "; use /restart " + item.ID + " to review a daemon restart request."
	default:
		return "App " + item.ID + " cannot be started from its current " + valueOr(item.Status, "unknown") + " state."
	}
}

func (m RootModel) openRunningAppPane(appID string) (RootModel, tea.Cmd) {
	paneIDs := m.paneManager.PaneIDsForApp(appID)
	switch len(paneIDs) {
	case 0:
		if !m.appListVisible {
			m.interaction.OpenTransient(interaction.TransientAppList)
			m.appListVisible = true
			m.appListOffset = 0
		}
		m.appInventory.SelectID(appID)
		m.followAppListSelection()
		m.appListPaneRefreshID = appID
		m.appListRefreshing = true
		m.appListNotice = "Refreshing daemon state for the running app's monitoring pane."
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case 1:
		paneID := paneIDs[0]
		if !m.paneManager.ReopenPane(paneID) {
			m.appListNotice = "The monitoring pane is no longer available; refresh the app list and try again."
			return m, nil
		}
		m.paneManager.FocusSelected()
		m.closeAppList()
		m.addAssistantMessage("Opened monitoring pane for " + appID + ".")
		return m, m.persistPreferencesCmd()
	default:
		m.closeAppList()
		if m.openPaneReopen(appID) {
			return m, nil
		}
		m.addAssistantMessage("No monitoring pane is currently available for " + appID + ".")
		return m, nil
	}
}

func (m RootModel) paneReopenCandidates() []panes.ReopenCandidate {
	if m.paneReopenAppID == "" {
		return m.paneManager.ReopenCandidates()
	}
	result := []panes.ReopenCandidate{}
	for _, paneID := range m.paneManager.PaneIDsForApp(m.paneReopenAppID) {
		snapshot := m.paneManager.PaneSnapshot(paneID)
		if snapshot == nil {
			continue
		}
		result = append(result, panes.ReopenCandidate{
			PaneID:      snapshot.ID,
			AppID:       snapshot.AppID,
			DisplayName: snapshot.DisplayName,
			PaneLabel:   snapshot.PaneLabel,
			Status:      snapshot.Status,
		})
	}
	return result
}

func (m *RootModel) openPaneReopen(appID string) bool {
	m.paneReopenAppID = strings.TrimSpace(appID)
	m.paneReopenSelected = 0
	m.paneReopenSelectedID = ""
	m.paneReopenOffset = 0
	m.paneReopenNotice = ""
	if len(m.paneReopenCandidates()) == 0 {
		m.paneReopenAppID = ""
		return false
	}
	m.paneReopenVisible = true
	m.interaction.OpenTransient(interaction.TransientPaneReopen)
	m.followPaneReopenSelection()
	return true
}

func (m *RootModel) closePaneReopen() {
	if !m.paneReopenVisible {
		return
	}
	m.paneReopenVisible = false
	m.paneReopenSelected = 0
	m.paneReopenSelectedID = ""
	m.paneReopenOffset = 0
	m.paneReopenAppID = ""
	m.paneReopenNotice = ""
	m.interaction.CloseTransient()
}

func (m RootModel) appListPageSize() int {
	metrics := m.operatorMetrics()
	if metrics.ResizeRequired {
		return 1
	}
	innerHeight := maxInt(1, metrics.Modal.Height-m.styles.Help.GetVerticalFrameSize())
	return maxInt(1, innerHeight-7)
}

func (m *RootModel) followAppListSelection() {
	rows := m.appListPageSize()
	selected := m.appInventory.SelectedIndex()
	if selected < m.appListOffset {
		m.appListOffset = selected
	} else if selected >= m.appListOffset+rows {
		m.appListOffset = selected - rows + 1
	}
	m.clampAppListOffset()
}

func (m *RootModel) clampAppListOffset() {
	maxOffset := maxInt(0, m.appInventory.Count()-m.appListPageSize())
	m.appListOffset = minInt(maxInt(0, m.appListOffset), maxOffset)
}

func (m RootModel) appListDataForView() *views.RegisteredAppsData {
	if !m.appListVisible {
		return nil
	}
	items := m.appInventory.Items()
	return &views.RegisteredAppsData{
		Items:            items,
		Selected:         m.appInventory.SelectedIndex(),
		Offset:           minInt(maxInt(0, m.appListOffset), maxInt(0, len(items)-m.appListPageSize())),
		ConnectionStatus: m.connectionStatus,
		StateKnown:       m.state != nil,
		Refreshing:       m.appListRefreshing,
		Notice:           m.appListNotice,
	}
}

func (m RootModel) handlePaneReopenKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	candidates := m.paneReopenCandidates()
	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		m.closePaneReopen()
		return m, nil
	case keymap.Matches(msg, m.keymap.Up):
		m.paneReopenSelected--
	case keymap.Matches(msg, m.keymap.Down):
		m.paneReopenSelected++
	case keymap.Matches(msg, m.keymap.PageUp):
		m.paneReopenSelected -= m.paneReopenPageSize()
	case keymap.Matches(msg, m.keymap.PageDown):
		m.paneReopenSelected += m.paneReopenPageSize()
	case keymap.Matches(msg, m.keymap.Home):
		m.paneReopenSelected = 0
	case keymap.Matches(msg, m.keymap.End):
		m.paneReopenSelected = len(candidates) - 1
	case keymap.Matches(msg, m.keymap.Enter):
		if len(candidates) == 0 {
			m.closePaneReopen()
			m.addAssistantMessage("No hidden pane is currently available to reopen.")
			return m, nil
		}
		m.clampPaneReopenSelection()
		candidate := candidates[m.paneReopenSelected]
		if !m.paneManager.ReopenPane(candidate.PaneID) {
			m.paneReopenNotice = "That pane is no longer available; choose another pane."
			m.clampPaneReopenSelection()
			return m, nil
		}
		m.paneManager.FocusSelected()
		m.closePaneReopen()
		m.addAssistantMessage("Opened " + valueOr(candidate.DisplayName, candidate.AppID) + " monitoring pane.")
		return m, m.persistPreferencesCmd()
	default:
		return m, nil
	}
	m.paneReopenSelectedID = ""
	m.paneReopenNotice = ""
	m.clampPaneReopenSelection()
	m.followPaneReopenSelection()
	return m, nil
}

func (m RootModel) paneReopenPageSize() int {
	return m.appListPageSize()
}

func (m *RootModel) clampPaneReopenSelection() {
	candidates := m.paneReopenCandidates()
	count := len(candidates)
	if count == 0 {
		m.paneReopenSelected = 0
		m.paneReopenSelectedID = ""
		m.paneReopenOffset = 0
		return
	}
	if m.paneReopenSelectedID != "" {
		for index, candidate := range candidates {
			if candidate.PaneID == m.paneReopenSelectedID {
				m.paneReopenSelected = index
				break
			}
		}
	}
	m.paneReopenSelected = minInt(maxInt(0, m.paneReopenSelected), count-1)
	m.paneReopenSelectedID = candidates[m.paneReopenSelected].PaneID
}

func (m *RootModel) followPaneReopenSelection() {
	m.clampPaneReopenSelection()
	rows := m.paneReopenPageSize()
	if m.paneReopenSelected < m.paneReopenOffset {
		m.paneReopenOffset = m.paneReopenSelected
	} else if m.paneReopenSelected >= m.paneReopenOffset+rows {
		m.paneReopenOffset = m.paneReopenSelected - rows + 1
	}
	maxOffset := maxInt(0, len(m.paneReopenCandidates())-rows)
	m.paneReopenOffset = minInt(maxInt(0, m.paneReopenOffset), maxOffset)
}

func (m RootModel) paneReopenDataForView() *views.PaneReopenData {
	if !m.paneReopenVisible {
		return nil
	}
	candidates := m.paneReopenCandidates()
	items := make([]views.PaneReopenItem, 0, len(candidates))
	for _, candidate := range candidates {
		registered, _ := m.appInventory.ItemByID(candidate.AppID)
		name := valueOr(candidate.DisplayName, valueOr(registered.Name, candidate.AppID))
		if label := strings.TrimSpace(candidate.PaneLabel); label != "" && !strings.EqualFold(label, name) {
			name += " / " + label
		}
		items = append(items, views.PaneReopenItem{
			PaneID:     candidate.PaneID,
			Name:       name,
			Project:    registered.Directory,
			Status:     candidate.Status,
			UserClosed: candidate.UserClosed,
		})
	}
	return &views.PaneReopenData{
		Items:    items,
		Selected: m.paneReopenSelected,
		Offset:   m.paneReopenOffset,
		Notice:   m.paneReopenNotice,
		AppID:    m.paneReopenAppID,
	}
}

func (m *RootModel) completeCommandPalette() bool {
	insertion, ok := m.commandPalette.Accept()
	if !ok {
		return false
	}
	m.commandInput = insertion
	m.setPrimaryFocus(interaction.FocusComposer)
	m.syncCommandPalette()
	m.refreshAssistantPrompt()
	return true
}

func (m RootModel) shouldCompleteCommandOnEnter() bool {
	if !m.commandPaletteVisible() {
		return false
	}
	if _, err := slash.Parse(m.commandInput); err == nil {
		return false
	}
	descriptor, ok := m.commandPalette.Selected()
	if !ok {
		return false
	}
	inputTokens := strings.Fields(strings.TrimPrefix(strings.TrimSpace(m.commandInput), "/"))
	canonicalTokens := strings.Fields(strings.TrimPrefix(descriptor.Canonical, "/"))
	return len(inputTokens) <= len(canonicalTokens)
}

func commandPaletteRows(height int) int {
	if height < 12 {
		return 1
	}
	if height < 16 {
		return 3
	}
	return 5
}

func (m RootModel) helpDataForView() *views.HelpData {
	if !m.helpVisible {
		return nil
	}
	return &views.HelpData{
		SearchView:   m.helpSearch.View(),
		Query:        m.helpSearch.Value(),
		Matches:      append([]slash.CommandMatch(nil), m.helpMatches...),
		Selected:     m.helpSelected,
		DetailOffset: m.helpDetailOffset,
	}
}

func (m RootModel) commandPaletteDataForView() *views.CommandPaletteData {
	if !m.commandPaletteVisible() {
		return nil
	}
	return &views.CommandPaletteData{
		Matches:         m.commandPalette.Visible(),
		SelectedVisible: m.commandPalette.SelectedVisibleIndex(),
		Total:           m.commandPalette.Count(),
	}
}

func (m RootModel) startCompletionDataForView() *views.StartCompletionData {
	if !m.startCompletionVisible() {
		return nil
	}
	return &views.StartCompletionData{
		Items:           m.startCompletion.Visible(),
		SelectedVisible: m.startCompletion.SelectedVisibleIndex(),
		Total:           m.startCompletion.Count(),
		Query:           m.startCompletion.Query(),
	}
}

func (m *RootModel) scrollPaneByWheel(paneID string, button tea.MouseButton) tea.Cmd {
	delta := 0
	switch button {
	case tea.MouseWheelUp:
		delta = 3
	case tea.MouseWheelDown:
		delta = -3
	default:
		return nil
	}
	if !m.paneManager.ScrollPane(paneID, delta) || delta < 0 {
		return nil
	}
	if !m.paneManager.IsPaneAtOldestLogBoundary(paneID) {
		return nil
	}
	target := m.paneManager.OlderLogTargetForPane(paneID)
	if target == nil || m.logFetchPending[paneID] == target.Before {
		return nil
	}
	m.logFetchPending[paneID] = target.Before
	return commands.FetchLogsCmd(m.ctx, m.client, *target)
}

func (m *RootModel) scrollResponse(delta int) {
	data := m.shellData()
	current := data.ResponseOffset
	maximum := views.ResponseScrollMax(m.styles, data)
	m.responseOffset = minInt(maxInt(0, current+delta), maximum)
	m.responseFollow = m.responseOffset >= maximum
	if m.responseFollow {
		m.responseNewOutput = 0
	}
}

func (m *RootModel) gotoResponseTop() {
	m.responseOffset = 0
	m.responseFollow = false
}

func (m *RootModel) gotoResponseBottom() {
	data := m.shellData()
	m.responseOffset = views.ResponseBottomOffset(m.styles, data)
	m.responseFollow = true
	m.responseNewOutput = 0
}

func (m RootModel) toggleAgentSurface() (RootModel, tea.Cmd) {
	metrics := m.operatorMetrics()
	if metrics.AgentDockable {
		if metrics.AgentDocked {
			m.preferences.Layout.AgentPaneCollapsed = true
			if m.interaction.Focus == interaction.FocusResponse {
				m.restoreAgentPreviousFocus()
			}
		} else {
			m.preferences.Layout.AgentPaneCollapsed = false
			m.setPrimaryFocus(interaction.FocusResponse)
		}
		m.syncOperatorLayout()
		m.clampBodyScroll()
		return m, m.persistPreferencesCmd()
	}
	if m.responseDetailsVisible() {
		m.interaction.CloseTransient()
		return m, nil
	}
	if m.interaction.Transient == interaction.TransientNone && m.interaction.Modal == interaction.ModalNone {
		m.interaction.OpenTransient(interaction.TransientResponseDetails)
	}
	return m, nil
}

func (m RootModel) handleAgentSurfaceKey(msg tea.KeyPressMsg, modal bool) (RootModel, tea.Cmd) {
	if keymap.Matches(msg, m.keymap.Quit) {
		if strings.TrimSpace(m.commandInput) != "" {
			if modal {
				m.interaction.CloseTransient()
			}
			m.quitConfirmation = true
			m.interaction.OpenModal(interaction.ModalQuitConfirmation)
			m.refreshAssistantPrompt()
			return m, nil
		}
		m.close()
		return m, tea.Quit
	}
	if keymap.Matches(msg, m.keymap.Help) {
		if modal {
			m.interaction.CloseTransient()
		}
		cmd := m.openHelp()
		m.diagnosticsExpanded = false
		return m, cmd
	}
	if keymap.Matches(msg, m.keymap.Diagnostics) {
		if modal {
			m.interaction.CloseTransient()
		}
		m.toggleDiagnostics()
		return m, nil
	}
	if msg.Text == "b" || msg.Keystroke() == "b" {
		if modal {
			m.interaction.CloseTransient()
		}
		return m.openCodePicker()
	}
	if isCopyShortcut(msg) || keymap.Matches(msg, m.keymap.CopyLogs) {
		payload := response.SanitizeTerminalText(strings.Join(m.assistantHistoryForView(), "\n\n"))
		if strings.TrimSpace(payload) == "" {
			m.addDiagnostic("response_copy_empty", "info", "There is no Agent response to copy.")
			return m, nil
		}
		return m, writeClipboardCmd(payload)
	}
	switch {
	case keymap.Matches(msg, m.keymap.Up):
		m.scrollResponse(-1)
	case keymap.Matches(msg, m.keymap.Down):
		m.scrollResponse(1)
	case keymap.Matches(msg, m.keymap.PageUp):
		m.scrollResponse(-maxInt(1, m.height/4))
	case keymap.Matches(msg, m.keymap.PageDown):
		m.scrollResponse(maxInt(1, m.height/4))
	case keymap.Matches(msg, m.keymap.Home):
		m.gotoResponseTop()
	case keymap.Matches(msg, m.keymap.End), keymap.Matches(msg, m.keymap.Follow):
		m.gotoResponseBottom()
	case keymap.Matches(msg, m.keymap.Escape):
		if modal {
			m.interaction.CloseTransient()
		} else {
			m.restoreAgentPreviousFocus()
		}
	default:
		if !modal {
			if updated, ok := m.startCommandInput(msg); ok {
				return updated, nil
			}
		}
	}
	return m, nil
}

func (m *RootModel) copyPaneLogsCmd(paneID string) tea.Cmd {
	if !m.clipboardWriteReady {
		m.addDiagnostic("clipboard_copy_unavailable", "info", "System clipboard writing is unavailable for pane logs.")
		return nil
	}
	payload, count := m.paneManager.Last20LogPayload(paneID)
	if count == 0 || payload == "" {
		m.addDiagnostic("clipboard_copy_empty", "info", "The selected pane has no retained log lines to copy.")
		return nil
	}
	title := paneID
	if pane := m.paneManager.PaneSnapshot(paneID); pane != nil && pane.Title != "" {
		title = pane.Title
	}
	return writePaneLogsClipboardCmd(payload, paneID, title, count)
}
