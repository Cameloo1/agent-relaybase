package model

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

type packageManagerSurface string

const (
	packageManagerSurfaceTable   packageManagerSurface = "table"
	packageManagerSurfaceActions packageManagerSurface = "actions"
	packageManagerSurfaceName    packageManagerSurface = "name"
	packageManagerSurfaceMembers packageManagerSurface = "members"
	packageManagerSurfaceRun     packageManagerSurface = "run"
)

type packageManagerActionID string

const (
	packageManagerActionLaunch  packageManagerActionID = "launch"
	packageManagerActionInspect packageManagerActionID = "inspect"
	packageManagerActionRetry   packageManagerActionID = "retry"
	packageManagerActionAbort   packageManagerActionID = "abort"
	packageManagerActionEdit    packageManagerActionID = "edit"
	packageManagerActionRename  packageManagerActionID = "rename"
	packageManagerActionDelete  packageManagerActionID = "delete"
)

type packageManagerAction struct {
	ID             packageManagerActionID
	Label          string
	Enabled        bool
	DisabledReason string
}

func projectPackageManagerActions(definition relaybaseclient.AppPackageDefinition, daemonReady bool) []packageManagerAction {
	lastRun := definition.LastRun
	activeRun := lastRun != nil && !lastRun.Terminal()
	daemonReason := "Relaybase daemon state is offline or stale."
	withDaemon := func(enabled bool, reason string) (bool, string) {
		if !daemonReady {
			return false, daemonReason
		}
		if !enabled {
			return false, reason
		}
		return true, ""
	}
	launch, launchReason := withDaemon(!activeRun, "A package run is already active.")
	inspect, inspectReason := withDaemon(lastRun != nil, "This package has no recorded run.")
	retryable := lastRun != nil && lastRun.Terminal() && lastRun.Status != "succeeded"
	retry, retryReason := withDaemon(retryable, "Retry is available only after an unsuccessful terminal run.")
	abort, abortReason := withDaemon(activeRun, "Abort is available only while a package run is active.")
	edit, editReason := withDaemon(!activeRun, "Package membership cannot change during an active run.")
	rename, renameReason := withDaemon(!activeRun, "A package cannot be renamed during an active run.")
	remove, removeReason := withDaemon(!activeRun, "A package cannot be deleted during an active run.")
	return []packageManagerAction{
		{ID: packageManagerActionLaunch, Label: "Launch package", Enabled: launch, DisabledReason: launchReason},
		{ID: packageManagerActionInspect, Label: "Inspect latest run", Enabled: inspect, DisabledReason: inspectReason},
		{ID: packageManagerActionRetry, Label: "Retry failed members", Enabled: retry, DisabledReason: retryReason},
		{ID: packageManagerActionAbort, Label: "Abort active run", Enabled: abort, DisabledReason: abortReason},
		{ID: packageManagerActionEdit, Label: "Edit apps and launch order", Enabled: edit, DisabledReason: editReason},
		{ID: packageManagerActionRename, Label: "Rename package", Enabled: rename, DisabledReason: renameReason},
		{ID: packageManagerActionDelete, Label: "Delete package", Enabled: remove, DisabledReason: removeReason},
	}
}

func (m *RootModel) openPackageManager() tea.Cmd {
	m.interaction.OpenTransient(interaction.TransientPackageManager)
	m.packageManagerVisible = true
	m.packageManagerSurface = packageManagerSurfaceTable
	m.packageManagerActionOffset = 0
	m.packageManagerNotice = ""
	m.packageManagerRefreshing = m.connectionStatus == "connected"
	m.ensurePackageManagerSelection()
	m.followPackageManagerSelection()
	if m.connectionStatus == "connected" {
		return commands.ListAppPackagesCmd(m.ctx, m.client)
	}
	return nil
}

func (m *RootModel) closePackageManager() {
	if !m.packageManagerVisible {
		return
	}
	m.packageManagerVisible = false
	m.packageManagerSurface = packageManagerSurfaceTable
	m.packageManagerOffset = 0
	m.packageManagerActionOffset = 0
	m.packageManagerSelectedAction = ""
	m.packageManagerCreating = false
	m.packageManagerMembers = nil
	m.packageManagerMemberSelected = 0
	m.packageManagerMemberOffset = 0
	m.packageManagerRunOffset = 0
	m.packageManagerNotice = ""
	m.packageManagerRefreshing = false
	m.packageManagerPendingID = ""
	m.packageManagerPendingAction = ""
	m.packageDeleteAutoConfirm = false
	m.packageManagerNameInput.SetValue("")
	m.packageManagerNameInput.Blur()
	m.interaction.CloseTransient()
}

func (m *RootModel) beginPackageDeletePreview(definition relaybaseclient.AppPackageDefinition, autoConfirm bool) tea.Cmd {
	m.packageManagerPendingID = definition.ID
	m.packageManagerPendingAction = packageManagerActionDelete
	m.packageDeleteAutoConfirm = autoConfirm
	m.packageManagerRefreshing = m.packageManagerVisible
	message := "Requesting a revision-bound deletion preview for " + definition.Name + "."
	if m.packageManagerVisible {
		m.packageManagerNotice = message
	} else {
		m.addAssistantMessage(message)
	}
	return commands.PreviewAppPackageDeleteCmd(m.ctx, m.client, definition.ID, definition.Revision)
}

