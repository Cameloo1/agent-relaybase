package model

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/bootstrap"
	"github.com/cameloo/relaybase/tui/internal/config"
	"github.com/cameloo/relaybase/tui/internal/events"
	"github.com/cameloo/relaybase/tui/internal/preferences"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/assistant"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/contextmenu"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/setupwizard"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

type Diagnostic struct {
	Code     string
	Severity string
	Message  string
}

const supportedAPIVersion = "v1"

const (
	daemonUnavailableDiagnosticCode = "daemon_unavailable"
	eventDisconnectedDiagnosticCode = "event_stream_disconnected"
	authTokenInvalidDiagnosticCode  = "auth_token_invalid"
	agentGatewayUnavailableCode     = "agent_gateway_unavailable"
	agentDiagnosticsUnavailableCode = "agent_diagnostics_unavailable"
	agentEventDisconnectedCode      = "agent_event_stream_disconnected"
)

var agentConfigDiagnosticCodes = []string{
	"agent_disabled",
	"agent_remote_model_disabled",
	"agent_model_missing",
	"openrouter_api_key_missing",
}

type daemonRetryMsg struct{}
type eventRetryMsg struct{}

type RootModel struct {
	cfg                  config.Config
	client               *relaybaseclient.Client
	bootstrapClient      *bootstrap.Client
	ctx                  context.Context
	cancel               context.CancelFunc
	state                *relaybaseclient.RelaybaseState
	stream               *relaybaseclient.EventStream
	connectionStatus     string
	eventStatus          string
	eventCount           int
	diagnostics          []Diagnostic
	theme                styles.Theme
	styles               styles.Styles
	keymap               keymap.KeyMap
	paneManager          panes.Manager
	contextMenu          contextmenu.Menu
	preferences          preferences.Preferences
	preferenceStore      preferences.Store
	commandInput         string
	commandActive        bool
	assistantHistory     []string
	naturalHistory       []assistant.HistoryEntry
	lastAssistantLine    string
	historyExpanded      bool
	setupSession         setupwizard.State
	pendingConfirm       *confirmationRequest
	agentConfig          *relaybaseclient.AgentConfig
	agentStatus          string
	agentDiagnostics     []relaybaseclient.AgentDiagnostic
	agentSession         *relaybaseclient.AgentSession
	agentSessions        []relaybaseclient.AgentSession
	agentStream          *relaybaseclient.AgentEventStream
	agentPendingInput    string
	pendingAgentApproval *relaybaseclient.AgentApproval
	lastNaturalAction    string
	helpVisible          bool
	width                int
	height               int
	bodyScrollOffset     int
	daemonRetryAttempt   int
	eventRetryAttempt    int
	lastBootstrapResult  *bootstrap.DaemonResult
	assistantPrompt      string
	now                  func() time.Time
}

type confirmationRequest struct {
	Action          string
	Target          slash.ResolvedTarget
	Risk            string
	Expected        string
	Command         slash.ParsedCommand
	LifecycleAction string
	ExportRequest   *relaybaseclient.LogExportRequest
	SetupCommand    *slash.ParsedCommand
	AssistantInput  string
	DaemonRepair    bool
}

var paneColorPalette = []string{"default", "#216869", "#8a5a00", "#9b1c31", "#6d4c3d"}
var assistantColorPalette = []string{"default", "#216869", "#8a5a00", "#9b1c31", "#6d4c3d"}

func NewRoot(cfg config.Config, client *relaybaseclient.Client) RootModel {
	ctx, cancel := context.WithCancel(context.Background())
	preferenceStore := preferences.NewStore(cfg.StateDir)
	loadedPreferences, preferenceResult := preferenceStore.Load()
	effectiveTheme := loadedPreferences.Theme
	if cfg.ThemeMode != "" && cfg.ThemeMode != config.DefaultTheme {
		effectiveTheme = cfg.ThemeMode
		loadedPreferences.Theme = cfg.ThemeMode
	}
	theme, themeDiagnostics := styles.ResolveTheme(effectiveTheme, os.Getenv)
	bootstrapClient := bootstrap.New(cfg.BootstrapURL, cfg.BootstrapToken, nil)
	bootstrapReport, bootstrapReportErr := bootstrap.DecodeReport(cfg.BootstrapReport)
	tuiStyles := styles.NewWithOptions(theme, styles.Options{
		AssistantBarColor: loadedPreferences.Assistant.BarColor,
	})
	diagnostics := make([]Diagnostic, 0, len(themeDiagnostics)+1)
	for _, diagnostic := range themeDiagnostics {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     diagnostic.Code,
			Severity: diagnostic.Severity,
			Message:  diagnostic.Message,
		})
	}
	for _, diagnostic := range preferenceResult.Diagnostics {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     diagnostic.Code,
			Severity: diagnostic.Severity,
			Message:  diagnostic.Message,
		})
	}
	for _, diagnostic := range assistant.ProviderDiagnostics(loadedPreferences.Assistant.Provider) {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     diagnostic.Code,
			Severity: diagnostic.Severity,
			Message:  diagnostic.Message,
		})
	}
	if strings.TrimSpace(cfg.Token) == "" {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     "auth_token_missing",
			Severity: "warning",
			Message:  "Relaybase auth token was not found in the environment or state directory.",
		})
	}
	if bootstrapReportErr != nil {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     "daemon_bootstrap_report_invalid",
			Severity: "warning",
			Message:  "Relaybase TUI bootstrap report could not be read.",
		})
	} else if bootstrapReport != nil && !bootstrapReport.Reachable {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     "daemon_bootstrap_" + valueOr(bootstrapReport.Code, "unavailable"),
			Severity: "warning",
			Message:  bootstrapResultMessage(bootstrapReport),
		})
	}
	if len(loadedPreferences.Keymap.ContextMenu) > 0 && loadedPreferences.Keymap.ContextMenu[0] != "ctrl+z" {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     "context_menu_ctrl_z_unavailable",
			Severity: "info",
			Message:  "Ctrl+Z context menu binding is overridden or unavailable; Ctrl+O remains available as the guaranteed fallback.",
		})
	}
	paneManager := panes.NewManager()
	paneManager.ApplyPreferences(
		loadedPreferences.Panes.Pinned,
		loadedPreferences.Panes.Hidden,
		loadedPreferences.Panes.Order,
		loadedPreferences.Panes.Colors,
		loadedPreferences.Layout.LastPage,
	)

	return RootModel{
		cfg:                 cfg,
		client:              client,
		bootstrapClient:     bootstrapClient,
		ctx:                 ctx,
		cancel:              cancel,
		connectionStatus:    "connecting",
		eventStatus:         "connecting",
		agentStatus:         "checking",
		diagnostics:         diagnostics,
		theme:               theme,
		styles:              tuiStyles,
		keymap:              keymap.WithContextMenu(loadedPreferences.Keymap.ContextMenu),
		paneManager:         paneManager,
		preferences:         loadedPreferences,
		preferenceStore:     preferenceStore,
		assistantHistory:    []string{},
		naturalHistory:      []assistant.HistoryEntry{},
		width:               80,
		height:              24,
		lastBootstrapResult: bootstrapReport,
		assistantPrompt:     assistant.PromptPlaceholder(),
		now:                 time.Now,
	}
}

func (m RootModel) Init() tea.Cmd {
	return commands.FetchStateCmd(m.ctx, m.client)
}

