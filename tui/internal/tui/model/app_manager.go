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
	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"golang.org/x/text/unicode/norm"
)

type appManagerMode string

const (
	appManagerModeManage      appManagerMode = "manage"
	appManagerModeStartPicker appManagerMode = "start-picker"
)

type appManagerSurface string

const (
	appManagerSurfaceTable         appManagerSurface = "table"
	appManagerSurfaceActions       appManagerSurface = "actions"
	appManagerSurfaceRename        appManagerSurface = "rename-editor"
	appManagerSurfacePackagePicker appManagerSurface = "package-picker"
	appManagerSurfacePackageCreate appManagerSurface = "package-create"
)

type appManagerActionID string

const (
	appManagerActionOpen       appManagerActionID = "open"
	appManagerActionStart      appManagerActionID = "start"
	appManagerActionStop       appManagerActionID = "stop"
	appManagerActionRestart    appManagerActionID = "restart"
	appManagerActionRename     appManagerActionID = "rename"
	appManagerActionCopyRoute  appManagerActionID = "copy-route"
	appManagerActionExportLogs appManagerActionID = "export-logs"
	appManagerActionRepair     appManagerActionID = "repair"
	appManagerActionUnregister appManagerActionID = "unregister"
	appManagerActionAddPackage appManagerActionID = "add-package"
)

type appManagerAction struct {
	ID             appManagerActionID
	Label          string
	Enabled        bool
	DisabledReason string
}

type appManagerActionContext struct {
	Item          inventory.Item
	Connected     bool
	StateKnown    bool
	PaneCount     int
	PackagesKnown bool
}

// projectAppManagerActions is a pure UI projection. It provides guidance only;
// the daemon remains authoritative for every lifecycle and registry gate.
func projectAppManagerActions(context appManagerActionContext) []appManagerAction {
	status := strings.ToLower(strings.TrimSpace(context.Item.Status))
	daemonReady := context.Connected && context.StateKnown
	daemonReason := "Relaybase daemon state is offline or stale."
	if context.Connected && !context.StateKnown {
		daemonReason = "Current daemon state has not loaded yet."
	}
	withDaemon := func(enabled bool, reason string) (bool, string) {
		if !daemonReady {
			return false, daemonReason
		}
		if !enabled {
			return false, reason
		}
		return true, ""
	}

	openEnabled, openReason := withDaemon(
		(status == "running" || status == "failed" || status == "degraded") && context.PaneCount > 0,
		"No monitoring pane is available for this app state.",
	)
	startEnabled, startReason := withDaemon(status == "stopped" || status == "", "Start is available only while the app is stopped.")
	stopEnabled, stopReason := withDaemon(status == "running", "Stop is available only while the app is running.")
	restartEnabled, restartReason := withDaemon(
		status == "running" || status == "failed" || status == "degraded",
		"Restart is available only for running, failed, or degraded apps.",
	)
	renameStatusAllowed := status == "running" || status == "stopped" || status == "failed" || status == "degraded" || status == "errored" || status == "conflict"
	renameEnabled, renameReason := withDaemon(renameStatusAllowed, "Rename is unavailable while app state is transitional or uncertain.")
	if renameEnabled && strings.TrimSpace(context.Item.ManifestPath) == "" {
		renameEnabled = false
		renameReason = "Rename requires a registered manifest-backed app."
	}
	exportEnabled, exportReason := withDaemon(true, "")
	repairEnabled, repairReason := withDaemon(true, "")
	unregisterEnabled, unregisterReason := withDaemon(status == "stopped", "Unregister requires the app to be stopped.")
	addPackageEnabled, addPackageReason := withDaemon(context.PackagesKnown, "Current package inventory has not loaded yet.")
	routeEnabled := strings.TrimSpace(context.Item.Route) != ""
	routeReason := "No current or last-known route is available."

	return []appManagerAction{
		{ID: appManagerActionOpen, Label: "Open monitoring pane", Enabled: openEnabled, DisabledReason: openReason},
		{ID: appManagerActionStart, Label: "Start app", Enabled: startEnabled, DisabledReason: startReason},
		{ID: appManagerActionStop, Label: "Stop app", Enabled: stopEnabled, DisabledReason: stopReason},
		{ID: appManagerActionRestart, Label: "Restart app", Enabled: restartEnabled, DisabledReason: restartReason},
		{ID: appManagerActionRename, Label: "Rename app", Enabled: renameEnabled, DisabledReason: renameReason},
		{ID: appManagerActionCopyRoute, Label: "Copy route", Enabled: routeEnabled, DisabledReason: routeReason},
		{ID: appManagerActionExportLogs, Label: "Export app logs", Enabled: exportEnabled, DisabledReason: exportReason},
		{ID: appManagerActionRepair, Label: "Inspect repair options", Enabled: repairEnabled, DisabledReason: repairReason},
		{ID: appManagerActionUnregister, Label: "Unregister app", Enabled: unregisterEnabled, DisabledReason: unregisterReason},
		{ID: appManagerActionAddPackage, Label: "Add to package…", Enabled: addPackageEnabled, DisabledReason: addPackageReason},
	}
}

