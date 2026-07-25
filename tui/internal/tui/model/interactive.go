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
		!m.appManagerVisible && !m.paneReopenVisible && len(m.registrationRepairs) == 0 && !m.helpVisible && !m.contextMenu.IsOpen() &&
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
		!m.appManagerVisible && !m.packageManagerVisible && !m.paneReopenVisible && len(m.registrationRepairs) == 0 && !m.helpVisible && !m.contextMenu.IsOpen() && m.pendingConfirm == nil && m.pendingAgentApproval == nil
}

func (m *RootModel) openAppManager(mode appManagerMode) tea.Cmd {
	m.interaction.OpenTransient(interaction.TransientAppManager)
	m.appManagerVisible = true
	m.appManagerMode = mode
	m.appManagerSurface = appManagerSurfaceTable
	m.appManagerSelectedActionID = ""
	m.appManagerActionOffset = 0
	m.appManagerPackageOffset = 0
	m.appManagerPendingPackageID = ""
	m.appManagerNotice = ""
	m.appManagerRefreshing = m.connectionStatus == "connected"
	m.followAppManagerSelection()
	if m.connectionStatus == "connected" {
		return tea.Batch(commands.FetchStateCmd(m.ctx, m.client), commands.ListAppPackagesCmd(m.ctx, m.client))
	}
	return nil
}

func (m *RootModel) closeAppManager() {
	if !m.appManagerVisible {
		return
	}
	m.appManagerVisible = false
	m.appManagerRefreshing = false
	m.appManagerNotice = ""
	m.appManagerOffset = 0
	m.appManagerActionOffset = 0
	m.appManagerSelectedActionID = ""
	m.appManagerPaneRefreshID = ""
	m.appManagerPendingAppID = ""
	m.appManagerPendingAction = ""
	m.appManagerRenameAppID = ""
	m.appManagerRenameCurrentName = ""
	m.appManagerRenameInput.SetValue("")
	m.appManagerRenameInput.Blur()
	m.appManagerPackageNameInput.SetValue("")
	m.appManagerPackageNameInput.Blur()
	m.appManagerPackageSelectedID = ""
	m.appManagerPackageOffset = 0
	m.appManagerPendingPackageID = ""
	m.interaction.CloseTransient()
}

func (m RootModel) handleAppManagerKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	if m.appManagerSurface == appManagerSurfacePackagePicker || m.appManagerSurface == appManagerSurfacePackageCreate {
		return m.handleAppPackagePickerKey(msg)
	}
	if m.appManagerSurface == appManagerSurfaceRename {
		switch {
		case keymap.Matches(msg, m.keymap.Escape):
			m.appManagerSurface = appManagerSurfaceActions
			m.appManagerRenameInput.Blur()
			m.appManagerNotice = "Rename draft preserved."
			return m, nil
		case keymap.Matches(msg, m.keymap.Enter):
			return m.previewAppRename()
		case isPasteShortcut(msg):
			return m, readClipboardCmd()
		default:
			before := m.appManagerRenameInput.Value()
			updated, cmd := m.appManagerRenameInput.Update(msg)
			m.appManagerRenameInput = updated
			if before != m.appManagerRenameInput.Value() {
				m.appManagerNotice = "Enter requests a daemon preview; the stable id remains unchanged."
			}
			return m, cmd
		}
	}
	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		if m.appManagerSurface == appManagerSurfaceActions {
			m.appManagerSurface = appManagerSurfaceTable
			m.appManagerActionOffset = 0
			m.appManagerNotice = ""
			m.followAppManagerSelection()
			return m, nil
		}
		m.closeAppManager()
		return m, nil
	case strings.EqualFold(msg.String(), "r"):
		if m.connectionStatus != "connected" {
			m.appManagerNotice = "Refresh is unavailable while the Relaybase daemon is offline; showing last known state."
			return m, nil
		}
		m.appManagerRefreshing = true
		m.appManagerNotice = "Refreshing daemon-backed app state."
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case keymap.Matches(msg, m.keymap.Up):
		m.moveAppManagerSelection(-1)
	case keymap.Matches(msg, m.keymap.Down):
		m.moveAppManagerSelection(1)
	case keymap.Matches(msg, m.keymap.PageUp):
		m.moveAppManagerSelection(-m.appManagerPageSize())
	case keymap.Matches(msg, m.keymap.PageDown):
		m.moveAppManagerSelection(m.appManagerPageSize())
	case keymap.Matches(msg, m.keymap.Home):
		m.selectAppManagerIndex(0)
	case keymap.Matches(msg, m.keymap.End):
		m.selectAppManagerIndex(m.appManagerItemCount() - 1)
	case keymap.Matches(msg, m.keymap.Enter):
		if m.appManagerSurface == appManagerSurfaceActions {
			return m.executeSelectedAppManagerAction()
		}
		if m.appManagerMode == appManagerModeStartPicker {
			return m.reviewSelectedAppManagerStart()
		}
		if m.appInventory.Selected() == nil {
			m.appManagerNotice = "No registered app is selected."
			return m, nil
		}
		m.appManagerSurface = appManagerSurfaceActions
		m.ensureAppManagerActionSelection()
		m.followAppManagerSelection()
		return m, nil
	default:
		return m, nil
	}
	m.appManagerNotice = ""
	m.followAppManagerSelection()
	return m, nil
}