func (m RootModel) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case daemonRetryMsg:
		if m.connectionStatus != "offline" {
			return m, nil
		}
		m.connectionStatus = "connecting"
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case eventRetryMsg:
		if m.connectionStatus != "connected" {
			return m, nil
		}
		m.eventStatus = "checking"
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.paneManager.Resize(msg.Width, dashboardHeight(msg.Height))
		m.clampBodyScroll()
		return m, nil
	case tea.MouseWheelMsg:
		mouse := msg.Mouse()
		if !m.mouseInBody(mouse.Y) {
			return m, nil
		}
		switch mouse.Button {
		case tea.MouseWheelUp:
			m.scrollBody(-3)
		case tea.MouseWheelDown:
			m.scrollBody(3)
		}
		return m, nil
	case tea.KeyPressMsg:
		if keymap.Matches(msg, m.keymap.ContextualMenu) || keymap.Matches(msg, m.keymap.ContextFallback) || isContextMenuKey(msg) {
			m.openContextMenu()
			return m, nil
		}
		if m.contextMenu.IsOpen() {
			if keymap.Matches(msg, m.keymap.Escape) {
				m.contextMenu = contextmenu.Menu{}
				return m, nil
			}
			if keymap.Matches(msg, m.keymap.Up) {
				m.contextMenu.Move(-1)
				return m, nil
			}
			if keymap.Matches(msg, m.keymap.Down) {
				m.contextMenu.Move(1)
				return m, nil
			}
			if keymap.Matches(msg, m.keymap.Enter) {
				return m, m.executeContextMenuSelection()
			}
			return m, nil
		}
		if m.commandActive {
			return m.handleCommandInput(msg)
		}
		if m.pendingAgentApproval != nil {
			if updated, ok := m.startCommandInput(msg); ok {
				return updated, nil
			}
			if keymap.Matches(msg, m.keymap.Escape) {
				approvalID := m.pendingAgentApproval.ID
				m.pendingAgentApproval = nil
				m.addAssistantMessage("Rejecting Operator Agent approval " + approvalID + ".")
				return m, commands.RejectAgentApprovalCmd(m.ctx, m.client, approvalID, "Rejected from Relaybase TUI with Esc")
			}
			if keymap.Matches(msg, m.keymap.Enter) {
				approval := *m.pendingAgentApproval
				approvalID := approval.ID
				m.pendingAgentApproval = nil
				if approval.Status == "recovered_pending" {
					m.addAssistantMessage("Reconfirming recovered Operator Agent approval " + approvalID + ".")
					return m, commands.ApproveAgentApprovalCmd(m.ctx, m.client, approvalID, relaybaseclient.AgentApprovalResolutionRequest{
						Reconfirm: true,
						Resume:    true,
					})
				}
				m.addAssistantMessage("Approving Operator Agent approval " + approvalID + ".")
				return m, commands.ApproveAgentApprovalCmd(m.ctx, m.client, approvalID)
			}
			if keymap.Matches(msg, m.keymap.Slash) {
				m.commandActive = true
				m.commandInput = "/"
				m.refreshAssistantPrompt()
				return m, nil
			}
			return m, nil
		}
		if m.pendingConfirm != nil {
			if updated, ok := m.startCommandInput(msg); ok {
				return updated, nil
			}
			if keymap.Matches(msg, m.keymap.Escape) {
				m.pendingConfirm = nil
				m.addAssistantMessage("Confirmation cancelled.")
				return m, nil
			}
			if keymap.Matches(msg, m.keymap.Enter) {
				return m, m.executePendingConfirmation()
			}
			if keymap.Matches(msg, m.keymap.Slash) {
				m.commandActive = true
				m.commandInput = "/"
				m.refreshAssistantPrompt()
				return m, nil
			}
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Quit) {
			m.close()
			return m, tea.Quit
		}
		if keymap.Matches(msg, m.keymap.Help) {
			m.helpVisible = !m.helpVisible
			m.resetBodyScroll()
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Escape) {
			if m.paneManager.Focused() {
				m.paneManager.BlurFocus()
				m.resetBodyScroll()
			} else {
				m.helpVisible = false
				m.resetBodyScroll()
			}
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Enter) {
			m.paneManager.FocusSelected()
			m.resetBodyScroll()
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Follow) {
			m.paneManager.ToggleFollowSelected()
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Slash) {
			m.commandActive = true
			m.commandInput = "/"
			m.refreshAssistantPrompt()
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Up) {
			if m.paneManager.Focused() {
				m.paneManager.ScrollSelected(1)
			} else {
				m.paneManager.MoveSelection(0, -1)
			}
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Down) {
			if m.paneManager.Focused() {
				m.paneManager.ScrollSelected(-1)
			} else {
				m.paneManager.MoveSelection(0, 1)
			}
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Left) {
			m.paneManager.MoveSelection(-1, 0)
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Right) {
			m.paneManager.MoveSelection(1, 0)
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.PageUp) {
			if m.paneManager.Focused() {
				m.paneManager.ScrollSelected(m.paneManager.Layout().PaneHeight)
				if target := m.paneManager.OlderLogTarget(); target != nil {
					return m, commands.FetchLogsCmd(m.ctx, m.client, *target)
				}
			} else {
				m.paneManager.PreviousPage()
				m.resetBodyScroll()
				return m, m.persistPreferencesCmd()
			}
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.PageDown) {
			if m.paneManager.Focused() {
				m.paneManager.ScrollSelected(-m.paneManager.Layout().PaneHeight)
			} else {
				m.paneManager.NextPage()
				m.resetBodyScroll()
				return m, m.persistPreferencesCmd()
			}
			return m, nil
		}
		if updated, ok := m.startCommandInput(msg); ok {
			return updated, nil
		}
		return m, nil
	case commands.StateLoadedMsg:
		wasOffline := m.connectionStatus != "connected"
		m.state = msg.State
		m.connectionStatus = "connected"
		m.daemonRetryAttempt = 0
		m.clearDiagnostics(
			daemonUnavailableDiagnosticCode,
			eventDisconnectedDiagnosticCode,
			authTokenInvalidDiagnosticCode,
			agentGatewayUnavailableCode,
			agentDiagnosticsUnavailableCode,
		)
		m.clearDiagnosticsByPrefix("daemon_bootstrap_")
		m.paneManager.ApplyState(msg.State)
		if m.hasNoRegisteredApps() && !m.setupSession.Active() {
			m.setupSession = setupwizard.NoApps(m.cfg.CurrentDirectory)
		}
		if !m.hasNoRegisteredApps() && m.setupSession.Mode == setupwizard.ModeNoApps {
			m.setupSession = setupwizard.Empty()
		}
		if msg.State != nil && msg.State.APIVersion != "" && msg.State.APIVersion != supportedAPIVersion {
			m.addDiagnostic(
				"api_version_mismatch",
				"warning",
				fmt.Sprintf("Daemon API version %s is not the TUI-supported %s contract.", msg.State.APIVersion, supportedAPIVersion),
			)
		}
		cmds := []tea.Cmd{
			commands.FetchLogsBatchCmd(m.ctx, m.client, m.paneManager.RefreshLogTargets()),
		}
		if m.stream == nil || m.eventStatus != "connected" {
			m.eventStatus = "connecting"
			cmds = append(cmds, events.ConnectCmd(m.ctx, m.client))
		}
		if wasOffline || m.agentConfig == nil {
			m.agentStatus = "checking"
			cmds = append(cmds, commands.FetchAgentConfigCmd(m.ctx, m.client), commands.FetchAgentDiagnosticsCmd(m.ctx, m.client))
		}
		return m, batchCommands(cmds...)
	case commands.StateFailedMsg:
		m.connectionStatus = "offline"
		m.eventStatus = "waiting"
		m.agentStatus = "waiting"
		if m.stream != nil {
			_ = m.stream.Close()
			m.stream = nil
		}
		m.clearDiagnostics(eventDisconnectedDiagnosticCode, agentGatewayUnavailableCode, agentDiagnosticsUnavailableCode)
		m.addOrReplaceDiagnostic(daemonUnavailableDiagnosticCode, "error", m.daemonUnavailableMessage())
		return m, m.scheduleDaemonRetryCmd()
	case commands.LogsLoadedMsg:
		m.paneManager.MergeSnapshot(msg.Target, msg.Snapshot)
		return m, nil
	case commands.LogsFailedMsg:
		safeErr := safeLogErrorMessage(msg.Err)
		m.paneManager.MarkLogFetchFailed(msg.Target, safeErr)
		m.addDiagnostic("pane_logs_unavailable", "warning", fmt.Sprintf("Could not fetch logs for %s: %s", msg.Target.AppID, safeErr))
		return m, nil
	case commands.PreferencesSavedMsg:
		return m, nil
	case commands.PreferencesSaveFailedMsg:
		m.addDiagnostic("preferences_save_failed", "warning", fmt.Sprintf("Could not save TUI preferences: %v", msg.Err))
		return m, nil
	case commands.DaemonBootstrapStatusMsg:
		m.applyDaemonBootstrapResult(msg.Result)
		m.addAssistantMessage("Daemon status: " + bootstrapResultMessage(msg.Result))
		return m, nil
	case commands.DaemonBootstrapEnsureMsg:
		m.applyDaemonBootstrapResult(msg.Result)
		m.addAssistantMessage("Daemon repair: " + bootstrapResultMessage(msg.Result))
		if msg.Result != nil && msg.Result.Reachable {
			return m, commands.FetchStateCmd(m.ctx, m.client)
		}
		return m, nil
	case commands.DaemonBootstrapFailedMsg:
		m.addOrReplaceDiagnostic("daemon_bootstrap_failed", "error", fmt.Sprintf("%s failed: %v", msg.Action, msg.Err))
		m.addAssistantMessage(fmt.Sprintf("%s failed: %v", msg.Action, msg.Err))
		return m, nil
	case commands.LifecycleRequestedMsg:
		message := fmt.Sprintf("%s requested for %s; operation %s", msg.Action, msg.AppID, valueOr(msg.OperationID, "pending"))
		if m.lastNaturalAction != "" {
			m.recordAssistantInteraction(assistant.ResponseActionResult, m.lastNaturalAction, message)
			m.lastNaturalAction = ""
			m.refreshAssistantPrompt()
		} else {
			m.addAssistantMessage(message)
		}
		return m, nil
	case commands.LifecycleRequestFailedMsg:
		message := fmt.Sprintf("%s failed for %s: %v", msg.Action, msg.AppID, msg.Err)
		m.addDiagnostic("lifecycle_request_failed", "error", fmt.Sprintf("Could not request %s for %s: %v", msg.Action, msg.AppID, msg.Err))
		if m.lastNaturalAction != "" {
			m.recordAssistantInteraction(assistant.ResponseDiagnostic, m.lastNaturalAction, message)
			m.lastNaturalAction = ""
			m.refreshAssistantPrompt()
		} else {
			m.addAssistantMessage(message)
		}
		return m, nil
	case commands.LogsExportedMsg:
		outputPath := ""
		if msg.Result != nil {
			outputPath = msg.Result.OutputPath
		}
		message := "Log export complete: " + valueOr(outputPath, "export created")
		if m.lastNaturalAction != "" {
			m.recordAssistantInteraction(assistant.ResponseActionResult, m.lastNaturalAction, message)
			m.lastNaturalAction = ""
			m.refreshAssistantPrompt()
		} else {
			m.addAssistantMessage(message)
		}
		return m, nil
	case commands.LogsExportFailedMsg:
		message := fmt.Sprintf("Log export failed: %v", msg.Err)
		m.addDiagnostic("log_export_failed", "error", fmt.Sprintf("Could not export %s logs: %v", msg.Request.Scope, msg.Err))
		if m.lastNaturalAction != "" {
			m.recordAssistantInteraction(assistant.ResponseDiagnostic, m.lastNaturalAction, message)
			m.lastNaturalAction = ""
			m.refreshAssistantPrompt()
		} else {
			m.addAssistantMessage(message)
		}
		return m, nil
	case commands.SetupDetectCompletedMsg:
		m.setupSession = setupwizard.FromDetect(msg.Result)
		m.addAssistantMessage("Setup detection complete for " + valueOr(setupDetectCWD(msg.Result), msg.Request.CWD) + ".")
		return m, nil
	case commands.SetupPlansCompletedMsg:
		m.setupSession = setupwizard.FromPlans(msg.Result)
		m.addAssistantMessage(fmt.Sprintf("Daemon returned %d setup choice(s).", setupChoiceCount(msg.Result)))
		return m, nil
	case commands.SetupPreviewCompletedMsg:
		m.setupSession = setupwizard.FromPreview(msg.Result)
		m.addAssistantMessage(fmt.Sprintf("Setup preview ready with %d file write(s).", setupWriteCount(msg.Result)))
		return m, nil
	case commands.SetupApplyCompletedMsg:
		m.setupSession = setupwizard.FromApply(msg.Result)
		m.addAssistantMessage(fmt.Sprintf("Setup applied with %d file result(s).", setupAppliedCount(msg.Result)))
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case commands.SetupRegisterCompletedMsg:
		m.setupSession = setupwizard.FromRegister(msg.Result)
		m.addAssistantMessage("Registered manifest for " + setupRegisterLabel(msg.Result) + ".")
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case commands.SetupManifestInspectCompletedMsg:
		m.setupSession = setupwizard.FromManifest(msg.Result)
		m.addAssistantMessage("Manifest inspection complete.")
		return m, nil
	case commands.SetupManifestValidateCompletedMsg:
		m.setupSession = setupwizard.FromManifest(msg.Result)
		m.addAssistantMessage("Manifest validation complete.")
		return m, nil
	case commands.SetupManifestPatchPreviewCompletedMsg:
		m.setupSession = setupwizard.FromManifestPatch(msg.Result)
		m.addAssistantMessage("Manifest patch preview ready.")
		return m, nil
	case commands.SetupManifestPatchApplyCompletedMsg:
		m.addAssistantMessage("Manifest patch applied for " + setupPatchLabel(msg.Result) + ".")
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case commands.SetupOpenCompletedMsg:
		m.setupSession = setupwizard.FromOpen(msg.Result)
		m.addAssistantMessage("Daemon open flow completed for " + valueOr(setupOpenCWD(msg.Result), msg.Request.CWD) + ".")
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case commands.SetupProveCompletedMsg:
		m.setupSession = setupwizard.FromProve(msg.Result)
		m.addAssistantMessage("Health proof completed for " + valueOr(setupProveCWD(msg.Result), msg.Request.CWD) + ".")
		return m, nil
	case commands.SetupRepairCompletedMsg:
		m.setupSession = setupwizard.FromRepair(msg.Result)
		m.addAssistantMessage(fmt.Sprintf("Repair preview ready with %d choice(s).", setupRepairChoiceCount(msg.Result)))
		return m, nil
	case commands.SetupFailedMsg:
		message := fmt.Sprintf("%s failed: %s", msg.Action, assistant.SanitizeText(fmt.Sprint(msg.Err)))
		m.addDiagnostic("setup_action_failed", "error", message)
		m.addAssistantMessage(message)
		return m, nil
	case commands.AgentConfigLoadedMsg:
		m.agentConfig = msg.Config
		m.agentStatus = agentStatusFromConfig(msg.Config)
		m.clearDiagnostics(agentGatewayUnavailableCode)
		m.clearAgentConfigDiagnostics()
		for _, diagnostic := range agentConfigDiagnostics(msg.Config) {
			m.addDiagnostic(diagnostic.Code, diagnostic.Severity, diagnostic.Message)
		}
		if m.agentThreadGatewayAvailable() {
			return m, commands.FetchActiveAgentSessionCmd(m.ctx, m.client)
		}
		return m, nil
	case commands.AgentConfigFailedMsg:
		if m.connectionStatus != "connected" {
			return m, nil
		}
		m.agentStatus = "unavailable"
		m.clearAgentConfigDiagnostics()
		m.addOrReplaceDiagnostic(agentGatewayUnavailableCode, "warning", "Could not read Agent Gateway config from the connected daemon.")
		return m, nil
	case commands.AgentDiagnosticsLoadedMsg:
		m.clearDiagnostics(agentDiagnosticsUnavailableCode)
		m.clearAgentDiagnostics()
		m.agentDiagnostics = append([]relaybaseclient.AgentDiagnostic(nil), msg.Diagnostics...)
		for _, diagnostic := range msg.Diagnostics {
			m.addDiagnostic(agentDiagnosticCode(diagnostic), valueOr(diagnostic.Severity, "info"), agentDiagnosticMessage(diagnostic))
		}
		return m, nil
	case commands.AgentDiagnosticsFailedMsg:
		if m.connectionStatus != "connected" {
			return m, nil
		}
		m.clearAgentDiagnostics()
		m.addOrReplaceDiagnostic(agentDiagnosticsUnavailableCode, "warning", "Could not read Agent Gateway diagnostics from the connected daemon.")
		return m, nil
	case commands.AgentSessionCreatedMsg:
		m.closeAgentStream()
		m.agentSession = msg.Session
		m.agentStatus = "session"
		if msg.Session != nil {
			m.agentSessions = upsertAgentSession(m.agentSessions, *msg.Session)
			m.addAssistantMessage("New Operator Agent thread active: " + agentSessionLabel(*msg.Session) + ".")
		}
		pending := m.agentPendingInput
		m.agentPendingInput = ""
		cmds := []tea.Cmd{}
		if msg.Session != nil && msg.Session.ID != "" {
			cmds = append(cmds, commands.ConnectAgentEventsCmd(m.ctx, m.client, msg.Session.ID))
			if pending != "" {
				cmds = append(cmds, commands.SendAgentMessageCmd(m.ctx, m.client, msg.Session.ID, relaybaseclient.AgentMessageRequest{
					Content: pending,
					Context: m.agentContext(),
				}))
			}
		}
		return m, tea.Batch(cmds...)
	case commands.AgentSessionCreateFailedMsg:
		m.agentPendingInput = ""
		m.agentStatus = "unavailable"
		m.addDiagnostic("agent_session_create_failed", "error", fmt.Sprintf("Could not create Operator Agent session: %v", msg.Err))
		m.addAssistantMessage("Operator Agent session could not be created: " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentActiveSessionLoadedMsg:
		m.agentSession = msg.Session
		if msg.Session == nil || msg.Session.ID == "" {
			m.agentStatus = "ready_no_thread"
			return m, nil
		}
		m.agentStatus = "session"
		m.agentSessions = upsertAgentSession(m.agentSessions, *msg.Session)
		m.addAssistantMessage("Active Operator Agent thread: " + agentSessionLabel(*msg.Session) + ".")
		return m, commands.ConnectAgentEventsCmd(m.ctx, m.client, msg.Session.ID)
	case commands.AgentActiveSessionFailedMsg:
		if m.connectionStatus == "connected" {
			m.addDiagnostic("agent_active_thread_unavailable", "warning", fmt.Sprintf("Could not read active Operator Agent thread: %v", msg.Err))
		}
		return m, nil
	case commands.AgentSessionsListedMsg:
		m.agentSessions = append([]relaybaseclient.AgentSession(nil), msg.Sessions...)
		m.addAssistantMessage(agentSessionListMessage(msg.Sessions, m.agentSessionID()))
		return m, nil
	case commands.AgentSessionsListFailedMsg:
		m.addDiagnostic("agent_thread_list_failed", "warning", fmt.Sprintf("Could not list Operator Agent threads: %v", msg.Err))
		m.addAssistantMessage("Could not list Operator Agent threads: " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentSessionActivatedMsg:
		m.closeAgentStream()
		m.agentSession = msg.Session
		if msg.Session != nil {
			m.agentSessions = upsertAgentSession(m.agentSessions, *msg.Session)
			m.addAssistantMessage("Switched Operator Agent thread to " + agentSessionLabel(*msg.Session) + ".")
			m.agentStatus = "session"
			return m, commands.ConnectAgentEventsCmd(m.ctx, m.client, msg.Session.ID)
		}
		m.agentStatus = "ready_no_thread"
		m.addAssistantMessage("No Operator Agent thread is active.")
		return m, nil
	case commands.AgentSessionActivateFailedMsg:
		m.addDiagnostic("agent_thread_switch_failed", "warning", fmt.Sprintf("Could not switch Operator Agent thread %s: %v", msg.SessionID, msg.Err))
		m.addAssistantMessage("Could not switch Operator Agent thread " + msg.SessionID + ": " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentSessionUpdatedMsg:
		if msg.Session != nil {
			m.agentSession = msg.Session
			m.agentSessions = upsertAgentSession(m.agentSessions, *msg.Session)
			m.addAssistantMessage("Operator Agent thread " + msg.Action + ": " + agentSessionLabel(*msg.Session) + ".")
		}
		return m, nil
	case commands.AgentSessionUpdateFailedMsg:
		m.addDiagnostic("agent_thread_update_failed", "warning", fmt.Sprintf("Could not %s Operator Agent thread %s: %v", msg.Action, msg.SessionID, msg.Err))
		m.addAssistantMessage("Could not " + msg.Action + " Operator Agent thread " + msg.SessionID + ": " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentSessionClearedMsg:
		clearedID := ""
		if msg.Result != nil {
			clearedID = msg.Result.SessionID
		}
		if clearedID == "" || clearedID == m.agentSessionID() {
			m.closeAgentStream()
			m.agentSession = nil
		}
		m.agentSessions = removeAgentSession(m.agentSessions, clearedID)
		m.assistantHistory = nil
		m.naturalHistory = nil
		m.lastAssistantLine = ""
		m.agentStatus = "ready_no_thread"
		m.addAssistantMessage("Operator Agent thread cleared" + optionalThreadSuffix(clearedID) + ".")
		return m, nil
	case commands.AgentSessionClearFailedMsg:
		m.addDiagnostic("agent_thread_clear_failed", "warning", fmt.Sprintf("Could not clear Operator Agent thread %s: %v", msg.SessionID, msg.Err))
		m.addAssistantMessage("Could not clear Operator Agent thread " + msg.SessionID + ": " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentSessionExportedMsg:
		m.addAssistantMessage(agentSessionExportMessage(msg.Result))
		return m, nil
	case commands.AgentSessionExportFailedMsg:
		m.addDiagnostic("agent_thread_export_failed", "warning", fmt.Sprintf("Could not export Operator Agent thread %s as %s: %v", msg.SessionID, msg.Format, msg.Err))
		m.addAssistantMessage("Could not export Operator Agent thread " + msg.SessionID + ": " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentSessionContextPreviewLoadedMsg:
		m.addAssistantMessage(agentSessionContextPreviewMessage(msg.Preview))
		return m, nil
	case commands.AgentSessionContextPreviewFailedMsg:
		m.addDiagnostic("agent_thread_preview_failed", "warning", fmt.Sprintf("Could not preview Operator Agent thread context %s: %v", msg.SessionID, msg.Err))
		m.addAssistantMessage("Could not preview Operator Agent thread context " + msg.SessionID + ": " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentEventsConnectedMsg:
		m.agentStream = msg.Stream
		m.agentStatus = "streaming"
		m.clearDiagnostics(agentEventDisconnectedCode)
		return m, commands.NextAgentEventCmd(m.ctx, msg.Stream)
	case commands.AgentEventMsg:
		m.agentStream = msg.Stream
		m.applyAgentRunEvent(msg.Event)
		return m, commands.NextAgentEventCmd(m.ctx, msg.Stream)
	case commands.AgentEventsDisconnectedMsg:
		m.agentStream = nil
		if m.agentSession != nil {
			m.agentStatus = "disconnected"
			m.addDiagnostic(agentEventDisconnectedCode, "warning", fmt.Sprintf("Operator Agent event stream disconnected: %v", msg.Err))
		}
		return m, nil
	case commands.AgentMessageSentMsg:
		if msg.Result != nil {
			m.agentStatus = "idle"
			for _, diagnostic := range msg.Result.Diagnostics {
				m.addDiagnostic(agentDiagnosticCode(diagnostic), valueOr(diagnostic.Severity, "info"), agentDiagnosticMessage(diagnostic))
			}
			if m.agentStream == nil {
				for _, event := range msg.Result.Run.Events {
					m.applyAgentRunEvent(event)
				}
			}
		}
		return m, nil
	case commands.AgentMessageSendFailedMsg:
		m.agentStatus = "failed"
		m.addDiagnostic("agent_message_failed", "error", fmt.Sprintf("Operator Agent message failed: %v", msg.Err))
		m.addAssistantMessage("Operator Agent message failed: " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentApprovalResolvedMsg:
		if msg.Approval != nil {
			m.addAssistantMessage(fmt.Sprintf("Operator Agent approval %s %s.", msg.Approval.ID, msg.Status))
		} else {
			m.addAssistantMessage("Operator Agent approval " + msg.Status + ".")
		}
		if msg.Status == "approved" {
			return m, commands.FetchStateCmd(m.ctx, m.client)
		}
		return m, nil
	case commands.AgentApprovalResolveFailedMsg:
		m.addDiagnostic("agent_approval_resolve_failed", "error", fmt.Sprintf("Could not mark approval %s as %s: %v", msg.ApprovalID, msg.Status, msg.Err))
		m.addAssistantMessage(fmt.Sprintf("Approval %s could not be marked %s: %v", msg.ApprovalID, msg.Status, msg.Err))
		return m, nil
	case events.StreamConnectedMsg:
		m.stream = msg.Stream
		m.eventStatus = "connected"
		m.eventRetryAttempt = 0
		m.clearDiagnostics(eventDisconnectedDiagnosticCode, authTokenInvalidDiagnosticCode)
		return m, events.NextCmd(m.ctx, msg.Stream)
	case events.DaemonEventMsg:
		m.stream = msg.Stream
		m.eventCount++
		cmds := []tea.Cmd{events.NextCmd(m.ctx, msg.Stream)}
		if shouldRefreshState(msg.Event.Type) {
			cmds = append(cmds, commands.FetchStateCmd(m.ctx, m.client))
		}
		if logEvent, ok := logEventFromDaemonEvent(msg.Event); ok {
			if cmd := commands.FetchLogsBatchCmd(m.ctx, m.client, m.paneManager.TargetsForLogEvent(logEvent)); cmd != nil {
				cmds = append(cmds, cmd)
			}
		}
		return m, tea.Batch(cmds...)
	case events.StreamDisconnectedMsg:
		m.stream = nil
		code := eventDiagnosticCode(msg.Err)
		if code == authTokenInvalidDiagnosticCode {
			m.eventStatus = "disconnected"
			m.addOrReplaceDiagnostic(code, "warning", "Relaybase auth token was rejected by the daemon event stream.")
			return m, nil
		}
		if m.connectionStatus != "connected" {
			m.eventStatus = "waiting"
			return m, nil
		}
		m.eventStatus = "reconnecting"
		m.addOrReplaceDiagnostic(eventDisconnectedDiagnosticCode, "warning", "Event stream disconnected; checking daemon state before reconnecting.")
		return m, m.scheduleEventRetryCmd()
	}
	return m, nil
}

func (m RootModel) View() tea.View {
	view := tea.NewView(m.Render())
	view.AltScreen = true
	view.BackgroundColor = m.theme.Background
	view.ForegroundColor = m.theme.Text
	view.MouseMode = tea.MouseModeCellMotion
	return view
}

func (m RootModel) Render() string {
	data := views.ShellData{
		Width:            m.width,
		Height:           m.height,
		BodyScrollOffset: m.bodyScrollOffset,
		ConnectionStatus: m.connectionStatus,
		EventStatus:      m.eventStatus,
		EventCount:       m.eventCount,
		AgentThreadLabel: m.agentThreadStatusLabel(),
		AppCount:         len(m.apps()),
		GroupCount:       len(m.groups()),
		Diagnostics:      m.viewDiagnostics(),
		ShowHelp:         m.helpVisible,
		KeyMap:           m.keymap,
		AssistantPrompt:  m.assistantPrompt,
		AssistantHistory: m.assistantHistoryForView(),
		SetupPanel:       m.setupPanelForView(),
		ContextMenu:      m.contextMenuSnapshot(),
		Confirmation:     m.confirmationForView(),
		Panes:            m.paneManager.CurrentPagePanes(),
		FocusedPane:      m.paneManager.FocusedPane(),
		PaneLayout:       m.paneManager.Layout(),
		Page:             m.paneManager.Page(),
		PageCount:        m.paneManager.PageCount(),
	}
	return views.RenderShell(m.styles, data)
}

func (m RootModel) Diagnostics() []Diagnostic {
	return append([]Diagnostic(nil), m.diagnostics...)
}

func (m RootModel) ConnectionStatus() string {
	return m.connectionStatus
}

func (m RootModel) EventStatus() string {
	return m.eventStatus
}

func (m RootModel) EventCount() int {
	return m.eventCount
}

func (m RootModel) HelpVisible() bool {
	return m.helpVisible
}

func (m RootModel) State() *relaybaseclient.RelaybaseState {
	return m.state
}

func (m RootModel) Theme() styles.Theme {
	return m.theme
}

func (m RootModel) PaneManager() panes.Manager {
	return m.paneManager
}

func (m RootModel) Preferences() preferences.Preferences {
	return m.preferences
}

func (m RootModel) ContextMenuOpen() bool {
	return m.contextMenu.IsOpen()
}

func (m RootModel) CommandInput() string {
	return m.commandInput
}

func (m RootModel) PendingConfirmation() bool {
	return m.pendingConfirm != nil
}

func (m RootModel) NaturalAssistantHistory() []assistant.HistoryEntry {
	return append([]assistant.HistoryEntry(nil), m.naturalHistory...)
}

func (m *RootModel) addDiagnostic(code string, severity string, message string) {
	m.addOrReplaceDiagnostic(code, severity, message)
}

func (m *RootModel) addOrReplaceDiagnostic(code string, severity string, message string) {
	message = assistant.SanitizeText(message)
	for index := range m.diagnostics {
		if m.diagnostics[index].Code == code {
			m.diagnostics[index] = Diagnostic{Code: code, Severity: severity, Message: message}
			return
		}
	}
	m.diagnostics = append(m.diagnostics, Diagnostic{Code: code, Severity: severity, Message: message})
}

func (m *RootModel) clearDiagnostics(codes ...string) {
	if len(codes) == 0 || len(m.diagnostics) == 0 {
		return
	}
	remove := map[string]bool{}
	for _, code := range codes {
		remove[code] = true
	}
	kept := m.diagnostics[:0]
	for _, diagnostic := range m.diagnostics {
		if !remove[diagnostic.Code] {
			kept = append(kept, diagnostic)
		}
	}
	m.diagnostics = kept
}

func (m *RootModel) clearDiagnosticsByPrefix(prefixes ...string) {
	if len(prefixes) == 0 || len(m.diagnostics) == 0 {
		return
	}
	kept := m.diagnostics[:0]
	for _, diagnostic := range m.diagnostics {
		remove := false
		for _, prefix := range prefixes {
			if strings.HasPrefix(diagnostic.Code, prefix) {
				remove = true
				break
			}
		}
		if !remove {
			kept = append(kept, diagnostic)
		}
	}
	m.diagnostics = kept
}

func (m *RootModel) clearAgentConfigDiagnostics() {
	m.clearDiagnostics(agentConfigDiagnosticCodes...)
}

func (m *RootModel) clearAgentDiagnostics() {
	if len(m.agentDiagnostics) == 0 {
		return
	}
	codes := make([]string, 0, len(m.agentDiagnostics))
	for _, diagnostic := range m.agentDiagnostics {
		codes = append(codes, agentDiagnosticCode(diagnostic))
	}
	m.clearDiagnostics(codes...)
}

func (m *RootModel) addAssistantMessage(message string) {
	message = assistant.SanitizeText(message)
	if message == "" {
		return
	}
	if message == m.lastAssistantLine {
		return
	}
	m.assistantHistory = append(m.assistantHistory, message)
	m.lastAssistantLine = message
	m.refreshAssistantPrompt()
}

func (m *RootModel) refreshAssistantPrompt() {
	if m.commandActive {
		m.assistantPrompt = m.commandInput
		return
	}
	if m.pendingAgentApproval != nil {
		if m.pendingAgentApproval.Status == "recovered_pending" {
			m.assistantPrompt = "recovered agent approval: Enter reconfirms resume, Esc rejects"
			return
		}
		m.assistantPrompt = "agent approval: press Enter or Esc"
		return
	}
	if m.pendingConfirm != nil {
		m.assistantPrompt = "confirm: press Enter or Esc"
		return
	}
	if latest := m.latestAssistantLine(); latest != "" {
		m.assistantPrompt = "> " + latest
		return
	}
	m.assistantPrompt = assistant.PromptPlaceholder()
}

func (m RootModel) handleCommandInput(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	if keymap.Matches(msg, m.keymap.Escape) {
		m.commandActive = false
		m.commandInput = ""
		m.refreshAssistantPrompt()
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Enter) {
		input := m.commandInput
		m.commandActive = false
		m.commandInput = ""
		m.refreshAssistantPrompt()
		return m.submitAssistantInput(input)
	}
	if isClearInput(msg) {
		m.commandActive = false
		m.commandInput = ""
		m.refreshAssistantPrompt()
		return m, nil
	}
	if isBackspace(msg) {
		runes := []rune(m.commandInput)
		if len(runes) > 0 {
			m.commandInput = string(runes[:len(runes)-1])
		}
		if m.commandInput == "" {
			m.commandActive = false
		}
		m.refreshAssistantPrompt()
		return m, nil
	}
	if isDelete(msg) {
		return m, nil
	}
	if msg.Text != "" {
		m.commandInput += normalizeCommandInputText(msg.Text)
		m.refreshAssistantPrompt()
	}
	return m, nil
}

func (m RootModel) startCommandInput(msg tea.KeyPressMsg) (RootModel, bool) {
	text := normalizeCommandInputText(msg.Text)
	if text == "" {
		return m, false
	}
	m.commandActive = true
	m.commandInput = text
	m.refreshAssistantPrompt()
	return m, true
}

func (m RootModel) submitAssistantInput(input string) (RootModel, tea.Cmd) {
	parsed, err := assistant.ParseInput(input)
	if err != nil {
		if !strings.HasPrefix(strings.TrimSpace(input), "/") && m.shouldUseAgentGateway() {
			return m.submitAgentInput(input)
		}
		m.recordAssistantError(input, err)
		return m, nil
	}
	if parsed.Source == assistant.SourceSlash {
		return m.submitSlashCommand(input)
	}

	switch parsed.Intent {
	case assistant.IntentAgentGateway:
		return m.submitFolderAgentInput(parsed)
	case assistant.IntentCommand:
		return m.submitNaturalCommand(parsed)
	case assistant.IntentShowLogs:
		return m.executeShowLogsIntent(parsed)
	case assistant.IntentBrokenSummary:
		message := m.brokenSummary()
		m.recordAssistantInteraction(assistant.ResponseAnswer, parsed.Raw, message)
		m.refreshAssistantPrompt()
		return m, nil
	case assistant.IntentDiagnostics:
		message := m.diagnosticsSummary()
		m.recordAssistantInteraction(assistant.ResponseDiagnostic, parsed.Raw, message)
		m.refreshAssistantPrompt()
		return m, nil
	default:
		m.recordAssistantError(input, assistant.ParseError{ResponseType: assistant.ResponseBlocked, Message: "Unsupported assistant command."})
		return m, nil
	}
}

func (m RootModel) submitFolderAgentInput(parsed assistant.ParsedInput) (RootModel, tea.Cmd) {
	if strings.TrimSpace(parsed.AgentInput) == "" {
		parsed.AgentInput = parsed.Raw
	}
	if strings.TrimSpace(parsed.SuggestedSlash) == "" {
		parsed.SuggestedSlash = "/configure <path> --dry-run"
	}
	if m.connectionStatus == "offline" {
		message := "Relaybase daemon is unavailable. Start it with: " + m.relaybaseServeCommand() + ". Then retry this message or use Slash fallback: " + parsed.SuggestedSlash + "."
		m.recordAssistantInteraction(assistant.ResponseBlocked, parsed.Raw, message)
		m.refreshAssistantPrompt()
		return m, nil
	}
	if m.agentConfig == nil {
		message := "Agent Gateway config is unavailable, so folder setup cannot use the Operator Agent yet. Start or retry the daemon with: " + m.relaybaseServeCommand() + ". Slash fallback: " + parsed.SuggestedSlash + "."
		m.recordAssistantInteraction(assistant.ResponseBlocked, parsed.Raw, message)
		m.refreshAssistantPrompt()
		return m, nil
	}
	if !m.agentConfig.Enabled {
		message := "Operator Agent is disabled for natural-language folder setup. Enable it in daemon config for model-backed setup. Slash fallback: " + parsed.SuggestedSlash + ". Daemon start command if needed: " + m.relaybaseServeCommand() + "."
		m.recordAssistantInteraction(assistant.ResponseBlocked, parsed.Raw, message)
		m.refreshAssistantPrompt()
		return m, nil
	}
	return m.submitAgentInput(parsed.AgentInput)
}

func (m RootModel) submitSlashCommand(input string) (RootModel, tea.Cmd) {
	command, err := slash.Parse(input)
	if err != nil {
		m.addAssistantMessage(err.Error())
		return m, nil
	}

	switch command.Kind {
	case slash.KindConfirm:
		if m.pendingConfirm == nil {
			m.addAssistantMessage("No pending action to confirm.")
			return m, nil
		}
		return m, m.executePendingConfirmation()
	case slash.KindCancel:
		m.pendingConfirm = nil
		m.addAssistantMessage("Confirmation cancelled.")
		return m, nil
	}

	if slash.RequiresConfirmation(command) && (m.pendingConfirm != nil || m.pendingAgentApproval != nil) {
		m.addAssistantMessage("Finish or cancel the pending approval before starting another destructive action.")
		return m, nil
	}

	if slash.RequiresConfirmation(command) && !command.Confirm {
		confirmation, err := m.prepareConfirmation(command)
		if err != nil {
			m.addAssistantMessage(err.Error())
			return m, nil
		}
		m.pendingConfirm = confirmation
		m.refreshAssistantPrompt()
		return m, nil
	}

	return m.executeSlashCommand(command)
}

func (m RootModel) submitNaturalCommand(parsed assistant.ParsedInput) (RootModel, tea.Cmd) {
	command := parsed.Command
	if slash.RequiresConfirmation(command) && (m.pendingConfirm != nil || m.pendingAgentApproval != nil) {
		m.recordAssistantError(parsed.Raw, assistant.ParseError{
			ResponseType: assistant.ResponseBlocked,
			Message:      "Finish or cancel the pending approval before starting another destructive action.",
		})
		return m, nil
	}
	if slash.RequiresConfirmation(command) && !command.Confirm {
		confirmation, err := m.prepareConfirmation(command)
		if err != nil {
			m.recordAssistantError(parsed.Raw, err)
			return m, nil
		}
		confirmation.AssistantInput = parsed.Raw
		m.pendingConfirm = confirmation
		message := confirmationPreviewMessage(*confirmation)
		m.recordAssistantInteraction(assistant.ResponseActionPreview, parsed.Raw, message)
		m.refreshAssistantPrompt()
		return m, nil
	}

	if err := m.validateNaturalCommand(command); err != nil {
		m.recordAssistantError(parsed.Raw, err)
		return m, nil
	}
	updated, cmd := m.executeSlashCommand(command)
	updated.recordAssistantInteraction(parsed.ResponseType, parsed.Raw, naturalCommandResultMessage(command))
	updated.refreshAssistantPrompt()
	return updated, cmd
}

func (m RootModel) submitAgentInput(input string) (RootModel, tea.Cmd) {
	content := strings.TrimSpace(input)
	if content == "" {
		m.addAssistantMessage("Enter an Operator Agent message.")
		return m, nil
	}
	if m.agentConfig != nil && !m.agentConfig.Enabled {
		m.addAssistantMessage("Operator Agent is disabled; slash commands and deterministic local commands remain available.")
		return m, nil
	}

	m.addAssistantMessage("You: " + content)
	m.agentStatus = "sending"
	context := m.agentContext()
	if m.agentSession == nil || m.agentSession.ID == "" {
		m.agentPendingInput = content
		return m, commands.CreateAgentSessionCmd(m.ctx, m.client, relaybaseclient.AgentSessionCreateRequest{
			Title:   "Relaybase TUI",
			Context: context,
		})
	}

	cmds := []tea.Cmd{
		commands.SendAgentMessageCmd(m.ctx, m.client, m.agentSession.ID, relaybaseclient.AgentMessageRequest{
			Content: content,
			Context: context,
		}),
	}
	if m.agentStream == nil {
		cmds = append(cmds, commands.ConnectAgentEventsCmd(m.ctx, m.client, m.agentSession.ID))
	}
	return m, tea.Batch(cmds...)
}

func (m RootModel) shouldUseAgentGateway() bool {
	return m.agentConfig != nil && m.agentConfig.Enabled
}

func (m RootModel) validateNaturalCommand(command slash.ParsedCommand) error {
	switch command.Kind {
	case slash.KindPaneColor, slash.KindPin, slash.KindUnpin:
		_, err := slash.ResolvePaneTarget(m.slashContext(), command.Target)
		return err
	default:
		return nil
	}
}

func (m RootModel) prepareConfirmation(command slash.ParsedCommand) (*confirmationRequest, error) {
	switch command.Kind {
	case slash.KindLaunch, slash.KindStop, slash.KindRestart:
		target, err := slash.ResolveLifecycleTarget(m.slashContext(), command.Target)
		if err != nil {
			return nil, err
		}
		action := lifecycleActionForCommand(command)
		return &confirmationRequest{
			Action:          action,
			Target:          target,
			Risk:            lifecycleRisk(action),
			Expected:        fmt.Sprintf("Daemon returns operation ids for %d app request(s).", len(target.AppIDs)),
			Command:         command,
			LifecycleAction: action,
		}, nil
	case slash.KindLogsExport:
		target, err := slash.ResolveExportTarget(m.slashContext(), command)
		if err != nil {
			return nil, err
		}
		request := exportRequestForTarget(command.Scope, target)
		return &confirmationRequest{
			Action:        "export logs",
			Target:        target,
			Risk:          "Writes a redacted log export artifact; logs may include sensitive operational context.",
			Expected:      "Daemon writes a redacted export and returns its export id/path.",
			Command:       command,
			ExportRequest: &request,
		}, nil
	case slash.KindDaemonRepair:
		if !m.daemonBootstrapAvailable() {
			return nil, errors.New(m.daemonBridgeUnavailableMessage("repair"))
		}
		return &confirmationRequest{
			Action:       "repair daemon",
			Target:       slash.ResolvedTarget{Description: m.cfg.BaseURL},
			Risk:         "Starts or reconnects the local Relaybase control-plane daemon. It does not start user apps.",
			Expected:     "The launch bridge starts Relaybase if needed and the TUI refreshes daemon state.",
			Command:      command,
			DaemonRepair: true,
		}, nil
	case slash.KindAddApp, slash.KindConfigure, slash.KindRegister, slash.KindOpen, slash.KindProve, slash.KindHealthProve,
		slash.KindManifestEdit, slash.KindHealthRoute, slash.KindPortPinned, slash.KindComponentRole, slash.KindComponentGroup, slash.KindComponentLabel:
		target, risk, expected, err := m.setupConfirmationText(command)
		if err != nil {
			return nil, err
		}
		return &confirmationRequest{
			Action:       setupActionLabel(command),
			Target:       target,
			Risk:         risk,
			Expected:     expected,
			Command:      command,
			SetupCommand: &command,
		}, nil
	default:
		return nil, fmt.Errorf("command does not require confirmation")
	}
}

func (m *RootModel) executePendingConfirmation() tea.Cmd {
	confirmation := m.pendingConfirm
	if confirmation == nil {
		m.addAssistantMessage("No pending action to confirm.")
		return nil
	}
	m.pendingConfirm = nil
	message := fmt.Sprintf("Confirmed %s for %s.", confirmation.Action, confirmation.Target.Description)
	if confirmation.AssistantInput != "" {
		m.recordAssistantInteraction(assistant.ResponseActionResult, confirmation.AssistantInput, message)
		m.lastNaturalAction = confirmation.AssistantInput
		m.refreshAssistantPrompt()
	} else {
		m.addAssistantMessage(message)
	}
	if confirmation.ExportRequest != nil {
		return commands.ExportLogsCmd(m.ctx, m.client, *confirmation.ExportRequest)
	}
	if confirmation.SetupCommand != nil {
		cmd, err := m.setupCmdForCommand(*confirmation.SetupCommand, true)
		if err != nil {
			m.addAssistantMessage(err.Error())
			return nil
		}
		return cmd
	}
	if confirmation.DaemonRepair {
		return commands.DaemonBootstrapEnsureCmd(m.ctx, m.bootstrapClient)
	}
	return commands.LifecycleRequestBatchCmd(m.ctx, m.client, confirmation.Target.AppIDs, confirmation.LifecycleAction)
}

func (m RootModel) executeSlashCommand(command slash.ParsedCommand) (RootModel, tea.Cmd) {
	switch command.Kind {
	case slash.KindLaunch, slash.KindStop, slash.KindRestart:
		target, err := slash.ResolveLifecycleTarget(m.slashContext(), command.Target)
		if err != nil {
			m.addAssistantMessage(err.Error())
			return m, nil
		}
		action := lifecycleActionForCommand(command)
		m.addAssistantMessage(fmt.Sprintf("Requesting %s for %s.", action, target.Description))
		return m, commands.LifecycleRequestBatchCmd(m.ctx, m.client, target.AppIDs, action)
	case slash.KindLogsExport:
		target, err := slash.ResolveExportTarget(m.slashContext(), command)
		if err != nil {
			m.addAssistantMessage(err.Error())
			return m, nil
		}
		request := exportRequestForTarget(command.Scope, target)
		m.addAssistantMessage("Requesting redacted log export for " + target.Description + ".")
		return m, commands.ExportLogsCmd(m.ctx, m.client, request)
	case slash.KindPage:
		switch command.Page {
		case "next":
			m.paneManager.NextPage()
		case "prev":
			m.paneManager.PreviousPage()
		default:
			m.paneManager.SetPage(command.PageNumber - 1)
		}
		m.addAssistantMessage(fmt.Sprintf("Page %d/%d.", m.paneManager.Page()+1, m.paneManager.PageCount()))
		return m, m.persistPreferencesCmd()
	case slash.KindPaneColor:
		target, err := slash.ResolvePaneTarget(m.slashContext(), command.Target)
		if err != nil {
			m.addAssistantMessage(err.Error())
			return m, nil
		}
		if !m.paneManager.SetPaneColor(target.PaneID, command.Color) {
			m.addAssistantMessage("Could not change pane color for " + target.Description + ".")
			return m, nil
		}
		m.addAssistantMessage(fmt.Sprintf("Pane color set to %s for %s.", command.Color, target.Description))
		return m, m.persistPreferencesCmd()
	case slash.KindPin, slash.KindUnpin:
		target, err := slash.ResolvePaneTarget(m.slashContext(), command.Target)
		if err != nil {
			m.addAssistantMessage(err.Error())
			return m, nil
		}
		pinned := command.Kind == slash.KindPin
		if !m.paneManager.SetPanePinned(target.PaneID, pinned) {
			m.addAssistantMessage("Could not update pin for " + target.Description + ".")
			return m, nil
		}
		if pinned {
			m.addAssistantMessage("Pinned " + target.Description + ".")
		} else {
			m.addAssistantMessage("Unpinned " + target.Description + ".")
		}
		return m, m.persistPreferencesCmd()
	case slash.KindTheme:
		m.applyTheme(command.Theme)
		m.addAssistantMessage("Theme set to " + command.Theme + ".")
		return m, m.persistPreferencesCmd()
	case slash.KindHelp:
		m.helpVisible = true
		m.addAssistantMessage("Showing command help.")
		return m, nil
	case slash.KindDaemonStatus:
		if !m.daemonBootstrapAvailable() {
			m.addAssistantMessage(m.daemonBridgeUnavailableMessage("status"))
			return m, nil
		}
		m.addAssistantMessage("Checking Relaybase daemon through the local launch bridge.")
		return m, commands.DaemonBootstrapStatusCmd(m.ctx, m.bootstrapClient)
	case slash.KindDaemonRepair:
		if !m.daemonBootstrapAvailable() {
			m.addAssistantMessage(m.daemonBridgeUnavailableMessage("repair"))
			return m, nil
		}
		m.addAssistantMessage("Requesting Relaybase daemon repair through the local launch bridge.")
		return m, commands.DaemonBootstrapEnsureCmd(m.ctx, m.bootstrapClient)
	case slash.KindThreadList:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			return m, nil
		}
		m.addAssistantMessage("Listing daemon-backed Operator Agent threads.")
		return m, commands.ListAgentSessionsCmd(m.ctx, m.client)
	case slash.KindThreadNew:
		return m, m.startNewAssistantThread(command.Value)
	case slash.KindThreadSwitch:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			return m, nil
		}
		sessionID, err := m.resolveAgentSessionTarget(command.Target)
		if err != nil {
			m.addAssistantMessage(err.Error())
			return m, nil
		}
		m.addAssistantMessage("Switching Operator Agent thread to " + sessionID + ".")
		return m, commands.ActivateAgentSessionCmd(m.ctx, m.client, sessionID)
	case slash.KindThreadRename:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			return m, nil
		}
		sessionID := m.agentSessionID()
		if sessionID == "" {
			m.addAssistantMessage("No daemon-backed Operator Agent thread is active. Use /thread new <title> first.")
			return m, nil
		}
		m.addAssistantMessage("Renaming active Operator Agent thread.")
		return m, commands.UpdateAgentSessionCmd(m.ctx, m.client, sessionID, relaybaseclient.AgentSessionUpdateRequest{Title: command.Value}, "renamed")
	case slash.KindThreadClear:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			return m, nil
		}
		sessionID := m.agentSessionID()
		if sessionID == "" {
			m.addAssistantMessage("No daemon-backed Operator Agent thread is active.")
			return m, nil
		}
		m.addAssistantMessage("Clearing active Operator Agent thread through the daemon.")
		return m, commands.ClearAgentSessionCmd(m.ctx, m.client, sessionID)
	case slash.KindThreadExport:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			return m, nil
		}
		sessionID := m.agentSessionID()
		if sessionID == "" {
			m.addAssistantMessage("No daemon-backed Operator Agent thread is active for export.")
			return m, nil
		}
		m.addAssistantMessage("Requesting redacted Operator Agent thread export as " + command.Format + ".")
		return m, commands.ExportAgentSessionCmd(m.ctx, m.client, sessionID, relaybaseclient.AgentSessionExportRequest{Format: command.Format})
	case slash.KindThreadPreview:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			return m, nil
		}
		sessionID := m.agentSessionID()
		if sessionID == "" {
			m.addAssistantMessage("No daemon-backed Operator Agent thread is active for context preview.")
			return m, nil
		}
		m.addAssistantMessage("Fetching Operator Agent active-thread context preview.")
		return m, commands.FetchAgentSessionContextPreviewCmd(m.ctx, m.client, sessionID)
	case slash.KindAddApp, slash.KindConfigure, slash.KindRegister, slash.KindOpen, slash.KindProve, slash.KindHealthProve,
		slash.KindRepair, slash.KindManifestInspect, slash.KindManifestEdit, slash.KindHealthRoute, slash.KindPortPinned,
		slash.KindComponentRole, slash.KindComponentGroup, slash.KindComponentLabel:
		cmd, err := m.setupCmdForCommand(command, command.Confirm)
		if err != nil {
			m.addAssistantMessage(err.Error())
			return m, nil
		}
		m.addAssistantMessage(setupRequestMessage(command))
		return m, cmd
	default:
		m.addAssistantMessage("Unsupported command. Use /help.")
		return m, nil
	}
}