func (m RootModel) appManagerActions() []appManagerAction {
	item := m.appInventory.Selected()
	if item == nil {
		return nil
	}
	return projectAppManagerActions(appManagerActionContext{
		Item: *item, Connected: m.connectionStatus == "connected", StateKnown: m.state != nil,
		PaneCount:     len(m.paneManager.PaneIDsForApp(item.ID)),
		PackagesKnown: m.appPackagesKnown,
	})
}

func (m RootModel) appManagerItemCount() int {
	if m.appManagerSurface == appManagerSurfacePackagePicker {
		return len(m.appPackages)
	}
	if m.appManagerSurface == appManagerSurfaceActions {
		return len(m.appManagerActions())
	}
	return m.appInventory.Count()
}

func (m *RootModel) moveAppManagerSelection(delta int) {
	if m.appManagerSurface == appManagerSurfacePackagePicker {
		m.moveAppPackagePickerSelection(delta)
		return
	}
	if m.appManagerSurface == appManagerSurfaceActions {
		m.selectAppManagerActionIndex(m.selectedAppManagerActionIndex() + delta)
		return
	}
	m.appInventory.Move(delta)
}

func (m *RootModel) selectAppManagerIndex(index int) {
	if m.appManagerSurface == appManagerSurfacePackagePicker {
		m.selectAppPackagePickerIndex(index)
		return
	}
	if m.appManagerSurface == appManagerSurfaceActions {
		m.selectAppManagerActionIndex(index)
		return
	}
	m.appInventory.SelectIndex(index)
}

func (m RootModel) selectedAppManagerActionIndex() int {
	actions := m.appManagerActions()
	for index, action := range actions {
		if action.ID == m.appManagerSelectedActionID {
			return index
		}
	}
	return 0
}

func (m *RootModel) selectAppManagerActionIndex(index int) {
	actions := m.appManagerActions()
	if len(actions) == 0 {
		m.appManagerSelectedActionID = ""
		return
	}
	index = minInt(maxInt(0, index), len(actions)-1)
	m.appManagerSelectedActionID = actions[index].ID
}

func (m *RootModel) ensureAppManagerActionSelection() {
	actions := m.appManagerActions()
	if len(actions) == 0 {
		m.appManagerSelectedActionID = ""
		return
	}
	for _, action := range actions {
		if action.ID == m.appManagerSelectedActionID {
			return
		}
	}
	m.appManagerSelectedActionID = actions[0].ID
}