func (m RootModel) selectedPackageDefinition() *relaybaseclient.AppPackageDefinition {
	for index := range m.appPackages {
		if m.appPackages[index].ID == m.packageManagerSelectedID {
			copy := m.appPackages[index]
			copy.MemberAppIDs = append([]string(nil), copy.MemberAppIDs...)
			return &copy
		}
	}
	return nil
}

func (m RootModel) hasAppPackage(id string) bool {
	for _, definition := range m.appPackages {
		if definition.ID == id {
			return true
		}
	}
	return false
}

func (m *RootModel) ensurePackageManagerSelection() {
	if len(m.appPackages) == 0 {
		m.packageManagerSelectedID = ""
		return
	}
	for _, definition := range m.appPackages {
		if definition.ID == m.packageManagerSelectedID {
			return
		}
	}
	m.packageManagerSelectedID = m.appPackages[0].ID
}

func (m RootModel) packageManagerSelectedIndex() int {
	for index, definition := range m.appPackages {
		if definition.ID == m.packageManagerSelectedID {
			return index
		}
	}
	return 0
}

func (m *RootModel) selectPackageManagerIndex(index int) {
	if len(m.appPackages) == 0 {
		m.packageManagerSelectedID = ""
		return
	}
	index = minInt(maxInt(0, index), len(m.appPackages)-1)
	m.packageManagerSelectedID = m.appPackages[index].ID
}

func (m *RootModel) movePackageManagerSelection(delta int) {
	if m.packageManagerSurface == packageManagerSurfaceActions {
		m.selectPackageManagerActionIndex(m.selectedPackageManagerActionIndex() + delta)
		return
	}
	if m.packageManagerSurface == packageManagerSurfaceMembers {
		rows := m.packageMemberRows()
		m.packageManagerMemberSelected = minInt(maxInt(0, m.packageManagerMemberSelected+delta), maxInt(0, len(rows)-1))
		return
	}
	if m.packageManagerSurface == packageManagerSurfaceRun {
		definition := m.selectedPackageDefinition()
		count := 0
		if definition != nil && definition.LastRun != nil {
			count = len(definition.LastRun.Members)
		}
		m.packageManagerRunOffset = minInt(maxInt(0, m.packageManagerRunOffset+delta), maxInt(0, count-packageRunViewportRows(m.height)))
		return
	}
	m.selectPackageManagerIndex(m.packageManagerSelectedIndex() + delta)
}

func (m RootModel) packageManagerActions() []packageManagerAction {
	definition := m.selectedPackageDefinition()
	if definition == nil {
		return nil
	}
	return projectPackageManagerActions(*definition, m.connectionStatus == "connected" && m.appPackagesKnown)
}

func (m RootModel) selectedPackageManagerActionIndex() int {
	for index, action := range m.packageManagerActions() {
		if action.ID == m.packageManagerSelectedAction {
			return index
		}
	}
	return 0
}

func (m *RootModel) selectPackageManagerActionIndex(index int) {
	actions := m.packageManagerActions()
	if len(actions) == 0 {
		m.packageManagerSelectedAction = ""
		return
	}
	index = minInt(maxInt(0, index), len(actions)-1)
	m.packageManagerSelectedAction = actions[index].ID
}

func (m *RootModel) ensurePackageManagerActionSelection() {
	actions := m.packageManagerActions()
	if len(actions) == 0 {
		m.packageManagerSelectedAction = ""
		return
	}
	for _, action := range actions {
		if action.ID == m.packageManagerSelectedAction {
			return
		}
	}
	m.packageManagerSelectedAction = actions[0].ID
}

func (m RootModel) packageManagerPageSize() int {
	metrics := m.operatorMetrics()
	if metrics.ResizeRequired {
		return 1
	}
	innerHeight := maxInt(1, metrics.Modal.Height-m.styles.Help.GetVerticalFrameSize())
	switch m.packageManagerSurface {
	case packageManagerSurfaceActions:
		return maxInt(1, innerHeight-12)
	case packageManagerSurfaceMembers:
		return maxInt(1, innerHeight-7)
	default:
		return maxInt(1, innerHeight-7)
	}
}