func (m RootModel) setupCmdForCommand(command slash.ParsedCommand, confirmed bool) (tea.Cmd, error) {
	switch command.Kind {
	case slash.KindAddApp:
		request, err := m.setupPlanRequestForCommand(command)
		if err != nil {
			return nil, err
		}
		if confirmed {
			return commands.SetupApplyCmd(m.ctx, m.client, relaybaseclient.SetupApplyRequest{
				SetupPlanRequest: request,
				Confirm:          true,
				Confirmation:     &relaybaseclient.SetupConfirmation{Confirmed: true, Reason: "TUI setup confirmation"},
			}), nil
		}
		return commands.SetupPreviewCmd(m.ctx, m.client, request), nil
	case slash.KindConfigure:
		request, err := m.setupPlanRequestForCommand(command)
		if err != nil {
			return nil, err
		}
		if command.DryRun || !confirmed {
			return commands.SetupPreviewCmd(m.ctx, m.client, request), nil
		}
		return commands.SetupApplyCmd(m.ctx, m.client, relaybaseclient.SetupApplyRequest{
			SetupPlanRequest: request,
			Confirm:          true,
			Confirmation:     &relaybaseclient.SetupConfirmation{Confirmed: true, Reason: "TUI configure confirmation"},
		}), nil
	case slash.KindRegister:
		request, err := m.registerManifestRequest(command.Path)
		if err != nil {
			return nil, err
		}
		return commands.SetupRegisterManifestCmd(m.ctx, m.client, request), nil
	case slash.KindOpen:
		cwd, err := m.cwdForSetupTarget(command.Target)
		if err != nil {
			return nil, err
		}
		return commands.SetupOpenCmd(m.ctx, m.client, relaybaseclient.OpenProjectRequest{
			CWD:          cwd,
			NoBrowser:    true,
			Confirm:      true,
			Confirmation: &relaybaseclient.SetupConfirmation{Confirmed: true, Reason: "TUI open confirmation"},
		}), nil
	case slash.KindProve, slash.KindHealthProve:
		request, err := m.proveRequestForTarget(command.Target)
		if err != nil {
			return nil, err
		}
		request.Confirm = true
		request.Confirmation = &relaybaseclient.SetupConfirmation{Confirmed: true, Reason: "TUI health proof confirmation"}
		return commands.SetupProveCmd(m.ctx, m.client, request), nil
	case slash.KindRepair:
		cwd, err := m.cwdForSetupTarget(command.Target)
		if err != nil {
			return nil, err
		}
		return commands.SetupRepairCmd(m.ctx, m.client, relaybaseclient.RepairSetupRequest{
			SetupPlanRequest: relaybaseclient.SetupPlanRequest{CWD: cwd},
			Reason:           "Requested from Relaybase TUI",
		}), nil
	case slash.KindManifestInspect:
		request, err := m.registerManifestRequest(command.Target)
		if err != nil {
			return nil, err
		}
		return commands.SetupInspectManifestCmd(m.ctx, m.client, request), nil
	case slash.KindManifestEdit, slash.KindHealthRoute, slash.KindPortPinned, slash.KindComponentRole, slash.KindComponentGroup, slash.KindComponentLabel:
		request, err := m.manifestPatchRequestForCommand(command)
		if err != nil {
			return nil, err
		}
		if confirmed {
			request.Confirm = true
			request.Confirmation = &relaybaseclient.SetupConfirmation{Confirmed: true, Reason: "TUI manifest edit confirmation"}
			return commands.SetupApplyManifestPatchCmd(m.ctx, m.client, request), nil
		}
		return commands.SetupPreviewManifestPatchCmd(m.ctx, m.client, request), nil
	default:
		return nil, fmt.Errorf("unsupported setup command")
	}
}