func (m RootModel) executeSelectedAppManagerAction() (RootModel, tea.Cmd) {
	item := m.appInventory.Selected()
	if item == nil {
		m.appManagerNotice = "No registered app is selected."
		return m, nil
	}
	actions := m.appManagerActions()
	index := m.selectedAppManagerActionIndex()
	if index < 0 || index >= len(actions) {
		m.appManagerNotice = "No management action is selected."
		return m, nil
	}
	action := actions[index]
	if !action.Enabled {
		m.appManagerNotice = action.Label + " is unavailable: " + action.DisabledReason
		return m, nil
	}

	switch action.ID {
	case appManagerActionOpen:
		return m.openRunningAppPane(item.ID)
	case appManagerActionStart, appManagerActionStop, appManagerActionRestart:
		lifecycleAction := string(action.ID)
		m.pendingConfirm = &confirmationRequest{
			Action:          lifecycleAction,
			Target:          slash.ResolvedTarget{Description: "app " + valueOr(item.Name, item.ID), AppIDs: []string{item.ID}},
			Risk:            lifecycleRisk(lifecycleAction),
			Expected:        "Daemon returns an operation id for the exact selected app.",
			Command:         slash.ParsedCommand{Kind: lifecycleCommandKind(lifecycleAction), Target: item.ID},
			LifecycleAction: lifecycleAction,
		}
		m.appManagerPendingAppID = item.ID
		m.appManagerPendingAction = action.ID
		m.interaction.OpenModal(interaction.ModalConfirmation)
		m.resetBodyScroll()
		m.refreshAssistantPrompt()
		return m, nil
	case appManagerActionRename:
		m.openAppRenameEditor(*item)
		return m, nil
	case appManagerActionCopyRoute:
		m.appManagerPendingAppID = item.ID
		m.appManagerPendingAction = action.ID
		m.appManagerNotice = "Copying the " + routeFreshnessLabel(m.connectionStatus) + " route."
		return m, writeClipboardTargetCmd(item.Route, "route for "+item.ID)
	case appManagerActionExportLogs:
		target := slash.ResolvedTarget{Description: "app " + valueOr(item.Name, item.ID), AppIDs: []string{item.ID}}
		request := exportRequestForTarget(slash.ScopeApp, target)
		m.pendingConfirm = &confirmationRequest{
			Action: "export logs", Target: target,
			Risk:          "Writes a redacted log export artifact; logs may include sensitive operational context.",
			Expected:      "Daemon writes a redacted app-scoped export and returns its export id/path.",
			Command:       slash.ParsedCommand{Kind: slash.KindLogsExport, Scope: slash.ScopeApp, Target: item.ID},
			ExportRequest: &request,
		}
		m.appManagerPendingAppID = item.ID
		m.appManagerPendingAction = action.ID
		m.interaction.OpenModal(interaction.ModalConfirmation)
		m.resetBodyScroll()
		m.refreshAssistantPrompt()
		return m, nil
	case appManagerActionRepair:
		cmd, err := m.appManagerRepairCmd(item.ID)
		if err != nil {
			m.appManagerNotice = "Repair options could not be loaded: " + err.Error()
			return m, nil
		}
		m.closeAppManager()
		m.addAssistantMessage("Requesting repair choices for app " + item.ID + ".")
		return m, cmd
	case appManagerActionUnregister:
		m.appManagerPendingAppID = item.ID
		m.appManagerPendingAction = action.ID
		m.appManagerRefreshing = true
		m.appManagerNotice = "Inspecting daemon unregister gates for " + item.ID + "."
		return m, commands.PreviewAppUnregisterCmd(m.ctx, m.client, item.ID)
	case appManagerActionAddPackage:
		m.openAppPackagePicker(item.ID)
		return m, nil
	default:
		m.appManagerNotice = "That management action is not available."
		return m, nil
	}
}

func (m *RootModel) openAppRenameEditor(item inventory.Item) {
	if m.appManagerRenameAppID != item.ID || m.appManagerRenameCurrentName != item.Name {
		m.appManagerRenameInput.SetValue(item.Name)
	}
	m.appManagerRenameAppID = item.ID
	m.appManagerRenameCurrentName = item.Name
	m.appManagerSurface = appManagerSurfaceRename
	m.appManagerNotice = "Edit the durable display name. The stable app id and route will not change."
	m.appManagerRenameInput.SetWidth(maxInt(12, minInt(64, m.width-24)))
	_ = m.appManagerRenameInput.Focus()
}

func (m RootModel) previewAppRename() (RootModel, tea.Cmd) {
	item, ok := m.appInventory.ItemByID(m.appManagerRenameAppID)
	if !ok || item.ID != m.appInventory.SelectedID() {
		m.appManagerNotice = "The selected app changed; return to the app table and choose it again."
		return m, nil
	}
	name, err := validateAppRenameName(m.appManagerRenameInput.Value(), m.appInventory.Items(), item.ID)
	if err != nil {
		m.appManagerNotice = err.Error()
		return m, nil
	}
	if name == m.appManagerRenameCurrentName {
		m.appManagerNotice = "That name is already current; no mutation is required."
		return m, nil
	}
	m.appManagerPendingAppID = item.ID
	m.appManagerPendingAction = appManagerActionRename
	m.appManagerRefreshing = true
	m.appManagerNotice = "Requesting a daemon-bound rename preview for " + item.ID + "."
	return m, commands.PreviewAppRenameCmd(m.ctx, m.client, item.ID, name)
}