func (m *RootModel) followPackageManagerSelection() {
	rows := m.packageManagerPageSize()
	switch m.packageManagerSurface {
	case packageManagerSurfaceActions:
		selected := m.selectedPackageManagerActionIndex()
		if selected < m.packageManagerActionOffset {
			m.packageManagerActionOffset = selected
		} else if selected >= m.packageManagerActionOffset+rows {
			m.packageManagerActionOffset = selected - rows + 1
		}
		m.packageManagerActionOffset = minInt(maxInt(0, m.packageManagerActionOffset), maxInt(0, len(m.packageManagerActions())-rows))
	case packageManagerSurfaceMembers:
		selected := m.packageManagerMemberSelected
		if selected < m.packageManagerMemberOffset {
			m.packageManagerMemberOffset = selected
		} else if selected >= m.packageManagerMemberOffset+rows {
			m.packageManagerMemberOffset = selected - rows + 1
		}
		m.packageManagerMemberOffset = minInt(maxInt(0, m.packageManagerMemberOffset), maxInt(0, len(m.packageMemberRows())-rows))
	default:
		selected := m.packageManagerSelectedIndex()
		if selected < m.packageManagerOffset {
			m.packageManagerOffset = selected
		} else if selected >= m.packageManagerOffset+rows {
			m.packageManagerOffset = selected - rows + 1
		}
		m.packageManagerOffset = minInt(maxInt(0, m.packageManagerOffset), maxInt(0, len(m.appPackages)-rows))
	}
}

func (m RootModel) handlePackageManagerKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	switch m.packageManagerSurface {
	case packageManagerSurfaceName:
		return m.handlePackageNameKey(msg)
	case packageManagerSurfaceMembers:
		return m.handlePackageMembersKey(msg)
	case packageManagerSurfaceRun:
		switch {
		case keymap.Matches(msg, m.keymap.Escape):
			m.packageManagerSurface = packageManagerSurfaceActions
			m.packageManagerNotice = ""
		case keymap.Matches(msg, m.keymap.Up):
			m.movePackageManagerSelection(-1)
		case keymap.Matches(msg, m.keymap.Down):
			m.movePackageManagerSelection(1)
		case keymap.Matches(msg, m.keymap.PageUp):
			m.movePackageManagerSelection(-packageRunViewportRows(m.height))
		case keymap.Matches(msg, m.keymap.PageDown):
			m.movePackageManagerSelection(packageRunViewportRows(m.height))
		case keymap.Matches(msg, m.keymap.Home):
			m.packageManagerRunOffset = 0
		case keymap.Matches(msg, m.keymap.End):
			definition := m.selectedPackageDefinition()
			if definition != nil && definition.LastRun != nil {
				m.packageManagerRunOffset = maxInt(0, len(definition.LastRun.Members)-packageRunViewportRows(m.height))
			}
		}
		return m, nil
	}

	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		if m.packageManagerSurface == packageManagerSurfaceActions {
			m.packageManagerSurface = packageManagerSurfaceTable
			m.packageManagerActionOffset = 0
			m.packageManagerNotice = ""
			m.followPackageManagerSelection()
			return m, nil
		}
		m.closePackageManager()
		return m, nil
	case strings.EqualFold(msg.String(), "r"):
		if m.connectionStatus != "connected" {
			m.packageManagerNotice = "Refresh is unavailable while the Relaybase daemon is offline; showing last known packages."
			return m, nil
		}
		m.packageManagerRefreshing = true
		m.packageManagerNotice = "Refreshing daemon-backed package state."
		return m, commands.ListAppPackagesCmd(m.ctx, m.client)
	case strings.EqualFold(msg.String(), "n") && m.packageManagerSurface == packageManagerSurfaceTable:
		m.packageManagerCreating = true
		m.packageManagerNameInput.SetValue("")
		m.packageManagerNameInput.SetWidth(maxInt(12, minInt(64, m.width-24)))
		_ = m.packageManagerNameInput.Focus()
		m.packageManagerSurface = packageManagerSurfaceName
		m.packageManagerNotice = "Name the package, then choose its registered apps and launch order."
		return m, nil
	case keymap.Matches(msg, m.keymap.Up):
		m.movePackageManagerSelection(-1)
	case keymap.Matches(msg, m.keymap.Down):
		m.movePackageManagerSelection(1)
	case keymap.Matches(msg, m.keymap.PageUp):
		m.movePackageManagerSelection(-m.packageManagerPageSize())
	case keymap.Matches(msg, m.keymap.PageDown):
		m.movePackageManagerSelection(m.packageManagerPageSize())
	case keymap.Matches(msg, m.keymap.Home):
		if m.packageManagerSurface == packageManagerSurfaceActions {
			m.selectPackageManagerActionIndex(0)
		} else {
			m.selectPackageManagerIndex(0)
		}
	case keymap.Matches(msg, m.keymap.End):
		if m.packageManagerSurface == packageManagerSurfaceActions {
			m.selectPackageManagerActionIndex(len(m.packageManagerActions()) - 1)
		} else {
			m.selectPackageManagerIndex(len(m.appPackages) - 1)
		}
	case keymap.Matches(msg, m.keymap.Enter):
		if m.packageManagerSurface == packageManagerSurfaceActions {
			return m.executeSelectedPackageManagerAction()
		}
		if m.selectedPackageDefinition() == nil {
			m.packageManagerNotice = "No saved package is selected. Press N to create one."
			return m, nil
		}
		m.packageManagerSurface = packageManagerSurfaceActions
		m.ensurePackageManagerActionSelection()
	default:
		return m, nil
	}
	m.packageManagerNotice = ""
	m.followPackageManagerSelection()
	return m, nil
}