func (m RootModel) setupPlanRequestForCommand(command slash.ParsedCommand) (relaybaseclient.SetupPlanRequest, error) {
	cwd, err := m.cwdForSetupTarget(command.Path)
	if err != nil {
		return relaybaseclient.SetupPlanRequest{}, err
	}
	request := relaybaseclient.SetupPlanRequest{CWD: cwd, CurrentDirectory: m.cfg.CurrentDirectory}
	if command.Command != "" {
		request.ComponentMetadata = relaybaseclient.ComponentSetupMetadata{
			Command: command.Command,
			CWD:     cwd,
		}
	}
	return request, nil
}

func (m RootModel) setupConfirmationText(command slash.ParsedCommand) (slash.ResolvedTarget, string, string, error) {
	description := setupTargetDescription(command)
	switch command.Kind {
	case slash.KindAddApp, slash.KindConfigure:
		cwd, err := m.cwdForSetupTarget(command.Path)
		if err != nil {
			return slash.ResolvedTarget{}, "", "", err
		}
		description = "project " + cwd
	case slash.KindRegister, slash.KindManifestInspect:
		request, err := m.registerManifestRequest(firstNonEmpty(command.Path, command.Target))
		if err != nil {
			return slash.ResolvedTarget{}, "", "", err
		}
		description = "manifest " + request.ManifestPath
	case slash.KindOpen, slash.KindRepair:
		cwd, err := m.cwdForSetupTarget(command.Target)
		if err != nil {
			return slash.ResolvedTarget{}, "", "", err
		}
		description = "project " + cwd
	case slash.KindProve, slash.KindHealthProve:
		request, err := m.proveRequestForTarget(command.Target)
		if err != nil {
			return slash.ResolvedTarget{}, "", "", err
		}
		description = "health proof for " + firstNonEmpty(request.AppID, request.CWD)
	case slash.KindManifestEdit, slash.KindHealthRoute, slash.KindPortPinned, slash.KindComponentRole, slash.KindComponentGroup, slash.KindComponentLabel:
		request, err := m.manifestPatchRequestForCommand(command)
		if err != nil {
			return slash.ResolvedTarget{}, "", "", err
		}
		description = "manifest " + request.ManifestPath
	}
	return slash.ResolvedTarget{Description: description}, setupRisk(command), setupExpected(command), nil
}

func (m RootModel) cwdForSetupTarget(target string) (string, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" || strings.EqualFold(trimmed, "current") || strings.EqualFold(trimmed, "cwd") ||
		strings.EqualFold(trimmed, "current folder") || strings.EqualFold(trimmed, "current directory") {
		if strings.TrimSpace(m.cfg.CurrentDirectory) == "" {
			return "", fmt.Errorf("Current-directory context is unavailable. Use /configure <path> --dry-run.")
		}
		return m.cfg.CurrentDirectory, nil
	}
	if looksLikePath(trimmed) {
		return trimmed, nil
	}
	app, err := m.appForTarget(trimmed)
	if err != nil {
		return "", err
	}
	manifestPath := setupwizard.ManifestPathFromApp(app)
	if manifestPath == "" {
		return "", fmt.Errorf("App %s does not expose a manifest path in daemon state; use an explicit project path.", app.ID)
	}
	return setupwizard.CWDFromManifestPath(manifestPath), nil
}

func (m RootModel) registerManifestRequest(target string) (relaybaseclient.RegisterManifestRequest, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" || strings.EqualFold(trimmed, "current") {
		app := m.paneManager.SelectedPane()
		if app == nil || app.AppID == "" {
			return relaybaseclient.RegisterManifestRequest{}, fmt.Errorf("No selected app is available for manifest lookup.")
		}
		trimmed = app.AppID
	}
	if looksLikeManifestPath(trimmed) {
		return relaybaseclient.RegisterManifestRequest{ManifestPath: trimmed, CWD: maybeDir(trimmed)}, nil
	}
	app, err := m.appForTarget(trimmed)
	if err != nil {
		return relaybaseclient.RegisterManifestRequest{}, err
	}
	manifestPath := setupwizard.ManifestPathFromApp(app)
	if manifestPath == "" {
		return relaybaseclient.RegisterManifestRequest{}, fmt.Errorf("App %s does not expose a manifest path in daemon state; provide an explicit relaybase.app.json path.", app.ID)
	}
	return relaybaseclient.RegisterManifestRequest{ManifestPath: manifestPath, CWD: setupwizard.CWDFromManifestPath(manifestPath)}, nil
}

func (m RootModel) proveRequestForTarget(target string) (relaybaseclient.ProveHealthRequest, error) {
	if looksLikePath(target) || strings.EqualFold(strings.TrimSpace(target), "current") || strings.TrimSpace(target) == "" {
		cwd, err := m.cwdForSetupTarget(target)
		return relaybaseclient.ProveHealthRequest{CWD: cwd, LifecycleProof: true}, err
	}
	app, err := m.appForTarget(target)
	if err != nil {
		return relaybaseclient.ProveHealthRequest{}, err
	}
	cwd := setupwizard.CWDFromManifestPath(setupwizard.ManifestPathFromApp(app))
	if cwd == "" {
		return relaybaseclient.ProveHealthRequest{}, fmt.Errorf("App %s does not expose a manifest path in daemon state; use /prove <project-path>.", app.ID)
	}
	return relaybaseclient.ProveHealthRequest{CWD: cwd, AppID: app.ID, LifecycleProof: true}, nil
}

func (m RootModel) manifestPatchRequestForCommand(command slash.ParsedCommand) (relaybaseclient.ManifestPatchRequest, error) {
	target := command.Target
	if command.Kind == slash.KindManifestEdit {
		target = "current"
	}
	request, err := m.registerManifestRequest(target)
	if err != nil {
		return relaybaseclient.ManifestPatchRequest{}, err
	}
	patch, err := patchForSetupCommand(command)
	if err != nil {
		return relaybaseclient.ManifestPatchRequest{}, err
	}
	return relaybaseclient.ManifestPatchRequest{
		CWD:          request.CWD,
		ManifestPath: request.ManifestPath,
		Patch:        patch,
	}, nil
}

func (m RootModel) appForTarget(target string) (relaybaseclient.AppState, error) {
	normalized := strings.ToLower(strings.TrimSpace(target))
	if normalized == "" || normalized == "current" || normalized == "selected" || normalized == "pane" {
		pane := m.paneManager.SelectedPane()
		if pane == nil || pane.AppID == "" {
			return relaybaseclient.AppState{}, fmt.Errorf("No selected app is available.")
		}
		normalized = strings.ToLower(pane.AppID)
	}
	if m.state == nil {
		return relaybaseclient.AppState{}, fmt.Errorf("Daemon state is unavailable; setup target %q cannot be resolved.", target)
	}
	matches := []relaybaseclient.AppState{}
	for _, app := range m.state.Apps {
		if strings.ToLower(app.ID) == normalized || strings.ToLower(app.Name) == normalized {
			matches = append(matches, app)
		}
	}
	if len(matches) == 0 {
		return relaybaseclient.AppState{}, fmt.Errorf("Unknown app %q. Use an exact app id or a project/manifest path.", target)
	}
	if len(matches) > 1 {
		options := []string{}
		for _, app := range matches {
			options = append(options, app.ID)
		}
		return relaybaseclient.AppState{}, fmt.Errorf("App target %q is ambiguous. Choose one of: %s.", target, strings.Join(options, ", "))
	}
	return matches[0], nil
}

func patchForSetupCommand(command slash.ParsedCommand) (map[string]any, error) {
	switch command.Kind {
	case slash.KindManifestEdit:
		return patchForManifestField(command.Field, command.Value)
	case slash.KindHealthRoute:
		if strings.TrimSpace(command.Route) == "" {
			return nil, fmt.Errorf("Health route cannot be empty.")
		}
		return map[string]any{"healthUrl": command.Route}, nil
	case slash.KindPortPinned:
		return map[string]any{"upstreamPort": command.Port}, nil
	case slash.KindComponentRole:
		return map[string]any{"relaybase": map[string]any{"componentRole": command.Value}}, nil
	case slash.KindComponentGroup:
		return map[string]any{"relaybase": map[string]any{"groupId": command.Value}}, nil
	case slash.KindComponentLabel:
		return map[string]any{"relaybase": map[string]any{"paneLabel": command.Value}}, nil
	default:
		return nil, fmt.Errorf("unsupported manifest patch command")
	}
}

func patchForManifestField(field string, value string) (map[string]any, error) {
	normalized := strings.TrimSpace(field)
	switch normalized {
	case "id", "name", "command", "cwd", "protocol", "healthUrl":
		return map[string]any{normalized: value}, nil
	case "upstreamPort", "relaybase.paneOrder":
		var parsed int
		if _, err := fmt.Sscanf(strings.TrimSpace(value), "%d", &parsed); err != nil || parsed <= 0 {
			return nil, fmt.Errorf("%s must be a positive number.", normalized)
		}
		if normalized == "upstreamPort" {
			return map[string]any{"upstreamPort": parsed}, nil
		}
		return map[string]any{"relaybase": map[string]any{"paneOrder": parsed}}, nil
	case "relaybase.groupId":
		return map[string]any{"relaybase": map[string]any{"groupId": value}}, nil
	case "relaybase.componentRole":
		return map[string]any{"relaybase": map[string]any{"componentRole": value}}, nil
	case "relaybase.displayName":
		return map[string]any{"relaybase": map[string]any{"displayName": value}}, nil
	case "relaybase.paneLabel":
		return map[string]any{"relaybase": map[string]any{"paneLabel": value}}, nil
	default:
		return nil, fmt.Errorf("Manifest field %q is not supported by the TUI safe edit surface.", field)
	}
}

func setupActionLabel(command slash.ParsedCommand) string {
	switch command.Kind {
	case slash.KindAddApp:
		return "add app"
	case slash.KindConfigure:
		return "configure project"
	case slash.KindRegister:
		return "register manifest"
	case slash.KindOpen:
		return "open project"
	case slash.KindProve, slash.KindHealthProve:
		return "prove health"
	case slash.KindManifestEdit, slash.KindHealthRoute, slash.KindPortPinned, slash.KindComponentRole, slash.KindComponentGroup, slash.KindComponentLabel:
		return "edit manifest"
	default:
		return "setup action"
	}
}

func setupRisk(command slash.ParsedCommand) string {
	switch command.Kind {
	case slash.KindOpen:
		return "Daemon may register a manifest, start an app, and expose a route."
	case slash.KindProve, slash.KindHealthProve:
		return "Daemon may write proof artifacts and run lifecycle checks."
	case slash.KindRegister:
		return "Daemon registers the manifest into Relaybase state."
	case slash.KindManifestEdit, slash.KindHealthRoute, slash.KindPortPinned, slash.KindComponentRole, slash.KindComponentGroup, slash.KindComponentLabel:
		return "Daemon writes an approved manifest patch."
	default:
		return "Daemon may write setup files and register a manifest."
	}
}

func setupExpected(command slash.ParsedCommand) string {
	switch command.Kind {
	case slash.KindManifestEdit, slash.KindHealthRoute, slash.KindPortPinned, slash.KindComponentRole, slash.KindComponentGroup, slash.KindComponentLabel:
		return "Daemon applies the safe manifest patch and refreshed state is fetched."
	case slash.KindRegister:
		return "Daemon returns a registered app record and refreshed state is fetched."
	case slash.KindOpen:
		return "Daemon returns open/project diagnostics and refreshed state is fetched."
	case slash.KindProve, slash.KindHealthProve:
		return "Daemon returns health proof diagnostics."
	default:
		return "Daemon applies the selected setup plan and refreshed state is fetched."
	}
}

func setupTargetDescription(command slash.ParsedCommand) string {
	return firstNonEmpty(command.Target, command.Path, command.Field, "setup target")
}

func setupRequestMessage(command slash.ParsedCommand) string {
	if command.Kind == slash.KindConfigure && command.DryRun {
		return "Requesting setup dry-run preview from daemon."
	}
	if command.Kind == slash.KindRepair {
		return "Requesting setup repair choices from daemon."
	}
	if command.Kind == slash.KindManifestInspect {
		return "Requesting manifest inspection from daemon."
	}
	return "Requesting " + setupActionLabel(command) + " through daemon setup API."
}

func setupDetectCWD(result *relaybaseclient.SetupDetectResult) string {
	if result == nil {
		return ""
	}
	return result.CWD
}