func (m RootModel) updateAppRenamePaste(content string) (RootModel, tea.Cmd) {
	if strings.TrimSpace(content) == "" {
		m.appManagerNotice = "Clipboard does not contain a visible app name."
		return m, nil
	}
	if _, err := validateAppRenameName(content, nil, m.appManagerRenameAppID); err != nil {
		m.appManagerNotice = err.Error()
		return m, nil
	}
	updated, cmd := m.appManagerRenameInput.Update(tea.PasteMsg{Content: content})
	m.appManagerRenameInput = updated
	m.appManagerNotice = "Pasted app name. Enter requests a daemon preview."
	return m, cmd
}

func (m RootModel) reviewSelectedAppManagerStart() (RootModel, tea.Cmd) {
	if m.connectionStatus != "connected" {
		m.appManagerNotice = "Start is unavailable until the Relaybase daemon is connected; use /daemon repair if it remains offline."
		return m, nil
	}
	item := m.appInventory.Selected()
	if item == nil {
		m.appManagerNotice = "No registered app is selected."
		return m, nil
	}
	status := strings.ToLower(strings.TrimSpace(item.Status))
	switch status {
	case "running":
		return m.openRunningAppPane(item.ID)
	case "starting", "stopping":
		m.appManagerNotice = "App " + item.ID + " is " + valueOr(item.Status, status) + "; wait for the daemon transition to finish."
		return m, nil
	}
	if !item.CanStart() {
		m.appManagerNotice = registeredAppUnavailableMessage(*item)
		return m, nil
	}
	m.appManagerNotice = ""
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
		if !m.appManagerVisible {
			m.interaction.OpenTransient(interaction.TransientAppManager)
			m.appManagerVisible = true
			m.appManagerMode = appManagerModeManage
			m.appManagerSurface = appManagerSurfaceTable
			m.appManagerOffset = 0
		}
		m.appInventory.SelectID(appID)
		m.followAppManagerSelection()
		m.appManagerPaneRefreshID = appID
		m.appManagerRefreshing = true
		m.appManagerNotice = "Refreshing daemon state for the running app's monitoring pane."
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case 1:
		paneID := paneIDs[0]
		if !m.paneManager.ReopenPane(paneID) {
			m.appManagerNotice = "The monitoring pane is no longer available; refresh app management and try again."
			return m, nil
		}
		m.paneManager.FocusSelected()
		m.closeAppManager()
		m.addAssistantMessage("Opened monitoring pane for " + appID + ".")
		return m, batchCommands(m.persistPreferencesCmd(), m.scheduleAgentActivityTick())
	default:
		m.closeAppManager()
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

func (m RootModel) appManagerPageSize() int {
	metrics := m.operatorMetrics()
	if metrics.ResizeRequired {
		return 1
	}
	innerHeight := maxInt(1, metrics.Modal.Height-m.styles.Help.GetVerticalFrameSize())
	if m.appManagerSurface == appManagerSurfaceActions {
		return maxInt(1, innerHeight-13)
	}
	if m.appManagerSurface == appManagerSurfaceRename {
		return maxInt(1, innerHeight-8)
	}
	return maxInt(1, innerHeight-7)
}

func (m *RootModel) followAppManagerSelection() {
	if m.appManagerSurface == appManagerSurfacePackagePicker || m.appManagerSurface == appManagerSurfacePackageCreate {
		m.followAppPackagePickerSelection()
		return
	}
	rows := m.appManagerPageSize()
	if m.appManagerSurface == appManagerSurfaceActions {
		selected := m.selectedAppManagerActionIndex()
		if selected < m.appManagerActionOffset {
			m.appManagerActionOffset = selected
		} else if selected >= m.appManagerActionOffset+rows {
			m.appManagerActionOffset = selected - rows + 1
		}
		m.clampAppManagerOffset()
		return
	}
	selected := m.appInventory.SelectedIndex()
	if selected < m.appManagerOffset {
		m.appManagerOffset = selected
	} else if selected >= m.appManagerOffset+rows {
		m.appManagerOffset = selected - rows + 1
	}
	m.clampAppManagerOffset()
}

func (m *RootModel) clampAppManagerOffset() {
	if m.appManagerSurface == appManagerSurfacePackagePicker || m.appManagerSurface == appManagerSurfacePackageCreate {
		m.appManagerPackageOffset = minInt(maxInt(0, m.appManagerPackageOffset), maxInt(0, len(m.appPackages)-m.appManagerPageSize()))
		return
	}
	if m.appManagerSurface == appManagerSurfaceActions {
		maxOffset := maxInt(0, len(m.appManagerActions())-m.appManagerPageSize())
		m.appManagerActionOffset = minInt(maxInt(0, m.appManagerActionOffset), maxOffset)
		return
	}
	maxOffset := maxInt(0, m.appInventory.Count()-m.appManagerPageSize())
	m.appManagerOffset = minInt(maxInt(0, m.appManagerOffset), maxOffset)
}

func (m RootModel) appManagerDataForView() *views.AppManagerData {
	if !m.appManagerVisible {
		return nil
	}
	items := m.appInventory.Items()
	actions := m.appManagerActions()
	projectedActions := make([]views.AppManagerAction, 0, len(actions))
	for _, action := range actions {
		projectedActions = append(projectedActions, views.AppManagerAction{
			ID: string(action.ID), Label: action.Label, Enabled: action.Enabled, DisabledReason: action.DisabledReason,
		})
	}
	data := &views.AppManagerData{
		Items:            items,
		Selected:         m.appInventory.SelectedIndex(),
		Offset:           minInt(maxInt(0, m.appManagerOffset), maxInt(0, len(items)-m.appManagerPageSize())),
		Mode:             string(m.appManagerMode),
		Surface:          string(m.appManagerSurface),
		Actions:          projectedActions,
		SelectedAction:   m.selectedAppManagerActionIndex(),
		ActionOffset:     minInt(maxInt(0, m.appManagerActionOffset), maxInt(0, len(actions)-m.appManagerPageSize())),
		ConnectionStatus: m.connectionStatus,
		StateKnown:       m.state != nil,
		Refreshing:       m.appManagerRefreshing,
		Notice:           m.appManagerNotice,
		Rename: &views.AppManagerRenameData{
			StableID:    m.appManagerRenameAppID,
			CurrentName: m.appManagerRenameCurrentName,
			InputView:   m.appManagerRenameInput.View(),
			Draft:       m.appManagerRenameInput.Value(),
		},
	}
	if m.appManagerSurface == appManagerSurfacePackagePicker {
		picker := m.packageTableData(m.appManagerPendingAppID, true)
		data.PackagePicker = &picker
	}
	if m.appManagerSurface == appManagerSurfacePackageCreate {
		data.PackageNameInput = m.appManagerPackageNameInput.View()
	}
	return data
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
	return m, m.scheduleAgentActivityTick()
}

func (m RootModel) paneReopenPageSize() int {
	return m.appManagerPageSize()
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
	next := minInt(maxInt(0, current+delta), maximum)
	m.setCurrentResponseOffset(next)
	m.setCurrentResponseFollow(next >= maximum)
	if m.currentResponseFollow() {
		m.setCurrentResponseNewOutput(0)
	}
}

func (m *RootModel) gotoResponseTop() {
	m.setCurrentResponseOffset(0)
	m.setCurrentResponseFollow(false)
}

func (m *RootModel) gotoResponseBottom() {
	data := m.shellData()
	m.setCurrentResponseOffset(views.ResponseBottomOffset(m.styles, data))
	m.setCurrentResponseFollow(true)
	m.setCurrentResponseNewOutput(0)
}

func (m RootModel) currentResponseOffset() int {
	if m.agentChatFull {
		return m.agentFullResponseOffset
	}
	return m.responseOffset
}

func (m *RootModel) setCurrentResponseOffset(value int) {
	if m.agentChatFull {
		m.agentFullResponseOffset = value
	} else {
		m.responseOffset = value
	}
}

func (m RootModel) currentResponseFollow() bool {
	if m.agentChatFull {
		return m.agentFullResponseFollow
	}
	return m.responseFollow
}

func (m *RootModel) setCurrentResponseFollow(value bool) {
	if m.agentChatFull {
		m.agentFullResponseFollow = value
	} else {
		m.responseFollow = value
	}
}

func (m RootModel) currentResponseNewOutput() int {
	if m.agentChatFull {
		return m.agentFullResponseNewOutput
	}
	return m.responseNewOutput
}

func (m *RootModel) setCurrentResponseNewOutput(value int) {
	if m.agentChatFull {
		m.agentFullResponseNewOutput = value
	} else {
		m.responseNewOutput = value
	}
}

func (m RootModel) toggleAgentSurface() (RootModel, tea.Cmd) {
	if m.agentChatFull {
		return m.toggleAgentChat()
	}
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

func (m RootModel) toggleAgentChat() (RootModel, tea.Cmd) {
	if m.agentChatFull {
		m.agentChatFull = false
		if m.agentChatRestoreDetails {
			m.interaction.OpenTransient(interaction.TransientResponseDetails)
			m.agentChatRestoreDetails = false
		} else {
			m.restoreAgentPreviousFocus()
		}
		return m, nil
	}
	if m.interaction.Modal != interaction.ModalNone || (m.interaction.Transient != interaction.TransientNone && !m.responseDetailsVisible()) {
		return m, nil
	}
	m.agentPreviousFocus = valueOrFocus(m.interaction.Focus, interaction.FocusPanes)
	m.agentChatRestoreDetails = m.responseDetailsVisible()
	if m.agentChatRestoreDetails {
		m.interaction.CloseTransient()
	}
	m.agentChatFull = true
	m.setPrimaryFocus(interaction.FocusResponse)
	if m.agentFullResponseFollow {
		m.gotoResponseBottom()
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
	if msg.Keystroke() == "ctrl+e" {
		m.toggleAllAgentTranscriptItems()
		return m, nil
	}
	if isCopyShortcut(msg) || keymap.Matches(msg, m.keymap.CopyLogs) {
		payload := m.agentTranscriptCopyText()
		if strings.TrimSpace(payload) == "" {
			payload = response.SanitizeTerminalText(strings.Join(m.assistantHistoryForView(), "\n\n"))
		}
		if strings.TrimSpace(payload) == "" {
			m.addDiagnostic("response_copy_empty", "info", "There is no Agent response to copy.")
			return m, nil
		}
		return m, writeClipboardCmd(payload)
	}
	switch {
	case keymap.Matches(msg, m.keymap.Up):
		if !m.moveAgentTranscriptSelection(-1) {
			m.scrollResponse(-1)
		}
	case keymap.Matches(msg, m.keymap.Down):
		if !m.moveAgentTranscriptSelection(1) {
			m.scrollResponse(1)
		}
	case keymap.Matches(msg, m.keymap.Enter), msg.Code == tea.KeySpace:
		m.toggleAgentTranscriptItem(m.agentTranscriptSelected)
	case keymap.Matches(msg, m.keymap.PageUp):
		m.scrollResponse(-maxInt(1, m.height/4))
	case keymap.Matches(msg, m.keymap.PageDown):
		m.scrollResponse(maxInt(1, m.height/4))
	case keymap.Matches(msg, m.keymap.Home):
		m.gotoResponseTop()
	case keymap.Matches(msg, m.keymap.End), keymap.Matches(msg, m.keymap.Follow):
		m.gotoResponseBottom()
	case keymap.Matches(msg, m.keymap.Escape):
		if m.agentChatFull {
			return m.toggleAgentChat()
		} else if modal {
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