func (m RootModel) handlePackageNameKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		m.packageManagerNameInput.Blur()
		if m.packageManagerCreating {
			m.packageManagerSurface = packageManagerSurfaceTable
		} else {
			m.packageManagerSurface = packageManagerSurfaceActions
		}
		m.packageManagerNotice = "Package name draft preserved."
		return m, nil
	case keymap.Matches(msg, m.keymap.Enter):
		name, err := validatePackageName(m.packageManagerNameInput.Value(), m.appPackages, m.packageManagerSelectedID)
		if err != nil {
			m.packageManagerNotice = err.Error()
			return m, nil
		}
		if m.packageManagerCreating {
			m.packageManagerMembers = nil
			m.packageManagerMemberSelected = 0
			m.packageManagerMemberOffset = 0
			m.packageManagerSurface = packageManagerSurfaceMembers
			m.packageManagerNotice = "Space adds apps; Ctrl+Up/Ctrl+Down changes the saved launch order."
			m.packageManagerNameInput.SetValue(name)
			m.packageManagerNameInput.Blur()
			return m, nil
		}
		definition := m.selectedPackageDefinition()
		if definition == nil {
			m.packageManagerNotice = "The selected package is no longer available; return to the table and refresh."
			return m, nil
		}
		if name == definition.Name {
			m.packageManagerNotice = "That package name is already current; no mutation is required."
			return m, nil
		}
		m.packageManagerPendingID = definition.ID
		m.packageManagerPendingAction = packageManagerActionRename
		m.packageManagerRefreshing = true
		m.packageManagerNotice = "Requesting a revision-bound package rename preview."
		return m, commands.PreviewAppPackageChangeCmd(m.ctx, m.client, definition.ID, definition.Revision, relaybaseclient.AppPackageChange{Kind: "rename", Name: name})
	case isPasteShortcut(msg):
		return m, readClipboardCmd()
	default:
		updated, cmd := m.packageManagerNameInput.Update(msg)
		m.packageManagerNameInput = updated
		return m, cmd
	}
}

func (m RootModel) handlePackageMembersKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	rows := m.packageMemberRows()
	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		if m.packageManagerCreating {
			m.packageManagerSurface = packageManagerSurfaceName
			_ = m.packageManagerNameInput.Focus()
		} else {
			m.packageManagerSurface = packageManagerSurfaceActions
		}
		m.packageManagerNotice = "Package membership draft preserved."
		return m, nil
	case msg.String() == "ctrl+up":
		m.reorderSelectedPackageMember(-1)
	case msg.String() == "ctrl+down":
		m.reorderSelectedPackageMember(1)
	case keymap.Matches(msg, m.keymap.Up):
		m.movePackageManagerSelection(-1)
	case keymap.Matches(msg, m.keymap.Down):
		m.movePackageManagerSelection(1)
	case keymap.Matches(msg, m.keymap.PageUp):
		m.movePackageManagerSelection(-m.packageManagerPageSize())
	case keymap.Matches(msg, m.keymap.PageDown):
		m.movePackageManagerSelection(m.packageManagerPageSize())
	case keymap.Matches(msg, m.keymap.Home):
		m.packageManagerMemberSelected = 0
	case keymap.Matches(msg, m.keymap.End):
		m.packageManagerMemberSelected = maxInt(0, len(rows)-1)
	case msg.String() == " " || msg.String() == "space" || msg.Text == " ":
		m.toggleSelectedPackageMember()
	case keymap.Matches(msg, m.keymap.Enter):
		if len(m.packageManagerMembers) < 1 || len(m.packageManagerMembers) > 100 {
			m.packageManagerNotice = "A package must contain 1 through 100 registered apps."
			return m, nil
		}
		if m.packageManagerCreating {
			name, err := validatePackageName(m.packageManagerNameInput.Value(), m.appPackages, "")
			if err != nil {
				m.packageManagerNotice = err.Error()
				return m, nil
			}
			m.packageManagerPendingAction = "create"
			m.packageManagerRefreshing = true
			m.packageManagerNotice = "Creating the saved package definition; no app will be launched."
			return m, commands.CreateAppPackageCmd(m.ctx, m.client, name, append([]string(nil), m.packageManagerMembers...))
		}
		definition := m.selectedPackageDefinition()
		if definition == nil {
			m.packageManagerNotice = "The selected package is no longer available; return to the table and refresh."
			return m, nil
		}
		if equalStringSlices(definition.MemberAppIDs, m.packageManagerMembers) {
			m.packageManagerNotice = "Package membership and launch order are unchanged."
			return m, nil
		}
		m.packageManagerPendingID = definition.ID
		m.packageManagerPendingAction = packageManagerActionEdit
		m.packageManagerRefreshing = true
		m.packageManagerNotice = "Requesting a revision-bound membership preview."
		return m, commands.PreviewAppPackageChangeCmd(m.ctx, m.client, definition.ID, definition.Revision, relaybaseclient.AppPackageChange{Kind: "replace-members", MemberAppIDs: append([]string(nil), m.packageManagerMembers...)})
	default:
		return m, nil
	}
	m.packageManagerNotice = ""
	m.followPackageManagerSelection()
	return m, nil
}