func validateAppRenameName(value string, items []inventory.Item, selectedAppID string) (string, error) {
	name := strings.TrimSpace(value)
	if count := utf8.RuneCountInString(name); count < 1 || count > 80 {
		return "", fmt.Errorf("App name must contain 1 through 80 visible Unicode characters.")
	}
	for _, character := range name {
		if unicode.Is(unicode.Cc, character) || unicode.Is(unicode.Cf, character) || unicode.Is(unicode.Cs, character) ||
			unicode.Is(unicode.Zl, character) || unicode.Is(unicode.Zp, character) || isExplicitInvisibleRenameRune(character) {
			return "", fmt.Errorf("App name cannot contain terminal controls, newlines, or invisible formatting characters.")
		}
	}
	candidate := collisionNameKey(name)
	for _, item := range items {
		if item.ID == selectedAppID {
			continue
		}
		if candidate == collisionNameKey(item.Name) || candidate == collisionNameKey(item.ID) {
			return "", fmt.Errorf("App name conflicts with registered app %s (%s).", item.ID, item.Name)
		}
	}
	return name, nil
}

func collisionNameKey(value string) string {
	return strings.ToLower(norm.NFKC.String(strings.TrimSpace(value)))
}

func isExplicitInvisibleRenameRune(character rune) bool {
	return character == '\u034f' || character == '\u115f' || character == '\u1160' ||
		(character >= '\u17b4' && character <= '\u17b5') ||
		(character >= '\u180b' && character <= '\u180f') ||
		(character >= '\ufff9' && character <= '\ufffb')
}

func (m RootModel) appManagerRepairCmd(appID string) (tea.Cmd, error) {
	item, ok := m.appInventory.ItemByID(appID)
	if !ok {
		return nil, fmt.Errorf("App %s is no longer present in current daemon inventory.", appID)
	}
	cwd := strings.TrimSpace(item.Directory)
	if cwd == "" {
		var err error
		cwd, err = m.cwdForSetupTarget(appID)
		if err != nil {
			return nil, err
		}
	}
	return commands.SetupRepairCmd(m.ctx, m.client, relaybaseclient.RepairSetupRequest{
		SetupPlanRequest: relaybaseclient.SetupPlanRequest{CWD: cwd},
		Reason:           "Requested from Relaybase TUI app management",
	}), nil
}

func lifecycleCommandKind(action string) string {
	switch action {
	case "start":
		return slash.KindStart
	case "restart":
		return slash.KindRestart
	default:
		return slash.KindStop
	}
}

func routeFreshnessLabel(connectionStatus string) string {
	if connectionStatus == "connected" {
		return "current"
	}
	return "last-known"
}

func sentenceCase(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "Action"
	}
	return strings.ToUpper(value[:1]) + value[1:]
}

func (m *RootModel) appManagerCancellationNotice() string {
	action := m.appManagerPendingAction
	m.appManagerPendingAppID = ""
	m.appManagerPendingAction = ""
	if action == "" {
		return "Action cancelled; no request was sent."
	}
	return fmt.Sprintf("%s cancelled; no mutation request was sent.", appManagerActionLabel(action))
}

func (m RootModel) appManagerRefreshNotice() string {
	if m.appManagerPendingAppID == "" || m.appManagerPendingAction == "" {
		return ""
	}
	item, ok := m.appInventory.ItemByID(m.appManagerPendingAppID)
	if !ok {
		return "The selected app is no longer registered."
	}
	if m.appManagerPendingAction == appManagerActionRename && m.appManagerSurface == appManagerSurfaceActions && item.Name == m.appManagerRenameCurrentName {
		return fmt.Sprintf("Renamed app to %s; stable id %s remains %s.", item.Name, item.ID, valueOr(item.Status, "unknown"))
	}
	return fmt.Sprintf("%s is %s; daemon state remains authoritative.", valueOr(item.Name, item.ID), valueOr(item.Status, "unknown"))
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func appManagerActionLabel(id appManagerActionID) string {
	for _, action := range projectAppManagerActions(appManagerActionContext{}) {
		if action.ID == id {
			return action.Label
		}
	}
	return "Action"
}
