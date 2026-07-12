package model

import (
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
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
	if !strings.HasPrefix(strings.TrimSpace(m.commandInput), "/") {
		m.commandPalette.SetQueryAndReset("")
		return
	}
	m.commandPalette.SetQueryAndReset(m.commandInput)
}

func (m RootModel) commandPaletteVisible() bool {
	return m.commandActive && strings.HasPrefix(strings.TrimSpace(m.commandInput), "/") &&
		!strings.Contains(m.commandInput, "\n") &&
		!m.helpVisible && !m.contextMenu.IsOpen() && m.pendingConfirm == nil && m.pendingAgentApproval == nil
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
	maximum := views.ResponseScrollMax(data)
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
	m.responseOffset = views.ResponseBottomOffset(data)
	m.responseFollow = true
	m.responseNewOutput = 0
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