func (m RootModel) executeSelectedPackageManagerAction() (RootModel, tea.Cmd) {
	definition := m.selectedPackageDefinition()
	if definition == nil {
		m.packageManagerNotice = "No saved package is selected."
		return m, nil
	}
	actions := m.packageManagerActions()
	index := m.selectedPackageManagerActionIndex()
	if index < 0 || index >= len(actions) {
		m.packageManagerNotice = "No package action is selected."
		return m, nil
	}
	action := actions[index]
	if !action.Enabled {
		m.packageManagerNotice = action.Label + " is unavailable: " + action.DisabledReason
		return m, nil
	}
	m.packageManagerPendingID = definition.ID
	m.packageManagerPendingAction = action.ID
	switch action.ID {
	case packageManagerActionLaunch:
		m.pendingConfirm = &confirmationRequest{
			Action: "launch package", Target: slash.ResolvedTarget{Description: "package " + definition.Name, AppIDs: append([]string(nil), definition.MemberAppIDs...)},
			Risk: "Starts stopped package members using daemon-owned lifecycle operations.", Expected: "The daemon creates a bounded package run for the exact stable package id.",
			Command: slash.ParsedCommand{Kind: slash.KindLaunchPackage}, PackageAction: "launch", PackageID: definition.ID,
		}
		m.interaction.OpenModal(interaction.ModalConfirmation)
		return m, nil
	case packageManagerActionInspect:
		m.packageManagerSurface = packageManagerSurfaceRun
		m.packageManagerRunOffset = 0
		m.packageManagerNotice = ""
		return m, nil
	case packageManagerActionRetry, packageManagerActionAbort:
		if definition.LastRun == nil {
			m.packageManagerNotice = "The selected package has no current run."
			return m, nil
		}
		kind := slash.KindPackageRunRetry
		verb := "retry package run"
		risk := "Retries only failed or interrupted members from the recorded run."
		if action.ID == packageManagerActionAbort {
			kind = slash.KindPackageRunAbort
			verb = "abort package run"
			risk = "Requests cancellation for pending package members; already-started apps remain running."
		}
		m.pendingConfirm = &confirmationRequest{
			Action: verb, Target: slash.ResolvedTarget{Description: "package " + definition.Name}, Risk: risk,
			Expected: "The daemon applies the request to the exact recorded package run.", Command: slash.ParsedCommand{Kind: kind},
			PackageAction: string(action.ID), PackageID: definition.ID, PackageRunID: definition.LastRun.ID,
		}
		m.interaction.OpenModal(interaction.ModalConfirmation)
		return m, nil
	case packageManagerActionEdit:
		m.packageManagerMembers = append([]string(nil), definition.MemberAppIDs...)
		m.packageManagerMemberSelected = 0
		m.packageManagerMemberOffset = 0
		m.packageManagerCreating = false
		m.packageManagerSurface = packageManagerSurfaceMembers
		m.packageManagerNotice = "Space adds or removes apps; Ctrl+Up/Ctrl+Down changes the saved launch order."
		return m, nil
	case packageManagerActionRename:
		m.packageManagerCreating = false
		m.packageManagerNameInput.SetValue(definition.Name)
		m.packageManagerNameInput.SetWidth(maxInt(12, minInt(64, m.width-24)))
		_ = m.packageManagerNameInput.Focus()
		m.packageManagerSurface = packageManagerSurfaceName
		m.packageManagerNotice = "The stable package id and historical runs will not change."
		return m, nil
	case packageManagerActionDelete:
		m.packageManagerRefreshing = true
		m.packageManagerNotice = "Inspecting daemon deletion gates and historical-run retention."
		return m, commands.PreviewAppPackageDeleteCmd(m.ctx, m.client, definition.ID, definition.Revision)
	default:
		return m, nil
	}
}

func (m RootModel) packageMemberRows() []views.PackageMemberRow {
	included := make(map[string]int, len(m.packageManagerMembers))
	known := make(map[string]string, m.appInventory.Count())
	for index, appID := range m.packageManagerMembers {
		included[appID] = index + 1
	}
	for _, item := range m.appInventory.Items() {
		known[item.ID] = valueOr(item.Name, item.ID)
	}
	rows := make([]views.PackageMemberRow, 0, len(known)+len(m.packageManagerMembers))
	for _, appID := range m.packageManagerMembers {
		name, ok := known[appID]
		rows = append(rows, views.PackageMemberRow{AppID: appID, Name: valueOr(name, appID), Included: true, Ordinal: included[appID], Missing: !ok})
	}
	for _, item := range m.appInventory.Items() {
		if _, ok := included[item.ID]; ok {
			continue
		}
		rows = append(rows, views.PackageMemberRow{AppID: item.ID, Name: valueOr(item.Name, item.ID)})
	}
	return rows
}