func setupChoiceCount(result *relaybaseclient.SetupPlansResult) int {
	if result == nil {
		return 0
	}
	return len(result.Choices)
}

func setupWriteCount(result *relaybaseclient.SetupPlanPreview) int {
	if result == nil {
		return 0
	}
	return len(result.FileWritePlan.Writes)
}

func setupAppliedCount(result *relaybaseclient.SetupApplyResult) int {
	if result == nil {
		return 0
	}
	return len(result.AppliedFiles)
}

func setupRegisterLabel(result *relaybaseclient.RegisterManifestResult) string {
	if result == nil {
		return "manifest"
	}
	return valueOr(result.App.ID, result.ManifestPath)
}

func setupPatchLabel(result *relaybaseclient.ManifestPatchResult) string {
	if result == nil {
		return "manifest"
	}
	return valueOr(result.App.ID, result.ManifestPath)
}

func setupOpenCWD(result *relaybaseclient.OpenProjectResult) string {
	if result == nil {
		return ""
	}
	return result.Plan.CWD
}

func setupProveCWD(result *relaybaseclient.ProveHealthResult) string {
	if result == nil {
		return ""
	}
	return result.CWD
}

func setupRepairChoiceCount(result *relaybaseclient.RepairSetupResult) int {
	if result == nil {
		return 0
	}
	return len(result.Plan.Choices)
}

func looksLikeManifestPath(value string) bool {
	trimmed := strings.TrimSpace(value)
	return looksLikePath(trimmed) || strings.HasSuffix(strings.ToLower(trimmed), ".json")
}