func (m *RootModel) toggleSelectedPackageMember() {
	rows := m.packageMemberRows()
	if m.packageManagerMemberSelected < 0 || m.packageManagerMemberSelected >= len(rows) {
		return
	}
	selectedID := rows[m.packageManagerMemberSelected].AppID
	for index, appID := range m.packageManagerMembers {
		if appID == selectedID {
			m.packageManagerMembers = append(m.packageManagerMembers[:index], m.packageManagerMembers[index+1:]...)
			m.packageManagerNotice = "Removed " + selectedID + " from the draft package."
			m.selectPackageMemberByID(selectedID)
			return
		}
	}
	if len(m.packageManagerMembers) >= 100 {
		m.packageManagerNotice = "A package cannot contain more than 100 apps."
		return
	}
	m.packageManagerMembers = append(m.packageManagerMembers, selectedID)
	m.packageManagerNotice = "Added " + selectedID + " to the draft package."
	m.selectPackageMemberByID(selectedID)
}

func (m *RootModel) reorderSelectedPackageMember(delta int) {
	rows := m.packageMemberRows()
	if m.packageManagerMemberSelected < 0 || m.packageManagerMemberSelected >= len(rows) || !rows[m.packageManagerMemberSelected].Included {
		m.packageManagerNotice = "Only included apps can be reordered."
		return
	}
	selectedID := rows[m.packageManagerMemberSelected].AppID
	for index, appID := range m.packageManagerMembers {
		if appID != selectedID {
			continue
		}
		target := index + delta
		if target < 0 || target >= len(m.packageManagerMembers) {
			return
		}
		m.packageManagerMembers[index], m.packageManagerMembers[target] = m.packageManagerMembers[target], m.packageManagerMembers[index]
		m.packageManagerNotice = "Updated the draft launch order."
		m.selectPackageMemberByID(selectedID)
		return
	}
}

func (m *RootModel) selectPackageMemberByID(appID string) {
	for index, row := range m.packageMemberRows() {
		if row.AppID == appID {
			m.packageManagerMemberSelected = index
			m.followPackageManagerSelection()
			return
		}
	}
}

func (m RootModel) packageTableData(appID string, picker bool) views.PackageTableData {
	rows := make([]views.PackageTableRow, 0, len(m.appPackages))
	selectedID := m.packageManagerSelectedID
	offset := m.packageManagerOffset
	if picker {
		selectedID = m.appManagerPackageSelectedID
		offset = m.appManagerPackageOffset
	}
	selected := 0
	for index, definition := range m.appPackages {
		lastRun := "never"
		if definition.LastRun != nil && strings.TrimSpace(definition.LastRun.Status) != "" {
			lastRun = definition.LastRun.Status
		}
		row := views.PackageTableRow{ID: definition.ID, Name: definition.Name, MemberCount: len(definition.MemberAppIDs), Revision: definition.Revision, LastRun: lastRun, Enabled: true}
		if picker {
			row.Membership = "not included"
			switch {
			case m.connectionStatus != "connected" || !m.appPackagesKnown:
				row.Enabled = false
				row.DisabledReason = "state unavailable"
			case containsString(definition.MemberAppIDs, appID):
				row.Enabled = false
				row.Membership = "already included"
				row.DisabledReason = "already included"
			case definition.LastRun != nil && !definition.LastRun.Terminal():
				row.Enabled = false
				row.DisabledReason = "run active"
			case len(definition.MemberAppIDs) >= 100:
				row.Enabled = false
				row.DisabledReason = "package full"
			}
		}
		if definition.ID == selectedID {
			selected = index
		}
		rows = append(rows, row)
	}
	return views.PackageTableData{Rows: rows, Selected: selected, Offset: offset, PickerMode: picker}
}

func (m RootModel) packageManagerDataForView() *views.PackageManagerData {
	if !m.packageManagerVisible {
		return nil
	}
	table := m.packageTableData("", false)
	actions := m.packageManagerActions()
	projected := make([]views.AppManagerAction, 0, len(actions))
	for _, action := range actions {
		projected = append(projected, views.AppManagerAction{ID: string(action.ID), Label: action.Label, Enabled: action.Enabled, DisabledReason: action.DisabledReason})
	}
	var selectedRow *views.PackageTableRow
	if table.Selected >= 0 && table.Selected < len(table.Rows) {
		copy := table.Rows[table.Selected]
		selectedRow = &copy
	}
	var run *views.PackageRunData
	if definition := m.selectedPackageDefinition(); definition != nil && definition.LastRun != nil {
		run = &views.PackageRunData{ID: definition.LastRun.ID, Status: definition.LastRun.Status}
		for _, member := range definition.LastRun.Members {
			run.Members = append(run.Members, views.PackageRunMemberData{AppID: member.AppID, State: member.State})
		}
	}
	return &views.PackageManagerData{
		Surface: string(m.packageManagerSurface), Table: table, ConnectionStatus: m.connectionStatus,
		Refreshing: m.packageManagerRefreshing, Notice: m.packageManagerNotice, Actions: projected,
		SelectedAction: m.selectedPackageManagerActionIndex(), ActionOffset: m.packageManagerActionOffset,
		SelectedPackage: selectedRow, NameInput: m.packageManagerNameInput.View(),
		NameCurrent: valueOr(packageName(m.selectedPackageDefinition()), "new package"), Creating: m.packageManagerCreating,
		Members: m.packageMemberRows(), SelectedMember: m.packageManagerMemberSelected, MemberOffset: m.packageManagerMemberOffset, Run: run,
		RunOffset: m.packageManagerRunOffset,
	}
}

func (m *RootModel) openAppPackagePicker(appID string) {
	m.appInventory.SelectID(appID)
	m.appManagerSurface = appManagerSurfacePackagePicker
	m.appManagerPendingAppID = appID
	m.appManagerPendingAction = appManagerActionAddPackage
	m.appManagerPackageOffset = 0
	m.appManagerNotice = "Choose a saved package. Adding membership will not launch any app."
	if len(m.appPackages) > 0 {
		found := false
		for _, definition := range m.appPackages {
			if definition.ID == m.appManagerPackageSelectedID {
				found = true
				break
			}
		}
		if !found {
			m.appManagerPackageSelectedID = m.appPackages[0].ID
		}
	}
	m.followAppPackagePickerSelection()
}

func (m RootModel) handleAppPackagePickerKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	if m.appManagerSurface == appManagerSurfacePackageCreate {
		switch {
		case keymap.Matches(msg, m.keymap.Escape):
			m.appManagerPackageNameInput.Blur()
			m.appManagerSurface = appManagerSurfacePackagePicker
			m.appManagerNotice = "Package name draft preserved."
			return m, nil
		case keymap.Matches(msg, m.keymap.Enter):
			name, err := validatePackageName(m.appManagerPackageNameInput.Value(), m.appPackages, "")
			if err != nil {
				m.appManagerNotice = err.Error()
				return m, nil
			}
			appID := m.appManagerPendingAppID
			if _, ok := m.appInventory.ItemByID(appID); !ok {
				m.appManagerNotice = "The selected app is no longer registered; return to the app table and refresh."
				return m, nil
			}
			m.appManagerPendingPackageID = "create"
			m.appManagerRefreshing = true
			m.appManagerNotice = "Creating the package with the selected app; no app will be launched."
			return m, commands.CreateAppPackageCmd(m.ctx, m.client, name, []string{appID})
		case isPasteShortcut(msg):
			return m, readClipboardCmd()
		default:
			updated, cmd := m.appManagerPackageNameInput.Update(msg)
			m.appManagerPackageNameInput = updated
			return m, cmd
		}
	}

	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		m.appManagerSurface = appManagerSurfaceActions
		m.appManagerNotice = ""
		m.followAppManagerSelection()
		return m, nil
	case strings.EqualFold(msg.String(), "n"):
		m.appManagerSurface = appManagerSurfacePackageCreate
		m.appManagerPackageNameInput.SetWidth(maxInt(12, minInt(64, m.width-24)))
		_ = m.appManagerPackageNameInput.Focus()
		m.appManagerNotice = "The selected app will be the package's first member."
		return m, nil
	case strings.EqualFold(msg.String(), "r"):
		if m.connectionStatus != "connected" {
			m.appManagerNotice = "Refresh is unavailable while the Relaybase daemon is offline."
			return m, nil
		}
		m.appManagerRefreshing = true
		return m, commands.ListAppPackagesCmd(m.ctx, m.client)
	case keymap.Matches(msg, m.keymap.Up):
		m.moveAppPackagePickerSelection(-1)
	case keymap.Matches(msg, m.keymap.Down):
		m.moveAppPackagePickerSelection(1)
	case keymap.Matches(msg, m.keymap.PageUp):
		m.moveAppPackagePickerSelection(-m.appManagerPageSize())
	case keymap.Matches(msg, m.keymap.PageDown):
		m.moveAppPackagePickerSelection(m.appManagerPageSize())
	case keymap.Matches(msg, m.keymap.Home):
		m.selectAppPackagePickerIndex(0)
	case keymap.Matches(msg, m.keymap.End):
		m.selectAppPackagePickerIndex(len(m.appPackages) - 1)
	case keymap.Matches(msg, m.keymap.Enter):
		definition := m.selectedAppPickerPackage()
		if definition == nil {
			m.appManagerNotice = "No saved package is selected. Press N to create one."
			return m, nil
		}
		row := m.packageTableData(m.appManagerPendingAppID, true).Rows[m.appPackagePickerSelectedIndex()]
		if !row.Enabled {
			m.appManagerNotice = "Package " + definition.Name + " is unavailable: " + row.DisabledReason + "."
			return m, nil
		}
		m.appManagerPendingPackageID = definition.ID
		m.appManagerRefreshing = true
		m.appManagerNotice = "Requesting a revision-bound add-membership preview."
		return m, commands.PreviewAppPackageChangeCmd(m.ctx, m.client, definition.ID, definition.Revision, relaybaseclient.AppPackageChange{Kind: "add-member", AppID: m.appManagerPendingAppID})
	default:
		return m, nil
	}
	m.appManagerNotice = ""
	m.followAppPackagePickerSelection()
	return m, nil
}