func looksLikePath(value string) bool {
	trimmed := strings.TrimSpace(value)
	return strings.Contains(trimmed, "/") || strings.Contains(trimmed, `\`) || strings.HasPrefix(trimmed, ".")
}

func maybeDir(pathValue string) string {
	if !looksLikePath(pathValue) {
		return ""
	}
	return filepath.Dir(pathValue)
}

func (m *RootModel) openContextMenu() {
	m.resetBodyScroll()
	if m.commandActive {
		m.contextMenu = contextmenu.AssistantMenu(m.assistantMenuOptions())
		return
	}
	m.contextMenu = contextmenu.PaneMenu(
		m.paneManager.SelectedPane(),
		contextmenu.PaneMenuOptions{
			CanReopen:        m.paneManager.CanReopen(),
			DaemonStateKnown: true,
			DaemonConnected:  m.connectionStatus == "connected",
		},
	)
}

func (m *RootModel) executeContextMenuSelection() tea.Cmd {
	item := m.contextMenu.SelectedItem()
	if item == nil {
		m.contextMenu = contextmenu.Menu{}
		return nil
	}
	if !item.Enabled {
		m.addAssistantMessage(menuUnavailableMessage(*item))
		m.contextMenu = contextmenu.Menu{}
		return nil
	}

	action := item.Action
	m.contextMenu = contextmenu.Menu{}
	switch action {
	case contextmenu.ActionPaneClose:
		m.paneManager.CloseSelected()
		m.addAssistantMessage("Pane closed.")
		return m.persistPreferencesCmd()
	case contextmenu.ActionPanePinToggle:
		before := m.paneManager.SelectedPane()
		m.paneManager.TogglePinSelected()
		after := m.paneManager.SelectedPane()
		if before != nil && after != nil && after.Pinned {
			m.addAssistantMessage("Pinned " + before.Title + ".")
		} else if before != nil {
			m.addAssistantMessage("Unpinned " + before.Title + ".")
		}
		return m.persistPreferencesCmd()
	case contextmenu.ActionPaneReopen:
		if m.paneManager.ReopenSelectedOrFirstAvailable() {
			m.addAssistantMessage("Reopened pane.")
			return m.persistPreferencesCmd()
		}
		m.addAssistantMessage("No hidden or stopped pane is available to reopen.")
		return nil
	case contextmenu.ActionPaneColor:
		color, ok := m.paneManager.CycleSelectedColor(paneColorPalette)
		if !ok {
			m.addAssistantMessage("No selected pane is available for color changes.")
			return nil
		}
		m.addAssistantMessage("Pane color set to " + color + ".")
		return m.persistPreferencesCmd()
	case contextmenu.ActionPaneCopyRoute:
		pane := m.paneManager.SelectedPane()
		if pane == nil || pane.RouteLabel == "" {
			m.addAssistantMessage("Selected pane has no route to show.")
			return nil
		}
		m.addAssistantMessage("Route: " + pane.RouteLabel)
		return nil
	case contextmenu.ActionPaneExportLogs:
		return m.confirmMenuCommand(slash.ParsedCommand{Kind: slash.KindLogsExport, Scope: slash.ScopePane, Target: "current"})
	case contextmenu.ActionPaneStop:
		return m.confirmMenuCommand(slash.ParsedCommand{Kind: slash.KindStop, Target: "current"})
	case contextmenu.ActionPaneRestart:
		return m.confirmMenuCommand(slash.ParsedCommand{Kind: slash.KindRestart, Target: "current"})
	case contextmenu.ActionPaneDiagnostics:
		m.addAssistantMessage(m.menuDiagnosticsMessage())
		return nil
	case contextmenu.ActionAssistantHistory:
		m.historyExpanded = !m.historyExpanded
		if m.historyExpanded {
			m.addAssistantMessage("Assistant history expanded.")
		} else {
			m.addAssistantMessage("Assistant history collapsed.")
		}
		return nil
	case contextmenu.ActionAssistantNewThread:
		return m.startNewAssistantThread("")
	case contextmenu.ActionAssistantClearInput:
		m.commandInput = ""
		m.commandActive = false
		m.addAssistantMessage("Assistant input cleared.")
		return nil
	case contextmenu.ActionAssistantBarColor:
		color := m.cycleAssistantBarColor()
		m.addAssistantMessage("Assistant bar color set to " + color + ".")
		return m.persistPreferencesCmd()
	case contextmenu.ActionAssistantExportChat:
		sessionID := m.agentSessionID()
		if sessionID == "" {
			m.addDiagnostic("assistant_chat_export_unavailable", "info", "Chat export needs a daemon-backed active Operator Agent thread.")
			m.addAssistantMessage("Chat export is unavailable without a daemon-backed active Operator Agent thread.")
			return nil
		}
		m.addAssistantMessage("Requesting redacted Operator Agent thread export.")
		return commands.ExportAgentSessionCmd(m.ctx, m.client, sessionID, relaybaseclient.AgentSessionExportRequest{Format: "markdown"})
	case contextmenu.ActionAssistantCommandHelp:
		m.helpVisible = true
		m.addAssistantMessage("Showing command help.")
		return nil
	case contextmenu.ActionAssistantLLMMode:
		m.reportAssistantProviderStatus()
		return nil
	default:
		m.addAssistantMessage("Menu action is unavailable.")
		return nil
	}
}

func (m *RootModel) confirmMenuCommand(command slash.ParsedCommand) tea.Cmd {
	confirmation, err := m.prepareConfirmation(command)
	if err != nil {
		m.addAssistantMessage(err.Error())
		return nil
	}
	m.pendingConfirm = confirmation
	m.refreshAssistantPrompt()
	return nil
}

func menuUnavailableMessage(item contextmenu.Item) string {
	if item.DisabledReason != "" {
		return item.Label + " is unavailable: " + item.DisabledReason + "."
	}
	return item.Label + " is unavailable."
}

func (m RootModel) menuDiagnosticsMessage() string {
	return m.diagnosticsSummary()
}

func (m RootModel) executeShowLogsIntent(parsed assistant.ParsedInput) (RootModel, tea.Cmd) {
	target, err := slash.ResolvePaneTarget(m.slashContext(), parsed.Target)
	if err != nil {
		m.recordAssistantError(parsed.Raw, err)
		return m, nil
	}
	if !m.paneManager.SelectPane(target.PaneID) {
		m.recordAssistantError(parsed.Raw, fmt.Errorf("Could not select %s.", target.Description))
		return m, nil
	}
	m.paneManager.FocusSelected()
	message := "Showing logs for " + target.Description + "."
	m.recordAssistantInteraction(assistant.ResponseActionResult, parsed.Raw, message)
	m.refreshAssistantPrompt()
	return m, commands.FetchLogsCmd(m.ctx, m.client, panes.LogTarget{
		PaneID: target.PaneID,
		AppID:  firstString(target.AppIDs),
		Limit:  panes.DefaultLogFetchLimit,
	})
}

func (m *RootModel) applyTheme(mode string) {
	m.preferences.Theme = mode
	theme, diagnostics := styles.ResolveTheme(mode, os.Getenv)
	m.theme = theme
	m.styles = styles.NewWithOptions(theme, styles.Options{
		AssistantBarColor: m.preferences.Assistant.BarColor,
	})
	for _, diagnostic := range diagnostics {
		m.addDiagnostic(diagnostic.Code, diagnostic.Severity, diagnostic.Message)
	}
}

func (m *RootModel) cycleAssistantBarColor() string {
	current := m.preferences.Assistant.BarColor
	next := assistantColorPalette[0]
	for index, color := range assistantColorPalette {
		if color == current {
			next = assistantColorPalette[(index+1)%len(assistantColorPalette)]
			break
		}
	}
	m.preferences.Assistant.BarColor = next
	m.styles = styles.NewWithOptions(m.theme, styles.Options{AssistantBarColor: next})
	return next
}

func (m *RootModel) reportAssistantProviderStatus() {
	if m.agentConfig == nil {
		m.addAssistantMessage("Operator Agent status is not loaded yet; deterministic mode remains active and slash commands remain available.")
		return
	}
	if !m.agentConfig.Enabled {
		m.addAssistantMessage("Operator Agent is disabled in the daemon; deterministic mode remains active and slash commands remain available.")
		return
	}
	m.addAssistantMessage("Operator Agent uses daemon Agent Gateway provider " + valueOr(m.agentConfig.Provider.Provider, "openrouter") + " with model " + valueOr(m.agentConfig.Provider.ModelSlug, "not configured") + ".")
	for _, diagnostic := range agentConfigDiagnostics(m.agentConfig) {
		m.addDiagnostic(diagnostic.Code, diagnostic.Severity, diagnostic.Message)
	}
}

func (m RootModel) agentContext() *relaybaseclient.TuiAgentContext {
	selected := m.paneManager.SelectedPane()
	context := &relaybaseclient.TuiAgentContext{
		CurrentPage:        m.paneManager.Page(),
		CurrentCWD:         strings.TrimSpace(m.cfg.CurrentDirectory),
		DaemonHasZeroApps:  m.hasNoRegisteredApps(),
		SetupWizardState:   agentSetupWizardState(m.setupSession),
		CurrentSetupPlanID: currentSetupPlanID(m.setupSession),
		Diagnostics:        m.agentDiagnosticsForContext(),
		TerminalCapabilities: &relaybaseclient.TerminalCapabilities{
			Clipboard:   "unavailable",
			BrowserOpen: "unavailable",
			ColorDepth:  "unknown",
		},
	}
	if selected != nil {
		context.SelectedPaneID = selected.ID
		context.SelectedAppID = selected.AppID
		context.SelectedGroupID = selected.GroupID
		context.SelectedComponentRole = selected.Role
		context.CurrentRoute = selected.RouteLabel
	}
	return context
}

func (m RootModel) agentDiagnosticsForContext() []relaybaseclient.AgentDiagnostic {
	diagnostics := []relaybaseclient.AgentDiagnostic{}
	for _, diagnostic := range m.viewDiagnostics() {
		diagnostics = append(diagnostics, relaybaseclient.AgentDiagnostic{
			Severity: diagnostic.Severity,
			Code:     diagnostic.Code,
			Message:  assistant.SanitizeText(diagnostic.Message),
		})
	}
	for _, diagnostic := range m.agentDiagnostics {
		diagnostics = append(diagnostics, diagnostic)
	}
	return diagnostics
}

func agentSetupWizardState(state setupwizard.State) string {
	switch state.Mode {
	case setupwizard.ModeNoApps:
		return "no_apps"
	case setupwizard.ModeDetect:
		return "detecting"
	case setupwizard.ModePreview, setupwizard.ModeManifest:
		return "previewing"
	case setupwizard.ModeApply:
		return "applying"
	case setupwizard.ModeRepair:
		return "repairing"
	case "":
		return "inactive"
	default:
		return state.Mode
	}
}

func currentSetupPlanID(state setupwizard.State) string {
	if state.Preview != nil {
		return firstNonEmpty(state.Preview.SelectedPlan.ID, state.Preview.SelectedPlan.Choice.ID)
	}
	if state.Plans != nil && len(state.Plans.Choices) > 0 {
		return state.Plans.Choices[0].ID
	}
	if state.Repair != nil && len(state.Repair.Plan.Previews) > 0 {
		return currentSetupPlanID(setupwizard.FromPreview(&state.Repair.Plan.Previews[0]))
	}
	return ""
}

func (m *RootModel) applyAgentRunEvent(event relaybaseclient.AgentRunEvent) {
	switch event.Type {
	case "model.delta":
		if delta := stringField(event.Data, "delta"); delta != "" {
			m.addAssistantMessage("Agent: " + delta)
		}
	case "answer":
		if content := stringField(event.Data, "content"); content != "" {
			m.recordAssistantInteraction(assistant.ResponseAnswer, "agent", content)
			m.refreshAssistantPrompt()
		}
	case "diagnostic":
		if diagnostic, ok := agentDiagnosticFromData(event.Data); ok {
			m.addDiagnostic(agentDiagnosticCode(diagnostic), valueOr(diagnostic.Severity, "info"), agentDiagnosticMessage(diagnostic))
			m.recordAssistantInteraction(assistant.ResponseDiagnostic, "agent", diagnostic.Message)
			m.refreshAssistantPrompt()
		}
	case "blocked":
		m.addAssistantMessage(firstNonEmpty(stringField(event.Data, "content"), diagnosticMessageFromData(event.Data), "Operator Agent request was blocked."))
	case "clarification_needed":
		m.addAssistantMessage(firstNonEmpty(stringField(event.Data, "content"), "Operator Agent needs clarification."))
	case "tool.approval_required", "approval_required", "setup.file_write_approval_required", "setup.manifest_patch_approval_required":
		if approval, ok := agentApprovalFromData(event.Data); ok {
			m.pendingAgentApproval = &approval
			m.addAssistantMessage("Operator Agent approval required: " + firstNonEmpty(approval.Target, approval.Action, approval.ToolName, approval.ID) + ".")
			m.refreshAssistantPrompt()
		}
	case "tool.approved":
		if approval, ok := agentApprovalFromData(event.Data); ok && m.pendingAgentApproval != nil && approval.ID == m.pendingAgentApproval.ID {
			m.pendingAgentApproval = nil
		}
		m.addAssistantMessage("Operator Agent tool approval recorded.")
	case "tool.rejected":
		m.pendingAgentApproval = nil
		m.addAssistantMessage("Operator Agent tool approval rejected.")
	case "tool.started":
		m.addAssistantMessage("Operator Agent tool started: " + firstNonEmpty(stringField(event.Data, "toolName"), stringField(event.Data, "tool"), "tool") + ".")
	case "tool.completed", "tool.failed":
		m.addAssistantMessage(agentToolStatusMessage(event))
	case "action_result":
		if m.pendingAgentApproval != nil && stringField(event.Data, "approvalId") == m.pendingAgentApproval.ID {
			m.pendingAgentApproval = nil
			m.refreshAssistantPrompt()
		}
		m.applyAgentActionResultState(event.Data)
		m.addAssistantMessage(agentActionResultMessage(event))
	case "setup.plan_preview", "setup_plan_preview", "file_write_preview":
		if preview, ok := setupPreviewFromData(event.Data); ok {
			m.setupSession = setupwizard.FromPreview(&preview)
			m.addAssistantMessage(setupPreviewReadyMessage(preview))
		}
	case "setup.repair_choices", "repair_choices":
		if repair, ok := repairResultFromData(event.Data); ok {
			m.setupSession = setupwizard.FromRepair(&repair)
			m.addAssistantMessage(fmt.Sprintf("Operator Agent repair choices ready with %d choice(s).", setupRepairChoiceCount(&repair)))
		}
	case "setup.prove_result", "prove_result":
		if prove, ok := proveResultFromData(event.Data); ok {
			m.setupSession = setupwizard.FromProve(&prove)
			m.addAssistantMessage("Operator Agent health proof result ready for " + valueOr(prove.CWD, "selected target") + ".")
		}
	case "tui.proposed_action":
		if action, ok := tuiProposedActionFromData(event.Data); ok {
			m.applyTuiProposedAction(action)
		}
	case "run.started":
		m.agentStatus = "running"
	case "run.completed":
		m.agentStatus = "idle"
	case "run.failed":
		m.agentStatus = "failed"
		if message := diagnosticMessageFromData(event.Data); message != "" {
			m.addAssistantMessage("Operator Agent run failed: " + message)
		}
	}
}

func (m *RootModel) applyAgentActionResultState(data json.RawMessage) {
	result, ok := setupAndStartResultFromData(data)
	if !ok {
		return
	}
	switch result.Result.Data.Phase {
	case "setup_applied":
		if result.Result.Data.Setup.CWD != "" || len(result.Result.Data.Setup.AppliedFiles) > 0 || result.Result.Data.Setup.RegisteredApp != nil {
			m.setupSession = setupwizard.FromApply(&result.Result.Data.Setup)
		}
	case "manifest_registered":
		if result.Result.Data.Registered.ManifestPath != "" || result.Result.Data.Registered.App.ID != "" {
			m.setupSession = setupwizard.FromRegister(&result.Result.Data.Registered)
		}
	case "start_failed":
		if result.Result.Data.RepairChoices.Plan.CWD != "" || len(result.Result.Data.RepairChoices.Plan.Choices) > 0 || len(result.Result.Data.RepairChoices.Plan.Previews) > 0 {
			m.setupSession = setupwizard.FromRepair(&result.Result.Data.RepairChoices)
		}
	}
}

func (m *RootModel) applyTuiProposedAction(action relaybaseclient.TuiProposedAction) {
	if action.UnavailableReason != "" {
		m.addDiagnostic("agent_tui_action_unavailable", "info", assistant.SanitizeText(action.UnavailableReason))
		m.addAssistantMessage("TUI action unavailable: " + action.UnavailableReason)
		return
	}
	if action.RequiresApproval {
		m.addAssistantMessage("TUI-only action requires daemon approval before it can be applied.")
		return
	}

	paneID := m.paneIDForAgentAction(action)
	switch action.Kind {
	case "focus_pane":
		if paneID == "" || !m.paneManager.SelectPane(paneID) {
			m.addAssistantMessage("Could not focus the requested pane.")
			return
		}
		m.paneManager.FocusSelected()
		m.addAssistantMessage("Focused pane from Operator Agent suggestion.")
	case "pin_pane":
		if paneID == "" || !m.paneManager.SetPanePinned(paneID, true) {
			m.addAssistantMessage("Could not pin the requested pane.")
			return
		}
		m.addAssistantMessage("Pinned pane from Operator Agent suggestion.")
	case "unpin_pane":
		if paneID == "" || !m.paneManager.SetPanePinned(paneID, false) {
			m.addAssistantMessage("Could not unpin the requested pane.")
			return
		}
		m.addAssistantMessage("Unpinned pane from Operator Agent suggestion.")
	case "change_pane_color":
		if paneID == "" || strings.TrimSpace(action.Color) == "" || !m.paneManager.SetPaneColor(paneID, action.Color) {
			m.addAssistantMessage("Could not change pane color from Operator Agent suggestion.")
			return
		}
		m.addAssistantMessage("Pane color set to " + action.Color + " from Operator Agent suggestion.")
	case "show_route":
		route := firstNonEmpty(action.Route, m.routeForPaneID(paneID))
		if route == "" {
			m.addAssistantMessage("Requested pane has no route to show.")
			return
		}
		m.addAssistantMessage("Route: " + route)
	case "copy_route":
		m.addDiagnostic("clipboard_unavailable", "info", "Clipboard route copy is unavailable in this TUI environment.")
		m.addAssistantMessage("Clipboard copy is unavailable; route: " + firstNonEmpty(action.Route, m.routeForPaneID(paneID), "not available"))
	case "open_browser":
		m.addDiagnostic("browser_open_unavailable", "info", "Browser open is unavailable from the TUI; use the shown route manually.")
		m.addAssistantMessage("Browser open is unavailable; route: " + firstNonEmpty(action.Route, m.routeForPaneID(paneID), "not available"))
	default:
		m.addAssistantMessage("Unsupported TUI proposed action: " + action.Kind)
	}
}

func (m RootModel) paneIDForAgentAction(action relaybaseclient.TuiProposedAction) string {
	if action.Target.PaneID != "" {
		return action.Target.PaneID
	}
	for _, pane := range m.paneManager.VisiblePanes() {
		if action.Target.AppID != "" && pane.AppID != action.Target.AppID {
			continue
		}
		if action.Target.GroupID != "" && pane.GroupID != action.Target.GroupID {
			continue
		}
		if action.Target.ComponentRole != "" && pane.Role != action.Target.ComponentRole {
			continue
		}
		return pane.ID
	}
	return ""
}

func (m RootModel) routeForPaneID(paneID string) string {
	for _, pane := range m.paneManager.VisiblePanes() {
		if pane.ID == paneID {
			return pane.RouteLabel
		}
	}
	return ""
}

func (m RootModel) slashContext() slash.ResolutionContext {
	return slash.ResolutionContext{
		State:        m.state,
		SelectedPane: paneRefFromSnapshot(m.paneManager.SelectedPane()),
		PagePanes:    paneRefsFromSnapshots(m.paneManager.CurrentPagePanes()),
	}
}

func (m RootModel) contextMenuSnapshot() *contextmenu.Snapshot {
	if !m.contextMenu.IsOpen() {
		return nil
	}
	snapshot := m.contextMenu.Snapshot()
	return &snapshot
}

func (m RootModel) setupPanelForView() string {
	if !m.setupSession.Active() {
		if m.hasNoRegisteredApps() && m.connectionStatus == "connected" {
			return setupwizard.NoApps(m.cfg.CurrentDirectory).Render()
		}
		return ""
	}
	return m.setupSession.Render()
}

func (m RootModel) assistantMenuOptions() contextmenu.AssistantMenuOptions {
	sessionID := m.agentSessionID()
	canExport := m.agentThreadGatewayAvailable() && sessionID != ""
	reason := ""
	if !canExport {
		if sessionID == "" {
			reason = "no daemon-backed active thread"
		} else {
			reason = "Agent Gateway is unavailable"
		}
	}
	return contextmenu.AssistantMenuOptions{
		CanExportChat:        canExport,
		ExportDisabledReason: reason,
	}
}

func (m RootModel) agentThreadGatewayAvailable() bool {
	return m.connectionStatus == "connected" && m.agentConfig != nil && m.agentConfig.Enabled
}

func (m RootModel) threadGatewayUnavailableMessage() string {
	if m.connectionStatus != "connected" {
		return "Daemon-backed Operator Agent threads are unavailable while the daemon is offline; deterministic local commands remain in-memory only."
	}
	if m.agentConfig == nil {
		return "Daemon-backed Operator Agent threads are unavailable until Agent Gateway config loads; deterministic local commands remain in-memory only."
	}
	if !m.agentConfig.Enabled {
		return "Daemon-backed Operator Agent threads need the Operator Agent enabled in daemon config; deterministic local commands remain in-memory only."
	}
	return "Daemon-backed Operator Agent threads are unavailable; deterministic local commands remain in-memory only."
}

func (m *RootModel) startNewAssistantThread(title string) tea.Cmd {
	m.commandInput = ""
	m.commandActive = false
	if !m.agentThreadGatewayAvailable() {
		m.resetLocalAssistantThread()
		m.addAssistantMessage("New local-only assistant thread started. " + m.threadGatewayUnavailableMessage())
		return nil
	}
	request := relaybaseclient.AgentSessionCreateRequest{
		Title:   strings.TrimSpace(title),
		Context: m.agentContext(),
	}
	if request.Title == "" {
		request.Title = "Relaybase TUI"
	}
	m.addAssistantMessage("Creating daemon-backed Operator Agent thread.")
	return commands.CreateAgentSessionCmd(m.ctx, m.client, request)
}

func (m *RootModel) resetLocalAssistantThread() {
	m.assistantHistory = nil
	m.naturalHistory = nil
	m.lastAssistantLine = ""
	m.agentPendingInput = ""
	m.refreshAssistantPrompt()
}

func (m RootModel) agentSessionID() string {
	if m.agentSession == nil {
		return ""
	}
	return m.agentSession.ID
}

func (m RootModel) agentThreadStatusLabel() string {
	if m.agentSession == nil || m.agentSession.ID == "" {
		return ""
	}
	label := agentSessionLabel(*m.agentSession)
	if m.agentSession.RecoveredApprovalCount > 0 {
		label += fmt.Sprintf(" [%d recovered approval(s)]", m.agentSession.RecoveredApprovalCount)
	}
	return label
}

func (m RootModel) resolveAgentSessionTarget(target string) (string, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return "", fmt.Errorf("Use /thread switch <id|number>.")
	}
	if index, err := strconv.Atoi(trimmed); err == nil {
		if index <= 0 || index > len(m.agentSessions) {
			return "", fmt.Errorf("Thread number %s is not in the cached list. Use /thread list first, then choose a listed number.", trimmed)
		}
		return m.agentSessions[index-1].ID, nil
	}
	if strings.Contains(trimmed, " ") {
		return "", fmt.Errorf("Thread switch accepts an exact id or listed number. Use /thread list, then /thread switch <id|number>.")
	}
	return trimmed, nil
}

func (m *RootModel) closeAgentStream() {
	if m.agentStream != nil {
		_ = m.agentStream.Close()
		m.agentStream = nil
	}
}

func (m RootModel) confirmationForView() *views.ConfirmationData {
	if m.pendingAgentApproval != nil {
		return agentApprovalForView(*m.pendingAgentApproval)
	}
	if m.pendingConfirm == nil {
		return nil
	}
	return &views.ConfirmationData{
		Action:         m.pendingConfirm.Action,
		Target:         m.pendingConfirm.Target.Description,
		Risk:           m.pendingConfirm.Risk,
		ExpectedResult: m.pendingConfirm.Expected,
	}
}

func (m RootModel) assistantHistoryForView() []string {
	combined := []string{}
	for _, entry := range m.naturalHistory {
		if entry.Message != "" {
			combined = append(combined, entry.Type+": "+entry.Message)
		}
	}
	combined = append(combined, m.assistantHistory...)
	if len(combined) == 0 {
		return nil
	}
	if m.historyExpanded || len(combined) <= 3 {
		return append([]string(nil), combined...)
	}
	return append([]string(nil), combined[len(combined)-3:]...)
}

func (m RootModel) latestAssistantLine() string {
	return assistant.SanitizeText(m.lastAssistantLine)
}

func (m *RootModel) recordAssistantInteraction(responseType string, input string, message string) {
	entry := assistant.HistoryEntry{
		At:      m.now(),
		Type:    responseType,
		Input:   assistant.SanitizeText(input),
		Message: assistant.SanitizeText(message),
	}
	if entry.Message == "" {
		return
	}
	m.naturalHistory = append(m.naturalHistory, entry)
	m.lastAssistantLine = entry.Message
	m.trimNaturalAssistantHistory()
}

func (m *RootModel) recordAssistantError(input string, err error) {
	responseType := assistant.ResponseDiagnostic
	var parseError assistant.ParseError
	if errors.As(err, &parseError) && parseError.ResponseType != "" {
		responseType = parseError.ResponseType
	}
	var resolutionError slash.ResolutionError
	if errors.As(err, &resolutionError) {
		switch resolutionError.Kind {
		case "ambiguous":
			responseType = assistant.ResponseClarificationNeeded
			m.addDiagnostic("assistant_target_ambiguous", "warning", err.Error())
		case "unknown":
			responseType = assistant.ResponseDiagnostic
			m.addDiagnostic("assistant_target_unknown", "warning", err.Error())
		}
	}
	if responseType == assistant.ResponseBlocked {
		m.addDiagnostic("assistant_command_unsupported", "info", err.Error())
	}
	m.recordAssistantInteraction(responseType, input, err.Error())
	m.refreshAssistantPrompt()
}

func (m *RootModel) trimNaturalAssistantHistory() {
	retentionDays := m.preferences.Assistant.HistoryRetentionDays
	if retentionDays <= 0 {
		retentionDays = preferences.Default().Assistant.HistoryRetentionDays
	}
	cutoff := m.now().Add(-time.Duration(retentionDays) * 24 * time.Hour)
	kept := []assistant.HistoryEntry{}
	for _, entry := range m.naturalHistory {
		if entry.At.IsZero() || entry.At.After(cutoff) || entry.At.Equal(cutoff) {
			kept = append(kept, entry)
		}
	}
	if len(kept) > 200 {
		kept = kept[len(kept)-200:]
	}
	m.naturalHistory = kept
}

func (m RootModel) apps() []relaybaseclient.AppState {
	if m.state == nil {
		return nil
	}
	return m.state.Apps
}

func (m RootModel) groups() []relaybaseclient.AppGroup {
	if m.state == nil {
		return nil
	}
	return m.state.Groups
}

func (m RootModel) hasNoRegisteredApps() bool {
	if m.state == nil {
		return false
	}
	return len(m.state.Apps) == 0 && len(m.state.Groups) == 0 && len(m.state.Components) == 0
}

func (m RootModel) viewDiagnostics() []views.DiagnosticLine {
	lines := make([]views.DiagnosticLine, 0, len(m.diagnostics))
	for _, diagnostic := range m.diagnostics {
		lines = append(lines, views.DiagnosticLine{
			Code:     diagnostic.Code,
			Severity: diagnostic.Severity,
			Message:  diagnostic.Message,
		})
	}
	for _, diagnostic := range m.paneManager.Diagnostics() {
		lines = append(lines, views.DiagnosticLine{
			Code:     diagnostic.Code,
			Severity: diagnostic.Severity,
			Message:  diagnostic.Message,
		})
	}
	if m.paneManager.Layout().Narrow {
		lines = append(lines, views.DiagnosticLine{
			Code:     "terminal_layout_degraded",
			Severity: "info",
			Message:  "Terminal is narrow; pane dashboard is using a single-column degraded layout.",
		})
	}
	return lines
}

func (m RootModel) brokenSummary() string {
	if m.connectionStatus == "offline" {
		if m.daemonBootstrapAvailable() {
			return "Relaybase daemon is unavailable, so app health cannot be inspected yet. Use /daemon repair or type fix daemon to start it through the Relaybase TUI launch bridge."
		}
		return "Relaybase daemon is unavailable, so app health cannot be inspected yet. Start or restart the daemon with: relaybase serve."
	}

	issues := []string{}
	for _, diagnostic := range m.viewDiagnostics() {
		if diagnostic.Severity == "error" || diagnostic.Severity == "warning" {
			issues = append(issues, fmt.Sprintf("%s: %s", diagnostic.Code, diagnostic.Message))
		}
	}
	if m.state != nil {
		for _, group := range m.state.Groups {
			if isBrokenStatus(group.AggregateStatus) {
				issues = append(issues, fmt.Sprintf("group %s is %s", firstNonEmpty(group.DisplayName, group.GroupID), group.AggregateStatus))
			}
		}
		for _, component := range componentsForAssistant(m.state) {
			if isBrokenStatus(component.Status) || component.LastError != "" {
				detail := fmt.Sprintf("component %s/%s is %s", firstNonEmpty(component.GroupID, component.AppID), component.AppID, firstNonEmpty(component.Status, "unknown"))
				if component.LastError != "" {
					detail += ": " + component.LastError
				}
				issues = append(issues, detail)
			}
		}
		for _, app := range m.state.Apps {
			if isBrokenStatus(app.RuntimeStatus) || isBrokenStatus(app.ReadinessState) || app.LastError != "" {
				status := firstNonEmpty(app.RuntimeStatus, app.ReadinessState, "unknown")
				detail := fmt.Sprintf("app %s is %s", firstNonEmpty(app.Name, app.ID), status)
				if app.LastError != "" {
					detail += ": " + app.LastError
				}
				issues = append(issues, detail)
			}
		}
		for _, diagnostic := range m.state.Diagnostics {
			if diagnostic.Severity == "error" || diagnostic.Severity == "warning" {
				issues = append(issues, fmt.Sprintf("%s: %s", diagnostic.Code, diagnostic.Message))
			}
		}
	}
	issues = uniqueStrings(issues)
	if len(issues) == 0 {
		return "No failed or degraded apps, components, or diagnostics are present in current daemon state."
	}
	return "Current issues: " + strings.Join(issues, "; ") + "."
}

func (m RootModel) diagnosticsSummary() string {
	diagnostics := []string{}
	for _, diagnostic := range m.viewDiagnostics() {
		diagnostics = append(diagnostics, fmt.Sprintf("%s/%s: %s", diagnostic.Severity, diagnostic.Code, diagnostic.Message))
	}
	if m.state != nil {
		for _, diagnostic := range m.state.Diagnostics {
			diagnostics = append(diagnostics, fmt.Sprintf("%s/%s: %s", diagnostic.Severity, diagnostic.Code, diagnostic.Message))
		}
	}
	diagnostics = uniqueStrings(diagnostics)
	if len(diagnostics) == 0 {
		return "No diagnostics are present in current TUI or daemon state."
	}
	return "Diagnostics: " + strings.Join(diagnostics, "; ") + "."
}

func (m RootModel) daemonBootstrapAvailable() bool {
	return m.bootstrapClient != nil && m.bootstrapClient.Available()
}

func (m *RootModel) applyDaemonBootstrapResult(result *bootstrap.DaemonResult) {
	if result == nil {
		return
	}
	m.lastBootstrapResult = result
	if result.Reachable {
		m.clearDiagnosticsByPrefix("daemon_bootstrap_")
		m.clearDiagnostics(daemonUnavailableDiagnosticCode, eventDisconnectedDiagnosticCode, authTokenInvalidDiagnosticCode)
		m.addOrReplaceDiagnostic("daemon_bootstrap_ready", "info", bootstrapResultMessage(result))
		m.connectionStatus = "connecting"
		m.eventStatus = "checking"
		return
	}
	m.clearDiagnostics("daemon_bootstrap_ready")
	m.addOrReplaceDiagnostic("daemon_bootstrap_"+valueOr(result.Code, "unavailable"), "error", bootstrapResultMessage(result))
}

func (m *RootModel) close() {
	if m.stream != nil {
		_ = m.stream.Close()
	}
	if m.agentStream != nil {
		_ = m.agentStream.Close()
	}
	if m.cancel != nil {
		m.cancel()
	}
}

func eventDiagnosticCode(err error) string {
	var apiError *relaybaseclient.APIError
	if errors.As(err, &apiError) {
		if apiError.StatusCode == 401 || apiError.StatusCode == 403 {
			return "auth_token_invalid"
		}
	}
	return "event_stream_disconnected"
}

func shouldRefreshState(eventType string) bool {
	switch eventType {
	case "app.registered",
		"app.state_changed",
		"app.lifecycle_operation_completed",
		"app.lifecycle_operation_failed",
		"route.health_changed":
		return true
	default:
		return false
	}
}

func logEventFromDaemonEvent(event relaybaseclient.DaemonEvent) (relaybaseclient.LogEvent, bool) {
	if event.Type != "log.line_available" || len(event.Data) == 0 {
		return relaybaseclient.LogEvent{}, false
	}
	var payload struct {
		Log relaybaseclient.LogEvent `json:"log"`
	}
	if err := json.Unmarshal(event.Data, &payload); err != nil {
		return relaybaseclient.LogEvent{}, false
	}
	return payload.Log, payload.Log.AppID != "" || payload.Log.GroupID != "" || payload.Log.ComponentRole != ""
}

func safeLogErrorMessage(err error) string {
	message := assistant.SanitizeText(fmt.Sprint(err))
	if strings.TrimSpace(message) == "" {
		return "log query failed"
	}
	return message
}

func confirmationPreviewMessage(confirmation confirmationRequest) string {
	return fmt.Sprintf(
		"Preview %s for %s. Risk: %s Expected: %s",
		confirmation.Action,
		confirmation.Target.Description,
		confirmation.Risk,
		confirmation.Expected,
	)
}

func agentApprovalForView(approval relaybaseclient.AgentApproval) *views.ConfirmationData {
	action := firstNonEmpty(agentPreviewAction(approval), approval.Action, approval.ToolName, "agent action")
	target := firstNonEmpty(agentPreviewTarget(approval), approval.Target, approval.ToolName, "agent target")
	risk := firstNonEmpty(agentPreviewRisk(approval), approval.Risk, "medium")
	expected := firstNonEmpty(agentPreviewExpected(approval), approval.ExpectedResult, "Daemon executes the approved tool and reports the result.")
	return &views.ConfirmationData{
		Action:         action,
		Target:         target,
		Risk:           risk,
		ExpectedResult: expected,
		Details:        agentApprovalDetails(approval),
	}
}

func agentPreviewAction(approval relaybaseclient.AgentApproval) string {
	if approval.Preview == nil {
		return ""
	}
	return approval.Preview.Action
}

func agentPreviewTarget(approval relaybaseclient.AgentApproval) string {
	if approval.Preview == nil {
		return ""
	}
	return approval.Preview.Target
}

func agentPreviewRisk(approval relaybaseclient.AgentApproval) string {
	if approval.Preview == nil {
		return ""
	}
	return approval.Preview.Risk
}

func agentPreviewExpected(approval relaybaseclient.AgentApproval) string {
	if approval.Preview == nil {
		return ""
	}
	return approval.Preview.ExpectedResult
}

func agentApprovalDetails(approval relaybaseclient.AgentApproval) []string {
	details := []string{}
	if approval.ID != "" {
		details = append(details, "approval id "+approval.ID)
	}
	if approval.Status == "recovered_pending" {
		details = append(details, "recovered approval: review this preview, then press Enter to explicitly reconfirm resume or Esc to reject")
		if approval.RecoveryState != "" {
			details = append(details, "recovery state "+approval.RecoveryState)
		}
		if !approval.RawArgumentsPersisted {
			details = append(details, "raw execution arguments are unavailable; daemon may block resume")
		}
	}
	if approval.ToolName != "" {
		details = append(details, "tool "+approval.ToolName)
	}
	if approval.Preview != nil {
		if approval.Preview.CurrentStatus != "" {
			details = append(details, "current status "+approval.Preview.CurrentStatus)
		}
		if approval.Preview.RuntimeID != "" {
			runtime := approval.Preview.RuntimeID
			if approval.Preview.RuntimeLabel != "" && approval.Preview.RuntimeLabel != approval.Preview.RuntimeID {
				runtime += " (" + approval.Preview.RuntimeLabel + ")"
			}
			if approval.Preview.RuntimeConfidence != "" {
				runtime += " confidence " + approval.Preview.RuntimeConfidence
			}
			details = append(details, "runtime "+assistant.SanitizeText(runtime))
		}
		if approval.Preview.SelectedCommand != nil {
			command := approval.Preview.SelectedCommand.Preview
			if command == "" && len(approval.Preview.SelectedCommand.Argv) > 0 {
				command = strings.Join(approval.Preview.SelectedCommand.Argv, " ")
			}
			if command != "" {
				details = append(details, "command "+assistant.SanitizeText(command))
			}
		}
		if approval.Preview.PortStrategy != "" {
			details = append(details, "port strategy "+approval.Preview.PortStrategy)
		}
		if len(approval.Preview.PortStrategyCandidates) > 0 {
			details = append(details, "port candidates "+strings.Join(approval.Preview.PortStrategyCandidates, ", "))
		}
		if len(approval.Preview.SetupQuestions) > 0 {
			for _, question := range approval.Preview.SetupQuestions[:minInt(len(approval.Preview.SetupQuestions), 4)] {
				details = append(details, "setup question "+assistant.SanitizeText(question))
			}
			if len(approval.Preview.SetupQuestions) > 4 {
				details = append(details, fmt.Sprintf("%d setup question(s) omitted", len(approval.Preview.SetupQuestions)-4))
			}
		}
		if approval.Preview.HealthRoute != "" {
			details = append(details, "health route "+approval.Preview.HealthRoute)
		}
		if len(approval.Preview.ManifestFieldsChanged) > 0 {
			details = append(details, "manifest fields "+strings.Join(approval.Preview.ManifestFieldsChanged, ", "))
		}
		if len(approval.Preview.EnvKeysChanged) > 0 {
			details = append(details, "env keys "+strings.Join(approval.Preview.EnvKeysChanged, ", ")+" (values hidden)")
		}
		if approval.Preview.MayIncludeSensitiveData {
			details = append(details, "sensitive data warning: preview was redacted by daemon")
		}
	}
	if approval.FileWrite != nil {
		details = append(details, fileWriteDetails(approval.FileWrite.FileWritePlan)...)
	}
	if approval.ManifestPatch != nil {
		details = append(details, "manifest patch "+approval.ManifestPatch.ManifestPatchPlan.ManifestPath)
		details = append(details, fileWriteDetails(approval.ManifestPatch.ManifestPatchPlan.FileWritePlan)...)
	}
	if approval.OpenRoute != nil && approval.OpenRoute.Route != "" {
		details = append(details, "route "+approval.OpenRoute.Route)
	}
	details = append(details, approvalArgumentDetails(approval.Arguments)...)
	if len(details) == 0 {
		details = append(details, "arguments are held by the daemon approval record")
	}
	return details
}

func agentSessionLabel(session relaybaseclient.AgentSession) string {
	title := firstNonEmpty(session.Title, "untitled")
	if session.ID == "" {
		return title
	}
	shortID := session.ID
	if len(shortID) > 12 {
		shortID = shortID[:12]
	}
	return title + " (" + shortID + ")"
}

func agentSessionListMessage(sessions []relaybaseclient.AgentSession, activeID string) string {
	if len(sessions) == 0 {
		return "No daemon-backed Operator Agent threads exist yet. Use /thread new [title] or send your first model-backed message."
	}
	lines := []string{"Operator Agent threads:"}
	for index, session := range sessions {
		prefix := fmt.Sprintf("%d. ", index+1)
		active := ""
		if activeID != "" && session.ID == activeID {
			active = " [active]"
		}
		counts := ""
		if session.Summary != nil {
			counts = fmt.Sprintf(" messages=%d runs=%d approvals=%d recovered=%d",
				session.Summary.MessageCount,
				session.Summary.RunCount,
				session.Summary.PendingApprovalCount,
				session.Summary.RecoveredApprovalCount,
			)
		}
		lines = append(lines, prefix+agentSessionLabel(session)+active+counts)
	}
	return strings.Join(lines, "\n")
}

func agentSessionExportMessage(result *relaybaseclient.AgentSessionExportResult) string {
	if result == nil {
		return "Operator Agent thread export completed."
	}
	parts := []string{
		"Operator Agent thread export complete",
		"id " + result.ExportID,
		"format " + result.Format,
	}
	if result.OutputPath != "" {
		parts = append(parts, "path "+result.OutputPath)
	}
	if result.MessageCount > 0 {
		parts = append(parts, fmt.Sprintf("messages %d", result.MessageCount))
	}
	if result.AuditEventCount > 0 {
		parts = append(parts, fmt.Sprintf("audit events %d", result.AuditEventCount))
	}
	if replacements := redactionReplacementCount(result.RedactionReport); replacements >= 0 {
		parts = append(parts, fmt.Sprintf("redactions %d", replacements))
	}
	return assistant.SanitizeText(strings.Join(parts, "; ") + ".")
}

func agentSessionContextPreviewMessage(preview *relaybaseclient.AgentThreadContextPreview) string {
	if preview == nil {
		return "Operator Agent context preview is unavailable."
	}
	lines := []string{
		"Operator Agent context preview:",
		"- active thread only: " + boolText(preview.RecallPolicy.Scope == "active_thread_only"),
		"- title: " + firstNonEmpty(preview.Title, "untitled"),
		fmt.Sprintf("- summary: messages=%d runs=%d events=%d pending approvals=%d recovered approvals=%d",
			preview.Summary.MessageCount,
			preview.Summary.RunCount,
			preview.Summary.EventCount,
			preview.Summary.PendingApprovalCount,
			preview.Summary.RecoveredApprovalCount,
		),
		"- privacy mode: " + firstNonEmpty(preview.Privacy.Mode, "standard"),
		fmt.Sprintf("- recent redacted turns: %d", len(preview.RecentMessages)),
		fmt.Sprintf("- pending approvals: %d", len(preview.PendingApprovals)),
		"- includes raw secrets: " + boolText(preview.RecallPolicy.IncludesRawSecrets),
		"- includes raw logs: " + boolText(preview.RecallPolicy.IncludesRawLogs),
		"- includes raw diffs: " + boolText(preview.RecallPolicy.IncludesRawDiffs),
		"- extra model calls for preview: " + boolText(preview.RecallPolicy.ExtraModelCalls),
		"- context categories: rolling summary, recent redacted turns, selected pane/app/group/cwd, setup refs, log/export refs, diagnostics, redaction counts",
	}
	return assistant.SanitizeText(strings.Join(lines, "\n"))
}

func redactionReplacementCount(raw json.RawMessage) int {
	if len(raw) == 0 {
		return -1
	}
	var report struct {
		TotalReplacements int `json:"totalReplacements"`
	}
	if err := json.Unmarshal(raw, &report); err != nil {
		return -1
	}
	return report.TotalReplacements
}

func upsertAgentSession(sessions []relaybaseclient.AgentSession, session relaybaseclient.AgentSession) []relaybaseclient.AgentSession {
	if session.ID == "" {
		return sessions
	}
	copied := append([]relaybaseclient.AgentSession(nil), sessions...)
	for index := range copied {
		if copied[index].ID == session.ID {
			copied[index] = session
			return copied
		}
	}
	return append([]relaybaseclient.AgentSession{session}, copied...)
}

func removeAgentSession(sessions []relaybaseclient.AgentSession, sessionID string) []relaybaseclient.AgentSession {
	if sessionID == "" {
		return sessions
	}
	filtered := sessions[:0]
	for _, session := range sessions {
		if session.ID != sessionID {
			filtered = append(filtered, session)
		}
	}
	return filtered
}

func optionalThreadSuffix(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	return " " + sessionID
}

func boolText(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func approvalArgumentDetails(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var args struct {
		Phase            string `json:"phase"`
		CWD              string `json:"cwd"`
		CurrentDirectory string `json:"currentDirectory"`
		AppID            string `json:"appId"`
		ManifestPath     string `json:"manifestPath"`
		SelectedPlanID   string `json:"selectedPlanId"`
		CommandHint      string `json:"commandHint"`
		Command          string `json:"command"`
		PortStrategyHint string `json:"portStrategyHint"`
		Reason           string `json:"reason"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil
	}
	details := []string{}
	if args.Phase != "" {
		details = append(details, "phase "+args.Phase)
	}
	if cwd := firstNonEmpty(args.CWD, args.CurrentDirectory); cwd != "" {
		details = append(details, "project path "+assistant.SanitizeText(cwd))
	}
	if args.AppID != "" {
		details = append(details, "app id "+assistant.SanitizeText(args.AppID))
	}
	if args.ManifestPath != "" {
		details = append(details, "manifest "+assistant.SanitizeText(args.ManifestPath))
	}
	if args.SelectedPlanID != "" {
		details = append(details, "setup plan "+assistant.SanitizeText(args.SelectedPlanID))
	}
	if command := firstNonEmpty(args.CommandHint, args.Command); command != "" {
		details = append(details, "command "+assistant.SanitizeText(command))
	}
	if args.PortStrategyHint != "" {
		details = append(details, "port strategy "+assistant.SanitizeText(args.PortStrategyHint))
	}
	if args.Reason != "" {
		details = append(details, "reason "+assistant.SanitizeText(args.Reason))
	}
	return details
}