func (m RootModel) selectedAppPickerPackage() *relaybaseclient.AppPackageDefinition {
	for index := range m.appPackages {
		if m.appPackages[index].ID == m.appManagerPackageSelectedID {
			copy := m.appPackages[index]
			copy.MemberAppIDs = append([]string(nil), copy.MemberAppIDs...)
			return &copy
		}
	}
	return nil
}

func (m RootModel) appPackagePickerSelectedIndex() int {
	for index, definition := range m.appPackages {
		if definition.ID == m.appManagerPackageSelectedID {
			return index
		}
	}
	return 0
}

func (m *RootModel) selectAppPackagePickerIndex(index int) {
	if len(m.appPackages) == 0 {
		m.appManagerPackageSelectedID = ""
		return
	}
	index = minInt(maxInt(0, index), len(m.appPackages)-1)
	m.appManagerPackageSelectedID = m.appPackages[index].ID
}

func (m *RootModel) moveAppPackagePickerSelection(delta int) {
	m.selectAppPackagePickerIndex(m.appPackagePickerSelectedIndex() + delta)
}

func (m *RootModel) followAppPackagePickerSelection() {
	rows := m.appManagerPageSize()
	selected := m.appPackagePickerSelectedIndex()
	if selected < m.appManagerPackageOffset {
		m.appManagerPackageOffset = selected
	} else if selected >= m.appManagerPackageOffset+rows {
		m.appManagerPackageOffset = selected - rows + 1
	}
	m.appManagerPackageOffset = minInt(maxInt(0, m.appManagerPackageOffset), maxInt(0, len(m.appPackages)-rows))
}

func validatePackageName(value string, definitions []relaybaseclient.AppPackageDefinition, selectedID string) (string, error) {
	name := strings.TrimSpace(value)
	if count := utf8.RuneCountInString(name); count < 1 || count > 64 {
		return "", fmt.Errorf("Package name must contain 1 through 64 visible Unicode characters.")
	}
	for _, character := range name {
		if unicode.IsControl(character) || unicode.Is(unicode.Cf, character) || unicode.Is(unicode.Cs, character) || unicode.Is(unicode.Zl, character) || unicode.Is(unicode.Zp, character) {
			return "", fmt.Errorf("Package name cannot contain terminal controls, newlines, or invisible formatting characters.")
		}
	}
	key := collisionNameKey(name)
	for _, definition := range definitions {
		if definition.ID == selectedID {
			continue
		}
		if key == collisionNameKey(definition.Name) || key == collisionNameKey(definition.ID) {
			return "", fmt.Errorf("Package name conflicts with saved package %s (%s).", definition.ID, definition.Name)
		}
	}
	return name, nil
}

func (m RootModel) updatePackageNamePaste(content string) (RootModel, tea.Cmd) {
	input := &m.packageManagerNameInput
	notice := &m.packageManagerNotice
	if m.appManagerVisible && m.appManagerSurface == appManagerSurfacePackageCreate {
		input = &m.appManagerPackageNameInput
		notice = &m.appManagerNotice
	}
	if strings.TrimSpace(content) == "" {
		*notice = "Clipboard does not contain a visible package name."
		return m, nil
	}
	updated, cmd := input.Update(tea.PasteMsg{Content: content})
	*input = updated
	*notice = "Pasted package name."
	return m, cmd
}

func equalStringSlices(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func packageName(definition *relaybaseclient.AppPackageDefinition) string {
	if definition == nil {
		return ""
	}
	return definition.Name
}

func packageRunViewportRows(height int) int {
	return maxInt(1, maxInt(8, height-8)-6)
}

func packagePreviewBlockers(blockers []struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}) string {
	messages := make([]string, 0, len(blockers))
	for _, blocker := range blockers {
		if message := strings.TrimSpace(blocker.Message); message != "" {
			messages = append(messages, message)
		}
	}
	return valueOr(strings.Join(messages, " "), "The daemon did not authorize this change.")
}

func packageDeleteBlockers(blockers []struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}) string {
	return packagePreviewBlockers(blockers)
}

func packageChangeSuccessNotice(kind string, name string) string {
	switch kind {
	case "rename":
		return "Renamed package to " + name + "; its stable id and historical runs were preserved."
	case "replace-members":
		return "Updated apps and launch order for " + name + ". No app was started or stopped."
	default:
		return "Updated package " + name + ". No app was started or stopped."
	}
}

func (m *RootModel) setPackageMutationFailure(packageID string, message string) {
	if m.appManagerVisible && m.appManagerPendingPackageID == packageID {
		m.appManagerNotice = message
		m.appManagerPendingPackageID = ""
		m.appManagerRefreshing = false
	}
	if m.packageManagerVisible && m.packageManagerPendingID == packageID {
		m.packageManagerNotice = message
		m.packageManagerPendingID = ""
		m.packageManagerPendingAction = ""
		m.packageManagerRefreshing = false
	}
}

func (m *RootModel) recordPackageRun(run relaybaseclient.AppPackageRun) {
	for index := range m.appPackages {
		if m.appPackages[index].ID == run.PackageID {
			copy := run
			m.appPackages[index].LastRun = &copy
			return
		}
	}
}