func fileWriteDetails(plan relaybaseclient.FileWritePlan) []string {
	if len(plan.Writes) == 0 {
		return nil
	}
	details := []string{}
	for _, write := range plan.Writes {
		label := strings.TrimSpace(write.Action + " " + write.Path)
		if label != "" {
			details = append(details, assistant.SanitizeText(label))
		}
		if write.Reason != "" {
			details = append(details, assistant.SanitizeText("reason "+write.Reason))
		}
		for _, hunk := range write.Diff.Hunks[:minInt(len(write.Diff.Hunks), 4)] {
			details = append(details, assistant.SanitizeText(hunk))
		}
		if len(write.Diff.Hunks) > 4 {
			details = append(details, fmt.Sprintf("%d diff hunk(s) omitted from compact approval view", len(write.Diff.Hunks)-4))
		}
	}
	return details
}

func naturalCommandResultMessage(command slash.ParsedCommand) string {
	switch command.Kind {
	case slash.KindPage:
		return "Page command applied."
	case slash.KindPaneColor:
		return "Pane color command applied."
	case slash.KindPin:
		return "Pane pin command applied."
	case slash.KindUnpin:
		return "Pane unpin command applied."
	case slash.KindTheme:
		return "Theme command applied."
	case slash.KindHelp:
		return "Help command applied."
	default:
		return "Command applied."
	}
}

func lifecycleActionForCommand(command slash.ParsedCommand) string {
	switch command.Kind {
	case slash.KindLaunch:
		return "start"
	case slash.KindRestart:
		return "restart"
	default:
		return "stop"
	}
}

func lifecycleRisk(action string) string {
	switch action {
	case "start":
		return "Starts app/component processes through the daemon."
	case "restart":
		return "Stops and starts app/component processes through the daemon."
	default:
		return "Stops app/component processes through the daemon."
	}
}

func exportRequestForTarget(scope string, target slash.ResolvedTarget) relaybaseclient.LogExportRequest {
	redact := true
	request := relaybaseclient.LogExportRequest{
		Scope:  scope,
		Format: "log",
		Redact: &redact,
	}
	switch scope {
	case slash.ScopePane:
		request.AppID = firstString(target.AppIDs)
		request.GroupID = target.GroupID
		request.ComponentRole = target.ComponentRole
	case slash.ScopeApp:
		request.AppID = firstString(target.AppIDs)
	case slash.ScopeGroup:
		request.GroupID = target.GroupID
	}
	return request
}

func paneRefFromSnapshot(snapshot *panes.PaneSnapshot) slash.PaneRef {
	if snapshot == nil {
		return slash.PaneRef{}
	}
	return slash.PaneRef{
		ID:          snapshot.ID,
		AppID:       snapshot.AppID,
		GroupID:     snapshot.GroupID,
		Role:        snapshot.Role,
		Title:       snapshot.Title,
		DisplayName: snapshot.DisplayName,
	}
}

func paneRefsFromSnapshots(snapshots []panes.PaneSnapshot) []slash.PaneRef {
	refs := make([]slash.PaneRef, 0, len(snapshots))
	for _, snapshot := range snapshots {
		copy := snapshot
		refs = append(refs, paneRefFromSnapshot(&copy))
	}
	return refs
}

func isBackspace(msg tea.KeyPressMsg) bool {
	if msg.Code == tea.KeyBackspace || msg.Code == 8 || msg.Code == 127 {
		return true
	}
	switch msg.Keystroke() {
	case "backspace", "ctrl+h":
		return true
	default:
		return false
	}
}

func isDelete(msg tea.KeyPressMsg) bool {
	if msg.Code == tea.KeyDelete {
		return true
	}
	return msg.Keystroke() == "delete"
}

func isClearInput(msg tea.KeyPressMsg) bool {
	return msg.Code == 21 || msg.Keystroke() == "ctrl+u"
}

func normalizeCommandInputText(text string) string {
	if text == "" {
		return ""
	}
	var builder strings.Builder
	lastWasSpace := false
	for _, value := range text {
		if value == '\r' || value == '\n' || value == '\t' {
			if !lastWasSpace {
				builder.WriteRune(' ')
				lastWasSpace = true
			}
			continue
		}
		if value < 32 || value == 127 {
			continue
		}
		builder.WriteRune(value)
		lastWasSpace = value == ' '
	}
	return builder.String()
}

func isContextMenuKey(msg tea.KeyPressMsg) bool {
	return msg.Code == 26 || msg.Code == 15
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		result = append(result, trimmed)
	}
	return result
}

func isBrokenStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "degraded", "error", "unhealthy":
		return true
	default:
		return false
	}
}

func componentsForAssistant(state *relaybaseclient.RelaybaseState) []relaybaseclient.AppComponent {
	if state == nil {
		return nil
	}
	if len(state.Components) > 0 {
		return state.Components
	}
	components := []relaybaseclient.AppComponent{}
	for _, group := range state.Groups {
		components = append(components, group.Components...)
	}
	return components
}

func agentStatusFromConfig(config *relaybaseclient.AgentConfig) string {
	if config == nil {
		return "unknown"
	}
	if !config.Enabled {
		return "disabled"
	}
	if !config.Provider.RemoteModelEnabled || !config.Provider.APIKeySource.Configured || config.Provider.ModelSlug == "" {
		return "needs_config"
	}
	return "ready"
}

func agentConfigDiagnostics(config *relaybaseclient.AgentConfig) []Diagnostic {
	if config == nil {
		return nil
	}
	if !config.Enabled {
		return []Diagnostic{{
			Code:     "agent_disabled",
			Severity: "info",
			Message:  "Operator Agent is disabled in the daemon. Set RELAYBASE_AGENT_ENABLED=1 in .env, then restart the daemon; deterministic slash commands remain available.",
		}}
	}
	diagnostics := []Diagnostic{}
	if !config.Provider.RemoteModelEnabled {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     "agent_remote_model_disabled",
			Severity: "warning",
			Message:  "Operator Agent remote model mode is disabled. Set RELAYBASE_AGENT_REMOTE_MODEL_ENABLED=1 in .env, then restart the daemon.",
		})
	}
	if config.Provider.ModelSlug == "" {
		diagnostics = append(diagnostics, Diagnostic{
			Code:     "agent_model_missing",
			Severity: "warning",
			Message:  "Operator Agent is enabled but no OpenRouter model slug is configured. Set RELAYBASE_AGENT_MODEL in .env, then restart the daemon.",
		})
	}
	if !config.Provider.APIKeySource.Configured {
		envVar := valueOr(config.Provider.APIKeySource.EnvVar, "OPENROUTER_API_KEY")
		diagnostics = append(diagnostics, Diagnostic{
			Code:     "openrouter_api_key_missing",
			Severity: "warning",
			Message:  "Operator Agent is enabled but " + envVar + " is not set in the daemon environment.",
		})
	}
	return diagnostics
}

func agentDiagnosticCode(diagnostic relaybaseclient.AgentDiagnostic) string {
	return strings.ToLower(firstNonEmpty(diagnostic.Code, diagnostic.ID, "agent_diagnostic"))
}

func agentDiagnosticMessage(diagnostic relaybaseclient.AgentDiagnostic) string {
	message := firstNonEmpty(diagnostic.Message, diagnostic.UserAction, "Operator Agent diagnostic.")
	if diagnostic.UserAction != "" && !strings.Contains(message, diagnostic.UserAction) {
		message += " " + diagnostic.UserAction
	}
	return assistant.SanitizeText(message)
}

func agentDiagnosticFromData(data json.RawMessage) (relaybaseclient.AgentDiagnostic, bool) {
	var diagnostic relaybaseclient.AgentDiagnostic
	if unmarshalData(data, &diagnostic) && diagnostic.Code != "" {
		return diagnostic, true
	}
	var wrapper struct {
		Diagnostic relaybaseclient.AgentDiagnostic `json:"diagnostic"`
	}
	if unmarshalData(data, &wrapper) && wrapper.Diagnostic.Code != "" {
		return wrapper.Diagnostic, true
	}
	return relaybaseclient.AgentDiagnostic{}, false
}

func agentApprovalFromData(data json.RawMessage) (relaybaseclient.AgentApproval, bool) {
	var wrapper struct {
		Approval relaybaseclient.AgentApproval `json:"approval"`
	}
	if unmarshalData(data, &wrapper) && wrapper.Approval.ID != "" {
		return wrapper.Approval, true
	}
	var approval relaybaseclient.AgentApproval
	if unmarshalData(data, &approval) && approval.ID != "" {
		return approval, true
	}
	return relaybaseclient.AgentApproval{}, false
}

func setupPreviewFromData(data json.RawMessage) (relaybaseclient.SetupPlanPreview, bool) {
	var wrapper struct {
		SetupPlanPreview relaybaseclient.SetupPlanPreview `json:"setupPlanPreview"`
		Preview          relaybaseclient.SetupPlanPreview `json:"preview"`
		Setup            relaybaseclient.SetupPlanPreview `json:"setup"`
	}
	if unmarshalData(data, &wrapper) {
		for _, preview := range []relaybaseclient.SetupPlanPreview{wrapper.SetupPlanPreview, wrapper.Preview, wrapper.Setup} {
			if preview.CWD != "" || preview.SelectedPlan.ID != "" || len(preview.FileWritePlan.Writes) > 0 {
				return preview, true
			}
		}
	}
	var preview relaybaseclient.SetupPlanPreview
	if unmarshalData(data, &preview) && (preview.CWD != "" || preview.SelectedPlan.ID != "" || len(preview.FileWritePlan.Writes) > 0) {
		return preview, true
	}
	return relaybaseclient.SetupPlanPreview{}, false
}

func repairResultFromData(data json.RawMessage) (relaybaseclient.RepairSetupResult, bool) {
	var wrapper struct {
		Repair relaybaseclient.RepairSetupResult `json:"repair"`
		Result relaybaseclient.RepairSetupResult `json:"result"`
		Setup  relaybaseclient.RepairSetupResult `json:"setup"`
	}
	if unmarshalData(data, &wrapper) {
		for _, repair := range []relaybaseclient.RepairSetupResult{wrapper.Repair, wrapper.Result, wrapper.Setup} {
			if repair.Plan.CWD != "" || len(repair.Plan.Choices) > 0 || len(repair.Plan.Previews) > 0 {
				return repair, true
			}
		}
	}
	var repair relaybaseclient.RepairSetupResult
	if unmarshalData(data, &repair) && (repair.Plan.CWD != "" || len(repair.Plan.Choices) > 0 || len(repair.Plan.Previews) > 0) {
		return repair, true
	}
	return relaybaseclient.RepairSetupResult{}, false
}

func proveResultFromData(data json.RawMessage) (relaybaseclient.ProveHealthResult, bool) {
	var wrapper struct {
		Prove  relaybaseclient.ProveHealthResult `json:"prove"`
		Result relaybaseclient.ProveHealthResult `json:"result"`
		Setup  relaybaseclient.ProveHealthResult `json:"setup"`
	}
	if unmarshalData(data, &wrapper) {
		for _, prove := range []relaybaseclient.ProveHealthResult{wrapper.Prove, wrapper.Result, wrapper.Setup} {
			if prove.CWD != "" || len(prove.Result) > 0 {
				return prove, true
			}
		}
	}
	var prove relaybaseclient.ProveHealthResult
	if unmarshalData(data, &prove) && (prove.CWD != "" || len(prove.Result) > 0) {
		return prove, true
	}
	return relaybaseclient.ProveHealthResult{}, false
}

func tuiProposedActionFromData(data json.RawMessage) (relaybaseclient.TuiProposedAction, bool) {
	var wrapper struct {
		Action relaybaseclient.TuiProposedAction `json:"action"`
	}
	if unmarshalData(data, &wrapper) && wrapper.Action.Kind != "" {
		return wrapper.Action, true
	}
	var action relaybaseclient.TuiProposedAction
	if unmarshalData(data, &action) && action.Kind != "" {
		return action, true
	}
	return relaybaseclient.TuiProposedAction{}, false
}

type setupAndStartActionResult struct {
	ToolName string `json:"toolName"`
	Tool     string `json:"tool"`
	Result   struct {
		Tool         string                           `json:"tool"`
		Status       string                           `json:"status"`
		OperationID  string                           `json:"operationId"`
		SetupPlanID  string                           `json:"setupPlanId"`
		RepairPlanID string                           `json:"repairPlanId"`
		Diagnostic   *relaybaseclient.AgentDiagnostic `json:"diagnostic"`
		Data         struct {
			Phase         string                                 `json:"phase"`
			AppID         string                                 `json:"appId"`
			Setup         relaybaseclient.SetupApplyResult       `json:"setup"`
			Registered    relaybaseclient.RegisterManifestResult `json:"registered"`
			RepairChoices relaybaseclient.RepairSetupResult      `json:"repairChoices"`
			Route         string                                 `json:"route"`
			Operation     struct {
				OperationID string `json:"operationId"`
				Status      string `json:"status"`
				Message     string `json:"message"`
				Error       *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"operation"`
			State struct {
				ID       string `json:"id"`
				HumanURL string `json:"humanUrl"`
				Route    string `json:"route"`
				Status   string `json:"status"`
			} `json:"state"`
			Logs struct {
				Events []struct {
					Stream  string `json:"stream"`
					Message string `json:"message"`
					Line    string `json:"line"`
				} `json:"events"`
				Diagnostics []relaybaseclient.Diagnostic `json:"diagnostics"`
			} `json:"logs"`
		} `json:"data"`
	} `json:"result"`
}

func setupAndStartResultFromData(data json.RawMessage) (setupAndStartActionResult, bool) {
	var result setupAndStartActionResult
	if !unmarshalData(data, &result) {
		return setupAndStartActionResult{}, false
	}
	tool := firstNonEmpty(result.ToolName, result.Tool, result.Result.Tool)
	if tool != "setup_and_start_project" {
		return setupAndStartActionResult{}, false
	}
	return result, true
}

func setupPreviewReadyMessage(preview relaybaseclient.SetupPlanPreview) string {
	parts := []string{
		"Operator Agent setup preview ready",
		fmt.Sprintf("files %d", setupWriteCount(&preview)),
	}
	if preview.CWD != "" {
		parts = append(parts, "project "+preview.CWD)
	}
	if preview.SelectedPlan.ID != "" {
		parts = append(parts, "plan "+preview.SelectedPlan.ID)
	}
	if command := setupPreviewSelectedCommand(preview); command != "" {
		parts = append(parts, "command "+command)
	}
	if strategy := setupPreviewPortStrategy(preview); strategy != "" {
		parts = append(parts, "port strategy "+strategy)
	}
	return assistant.SanitizeText(strings.Join(parts, "; ") + ".")
}

func setupPreviewSelectedCommand(preview relaybaseclient.SetupPlanPreview) string {
	candidates := preview.SelectedPlan.Choice.RuntimeStartCommandCandidates
	if len(candidates) == 0 {
		return ""
	}
	return firstNonEmpty(candidates[0].CommandPreview, strings.Join(candidates[0].Command, " "))
}

func setupPreviewPortStrategy(preview relaybaseclient.SetupPlanPreview) string {
	if len(preview.SelectedPlan.Choice.RuntimePortStrategies) > 0 {
		return preview.SelectedPlan.Choice.RuntimePortStrategies[0].ID
	}
	if len(preview.SelectedPlan.Choice.PortStrategies) > 0 {
		return preview.SelectedPlan.Choice.PortStrategies[0]
	}
	return ""
}

func agentToolStatusMessage(event relaybaseclient.AgentRunEvent) string {
	tool := firstNonEmpty(stringField(event.Data, "toolName"), stringField(event.Data, "tool"), "tool")
	if event.Type == "tool.failed" {
		return "Operator Agent tool failed: " + tool + "."
	}
	return "Operator Agent tool completed: " + tool + "."
}

func agentActionResultMessage(event relaybaseclient.AgentRunEvent) string {
	if result, ok := setupAndStartResultFromData(event.Data); ok {
		return setupAndStartActionResultMessage(result)
	}
	tool := firstNonEmpty(stringField(event.Data, "toolName"), stringField(event.Data, "tool"), "tool")
	status := "completed"
	if event.Type == "tool.failed" {
		status = "failed"
	}
	if event.Type == "action_result" {
		status = firstNonEmpty(stringField(event.Data, "status"), status)
	}
	result := stringField(event.Data, "message")
	if result == "" {
		result = diagnosticMessageFromData(event.Data)
	}
	if result == "" {
		result = "Operator Agent " + tool + " " + status + "."
	}
	return result
}

func setupAndStartActionResultMessage(result setupAndStartActionResult) string {
	phase := result.Result.Data.Phase
	switch phase {
	case "setup_applied":
		parts := []string{
			"Setup applied",
			fmt.Sprintf("files %d", len(result.Result.Data.Setup.AppliedFiles)),
		}
		if app := result.Result.Data.Setup.RegisteredApp; app != nil && app.ID != "" {
			parts = append(parts, "registered app "+app.ID)
		}
		parts = append(parts, "start still requires a separate approval")
		return assistant.SanitizeText(strings.Join(parts, "; ") + ".")
	case "manifest_registered":
		parts := []string{"Manifest registered"}
		if result.Result.Data.Registered.App.ID != "" {
			parts = append(parts, "app "+result.Result.Data.Registered.App.ID)
		}
		if result.Result.Data.Registered.ManifestPath != "" {
			parts = append(parts, "manifest "+result.Result.Data.Registered.ManifestPath)
		}
		parts = append(parts, "start still requires a separate approval")
		return assistant.SanitizeText(strings.Join(parts, "; ") + ".")
	case "started":
		parts := []string{"Start completed"}
		if appID := firstNonEmpty(result.Result.Data.AppID, result.Result.Data.State.ID); appID != "" {
			parts = append(parts, "app "+appID)
		}
		if operationID := firstNonEmpty(result.Result.Data.Operation.OperationID, result.Result.OperationID); operationID != "" {
			parts = append(parts, "operation "+operationID)
		}
		if status := firstNonEmpty(result.Result.Data.Operation.Status, result.Result.Status); status != "" {
			parts = append(parts, "status "+status)
		}
		if route := firstNonEmpty(result.Result.Data.Route, result.Result.Data.State.HumanURL, result.Result.Data.State.Route); route != "" {
			parts = append(parts, "route "+route)
		}
		if logs := compactLogLines(result.Result.Data.Logs.Events, 3); len(logs) > 0 {
			parts = append(parts, "logs "+strings.Join(logs, " | "))
		}
		return assistant.SanitizeText(strings.Join(parts, "; ") + ".")
	case "start_failed":
		parts := []string{"Start failed"}
		if appID := result.Result.Data.AppID; appID != "" {
			parts = append(parts, "app "+appID)
		}
		if operationID := firstNonEmpty(result.Result.Data.Operation.OperationID, result.Result.OperationID); operationID != "" {
			parts = append(parts, "operation "+operationID)
		}
		if status := firstNonEmpty(result.Result.Data.Operation.Status, result.Result.Status); status != "" {
			parts = append(parts, "status "+status)
		}
		if message := firstNonEmpty(operationErrorMessage(result), diagnosticMessage(result.Result.Diagnostic)); message != "" {
			parts = append(parts, message)
		}
		if choices := setupRepairChoiceCount(&result.Result.Data.RepairChoices); choices > 0 {
			parts = append(parts, fmt.Sprintf("repair choices %d", choices))
		}
		if logs := compactLogLines(result.Result.Data.Logs.Events, 2); len(logs) > 0 {
			parts = append(parts, "logs "+strings.Join(logs, " | "))
		}
		return assistant.SanitizeText(strings.Join(parts, "; ") + ".")
	default:
		if result.Result.Diagnostic != nil {
			return agentDiagnosticMessage(*result.Result.Diagnostic)
		}
		return "Operator Agent setup/start action completed."
	}
}

func compactLogLines(events []struct {
	Stream  string `json:"stream"`
	Message string `json:"message"`
	Line    string `json:"line"`
}, limit int) []string {
	lines := []string{}
	for _, event := range events {
		message := firstNonEmpty(event.Message, event.Line)
		if message == "" {
			continue
		}
		if event.Stream != "" {
			message = "[" + event.Stream + "] " + message
		}
		lines = append(lines, assistant.SanitizeText(message))
		if len(lines) >= limit {
			break
		}
	}
	return lines
}

func operationErrorMessage(result setupAndStartActionResult) string {
	if result.Result.Data.Operation.Error != nil && result.Result.Data.Operation.Error.Message != "" {
		return result.Result.Data.Operation.Error.Message
	}
	return result.Result.Data.Operation.Message
}

func diagnosticMessage(diagnostic *relaybaseclient.AgentDiagnostic) string {
	if diagnostic == nil {
		return ""
	}
	return agentDiagnosticMessage(*diagnostic)
}

func diagnosticMessageFromData(data json.RawMessage) string {
	if diagnostic, ok := agentDiagnosticFromData(data); ok {
		return agentDiagnosticMessage(diagnostic)
	}
	var wrapper struct {
		Diagnostic relaybaseclient.AgentDiagnostic `json:"diagnostic"`
		Content    string                          `json:"content"`
		Message    string                          `json:"message"`
	}
	if unmarshalData(data, &wrapper) {
		return assistant.SanitizeText(firstNonEmpty(wrapper.Content, wrapper.Message, wrapper.Diagnostic.Message))
	}
	return ""
}

func stringField(data json.RawMessage, field string) string {
	if len(data) == 0 {
		return ""
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(data, &record); err != nil {
		return ""
	}
	raw, ok := record[field]
	if !ok {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err == nil {
		return assistant.SanitizeText(value)
	}
	return ""
}

func unmarshalData(data json.RawMessage, target any) bool {
	if len(data) == 0 {
		return false
	}
	return json.Unmarshal(data, target) == nil
}

func valueOr(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func dashboardHeight(height int) int {
	return maxInt(8, height-5)
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}

func (m RootModel) preferenceSnapshot() preferences.Preferences {
	snapshot := m.preferences
	snapshot.Panes.Pinned = m.paneManager.PinnedIDs()
	snapshot.Panes.Hidden = m.paneManager.HiddenIDs()
	snapshot.Panes.Order = m.paneManager.OrderIDs()
	snapshot.Panes.Colors = m.paneManager.Colors()
	snapshot.Layout.LastPage = m.paneManager.Page()
	return preferences.Sanitize(snapshot)
}

func (m RootModel) persistPreferencesCmd() tea.Cmd {
	return commands.SavePreferencesCmd(m.preferenceStore, m.preferenceSnapshot())
}

func (m *RootModel) scrollBody(delta int) {
	m.bodyScrollOffset = maxInt(0, m.bodyScrollOffset+delta)
}

func (m *RootModel) resetBodyScroll() {
	m.bodyScrollOffset = 0
}

func (m *RootModel) clampBodyScroll() {
	m.bodyScrollOffset = maxInt(0, m.bodyScrollOffset)
}

func (m RootModel) mouseInBody(y int) bool {
	if m.height <= 0 {
		return true
	}
	bodyTop := 3
	bodyBottom := m.height - 2
	return y >= bodyTop && y < bodyBottom
}

func (m RootModel) daemonUnavailableMessage() string {
	baseURL := "the configured daemon URL"
	if m.client != nil && m.client.BaseURL() != "" {
		baseURL = m.client.BaseURL()
	}
	if m.daemonBootstrapAvailable() {
		return "Relaybase daemon is unavailable at " + baseURL + ". Use /daemon repair or type fix daemon to start it through the Relaybase TUI launch bridge. Retrying..."
	}
	return "Relaybase daemon is unavailable at " + baseURL + ". " + m.manualDaemonRecoveryInstruction() + " Retrying..."
}

func (m RootModel) daemonBridgeUnavailableMessage(action string) string {
	baseURL := "the configured daemon URL"
	if m.client != nil && m.client.BaseURL() != "" {
		baseURL = m.client.BaseURL()
	}
	prefix := "Daemon " + action + " through the local launch bridge is unavailable from this direct TUI launch."
	return prefix + " Relaunch with: relaybase tui. " + m.manualDaemonRecoveryInstruction() + " Then use /daemon retry. Target: " + baseURL + "."
}

func (m RootModel) manualDaemonRecoveryInstruction() string {
	return "Or start the daemon in another terminal with: " + m.relaybaseServeCommand() + "."
}

func (m RootModel) relaybaseServeCommand() string {
	parts := []string{"relaybase", "serve"}
	host, port := hostPortFromBaseURL(m.cfg.BaseURL)
	if host != "" && host != "127.0.0.1" && host != "localhost" {
		parts = append(parts, "--host", shellQuote(host))
	}
	if port != "" && port != "7777" {
		parts = append(parts, "--port", shellQuote(port))
	}
	if stateDir := strings.TrimSpace(m.cfg.StateDir); stateDir != "" {
		parts = append(parts, "--state-dir", shellQuote(stateDir))
	}
	return strings.Join(parts, " ")
}

func hostPortFromBaseURL(baseURL string) (string, string) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", ""
	}
	return parsed.Hostname(), parsed.Port()
}

func shellQuote(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return `""`
	}
	if !strings.ContainsAny(value, " \t\"") {
		return value
	}
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

func bootstrapResultMessage(result *bootstrap.DaemonResult) string {
	if result == nil {
		return "No daemon bootstrap result was returned."
	}
	status := "not reachable"
	if result.Reachable {
		status = "reachable"
	}
	parts := []string{"Relaybase daemon is " + status}
	if result.Code != "" {
		parts = append(parts, "code "+result.Code)
	}
	if result.Started {
		parts = append(parts, "started by bridge")
	}
	if result.Error != "" {
		parts = append(parts, "detail "+assistant.SanitizeText(result.Error))
	}
	if result.UserAction != "" {
		parts = append(parts, "next "+assistant.SanitizeText(result.UserAction))
	}
	if result.LogPath != "" {
		parts = append(parts, "log "+result.LogPath)
	}
	return strings.Join(parts, "; ") + "."
}

func (m *RootModel) scheduleDaemonRetryCmd() tea.Cmd {
	m.daemonRetryAttempt++
	delay := retryDelay(m.daemonRetryAttempt)
	return tea.Tick(delay, func(time.Time) tea.Msg {
		return daemonRetryMsg{}
	})
}

func (m *RootModel) scheduleEventRetryCmd() tea.Cmd {
	m.eventRetryAttempt++
	delay := retryDelay(m.eventRetryAttempt)
	return tea.Tick(delay, func(time.Time) tea.Msg {
		return eventRetryMsg{}
	})
}

func retryDelay(attempt int) time.Duration {
	switch {
	case attempt <= 1:
		return time.Second
	case attempt == 2:
		return 2 * time.Second
	case attempt == 3:
		return 5 * time.Second
	default:
		return 10 * time.Second
	}
}

func batchCommands(cmds ...tea.Cmd) tea.Cmd {
	filtered := []tea.Cmd{}
	for _, cmd := range cmds {
		if cmd != nil {
			filtered = append(filtered, cmd)
		}
	}
	if len(filtered) == 0 {
		return nil
	}
	return tea.Batch(filtered...)
}
