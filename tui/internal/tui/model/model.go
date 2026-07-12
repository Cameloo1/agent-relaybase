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

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/bootstrap"
	"github.com/cameloo/relaybase/tui/internal/config"
	"github.com/cameloo/relaybase/tui/internal/events"
	"github.com/cameloo/relaybase/tui/internal/preferences"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/assistant"
	"github.com/cameloo/relaybase/tui/internal/tui/commandpalette"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/composer"
	"github.com/cameloo/relaybase/tui/internal/tui/contextmenu"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/layout"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/response"
	"github.com/cameloo/relaybase/tui/internal/tui/setupwizard"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
	usagecomponent "github.com/cameloo/relaybase/tui/internal/tui/usage"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

type Diagnostic struct {
	Code     string
	Severity string
	Message  string
}

type clipboardPasteLoadedMsg struct {
	Text string
	Err  error
}

type clipboardCopyFinishedMsg struct {
	Err       error
	PaneID    string
	PaneTitle string
	LineCount int
	Target    string
}

type pasteReadyMsg struct {
	Generation uint64
	Text       string
	Bytes      int
	Lines      int
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
	cfg                    config.Config
	client                 *relaybaseclient.Client
	bootstrapClient        *bootstrap.Client
	ctx                    context.Context
	cancel                 context.CancelFunc
	state                  *relaybaseclient.RelaybaseState
	stream                 *relaybaseclient.EventStream
	connectionStatus       string
	eventStatus            string
	eventCount             int
	diagnostics            []Diagnostic
	theme                  styles.Theme
	styles                 styles.Styles
	keymap                 keymap.KeyMap
	paneManager            panes.Manager
	appInventory           inventory.Manager
	contextMenu            contextmenu.Menu
	preferences            preferences.Preferences
	preferenceStore        preferences.Store
	commandInput           string
	commandActive          bool
	composer               composer.Model
	paste                  *pendingPaste
	pasteGeneration        uint64
	interaction            interaction.State
	responseOffset         int
	responseFollow         bool
	responseNewOutput      int
	assistantHistory       []string
	assistantTimeline      []string
	naturalHistory         []assistant.HistoryEntry
	agentDelta             string
	lastAssistantLine      string
	historyExpanded        bool
	setupSession           setupwizard.State
	registrationPreview    *relaybaseclient.RegistrationSetupResult
	regRepairPreview       *relaybaseclient.RegistrationRepairPreviewResult
	regVerifyAppID         string
	pendingConfirm         *confirmationRequest
	quitConfirmation       bool
	agentConfig            *relaybaseclient.AgentConfig
	agentStatus            string
	agentDiagnostics       []relaybaseclient.AgentDiagnostic
	agentSession           *relaybaseclient.AgentSession
	agentSessions          []relaybaseclient.AgentSession
	threadDrafts           map[string]threadDraftState
	threadResponses        map[string]threadResponseState
	agentStream            *relaybaseclient.AgentEventStream
	agentStreamSessionID   string
	agentStreamGeneration  uint64
	agentInitialReplay     bool
	agentPendingInput      string
	agentPendingGeneration uint64
	agentMessageGeneration uint64
	pendingSubmissionDraft *submissionDraftState
	authorizedProjectRoots []string
	pendingAgentApproval   *relaybaseclient.AgentApproval
	lastNaturalAction      string
	helpVisible            bool
	helpSearch             textinput.Model
	helpMatches            []slash.CommandMatch
	helpSelected           int
	helpDetailOffset       int
	usage                  usagecomponent.Model
	usageRequestGeneration uint64
	threadSwitcherVisible  bool
	threadSwitcherLoading  bool
	threadSwitcherSelected int
	codePickerVisible      bool
	codePickerSelected     int
	commandPalette         commandpalette.Model
	clipboardWriteReady    bool
	appPackages            []relaybaseclient.AppPackageDefinition
	activePackageRun       *relaybaseclient.AppPackageRun
	packageListRequested   bool
	packageRunProgress     string
	packageRunPolling      map[string]bool
	packageRunPollFailures map[string]int
	packageRunReported     map[string]bool
	logFetchPending        map[string]string
	diagnosticsExpanded    bool
	width                  int
	height                 int
	bodyScrollOffset       int
	daemonRetryAttempt     int
	eventRetryAttempt      int
	lastBootstrapResult    *bootstrap.DaemonResult
	assistantPrompt        string
	localThreadGeneration  uint64
	composerHistoryID      uint64
	now                    func() time.Time
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
	PackageAction   string
	PackageID       string
	PackageRunID    string
	Details         []string
}

type threadDraftState struct {
	Snapshot composer.Snapshot
	Active   bool
}

// threadResponseState keeps every response-surface cursor and transcript tied
// to the daemon thread that produced it. It is process-memory only, just like
// composer drafts, and prevents a late replay or thread switch from blending
// two operator conversations in the same panel.
type threadResponseState struct {
	AssistantHistory  []string
	AssistantTimeline []string
	NaturalHistory    []assistant.HistoryEntry
	AgentDelta        string
	LastAssistantLine string
	HistoryExpanded   bool
	ResponseOffset    int
	ResponseFollow    bool
	ResponseNewOutput int
}

type pendingPaste struct {
	Generation uint64
	Snapshot   composer.Snapshot
	Active     bool
	Focus      interaction.PrimaryFocus
}

type submissionDraftState struct {
	Snapshot                composer.Snapshot
	Focus                   interaction.PrimaryFocus
	AwaitingAgentAcceptance bool
	SessionID               string
	Generation              uint64
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
	helpSearch := textinput.New()
	helpSearch.Prompt = ""
	helpSearch.Placeholder = "command or keyword"
	helpSearch.CharLimit = 80
	helpSearch.SetWidth(48)
	applyTextInputTheme(&helpSearch, theme)
	composerModel := composer.New(76)
	composerModel.ApplyTheme(theme, loadedPreferences.Assistant.BarColor)
	composerModel.SetHistoryScope("local:1")

	return RootModel{
		cfg:                    cfg,
		client:                 client,
		bootstrapClient:        bootstrapClient,
		ctx:                    ctx,
		cancel:                 cancel,
		connectionStatus:       "connecting",
		eventStatus:            "connecting",
		agentStatus:            "checking",
		diagnostics:            diagnostics,
		theme:                  theme,
		styles:                 tuiStyles,
		keymap:                 keymap.WithContextMenu(loadedPreferences.Keymap.ContextMenu),
		paneManager:            paneManager,
		preferences:            loadedPreferences,
		preferenceStore:        preferenceStore,
		assistantHistory:       []string{},
		naturalHistory:         []assistant.HistoryEntry{},
		width:                  80,
		height:                 24,
		lastBootstrapResult:    bootstrapReport,
		assistantPrompt:        assistant.PromptPlaceholder(),
		helpSearch:             helpSearch,
		helpMatches:            slash.SearchCatalog(""),
		commandPalette:         commandpalette.New(commandpalette.DefaultMaxRows),
		composer:               composerModel,
		interaction:            interaction.New(),
		responseFollow:         true,
		localThreadGeneration:  1,
		threadDrafts:           map[string]threadDraftState{},
		threadResponses:        map[string]threadResponseState{},
		clipboardWriteReady:    clipboardWriteAvailable(),
		packageRunPolling:      map[string]bool{},
		packageRunPollFailures: map[string]int{},
		packageRunReported:     map[string]bool{},
		logFetchPending:        map[string]string{},
		now:                    time.Now,
	}
}

func (m RootModel) Init() tea.Cmd {
	return commands.FetchStateCmd(m.ctx, m.client)
}

const packageRunPollWarningThreshold = 3

func (m *RootModel) beginPackageRunPolling(runID string) tea.Cmd {
	if runID == "" {
		return nil
	}
	if m.packageRunPolling == nil {
		m.packageRunPolling = map[string]bool{}
	}
	if m.packageRunPollFailures == nil {
		m.packageRunPollFailures = map[string]int{}
	}
	if m.packageRunReported == nil {
		m.packageRunReported = map[string]bool{}
	}
	if m.packageRunPolling[runID] {
		return nil
	}
	m.packageRunPolling[runID] = true
	m.packageRunPollFailures[runID] = 0
	delete(m.packageRunReported, runID)
	m.clearDiagnostics("app_package_run_poll_retry", "app_package_run_poll_failed")
	return commands.PollAppPackageRunCmd(m.ctx, m.client, runID, 0)
}

func (m *RootModel) continuePackageRunPolling(runID string, attempt int) tea.Cmd {
	if !m.packageRunPolling[runID] {
		return nil
	}
	return commands.PollAppPackageRunCmd(m.ctx, m.client, runID, attempt)
}

func (m *RootModel) finishPackageRun(run relaybaseclient.AppPackageRun) tea.Cmd {
	if m.packageRunReported == nil {
		m.packageRunReported = map[string]bool{}
	}
	delete(m.packageRunPolling, run.ID)
	delete(m.packageRunPollFailures, run.ID)
	m.clearDiagnostics("app_package_run_poll_retry", "app_package_run_poll_failed")
	if m.packageRunReported[run.ID] {
		return nil
	}
	m.packageRunReported[run.ID] = true
	m.packageRunProgress = ""
	m.addAssistantMessage(packageRunResultMessage(run))
	return commands.ListAppPackagesCmd(m.ctx, m.client)
}

func (m *RootModel) recoverPackageRunPoll(runID string, attempt int, err error) tea.Cmd {
	if errors.Is(err, context.Canceled) || m.ctx.Err() != nil {
		delete(m.packageRunPolling, runID)
		delete(m.packageRunPollFailures, runID)
		return nil
	}
	failures := m.packageRunPollFailures[runID] + 1
	m.packageRunPollFailures[runID] = failures
	if failures >= packageRunPollWarningThreshold {
		m.addOrReplaceDiagnostic("app_package_run_poll_retry", "warning", "Could not refresh app package run status; retrying with bounded backoff.")
	}
	return m.continuePackageRunPolling(runID, failures)
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
		// Width can reflow a multiline draft and therefore change DynamicHeight.
		// Size the composer first, then project every dependent region once.
		m.composer.SetWidth(maxInt(8, msg.Width-4))
		m.syncOperatorLayout()
		m.helpSearch.SetWidth(maxInt(16, minInt(48, msg.Width-12)))
		m.commandPalette.SetMaxRows(commandPaletteRows(msg.Height))
		m.clampBodyScroll()
		return m, nil
	case tea.MouseWheelMsg:
		mouse := msg.Mouse()
		frame := views.BuildShell(m.styles, m.shellData())
		if m.pendingConfirm != nil || m.pendingAgentApproval != nil || m.diagnosticsExpanded || strings.TrimSpace(m.setupPanelForView()) != "" {
			if region, ok := frame.HitMap.Hit(mouse.X, mouse.Y); ok && region.Kind == components.HitModal {
				switch mouse.Button {
				case tea.MouseWheelUp:
					m.scrollBody(-3)
				case tea.MouseWheelDown:
					m.scrollBody(3)
				}
			}
			return m, nil
		}
		if m.quitConfirmation || m.contextMenu.IsOpen() {
			return m, nil
		}
		if m.helpVisible {
			if region, ok := frame.HitMap.Hit(mouse.X, mouse.Y); ok {
				switch region.Kind {
				case components.HitHelpResult:
					switch mouse.Button {
					case tea.MouseWheelUp:
						m.moveHelpSelection(-1)
					case tea.MouseWheelDown:
						m.moveHelpSelection(1)
					}
				case components.HitHelpDetail:
					switch mouse.Button {
					case tea.MouseWheelUp:
						m.scrollHelpDetail(-3)
					case tea.MouseWheelDown:
						m.scrollHelpDetail(3)
					}
				}
			}
			return m, nil
		}
		if m.usage.IsOpen() {
			return m, nil
		}
		if m.codePickerVisible {
			if region, ok := frame.HitMap.Hit(mouse.X, mouse.Y); ok && region.Kind == components.HitCodePickerRow {
				switch mouse.Button {
				case tea.MouseWheelUp:
					m.moveCodePicker(-1)
				case tea.MouseWheelDown:
					m.moveCodePicker(1)
				}
			}
			return m, nil
		}
		if m.threadSwitcherVisible {
			if region, ok := frame.HitMap.Hit(mouse.X, mouse.Y); ok && region.Kind == components.HitThreadSwitcherRow {
				switch mouse.Button {
				case tea.MouseWheelUp:
					m.moveThreadSwitcher(-1)
				case tea.MouseWheelDown:
					m.moveThreadSwitcher(1)
				}
			}
			return m, nil
		}
		if m.inventoryVisible() {
			metrics := layout.Compute(maxInt(m.width, 1), maxInt(m.height, 1), m.composer.Rows())
			if metrics.Panes.Contains(mouse.X, mouse.Y) {
				switch mouse.Button {
				case tea.MouseWheelUp:
					m.scrollBody(-3)
				case tea.MouseWheelDown:
					m.scrollBody(3)
				}
				return m, nil
			}
		}
		if region, ok := frame.HitMap.Hit(mouse.X, mouse.Y); ok {
			switch region.Kind {
			case components.HitPaneSurface:
				return m, nil
			case components.HitPaneLogs:
				return m, m.scrollPaneByWheel(region.PaneID, mouse.Button)
			case components.HitResponse:
				m.setPrimaryFocus(interaction.FocusResponse)
				switch mouse.Button {
				case tea.MouseWheelUp:
					m.scrollResponse(-3)
				case tea.MouseWheelDown:
					m.scrollResponse(3)
				}
				return m, nil
			case components.HitComposer:
				m.setPrimaryFocus(interaction.FocusComposer)
				return m, nil
			case components.HitCommandPaletteRow:
				if mouse.Button == tea.MouseWheelUp {
					m.commandPalette.Move(-1)
				} else if mouse.Button == tea.MouseWheelDown {
					m.commandPalette.Move(1)
				}
				return m, nil
			case components.HitCommandPalette:
				return m, nil
			}
		}
		return m, nil
	case tea.MouseClickMsg:
		mouse := msg.Mouse()
		if mouse.Button != tea.MouseLeft || m.pendingConfirm != nil || m.pendingAgentApproval != nil || m.quitConfirmation || m.contextMenu.IsOpen() || m.usage.IsOpen() {
			return m, nil
		}
		frame := views.BuildShell(m.styles, m.shellData())
		region, ok := frame.HitMap.Hit(mouse.X, mouse.Y)
		if m.codePickerVisible {
			if !ok || (region.Kind != components.HitModal && region.Kind != components.HitCodePickerRow) {
				m.closeCodePicker()
				return m, nil
			}
			if region.Kind == components.HitCodePickerRow {
				if region.Index == m.codePickerSelected {
					return m.copySelectedCodeBlock()
				}
				m.codePickerSelected = region.Index
			}
			return m, nil
		}
		if m.threadSwitcherVisible {
			if !ok || (region.Kind != components.HitModal && region.Kind != components.HitThreadSwitcherRow) {
				m.closeThreadSwitcher()
				return m, nil
			}
			if region.Kind == components.HitThreadSwitcherRow {
				if region.Index == m.threadSwitcherSelected && !m.threadSwitcherLoading {
					return m.activateSelectedThread()
				}
				m.threadSwitcherSelected = region.Index
			}
			return m, nil
		}
		if m.helpVisible {
			if ok && region.Kind == components.HitHelpResult {
				m.helpSelected = region.Index
				m.clampHelpSelection()
				m.helpDetailOffset = 0
			}
			// Help is a transient owner. A click outside its interactive rows is
			// inert and never falls through to the dashboard behind the overlay.
			return m, nil
		}
		if m.diagnosticsExpanded || strings.TrimSpace(m.setupPanelForView()) != "" {
			return m, nil
		}
		if m.commandPaletteVisible() {
			if ok && region.Kind == components.HitCommandPaletteRow && m.commandPalette.SelectVisibleRow(region.Index) {
				m.completeCommandPalette()
			}
			return m, nil
		}
		if !ok {
			return m, nil
		}
		switch region.Kind {
		case components.HitHelpResult:
			if m.helpVisible {
				m.helpSelected = region.Index
				m.clampHelpSelection()
				m.helpDetailOffset = 0
			}
			return m, nil
		case components.HitHelpDetail:
			return m, nil
		case components.HitPaneCopyLogs:
			m.paneManager.SelectPane(region.PaneID)
			return m, m.copyPaneLogsCmd(region.PaneID)
		case components.HitPaneLogs:
			m.setPrimaryFocus(interaction.FocusPanes)
			if m.paneManager.SelectedPaneID() == region.PaneID {
				m.paneManager.FocusSelected()
			} else {
				m.paneManager.SelectPane(region.PaneID)
			}
			return m, nil
		case components.HitResponse:
			m.setPrimaryFocus(interaction.FocusResponse)
			return m, nil
		case components.HitComposer:
			m.setPrimaryFocus(interaction.FocusComposer)
			return m, nil
		case components.HitCommandPaletteRow:
			if m.commandPalette.SelectVisibleRow(region.Index) {
				m.completeCommandPalette()
			}
			return m, nil
		}
		return m, nil
	case tea.PasteMsg:
		if m.pendingConfirm != nil || m.pendingAgentApproval != nil || m.quitConfirmation || m.usage.IsOpen() || m.contextMenu.IsOpen() {
			return m, nil
		}
		if m.threadSwitcherVisible || m.codePickerVisible {
			return m, nil
		}
		if m.helpVisible {
			before := m.helpSearch.Value()
			clean := strings.Join(strings.Fields(composer.SanitizePaste(msg.Content)), " ")
			updated, cmd := m.helpSearch.Update(tea.PasteMsg{Content: clean})
			m.helpSearch = updated
			if m.helpSearch.Value() != before {
				m.syncHelpMatches()
			}
			return m, cmd
		}
		return m.beginPaste(msg.Content)
	case pasteReadyMsg:
		if m.pendingConfirm != nil || m.pendingAgentApproval != nil || m.quitConfirmation || m.usage.IsOpen() || m.contextMenu.IsOpen() || m.threadSwitcherVisible || m.codePickerVisible || m.helpVisible {
			return m.cancelPendingPaste(), nil
		}
		return m.completePaste(msg), nil
	case clipboardPasteLoadedMsg:
		if m.pendingConfirm != nil || m.pendingAgentApproval != nil || m.quitConfirmation || m.usage.IsOpen() || m.contextMenu.IsOpen() || m.threadSwitcherVisible || m.codePickerVisible || m.helpVisible {
			return m, nil
		}
		if msg.Err != nil {
			m.addDiagnostic("clipboard_paste_failed", "warning", "Could not read from the system clipboard.")
			return m, nil
		}
		if strings.TrimSpace(msg.Text) == "" {
			m.addDiagnostic("clipboard_paste_empty", "info", "Clipboard is empty.")
			return m, nil
		}
		return m.beginPaste(msg.Text)
	case clipboardCopyFinishedMsg:
		if msg.Err != nil {
			if msg.PaneID != "" {
				m.clipboardWriteReady = false
				m.addDiagnostic("clipboard_copy_failed", "warning", "Could not copy pane logs to the system clipboard.")
			} else {
				m.addDiagnostic("clipboard_copy_failed", "warning", "Could not write the current input to the system clipboard.")
			}
			return m, nil
		}
		if msg.PaneID != "" {
			m.addAssistantMessage(fmt.Sprintf("Copied %d log lines from %s.", msg.LineCount, msg.PaneTitle))
		} else if msg.Target != "" {
			m.addAssistantMessage("Copied " + msg.Target + " to clipboard.")
		} else {
			m.addAssistantMessage("Copied current input to clipboard.")
		}
		return m, nil
	case tea.KeyPressMsg:
		if m.quitConfirmation {
			return m.handleQuitConfirmationKey(msg)
		}
		if m.pendingAgentApproval != nil || m.pendingConfirm != nil {
			return m.handleBlockingModalKey(msg)
		}
		if m.usage.IsOpen() {
			return m.handleUsageKey(msg)
		}
		if m.codePickerVisible {
			return m.handleCodePickerKey(msg)
		}
		if m.threadSwitcherVisible {
			return m.handleThreadSwitcherKey(msg)
		}
		if isThreadSwitcherShortcut(msg) {
			return m.openThreadSwitcher()
		}
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
		if m.helpVisible {
			return m.handleHelpKey(msg)
		}
		if m.commandActive {
			return m.handleCommandInput(msg)
		}
		if m.interaction.Owner() == interaction.OwnerResponse {
			// Global console bindings remain global even while the response owns
			// navigation. Resolve them before adopting printable text as a draft.
			if keymap.Matches(msg, m.keymap.Quit) {
				if strings.TrimSpace(m.commandInput) != "" {
					m.quitConfirmation = true
					m.interaction.OpenModal(interaction.ModalQuitConfirmation)
					m.refreshAssistantPrompt()
					return m, nil
				}
				m.close()
				return m, tea.Quit
			}
			if keymap.Matches(msg, m.keymap.Help) {
				cmd := m.openHelp()
				m.diagnosticsExpanded = false
				return m, cmd
			}
			if keymap.Matches(msg, m.keymap.Diagnostics) {
				m.toggleDiagnostics()
				return m, nil
			}
			if msg.Text == "b" || msg.Keystroke() == "b" {
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
				return m, nil
			case keymap.Matches(msg, m.keymap.Down):
				m.scrollResponse(1)
				return m, nil
			case keymap.Matches(msg, m.keymap.PageUp):
				m.scrollResponse(-maxInt(1, m.height/4))
				return m, nil
			case keymap.Matches(msg, m.keymap.PageDown):
				m.scrollResponse(maxInt(1, m.height/4))
				return m, nil
			case keymap.Matches(msg, m.keymap.Home):
				m.gotoResponseTop()
				return m, nil
			case keymap.Matches(msg, m.keymap.End), keymap.Matches(msg, m.keymap.Follow):
				m.gotoResponseBottom()
				return m, nil
			case keymap.Matches(msg, m.keymap.Escape):
				m.setPrimaryFocus(interaction.FocusPanes)
				return m, nil
			}
			if updated, ok := m.startCommandInput(msg); ok {
				return updated, nil
			}
			// Response owns all remaining keys. In particular, Enter is inert
			// here and must not fall through to pane focus.
			return m, nil
		}
		if isPasteShortcut(msg) {
			return m, readClipboardCmd()
		}
		if keymap.Matches(msg, m.keymap.Diagnostics) {
			m.toggleDiagnostics()
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Quit) {
			if strings.TrimSpace(m.commandInput) != "" {
				m.quitConfirmation = true
				m.interaction.OpenModal(interaction.ModalQuitConfirmation)
				m.refreshAssistantPrompt()
				return m, nil
			}
			m.close()
			return m, tea.Quit
		}
		if keymap.Matches(msg, m.keymap.Help) {
			cmd := m.openHelp()
			m.diagnosticsExpanded = false
			return m, cmd
		}
		if keymap.Matches(msg, m.keymap.Escape) {
			if m.diagnosticsExpanded {
				m.diagnosticsExpanded = false
				m.resetBodyScroll()
			} else if m.paneManager.Focused() {
				m.paneManager.BlurFocus()
				m.resetBodyScroll()
			} else {
				m.closeHelp()
				m.resetBodyScroll()
			}
			return m, nil
		}
		if m.inventoryVisible() {
			if keymap.Matches(msg, m.keymap.Up) {
				m.appInventory.Move(-1)
				m.followInventorySelection()
				return m, nil
			}
			if keymap.Matches(msg, m.keymap.Down) {
				m.appInventory.Move(1)
				m.followInventorySelection()
				return m, nil
			}
			if keymap.Matches(msg, m.keymap.Enter) {
				cmd := m.requestSelectedInventoryStart()
				return m, cmd
			}
		}
		if m.handleBodyScrollKey(msg) {
			return m, nil
		}
		if m.paneManager.Focused() && keymap.Matches(msg, m.keymap.CopyLogs) {
			return m, m.copyPaneLogsCmd(m.paneManager.SelectedPaneID())
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
			m.commandInput = "/"
			m.setPrimaryFocus(interaction.FocusComposer)
			m.syncCommandPalette()
			m.refreshAssistantPrompt()
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Up) {
			if m.paneManager.Focused() {
				m.paneManager.ScrollSelected(1)
			} else {
				m.paneManager.MoveSelection(0, -1)
				m.followPaneSelection(-1)
			}
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Down) {
			if m.paneManager.Focused() {
				m.paneManager.ScrollSelected(-1)
			} else {
				m.paneManager.MoveSelection(0, 1)
				m.followPaneSelection(1)
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
				paneID := m.paneManager.SelectedPaneID()
				if m.paneManager.IsPaneAtOldestLogBoundary(paneID) {
					target := m.paneManager.OlderLogTarget()
					if target == nil || m.logFetchPending[paneID] == target.Before {
						return m, nil
					}
					m.logFetchPending[paneID] = target.Before
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
		m.appInventory.ApplyState(msg.State)
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
			commands.ListAppPackagesCmd(m.ctx, m.client),
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
		delete(m.logFetchPending, msg.Target.PaneID)
		m.paneManager.MergeSnapshot(msg.Target, msg.Snapshot)
		return m, nil
	case commands.LogsFailedMsg:
		delete(m.logFetchPending, msg.Target.PaneID)
		safeErr := safeLogErrorMessage(msg.Err)
		m.paneManager.MarkLogFetchFailed(msg.Target, safeErr)
		m.addDiagnostic("pane_logs_unavailable", "warning", fmt.Sprintf("Could not fetch logs for %s: %s", msg.Target.AppID, safeErr))
		return m, nil
	case commands.AppPackagesLoadedMsg:
		m.appPackages = append([]relaybaseclient.AppPackageDefinition(nil), msg.Packages...)
		m.clearDiagnostics("app_packages_unavailable")
		if m.packageListRequested {
			m.packageListRequested = false
			m.addAssistantMessage(appPackageListMessage(m.appPackages, m.state))
		}
		return m, nil
	case commands.AppPackagesFailedMsg:
		if m.packageListRequested {
			m.packageListRequested = false
			m.addAssistantMessage("Could not list app packages: " + safePackageErrorMessage(msg.Err))
		} else {
			m.addOrReplaceDiagnostic("app_packages_unavailable", "warning", "Saved app packages are temporarily unavailable from the daemon.")
		}
		return m, nil
	case commands.AppPackageCreatedMsg:
		if msg.Package != nil {
			m.upsertAppPackage(*msg.Package)
			m.addAssistantMessage(fmt.Sprintf("Created package %s with %d app(s).", msg.Package.Name, len(msg.Package.MemberAppIDs)))
		}
		return m, nil
	case commands.AppPackageCreateFailedMsg:
		m.addAssistantMessage("Could not create app package: " + safePackageErrorMessage(msg.Err))
		return m, nil
	case commands.AppPackageDeletedMsg:
		if msg.Package != nil {
			m.removeAppPackage(msg.Package.ID)
			m.addAssistantMessage("Deleted package " + msg.Package.Name + ". Running apps were not stopped.")
		}
		return m, nil
	case commands.AppPackageDeleteFailedMsg:
		m.addAssistantMessage("Could not delete app package: " + safePackageErrorMessage(msg.Err))
		return m, nil
	case commands.AppPackageRunStartedMsg:
		if msg.Run == nil {
			return m, nil
		}
		m.activePackageRun = msg.Run
		m.packageRunProgress = ""
		m.addAssistantMessage(packageRunAcceptedMessage(*msg.Run, msg.Action))
		if msg.Run.Terminal() {
			return m, m.finishPackageRun(*msg.Run)
		}
		return m, m.beginPackageRunPolling(msg.Run.ID)
	case commands.AppPackageRunStartFailedMsg:
		m.addAssistantMessage(fmt.Sprintf("Package %s failed: %s", msg.Action, safePackageErrorMessage(msg.Err)))
		return m, nil
	case commands.AppPackageRunLoadedMsg:
		if msg.Run == nil {
			return m, nil
		}
		if m.packageRunReported[msg.Run.ID] {
			return m, nil
		}
		m.activePackageRun = msg.Run
		if msg.Run.Terminal() {
			return m, m.finishPackageRun(*msg.Run)
		}
		m.packageRunPollFailures[msg.Run.ID] = 0
		m.clearDiagnostics("app_package_run_poll_retry", "app_package_run_poll_failed")
		if progress := packageRunProgressMessage(*msg.Run); progress != m.packageRunProgress {
			m.packageRunProgress = progress
			m.addAssistantMessage(progress)
		}
		return m, m.continuePackageRunPolling(msg.Run.ID, 0)
	case commands.AppPackageRunLoadFailedMsg:
		return m, m.recoverPackageRunPoll(msg.RunID, msg.Attempt, msg.Err)
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
	case commands.SetupRegistrationPreviewCompletedMsg:
		m.registrationPreview = msg.Result
		m.addAssistantMessage(registrationPreviewMessage(msg.Result))
		if msg.Result != nil && msg.Result.Approval.Required && msg.Result.PreviewID != "" {
			command := slash.ParsedCommand{Raw: "/register " + quoteSetupPath(msg.Request.Path), Kind: slash.KindRegister, Path: msg.Request.Path, Target: msg.Request.Path, NoVerify: msg.Request.VerificationMode == "none"}
			confirmation, err := m.prepareConfirmation(command)
			if err == nil {
				if msg.Result.VerificationIntent.WillStart {
					confirmation.Action = "confirm and verify registration"
					confirmation.Risk = "Daemon writes the approved manifest or registry update, starts the app once on a managed port, probes health, stops it, and verifies backend-port closure."
					confirmation.Expected = "The app ends stopped and is reported verified only when health, stop, and port closure all pass."
					confirmation.Details = []string{
						fmt.Sprintf("expected maximum: %dms", msg.Result.VerificationIntent.ExpectedMaximumMS),
						"no app will be left running after a successful proof",
					}
					for _, target := range msg.Result.VerificationIntent.HealthCandidates {
						confirmation.Details = append(confirmation.Details, "health candidate: "+target)
					}
				} else {
					confirmation.Action = "register without verification"
					confirmation.Risk = "Daemon writes the approved manifest or registry update without proving launch readiness."
					confirmation.Expected = "The app remains stopped and is honestly marked registered but unverified."
				}
				m.pendingConfirm = confirmation
				m.refreshAssistantPrompt()
			}
		}
		return m, nil
	case commands.SetupRegistrationApplyCompletedMsg:
		m.regVerifyAppID = ""
		m.registrationPreview = msg.Result
		m.addAssistantMessage(registrationPreviewMessage(msg.Result))
		return m, commands.FetchStateCmd(m.ctx, m.client)
	case commands.SetupRegistrationCancelCompletedMsg:
		if msg.Result != nil && msg.Result.Cancelled {
			m.addAssistantMessage(msg.Result.Message)
		} else {
			m.regVerifyAppID = ""
			m.addAssistantMessage("No active registration verification attempt was found.")
		}
		return m, nil
	case commands.SetupRegistrationRepairPreviewCompletedMsg:
		m.regRepairPreview = msg.Result
		if msg.Result == nil {
			m.addAssistantMessage("Registration repair preview was unavailable. No files or processes changed.")
			return m, nil
		}
		m.addAssistantMessage("Registration repair preview ready: " + msg.Result.Repair.Label + ".")
		m.pendingConfirm = &confirmationRequest{
			Action:       "apply repair and verify",
			Target:       slash.ResolvedTarget{Description: "app " + msg.Result.AppID},
			Risk:         "Daemon writes the exact previewed manifest patch, re-registers the app, and runs one new bounded start/health/stop proof.",
			Expected:     "The app ends stopped; verification passes only when health, stop, and backend-port closure pass.",
			Command:      slash.ParsedCommand{Kind: slash.KindRepair, Target: msg.Result.AppID},
			SetupCommand: &slash.ParsedCommand{Kind: slash.KindRepair, Target: msg.Result.AppID},
			Details:      []string{msg.Result.Repair.Reason, fmt.Sprintf("files: %d", len(msg.Result.FileWritePlan.Writes))},
		}
		m.refreshAssistantPrompt()
		return m, nil
	case commands.SetupRegistrationRepairApplyCompletedMsg:
		m.regVerifyAppID = ""
		m.regRepairPreview = nil
		m.registrationPreview = msg.Result
		m.addAssistantMessage(registrationPreviewMessage(msg.Result))
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
		if msg.Action == "apply registration" || msg.Action == "apply registration repair" || msg.Action == "cancel registration verification" {
			m.regVerifyAppID = ""
		}
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
	case commands.AgentUsageLoadedMsg:
		if msg.Generation == 0 || msg.Generation != m.usageRequestGeneration || !m.usage.IsOpen() {
			return m, nil
		}
		m.usage.Loaded(msg.Usage)
		return m, nil
	case commands.AgentUsageFailedMsg:
		if msg.Generation == 0 || msg.Generation != m.usageRequestGeneration || !m.usage.IsOpen() {
			return m, nil
		}
		m.usage.Failed(msg.Err)
		return m, nil
	case commands.AgentSessionCreatedMsg:
		m.closeAgentStream()
		m.agentSession = msg.Session
		m.syncComposerHistoryScope()
		m.agentStatus = "session"
		if msg.Session != nil {
			m.restoreThreadResponse(msg.Session.ID)
			m.restoreThreadDraft(msg.Session.ID)
			m.agentSessions = upsertAgentSession(m.agentSessions, *msg.Session)
			m.addAssistantMessage("New Operator Agent thread active: " + agentSessionLabel(*msg.Session) + ".")
		}
		pending := m.agentPendingInput
		pendingGeneration := m.agentPendingGeneration
		m.agentPendingInput = ""
		m.agentPendingGeneration = 0
		cmds := []tea.Cmd{}
		if msg.Session != nil && msg.Session.ID != "" {
			cmds = append(cmds, m.connectAgentEventsCmd(msg.Session.ID))
			if pending != "" {
				if pendingGeneration == 0 {
					pendingGeneration = m.nextAgentMessageGeneration()
				}
				m.bindPendingSubmission(msg.Session.ID, pendingGeneration)
				cmds = append(cmds, commands.SendAgentMessageCmd(m.ctx, m.client, msg.Session.ID, relaybaseclient.AgentMessageRequest{
					Content: pending,
					Context: m.agentContext(),
				}, pendingGeneration))
			}
		} else if pending != "" {
			m.restorePendingSubmissionDraft()
		}
		return m, tea.Batch(cmds...)
	case commands.AgentSessionCreateFailedMsg:
		m.agentPendingInput = ""
		m.agentPendingGeneration = 0
		m.authorizedProjectRoots = nil
		m.agentStatus = "unavailable"
		m.restorePendingSubmissionDraft()
		m.addDiagnostic("agent_session_create_failed", "error", fmt.Sprintf("Could not create Operator Agent session: %v", msg.Err))
		m.addAssistantMessage("Operator Agent session could not be created: " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentActiveSessionLoadedMsg:
		previousSessionID := m.agentSessionID()
		nextSessionID := ""
		if msg.Session != nil {
			nextSessionID = strings.TrimSpace(msg.Session.ID)
		}
		if previousSessionID != nextSessionID && previousSessionID != "" {
			m.captureThreadDraft()
			m.captureThreadResponse()
		}
		m.agentSession = msg.Session
		if nextSessionID == "" && previousSessionID != "" {
			m.advanceLocalThreadIdentity()
		} else {
			m.syncComposerHistoryScope()
		}
		if previousSessionID != nextSessionID {
			m.restoreThreadResponse(nextSessionID)
			m.restoreThreadDraft(nextSessionID)
		}
		if msg.Session == nil || msg.Session.ID == "" {
			m.agentStatus = "ready_no_thread"
			return m, nil
		}
		m.agentStatus = "session"
		m.agentSessions = upsertAgentSession(m.agentSessions, *msg.Session)
		m.addAssistantMessage("Active Operator Agent thread: " + agentSessionLabel(*msg.Session) + ".")
		return m, m.connectAgentEventsCmd(msg.Session.ID)
	case commands.AgentActiveSessionFailedMsg:
		if m.connectionStatus == "connected" {
			m.addDiagnostic("agent_active_thread_unavailable", "warning", fmt.Sprintf("Could not read active Operator Agent thread: %v", msg.Err))
		}
		return m, nil
	case commands.AgentSessionsListedMsg:
		m.agentSessions = append([]relaybaseclient.AgentSession(nil), msg.Sessions...)
		if m.threadSwitcherVisible {
			m.threadSwitcherLoading = false
			m.syncThreadSwitcherSelection()
		} else {
			m.addAssistantMessage(agentSessionListMessage(msg.Sessions, m.agentSessionID()))
		}
		return m, nil
	case commands.AgentSessionsListFailedMsg:
		m.threadSwitcherLoading = false
		m.addDiagnostic("agent_thread_list_failed", "warning", fmt.Sprintf("Could not list Operator Agent threads: %v", msg.Err))
		m.addAssistantMessage("Could not list Operator Agent threads: " + fmt.Sprint(msg.Err))
		return m, nil
	case commands.AgentSessionActivatedMsg:
		m.threadSwitcherLoading = false
		m.closeThreadSwitcher()
		m.closeAgentStream()
		m.agentSession = msg.Session
		m.syncComposerHistoryScope()
		if msg.Session != nil {
			m.restoreThreadResponse(msg.Session.ID)
			m.restoreThreadDraft(msg.Session.ID)
			m.agentSessions = upsertAgentSession(m.agentSessions, *msg.Session)
			m.addAssistantMessage("Switched Operator Agent thread to " + agentSessionLabel(*msg.Session) + ".")
			m.agentStatus = "session"
			return m, m.connectAgentEventsCmd(msg.Session.ID)
		}
		m.agentStatus = "ready_no_thread"
		m.restoreThreadResponse("")
		m.addAssistantMessage("No Operator Agent thread is active.")
		return m, nil
	case commands.AgentSessionActivateFailedMsg:
		m.threadSwitcherLoading = false
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
			m.advanceLocalThreadIdentity()
		}
		m.agentSessions = removeAgentSession(m.agentSessions, clearedID)
		delete(m.threadDrafts, clearedID)
		delete(m.threadResponses, clearedID)
		m.assistantHistory = nil
		m.assistantTimeline = nil
		m.naturalHistory = nil
		m.agentDelta = ""
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
		if !m.agentEventLifecycleCurrent(msg.SessionID, msg.Generation) {
			if msg.Stream != nil {
				_ = msg.Stream.Close()
			}
			return m, nil
		}
		m.agentStream = msg.Stream
		m.agentInitialReplay = true
		m.agentStatus = "streaming"
		m.clearDiagnostics(agentEventDisconnectedCode)
		return m, commands.NextAgentEventCmd(m.ctx, msg.Stream, msg.SessionID, msg.Generation)
	case commands.AgentEventMsg:
		if !m.agentEventLifecycleCurrent(msg.SessionID, msg.Generation) ||
			(msg.Event.SessionID != "" && msg.Event.SessionID != msg.SessionID) {
			// A closed stream can still deliver one queued replay event. Do not
			// let that stale thread mutate the active response surface.
			if msg.Stream != nil {
				_ = msg.Stream.Close()
			}
			return m, nil
		}
		m.agentStream = msg.Stream
		if msg.Event.Type != "stream.reconnecting" {
			m.agentStatus = "streaming"
			m.clearDiagnostics(agentEventDisconnectedCode)
		}
		m.applyAgentRunEvent(msg.Event)
		return m, commands.NextAgentEventCmd(m.ctx, msg.Stream, msg.SessionID, msg.Generation)
	case commands.AgentEventsDisconnectedMsg:
		if !m.agentEventLifecycleCurrent(msg.SessionID, msg.Generation) {
			return m, nil
		}
		m.agentStream = nil
		m.agentStreamSessionID = ""
		m.agentStreamGeneration++
		m.agentInitialReplay = false
		if m.agentSession != nil {
			m.agentStatus = "disconnected"
			m.addDiagnostic(agentEventDisconnectedCode, "warning", fmt.Sprintf("Operator Agent event stream disconnected: %v", msg.Err))
		}
		return m, nil
	case commands.AgentMessageSentMsg:
		completionSessionID := strings.TrimSpace(msg.SessionID)
		if completionSessionID == "" && msg.Result != nil {
			completionSessionID = strings.TrimSpace(msg.Result.Run.SessionID)
		}
		if !m.agentMessageCompletionCurrent(completionSessionID, msg.Generation) {
			return m, nil
		}
		m.authorizedProjectRoots = nil
		m.pendingSubmissionDraft = nil
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
		if !m.agentMessageCompletionCurrent(msg.SessionID, msg.Generation) {
			return m, nil
		}
		m.authorizedProjectRoots = nil
		m.agentStatus = "failed"
		m.restorePendingSubmissionDraft()
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

func (m RootModel) handleBlockingModalKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	if m.pendingAgentApproval != nil {
		m.interaction.OpenModal(interaction.ModalAgentApproval)
		if m.handleBodyScrollKey(msg) {
			return m, nil
		}
		if keymap.Matches(msg, m.keymap.Escape) {
			approvalID := m.pendingAgentApproval.ID
			m.pendingAgentApproval = nil
			m.interaction.CloseModal()
			m.resetBodyScroll()
			m.addAssistantMessage("Rejecting Operator Agent approval " + approvalID + ".")
			return m, commands.RejectAgentApprovalCmd(m.ctx, m.client, approvalID, "Rejected from Relaybase TUI with Esc")
		}
		if keymap.Matches(msg, m.keymap.Enter) {
			approval := *m.pendingAgentApproval
			m.pendingAgentApproval = nil
			m.interaction.CloseModal()
			m.resetBodyScroll()
			if approval.Status == "recovered_pending" {
				m.addAssistantMessage("Reconfirming recovered Operator Agent approval " + approval.ID + ".")
				return m, commands.ApproveAgentApprovalCmd(m.ctx, m.client, approval.ID, relaybaseclient.AgentApprovalResolutionRequest{Reconfirm: true, Resume: true})
			}
			m.addAssistantMessage("Approving Operator Agent approval " + approval.ID + ".")
			return m, commands.ApproveAgentApprovalCmd(m.ctx, m.client, approval.ID)
		}
		return m, nil
	}
	if m.pendingConfirm == nil {
		return m, nil
	}
	m.interaction.OpenModal(interaction.ModalConfirmation)
	if m.handleBodyScrollKey(msg) {
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Escape) {
		m.pendingConfirm = nil
		m.interaction.CloseModal()
		m.resetBodyScroll()
		m.addAssistantMessage("Confirmation cancelled.")
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Enter) {
		m.interaction.CloseModal()
		m.resetBodyScroll()
		return m, m.executePendingConfirmation()
	}
	return m, nil
}

func (m RootModel) handleUsageKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	if keymap.Matches(msg, m.keymap.Escape) {
		m.usage.Close()
		m.invalidateUsageRequest()
		m.interaction.CloseModal()
		return m, nil
	}
	if strings.EqualFold(msg.Text, "r") || strings.EqualFold(msg.Keystroke(), "r") {
		m.usage.Loading()
		generation := m.nextUsageRequestGeneration()
		return m, commands.FetchAgentUsageCmd(m.ctx, m.client, generation)
	}
	return m, nil
}

func (m *RootModel) nextUsageRequestGeneration() uint64 {
	m.usageRequestGeneration = incrementGeneration(m.usageRequestGeneration)
	return m.usageRequestGeneration
}

func (m *RootModel) invalidateUsageRequest() {
	m.usageRequestGeneration = incrementGeneration(m.usageRequestGeneration)
}

func (m RootModel) handleQuitConfirmationKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	if keymap.Matches(msg, m.keymap.Escape) {
		m.quitConfirmation = false
		m.interaction.CloseModal()
		m.refreshAssistantPrompt()
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Enter) {
		m.quitConfirmation = false
		m.interaction.CloseModal()
		m.close()
		return m, tea.Quit
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
	return views.RenderShell(m.styles, m.shellData())
}

func (m RootModel) shellData() views.ShellData {
	composerView := m.composer
	if composerView.Value() != m.commandInput {
		composerView.SetValue(m.commandInput)
	}
	composerView.SetWidth(maxInt(8, m.width-4))
	if m.commandActive {
		_ = composerView.Focus()
	}
	responseEntries := m.assistantHistoryForView()
	responseSource := strings.Join(responseEntries, "\n\n")
	data := views.ShellData{
		OperatorConsole:     true,
		Width:               m.width,
		Height:              m.height,
		BodyScrollOffset:    m.bodyScrollOffset,
		ConnectionStatus:    m.connectionStatus,
		EventStatus:         m.eventStatus,
		EventCount:          m.eventCount,
		AgentStatus:         m.agentStatus,
		AgentThreadLabel:    m.agentThreadStatusLabel(),
		StateKnown:          m.state != nil,
		AppCount:            m.registeredAppCount(),
		ActiveAppCount:      m.activeAppCount(),
		RegisteredAppCount:  m.registeredAppCount(),
		GroupCount:          len(m.groups()),
		Diagnostics:         m.viewDiagnostics(),
		DiagnosticsOpen:     m.diagnosticsExpanded,
		ShowHelp:            m.helpVisible,
		Help:                m.helpDataForView(),
		Usage:               m.usage.Snapshot(),
		ThreadSwitcher:      m.threadSwitcherDataForView(),
		CodePicker:          m.codePickerDataForView(),
		KeyMap:              m.keymap,
		AssistantPrompt:     m.assistantPrompt,
		AssistantHistory:    m.assistantHistoryForView(),
		SetupPanel:          m.setupPanelForView(),
		ContextMenu:         m.contextMenuSnapshot(),
		Confirmation:        m.confirmationForView(),
		Panes:               m.paneManager.CurrentPagePanes(),
		Inventory:           m.appInventory.Items(),
		FocusedPane:         m.paneManager.FocusedPane(),
		PaneLayout:          m.paneManager.Layout(),
		Page:                m.paneManager.Page(),
		PageCount:           m.paneManager.PageCount(),
		ClipboardWriteReady: m.clipboardWriteReady,
		CommandPalette:      m.commandPaletteDataForView(),
		ComposerView:        composerView.View(),
		ComposerRows:        composerView.Rows(),
		ComposerPasting:     m.paste != nil,
		ResponseSource:      responseSource,
		ResponseState:       m.agentStatus,
		ResponseFollow:      m.responseFollow,
		ResponseNewOutput:   m.responseNewOutput,
		ResponseOffset:      m.responseOffset,
		PrimaryFocus:        string(m.interaction.Focus),
	}
	if data.ResponseFollow {
		data.ResponseOffset = views.ResponseBottomOffset(data)
	} else {
		data.ResponseOffset = minInt(maxInt(0, data.ResponseOffset), views.ResponseScrollMax(data))
	}
	return data
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
	m.assistantTimeline = append(m.assistantTimeline, message)
	if !m.responseFollow {
		m.responseNewOutput++
	}
	m.lastAssistantLine = message
	m.refreshAssistantPrompt()
}

func (m *RootModel) refreshAssistantPrompt() {
	// Composer DynamicHeight can change after typing, paste, history adoption,
	// and thread restoration without a WindowSizeMsg. Every prompt refresh is
	// therefore also a cheap synchronization point for pane projection.
	defer m.syncOperatorLayout()
	if m.pendingAgentApproval != nil && m.interaction.Modal == interaction.ModalNone {
		m.resetBodyScroll()
		m.interaction.OpenModal(interaction.ModalAgentApproval)
	} else if m.pendingConfirm != nil && m.interaction.Modal == interaction.ModalNone {
		m.resetBodyScroll()
		m.interaction.OpenModal(interaction.ModalConfirmation)
	}
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
	m.syncComposer()
	if m.paste != nil {
		if keymap.Matches(msg, m.keymap.Escape) {
			return m.cancelPendingPaste(), nil
		}
		return m, nil
	}
	if isPasteShortcut(msg) {
		return m, readClipboardCmd()
	}
	if isCopyShortcut(msg) {
		payload := m.composer.SelectedText()
		if payload == "" {
			payload = m.composer.Value()
		}
		if strings.TrimSpace(payload) == "" {
			m.addDiagnostic("clipboard_copy_empty", "info", "There is no current input to copy.")
			return m, nil
		}
		return m, writeClipboardCmd(payload)
	}
	if m.commandPaletteVisible() {
		switch {
		case keymap.Matches(msg, m.keymap.Tab):
			m.completeCommandPalette()
			return m, nil
		case keymap.Matches(msg, m.keymap.Up):
			m.commandPalette.Move(-1)
			return m, nil
		case keymap.Matches(msg, m.keymap.Down):
			m.commandPalette.Move(1)
			return m, nil
		case keymap.Matches(msg, m.keymap.PageUp):
			m.commandPalette.Page(-1)
			return m, nil
		case keymap.Matches(msg, m.keymap.PageDown):
			m.commandPalette.Page(1)
			return m, nil
		case keymap.Matches(msg, m.keymap.Home):
			m.commandPalette.Home()
			return m, nil
		case keymap.Matches(msg, m.keymap.End):
			m.commandPalette.End()
			return m, nil
		}
	}
	if keymap.Matches(msg, m.keymap.Up) && m.composer.AtVisualTop() {
		if m.composer.PreviousHistory() {
			m.commandInput = m.composer.Value()
			m.syncCommandPalette()
			m.refreshAssistantPrompt()
		}
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Down) && m.composer.AtVisualBottom() {
		if m.composer.NextHistory() {
			m.commandInput = m.composer.Value()
			m.syncCommandPalette()
			m.refreshAssistantPrompt()
		}
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Escape) {
		m.setPrimaryFocus(interaction.FocusPanes)
		m.syncCommandPalette()
		m.refreshAssistantPrompt()
		return m, nil
	}
	if keymap.Matches(msg, m.keymap.Enter) {
		if m.shouldCompleteCommandOnEnter() {
			m.completeCommandPalette()
			return m, nil
		}
		input := m.commandInput
		m.pendingSubmissionDraft = &submissionDraftState{Snapshot: m.composer.Snapshot(), Focus: m.interaction.Focus}
		m.commandActive = false
		m.commandInput = ""
		m.composer.Clear()
		m.setPrimaryFocus(interaction.FocusPanes)
		m.syncCommandPalette()
		m.refreshAssistantPrompt()
		updated, command := m.submitAssistantInput(input)
		if updated.pendingSubmissionDraft == nil {
			return updated, command
		}
		updated.composerHistoryID++
		historyScope := updated.composerHistoryScopeID()
		updated.composer.AddHistory(composer.HistoryEntry{
			ID:        fmt.Sprintf("%s:%d", historyScope, updated.composerHistoryID),
			Value:     input,
			Source:    "tui",
			ThreadID:  historyScope,
			CreatedAt: updated.now(),
		})
		if !updated.pendingSubmissionDraft.AwaitingAgentAcceptance || command == nil {
			updated.pendingSubmissionDraft = nil
		}
		return updated, command
	}
	if isClearInput(msg) {
		m.composer.DeleteBeforeCursor()
		m.commandInput = m.composer.Value()
		if m.commandInput == "" {
			m.setPrimaryFocus(interaction.FocusPanes)
		}
		m.syncCommandPalette()
		m.refreshAssistantPrompt()
		return m, nil
	}
	if isBackspace(msg) {
		m.composer.Backspace()
		m.commandInput = m.composer.Value()
		if m.commandInput == "" {
			m.setPrimaryFocus(interaction.FocusPanes)
		}
		m.syncCommandPalette()
		m.refreshAssistantPrompt()
		return m, nil
	}
	if isDelete(msg) {
		m.composer.DeleteForward()
		m.commandInput = m.composer.Value()
		m.syncCommandPalette()
		m.refreshAssistantPrompt()
		return m, nil
	}
	command := m.composer.Update(msg)
	m.commandInput = m.composer.Value()
	if m.commandInput == "" && isClearInput(msg) {
		m.commandActive = false
	}
	m.syncCommandPalette()
	m.refreshAssistantPrompt()
	return m, command
}

func (m RootModel) beginPaste(text string) (RootModel, tea.Cmd) {
	if text == "" {
		return m, nil
	}
	m.syncComposer()
	m.pasteGeneration++
	m.paste = &pendingPaste{Generation: m.pasteGeneration, Snapshot: m.composer.Snapshot(), Active: m.commandActive, Focus: m.interaction.Focus}
	m.setPrimaryFocus(interaction.FocusComposer)
	m.refreshAssistantPrompt()
	return m, normalizePasteCmd(m.pasteGeneration, text)
}

func (m RootModel) completePaste(msg pasteReadyMsg) RootModel {
	if m.paste == nil || m.paste.Generation != msg.Generation {
		return m
	}
	pending := *m.paste
	m.paste = nil
	if err := m.composer.Paste(msg.Text); err != nil {
		m.composer.Restore(pending.Snapshot)
		m.commandInput = pending.Snapshot.Value
		m.commandActive = pending.Active
		if pending.Active {
			m.setPrimaryFocus(interaction.FocusComposer)
		} else {
			m.setPrimaryFocus(valueOrFocus(pending.Focus, interaction.FocusPanes))
		}
		m.addDiagnostic("composer_paste_rejected", "warning", fmt.Sprintf("Paste of %d bytes and %d lines exceeds the composer limit; the existing draft was preserved.", msg.Bytes, msg.Lines))
		m.syncCommandPalette()
		m.refreshAssistantPrompt()
		return m
	}
	m.commandInput = m.composer.Value()
	m.setPrimaryFocus(interaction.FocusComposer)
	m.syncCommandPalette()
	m.refreshAssistantPrompt()
	return m
}

func (m RootModel) cancelPendingPaste() RootModel {
	if m.paste == nil {
		return m
	}
	pending := *m.paste
	m.paste = nil
	m.pasteGeneration++
	m.composer.Restore(pending.Snapshot)
	m.commandInput = pending.Snapshot.Value
	m.commandActive = pending.Active
	if pending.Active {
		m.setPrimaryFocus(interaction.FocusComposer)
	} else {
		m.setPrimaryFocus(valueOrFocus(pending.Focus, interaction.FocusPanes))
	}
	m.syncCommandPalette()
	m.refreshAssistantPrompt()
	return m
}

func valueOrFocus(value interaction.PrimaryFocus, fallback interaction.PrimaryFocus) interaction.PrimaryFocus {
	if value == "" {
		return fallback
	}
	return value
}

func normalizePasteCmd(generation uint64, text string) tea.Cmd {
	return func() tea.Msg {
		clean := composer.SanitizePaste(text)
		lines := 0
		if clean != "" {
			lines = strings.Count(clean, "\n") + 1
		}
		return pasteReadyMsg{Generation: generation, Text: clean, Bytes: len([]byte(clean)), Lines: lines}
	}
}

func (m RootModel) startCommandInput(msg tea.KeyPressMsg) (RootModel, bool) {
	if isPasteShortcut(msg) || isCopyShortcut(msg) {
		return m, false
	}
	text := msg.Text
	if text == "" {
		return m, false
	}
	m.syncComposer()
	m.composer.Insert(text)
	m.commandInput = m.composer.Value()
	m.setPrimaryFocus(interaction.FocusComposer)
	m.syncCommandPalette()
	m.refreshAssistantPrompt()
	return m, true
}

func (m *RootModel) syncComposer() {
	if m.composer.Value() != m.commandInput {
		m.composer.SetValue(m.commandInput)
	}
	if m.commandActive && !m.composer.Focused() {
		_ = m.composer.Focus()
	}
}

func (m *RootModel) setPrimaryFocus(focus interaction.PrimaryFocus) {
	m.interaction.SetFocus(focus)
	if m.interaction.Focus != focus {
		return
	}
	if focus == interaction.FocusComposer {
		m.commandActive = true
		m.syncComposer()
		_ = m.composer.Focus()
	} else {
		m.commandActive = false
		m.composer.Blur()
	}
	m.refreshAssistantPrompt()
}

func (m *RootModel) restorePendingSubmissionDraft() {
	if m.pendingSubmissionDraft == nil {
		return
	}
	pending := *m.pendingSubmissionDraft
	m.pendingSubmissionDraft = nil
	// Never overwrite text the operator typed after an asynchronous send began.
	// The attempted value remains in scoped history in that case.
	if m.commandInput != "" {
		return
	}
	m.composer.Restore(pending.Snapshot)
	m.commandInput = pending.Snapshot.Value
	m.setPrimaryFocus(interaction.FocusComposer)
	m.syncCommandPalette()
	m.refreshAssistantPrompt()
}

func (m *RootModel) syncOperatorLayout() {
	metrics := layout.Compute(m.width, m.height, m.composer.Rows())
	m.paneManager.Resize(metrics.Panes.Width, metrics.Panes.Height)
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
		m.restorePendingSubmissionDraft()
		m.refreshAssistantPrompt()
		return m, nil
	}
	if m.agentConfig == nil {
		message := "Agent Gateway config is unavailable, so folder setup cannot use the Operator Agent yet. Start or retry the daemon with: " + m.relaybaseServeCommand() + ". Slash fallback: " + parsed.SuggestedSlash + "."
		m.recordAssistantInteraction(assistant.ResponseBlocked, parsed.Raw, message)
		m.restorePendingSubmissionDraft()
		m.refreshAssistantPrompt()
		return m, nil
	}
	if !m.agentConfig.Enabled {
		message := "Operator Agent is disabled for natural-language folder setup. Enable it in daemon config for model-backed setup. Slash fallback: " + parsed.SuggestedSlash + ". Daemon start command if needed: " + m.relaybaseServeCommand() + "."
		m.recordAssistantInteraction(assistant.ResponseBlocked, parsed.Raw, message)
		m.restorePendingSubmissionDraft()
		m.refreshAssistantPrompt()
		return m, nil
	}
	if !agentGatewayConfigured(m.agentConfig) {
		message := "Operator Agent is not fully configured for model-backed folder setup. Complete the daemon Agent configuration, then retry. Deterministic Slash fallback: " + parsed.SuggestedSlash + "."
		m.recordAssistantInteraction(assistant.ResponseBlocked, parsed.Raw, message)
		m.restorePendingSubmissionDraft()
		m.refreshAssistantPrompt()
		return m, nil
	}
	return m.submitAgentInput(parsed.AgentInput)
}

func (m RootModel) submitSlashCommand(input string) (RootModel, tea.Cmd) {
	command, err := slash.Parse(input)
	if err != nil {
		m.addAssistantMessage(err.Error())
		m.restorePendingSubmissionDraft()
		return m, nil
	}

	switch command.Kind {
	case slash.KindConfirm:
		if m.pendingConfirm == nil {
			m.addAssistantMessage("No pending action to confirm.")
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		return m, m.executePendingConfirmation()
	case slash.KindCancel:
		if m.regVerifyAppID != "" {
			appID := m.regVerifyAppID
			m.addAssistantMessage("Requesting cancellation for registration verification of " + appID + ".")
			return m, commands.SetupRegistrationCancelCmd(m.ctx, m.client, appID)
		}
		m.pendingConfirm = nil
		m.interaction.CloseModal()
		m.resetBodyScroll()
		m.addAssistantMessage("Confirmation cancelled.")
		return m, nil
	}

	if parsed, ok := m.agentManagedSlashInput(command); ok {
		if m.shouldUseAgentGateway() {
			root, err := m.authorizedProjectRootForCommand(command)
			if err != nil {
				m.addAssistantMessage(err.Error())
				m.restorePendingSubmissionDraft()
				return m, nil
			}
			m.authorizedProjectRoots = boundedAuthorizedProjectRoots([]string{root})
			return m.submitFolderAgentInput(parsed)
		}
		if command.Kind == slash.KindAddApp && strings.TrimSpace(command.Command) == "" && m.connectionStatus == "connected" {
			cmd, err := m.setupCmdForCommand(command, false)
			if err != nil {
				m.addAssistantMessage(err.Error())
				m.restorePendingSubmissionDraft()
				return m, nil
			}
			m.addAssistantMessage("Operator Agent is unavailable or not configured; requesting a deterministic daemon setup preview instead.")
			return m, cmd
		}
		if command.Kind == slash.KindAddApp && strings.TrimSpace(command.Command) == "" {
			return m.submitFolderAgentInput(parsed)
		}
	}

	if slash.RequiresConfirmation(command) && (m.pendingConfirm != nil || m.pendingAgentApproval != nil) {
		m.addAssistantMessage("Finish or cancel the pending approval before starting another destructive action.")
		m.restorePendingSubmissionDraft()
		return m, nil
	}

	if command.Kind == slash.KindRegister && !command.Confirm {
		request, err := m.registrationPreviewRequest(command.Path, command.NoVerify)
		if err != nil {
			m.addAssistantMessage(err.Error())
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		m.addAssistantMessage("Inspecting the project and compiling a registration preview. No files will be written.")
		return m, commands.SetupRegistrationPreviewCmd(m.ctx, m.client, request)
	}

	if slash.RequiresConfirmation(command) && !command.Confirm {
		confirmation, err := m.prepareConfirmation(command)
		if err != nil {
			m.addAssistantMessage(err.Error())
			m.restorePendingSubmissionDraft()
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
		m.restorePendingSubmissionDraft()
		return m, nil
	}
	if m.agentConfig != nil && !m.agentConfig.Enabled {
		m.addAssistantMessage("Operator Agent is disabled; slash commands and deterministic local commands remain available.")
		m.restorePendingSubmissionDraft()
		return m, nil
	}
	if m.pendingSubmissionDraft != nil {
		m.pendingSubmissionDraft.AwaitingAgentAcceptance = true
	}

	m.addAssistantMessage("You: " + content)
	m.agentStatus = "sending"
	context := m.agentContext()
	generation := m.nextAgentMessageGeneration()
	if m.agentSession == nil || m.agentSession.ID == "" {
		m.agentPendingInput = content
		m.agentPendingGeneration = generation
		m.bindPendingSubmission("", generation)
		return m, commands.CreateAgentSessionCmd(m.ctx, m.client, relaybaseclient.AgentSessionCreateRequest{
			Title:   "Relaybase TUI",
			Context: context,
		})
	}

	sessionID := m.agentSession.ID
	m.bindPendingSubmission(sessionID, generation)
	cmds := []tea.Cmd{
		commands.SendAgentMessageCmd(m.ctx, m.client, sessionID, relaybaseclient.AgentMessageRequest{
			Content: content,
			Context: context,
		}, generation),
	}
	if m.agentStream == nil {
		cmds = append(cmds, m.connectAgentEventsCmd(sessionID))
	}
	return m, tea.Batch(cmds...)
}

func (m *RootModel) nextAgentMessageGeneration() uint64 {
	m.agentMessageGeneration = incrementGeneration(m.agentMessageGeneration)
	return m.agentMessageGeneration
}

func (m *RootModel) bindPendingSubmission(sessionID string, generation uint64) {
	if m.pendingSubmissionDraft == nil {
		return
	}
	m.pendingSubmissionDraft.SessionID = strings.TrimSpace(sessionID)
	m.pendingSubmissionDraft.Generation = generation
}

func (m RootModel) agentMessageCompletionCurrent(sessionID string, generation uint64) bool {
	sessionID = strings.TrimSpace(sessionID)
	if generation == 0 {
		// The smoke renderer injects daemon-owned historical runs directly and
		// predates request generations. Keep that read-only compatibility path
		// only when this model has never started an interactive message request.
		return m.agentMessageGeneration == 0 && (sessionID == "" || sessionID == m.agentSessionID())
	}
	return generation == m.agentMessageGeneration && sessionID != "" && sessionID == m.agentSessionID()
}

func (m RootModel) shouldUseAgentGateway() bool {
	return agentGatewayConfigured(m.agentConfig)
}

func (m RootModel) agentManagedSlashInput(command slash.ParsedCommand) (assistant.ParsedInput, bool) {
	if command.Confirm {
		return assistant.ParsedInput{}, false
	}
	switch command.Kind {
	case slash.KindAddApp:
		pathValue := strings.TrimSpace(command.Path)
		if pathValue == "" || strings.TrimSpace(command.Command) != "" {
			return assistant.ParsedInput{}, false
		}
		return agentManagedSetupInput(command, "add "+pathValue, pathValue, "/configure "+quoteSetupPath(pathValue)+" --dry-run"), true
	case slash.KindConfigure:
		if command.DryRun {
			return assistant.ParsedInput{}, false
		}
		pathValue := strings.TrimSpace(command.Path)
		if pathValue == "" {
			pathValue = "current folder"
		}
		return agentManagedSetupInput(command, "configure "+pathValue, pathValue, "/configure "+quoteSetupPath(pathValue)+" --dry-run"), true
	case slash.KindRegister:
		return assistant.ParsedInput{}, false
	default:
		return assistant.ParsedInput{}, false
	}
}

func agentManagedSetupInput(command slash.ParsedCommand, agentInput string, pathValue string, fallback string) assistant.ParsedInput {
	return assistant.ParsedInput{
		Raw:            command.Raw,
		Normalized:     strings.ToLower(strings.TrimSpace(agentInput)),
		Source:         assistant.SourceSlash,
		Intent:         assistant.IntentAgentGateway,
		Command:        command,
		Target:         pathValue,
		Path:           pathValue,
		AgentInput:     agentInput,
		SuggestedSlash: fallback,
		ResponseType:   assistant.ResponseActionPreview,
	}
}

const maxAuthorizedProjectRoots = 8

func (m RootModel) authorizedProjectRootForCommand(command slash.ParsedCommand) (string, error) {
	var root string
	var err error
	switch command.Kind {
	case slash.KindAddApp, slash.KindConfigure:
		root, err = m.cwdForSetupTarget(command.Path)
	case slash.KindRegister:
		var request relaybaseclient.RegisterManifestRequest
		request, err = m.registerManifestRequest(firstNonEmpty(command.Path, command.Target))
		root = request.CWD
	default:
		return "", fmt.Errorf("Command does not provide an authorized project root.")
	}
	if err != nil {
		return "", err
	}
	return m.canonicalProjectRoot(root)
}

func (m RootModel) canonicalProjectRoot(root string) (string, error) {
	trimmed := strings.TrimSpace(root)
	if trimmed == "" {
		return "", fmt.Errorf("Project root is unavailable; provide an explicit project path.")
	}
	if !filepath.IsAbs(trimmed) {
		base := strings.TrimSpace(m.cfg.CurrentDirectory)
		if base == "" {
			return "", fmt.Errorf("Relative project path %q cannot be authorized without current-directory context.", trimmed)
		}
		trimmed = filepath.Join(base, trimmed)
	}
	canonical := filepath.Clean(trimmed)
	if evaluated, evalErr := filepath.EvalSymlinks(canonical); evalErr == nil {
		canonical = filepath.Clean(evaluated)
	}
	return canonical, nil
}

func boundedAuthorizedProjectRoots(roots []string) []string {
	result := make([]string, 0, min(len(roots), maxAuthorizedProjectRoots))
	for _, root := range roots {
		root = filepath.Clean(strings.TrimSpace(root))
		if root == "" || root == "." {
			continue
		}
		duplicate := false
		for _, existing := range result {
			if strings.EqualFold(existing, root) {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		result = append(result, root)
		if len(result) == maxAuthorizedProjectRoots {
			break
		}
	}
	return result
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
	case slash.KindLaunchPackage, slash.KindDeletePackage:
		definition, err := m.resolveAppPackage(command.PackageName)
		if err != nil {
			return nil, err
		}
		action := "launch package"
		risk := "Starts each eligible app through daemon lifecycle operations. Partial success is retained and Relaybase will not roll back apps that started."
		expected := fmt.Sprintf("Daemon creates one inspectable package run for %d ordered app member(s).", len(definition.MemberAppIDs))
		if command.Kind == slash.KindDeletePackage {
			action = "delete package"
			risk = "Deletes only the saved package definition. It does not stop or restart any app."
			expected = "Daemon deletes the package definition while preserving historical run records."
		}
		details := make([]string, 0, len(definition.MemberAppIDs))
		for _, appID := range definition.MemberAppIDs {
			details = append(details, appNameForPackage(m.state, appID)+" ("+appID+")")
		}
		return &confirmationRequest{
			Action:        action,
			Target:        slash.ResolvedTarget{Description: "package " + definition.Name},
			Risk:          risk,
			Expected:      expected,
			Command:       command,
			PackageAction: action,
			PackageID:     definition.ID,
			Details:       details,
		}, nil
	case slash.KindPackageRunRetry, slash.KindPackageRunAbort:
		action := "retry package run"
		risk := "Starts only failed, skipped, or interrupted members from the selected terminal package run. Successful apps are not rolled back."
		expected := "Daemon creates a linked retry run with inspectable per-app outcomes."
		if command.Kind == slash.KindPackageRunAbort {
			action = "abort package run"
			risk = "Prevents package members not yet enqueued from starting. It does not stop apps already started by the run."
			expected = "Daemon records an abort request and preserves every completed member outcome."
		}
		return &confirmationRequest{
			Action:        action,
			Target:        slash.ResolvedTarget{Description: "package run " + command.RunID},
			Risk:          risk,
			Expected:      expected,
			Command:       command,
			PackageAction: action,
			PackageRunID:  command.RunID,
		}, nil
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
	m.interaction.CloseModal()
	m.resetBodyScroll()
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
		if confirmation.SetupCommand.Kind == slash.KindRegister && m.registrationPreview != nil && m.registrationPreview.App != nil && m.registrationPreview.VerificationIntent.WillStart {
			m.regVerifyAppID = m.registrationPreview.App.ID
		}
		cmd, err := m.setupCmdForCommand(*confirmation.SetupCommand, true)
		if err != nil {
			m.regVerifyAppID = ""
			m.addAssistantMessage(err.Error())
			return nil
		}
		return cmd
	}
	if confirmation.DaemonRepair {
		return commands.DaemonBootstrapEnsureCmd(m.ctx, m.bootstrapClient)
	}
	if confirmation.PackageAction != "" {
		switch confirmation.Command.Kind {
		case slash.KindLaunchPackage:
			return commands.LaunchAppPackageCmd(m.ctx, m.client, confirmation.PackageID)
		case slash.KindDeletePackage:
			return commands.DeleteAppPackageCmd(m.ctx, m.client, confirmation.PackageID)
		case slash.KindPackageRunRetry:
			return commands.RetryAppPackageRunCmd(m.ctx, m.client, confirmation.PackageRunID)
		case slash.KindPackageRunAbort:
			return commands.AbortAppPackageRunCmd(m.ctx, m.client, confirmation.PackageRunID)
		}
	}
	return commands.LifecycleRequestBatchCmd(m.ctx, m.client, confirmation.Target.AppIDs, confirmation.LifecycleAction)
}

func (m RootModel) executeSlashCommand(command slash.ParsedCommand) (RootModel, tea.Cmd) {
	switch command.Kind {
	case slash.KindCreatePackage:
		m.addAssistantMessage(fmt.Sprintf("Creating package %s with %d registered app reference(s).", command.PackageName, len(command.Members)))
		return m, commands.CreateAppPackageCmd(m.ctx, m.client, command.PackageName, command.Members)
	case slash.KindPackages:
		m.packageListRequested = true
		m.addAssistantMessage("Refreshing saved app packages.")
		return m, commands.ListAppPackagesCmd(m.ctx, m.client)
	case slash.KindLaunchPackage, slash.KindDeletePackage:
		definition, err := m.resolveAppPackage(command.PackageName)
		if err != nil {
			m.addAssistantMessage(err.Error())
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		if command.Kind == slash.KindLaunchPackage {
			m.addAssistantMessage("Requesting package launch for " + definition.Name + ".")
			return m, commands.LaunchAppPackageCmd(m.ctx, m.client, definition.ID)
		}
		m.addAssistantMessage("Requesting package deletion for " + definition.Name + ".")
		return m, commands.DeleteAppPackageCmd(m.ctx, m.client, definition.ID)
	case slash.KindPackageRunRetry:
		m.addAssistantMessage("Requesting retry for package run " + command.RunID + ".")
		return m, commands.RetryAppPackageRunCmd(m.ctx, m.client, command.RunID)
	case slash.KindPackageRunAbort:
		m.addAssistantMessage("Requesting abort for package run " + command.RunID + ".")
		return m, commands.AbortAppPackageRunCmd(m.ctx, m.client, command.RunID)
	case slash.KindLaunch, slash.KindStop, slash.KindRestart:
		target, err := slash.ResolveLifecycleTarget(m.slashContext(), command.Target)
		if err != nil {
			m.addAssistantMessage(err.Error())
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		action := lifecycleActionForCommand(command)
		m.addAssistantMessage(fmt.Sprintf("Requesting %s for %s.", action, target.Description))
		return m, commands.LifecycleRequestBatchCmd(m.ctx, m.client, target.AppIDs, action)
	case slash.KindLogsExport:
		target, err := slash.ResolveExportTarget(m.slashContext(), command)
		if err != nil {
			m.addAssistantMessage(err.Error())
			m.restorePendingSubmissionDraft()
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
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		if !m.paneManager.SetPaneColor(target.PaneID, command.Color) {
			m.addAssistantMessage("Could not change pane color for " + target.Description + ".")
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		m.addAssistantMessage(fmt.Sprintf("Pane color set to %s for %s.", command.Color, target.Description))
		return m, m.persistPreferencesCmd()
	case slash.KindPin, slash.KindUnpin:
		target, err := slash.ResolvePaneTarget(m.slashContext(), command.Target)
		if err != nil {
			m.addAssistantMessage(err.Error())
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		pinned := command.Kind == slash.KindPin
		if !m.paneManager.SetPanePinned(target.PaneID, pinned) {
			m.addAssistantMessage("Could not update pin for " + target.Description + ".")
			m.restorePendingSubmissionDraft()
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
		m.addAssistantMessage("Showing command help.")
		return m, m.openHelp()
	case slash.KindUsage:
		m.usage.Open()
		m.interaction.OpenModal(interaction.ModalUsage)
		m.addAssistantMessage("Loading recorded model usage.")
		generation := m.nextUsageRequestGeneration()
		return m, commands.FetchAgentUsageCmd(m.ctx, m.client, generation)
	case slash.KindDaemonStatus:
		if !m.daemonBootstrapAvailable() {
			m.addAssistantMessage(m.daemonBridgeUnavailableMessage("status"))
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		m.addAssistantMessage("Checking Relaybase daemon through the local launch bridge.")
		return m, commands.DaemonBootstrapStatusCmd(m.ctx, m.bootstrapClient)
	case slash.KindDaemonRepair:
		if !m.daemonBootstrapAvailable() {
			m.addAssistantMessage(m.daemonBridgeUnavailableMessage("repair"))
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		m.addAssistantMessage("Requesting Relaybase daemon repair through the local launch bridge.")
		return m, commands.DaemonBootstrapEnsureCmd(m.ctx, m.bootstrapClient)
	case slash.KindThreadList:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		m.addAssistantMessage("Listing daemon-backed Operator Agent threads.")
		return m, commands.ListAgentSessionsCmd(m.ctx, m.client)
	case slash.KindThreadNew:
		return m, m.startNewAssistantThread(command.Value)
	case slash.KindThreadSwitch:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		sessionID, err := m.resolveAgentSessionTarget(command.Target)
		if err != nil {
			m.addAssistantMessage(err.Error())
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		m.addAssistantMessage("Switching Operator Agent thread to " + sessionID + ".")
		m.captureThreadDraft()
		m.captureThreadResponse()
		return m, commands.ActivateAgentSessionCmd(m.ctx, m.client, sessionID)
	case slash.KindThreadRename:
		if !m.agentThreadGatewayAvailable() {
			m.addAssistantMessage(m.threadGatewayUnavailableMessage())
			m.restorePendingSubmissionDraft()
			return m, nil
		}
		sessionID := m.agentSessionID()
		if sessionID == "" {
			m.addAssistantMessage("No daemon-backed Operator Agent thread is active. Use /thread new <title> first.")
			m.restorePendingSubmissionDraft()
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
		if !confirmed {
			request, err := m.registrationPreviewRequest(command.Path, command.NoVerify)
			if err != nil {
				return nil, err
			}
			return commands.SetupRegistrationPreviewCmd(m.ctx, m.client, request), nil
		}
		if m.registrationPreview == nil || m.registrationPreview.PreviewID == "" {
			return nil, fmt.Errorf("Registration preview is unavailable or stale; run /register again.")
		}
		return commands.SetupRegistrationApplyCmd(m.ctx, m.client, relaybaseclient.RegistrationApplyRequest{
			PreviewID:    m.registrationPreview.PreviewID,
			Confirm:      true,
			Confirmation: &relaybaseclient.SetupConfirmation{Confirmed: true, Reason: "TUI registration confirmation"},
		}), nil
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
		if m.registrationPreview != nil && m.registrationPreview.App != nil && m.registrationPreview.Verification != nil && len(m.registrationPreview.Verification.Repairs) > 0 {
			if confirmed {
				if m.regRepairPreview == nil || m.regRepairPreview.PreviewID == "" {
					return nil, fmt.Errorf("Registration repair preview is unavailable or stale; run /repair again.")
				}
				m.regVerifyAppID = m.regRepairPreview.AppID
				return commands.SetupRegistrationRepairApplyCmd(m.ctx, m.client, relaybaseclient.RegistrationRepairApplyRequest{
					PreviewID:    m.regRepairPreview.PreviewID,
					Confirm:      true,
					Confirmation: &relaybaseclient.SetupConfirmation{Confirmed: true, Reason: "TUI registration repair confirmation"},
				}), nil
			}
			repair := m.registrationPreview.Verification.Repairs[0]
			for _, candidate := range m.registrationPreview.Verification.Repairs {
				if candidate.Recommended {
					repair = candidate
					break
				}
			}
			return commands.SetupRegistrationRepairPreviewCmd(m.ctx, m.client, relaybaseclient.RegistrationRepairPreviewRequest{
				AppID:    m.registrationPreview.App.ID,
				RepairID: repair.ID,
			}), nil
		}
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
		strings.EqualFold(trimmed, "current folder") || strings.EqualFold(trimmed, "current directory") ||
		strings.EqualFold(trimmed, "this folder") || strings.EqualFold(trimmed, "this directory") {
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
	if strings.EqualFold(trimmed, "cwd") || strings.EqualFold(trimmed, "current folder") ||
		strings.EqualFold(trimmed, "current directory") || strings.EqualFold(trimmed, "this folder") ||
		strings.EqualFold(trimmed, "this directory") || trimmed == "." {
		cwd, err := m.cwdForSetupTarget(trimmed)
		if err != nil {
			return relaybaseclient.RegisterManifestRequest{}, err
		}
		return relaybaseclient.RegisterManifestRequest{ManifestPath: filepath.Join(cwd, "relaybase.app.json"), CWD: cwd, Mode: "folder"}, nil
	}
	if trimmed == "" || strings.EqualFold(trimmed, "current") {
		app := m.paneManager.SelectedPane()
		if app == nil || app.AppID == "" {
			return relaybaseclient.RegisterManifestRequest{}, fmt.Errorf("No selected app is available for manifest lookup.")
		}
		trimmed = app.AppID
	}
	if looksLikeManifestFile(trimmed) {
		return relaybaseclient.RegisterManifestRequest{ManifestPath: trimmed, CWD: maybeDir(trimmed), Mode: "manifest"}, nil
	}
	if looksLikePath(trimmed) {
		return relaybaseclient.RegisterManifestRequest{ManifestPath: filepath.Join(trimmed, "relaybase.app.json"), CWD: trimmed, Mode: "folder"}, nil
	}
	app, err := m.appForTarget(trimmed)
	if err != nil {
		return relaybaseclient.RegisterManifestRequest{}, err
	}
	manifestPath := setupwizard.ManifestPathFromApp(app)
	if manifestPath == "" {
		return relaybaseclient.RegisterManifestRequest{}, fmt.Errorf("App %s does not expose a manifest path in daemon state; provide an explicit relaybase.app.json path.", app.ID)
	}
	return relaybaseclient.RegisterManifestRequest{ManifestPath: manifestPath, CWD: setupwizard.CWDFromManifestPath(manifestPath), Mode: "manifest"}, nil
}

func (m RootModel) registrationPreviewRequest(target string, noVerify ...bool) (relaybaseclient.RegistrationPreviewRequest, error) {
	request, err := m.registerManifestRequest(target)
	if err != nil {
		return relaybaseclient.RegistrationPreviewRequest{}, err
	}
	pathValue := request.ManifestPath
	if request.Mode == "folder" {
		pathValue = request.CWD
	}
	verificationMode := "quick"
	if len(noVerify) > 0 && noVerify[0] {
		verificationMode = "none"
	}
	return relaybaseclient.RegistrationPreviewRequest{Path: pathValue, CWD: request.CWD, Mode: request.Mode, VerificationMode: verificationMode}, nil
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
	return looksLikeManifestFile(trimmed)
}

func looksLikeManifestFile(value string) bool {
	trimmed := strings.TrimSpace(value)
	lower := strings.ToLower(trimmed)
	return strings.HasSuffix(lower, ".json")
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

func quoteSetupPath(value string) string {
	trimmed := strings.TrimSpace(value)
	if !strings.ContainsAny(trimmed, " \t") {
		return trimmed
	}
	return `"` + strings.ReplaceAll(trimmed, `"`, `\"`) + `"`
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
		m.composer.Clear()
		m.setPrimaryFocus(interaction.FocusPanes)
		m.syncCommandPalette()
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
		m.addAssistantMessage("Showing command help.")
		return m.openHelp()
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
	m.composer.ApplyTheme(theme, m.preferences.Assistant.BarColor)
	applyTextInputTheme(&m.helpSearch, theme)
	for _, diagnostic := range diagnostics {
		m.addDiagnostic(diagnostic.Code, diagnostic.Severity, diagnostic.Message)
	}
}

func applyTextInputTheme(input *textinput.Model, theme styles.Theme) {
	base := lipgloss.NewStyle().Foreground(theme.Text).Background(theme.Background)
	focused := textinput.StyleState{
		Text:        base,
		Placeholder: lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.Background),
		Suggestion:  lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.Background),
		Prompt:      lipgloss.NewStyle().Foreground(theme.Accent).Background(theme.Background).Bold(true),
	}
	blurred := focused
	blurred.Prompt = lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.Background)
	input.SetStyles(textinput.Styles{
		Focused: focused,
		Blurred: blurred,
		Cursor: textinput.CursorStyle{
			Color: theme.Accent,
			Shape: tea.CursorBar,
			Blink: true,
		},
	})
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
	m.composer.ApplyTheme(m.theme, next)
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
		CurrentPage:            m.paneManager.Page(),
		CurrentCWD:             strings.TrimSpace(m.cfg.CurrentDirectory),
		AuthorizedProjectRoots: append([]string(nil), m.authorizedProjectRoots...),
		DaemonHasZeroApps:      m.hasNoRegisteredApps(),
		SetupWizardState:       agentSetupWizardState(m.setupSession),
		CurrentSetupPlanID:     currentSetupPlanID(m.setupSession),
		Diagnostics:            m.agentDiagnosticsForContext(),
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
	case "stream.reconnecting":
		m.agentStatus = "reconnecting"
		m.addOrReplaceDiagnostic(
			agentEventDisconnectedCode,
			"warning",
			fmt.Sprintf("Operator Agent event stream reconnecting from sequence %d (attempt %d).", int64Field(event.Data, "afterSequence"), intField(event.Data, "attempt")),
		)
	case "model.delta":
		if delta := stringField(event.Data, "delta"); delta != "" {
			m.agentDelta += delta
			m.lastAssistantLine = "Agent: " + assistant.SanitizeText(m.agentDelta)
			m.refreshAssistantPrompt()
		}
	case "answer":
		if content := stringField(event.Data, "content"); content != "" {
			m.agentDelta = ""
			m.recordAssistantInteraction(assistant.ResponseAnswer, "agent", content)
			m.refreshAssistantPrompt()
		}
	case "diagnostic":
		if diagnostic, ok := agentDiagnosticFromData(event.Data); ok {
			if !m.agentInitialReplay {
				m.addDiagnostic(agentDiagnosticCode(diagnostic), valueOr(diagnostic.Severity, "info"), agentDiagnosticMessage(diagnostic))
			}
			m.recordAssistantInteraction(assistant.ResponseDiagnostic, "agent", diagnostic.Message)
			m.refreshAssistantPrompt()
		}
	case "stream.replay_completed":
		m.agentInitialReplay = false
	case "blocked":
		m.addAssistantMessage(firstNonEmpty(stringField(event.Data, "content"), diagnosticMessageFromData(event.Data), "Operator Agent request was blocked."))
	case "clarification_needed":
		m.addAssistantMessage(firstNonEmpty(stringField(event.Data, "content"), "Operator Agent needs clarification."))
	case "tool.approval_required", "approval_required", "setup.file_write_approval_required", "setup.manifest_patch_approval_required":
		if approval, ok := agentApprovalFromData(event.Data); ok {
			m.pendingAgentApproval = &approval
			m.resetBodyScroll()
			m.interaction.OpenModal(interaction.ModalAgentApproval)
			m.addAssistantMessage("Operator Agent approval required: " + firstNonEmpty(approval.Target, approval.Action, approval.ToolName, approval.ID) + ".")
			m.refreshAssistantPrompt()
		}
	case "tool.approved":
		if approval, ok := agentApprovalFromData(event.Data); ok && m.pendingAgentApproval != nil && approval.ID == m.pendingAgentApproval.ID {
			m.pendingAgentApproval = nil
			m.interaction.CloseModal()
			m.resetBodyScroll()
		}
		m.addAssistantMessage("Operator Agent tool approval recorded.")
	case "tool.rejected":
		if approval, ok := agentApprovalFromData(event.Data); ok && m.pendingAgentApproval != nil && approval.ID == m.pendingAgentApproval.ID {
			m.pendingAgentApproval = nil
			m.interaction.CloseModal()
			m.resetBodyScroll()
		}
		m.addAssistantMessage("Operator Agent tool approval rejected.")
	case "tool.started":
		m.addAssistantMessage("Operator Agent tool started: " + firstNonEmpty(stringField(event.Data, "toolName"), stringField(event.Data, "tool"), "tool") + ".")
	case "tool.completed", "tool.failed":
		m.addAssistantMessage(agentToolStatusMessage(event))
	case "action_result":
		if m.pendingAgentApproval != nil && stringField(event.Data, "approvalId") == m.pendingAgentApproval.ID {
			m.pendingAgentApproval = nil
			m.interaction.CloseModal()
			m.resetBodyScroll()
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
		m.flushAgentDelta()
		m.agentStatus = "idle"
	case "run.failed":
		m.flushAgentDelta()
		m.agentStatus = "failed"
		if message := diagnosticMessageFromData(event.Data); message != "" {
			m.addAssistantMessage("Operator Agent run failed: " + message)
		}
	}
}

func (m *RootModel) flushAgentDelta() {
	delta := strings.TrimSpace(m.agentDelta)
	if delta == "" {
		return
	}
	m.agentDelta = ""
	m.addAssistantMessage("Agent: " + delta)
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

func (m RootModel) openCodePicker() (RootModel, tea.Cmd) {
	if len(m.responseCodeBlocks()) == 0 {
		m.addDiagnostic("response_code_unavailable", "info", "The active Agent response has no sanitized fenced code blocks to copy.")
		return m, nil
	}
	m.codePickerVisible = true
	m.codePickerSelected = minInt(maxInt(m.codePickerSelected, 0), len(m.responseCodeBlocks())-1)
	m.interaction.OpenTransient(interaction.TransientCodePicker)
	return m, nil
}

func (m RootModel) handleCodePickerKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		m.closeCodePicker()
		return m, nil
	case keymap.Matches(msg, m.keymap.Up), keymap.Matches(msg, m.keymap.Left):
		m.moveCodePicker(-1)
		return m, nil
	case keymap.Matches(msg, m.keymap.Down), keymap.Matches(msg, m.keymap.Right):
		m.moveCodePicker(1)
		return m, nil
	case keymap.Matches(msg, m.keymap.Home):
		m.codePickerSelected = 0
		return m, nil
	case keymap.Matches(msg, m.keymap.End):
		m.codePickerSelected = maxInt(0, len(m.responseCodeBlocks())-1)
		return m, nil
	case keymap.Matches(msg, m.keymap.Enter):
		return m.copySelectedCodeBlock()
	default:
		return m, nil
	}
}

func (m RootModel) copySelectedCodeBlock() (RootModel, tea.Cmd) {
	blocks := m.responseCodeBlocks()
	if len(blocks) == 0 {
		m.closeCodePicker()
		return m, nil
	}
	m.codePickerSelected = minInt(maxInt(m.codePickerSelected, 0), len(blocks)-1)
	selected := m.codePickerSelected + 1
	m.closeCodePicker()
	return m, writeClipboardTargetCmd(blocks[selected-1], fmt.Sprintf("sanitized code block %d", selected))
}

func (m *RootModel) moveCodePicker(delta int) {
	blocks := m.responseCodeBlocks()
	if len(blocks) == 0 || delta == 0 {
		return
	}
	m.codePickerSelected = minInt(maxInt(m.codePickerSelected+delta, 0), len(blocks)-1)
}

func (m *RootModel) closeCodePicker() {
	m.codePickerVisible = false
	m.interaction.CloseTransient()
}

func (m RootModel) codePickerDataForView() *views.CodePickerData {
	if !m.codePickerVisible {
		return nil
	}
	blocks := m.responseCodeBlocks()
	data := &views.CodePickerData{Selected: m.codePickerSelected}
	for _, block := range blocks {
		lines := 0
		if block != "" {
			lines = strings.Count(block, "\n") + 1
		}
		data.LineCounts = append(data.LineCounts, lines)
	}
	return data
}

func (m RootModel) responseCodeBlocks() []string {
	return response.CodeBlocks(strings.Join(m.assistantHistoryForView(), "\n\n"))
}

func (m RootModel) openThreadSwitcher() (RootModel, tea.Cmd) {
	if !m.agentThreadGatewayAvailable() {
		m.addAssistantMessage(m.threadGatewayUnavailableMessage())
		return m, nil
	}
	m.threadSwitcherVisible = true
	m.interaction.OpenTransient(interaction.TransientThreadSwitcher)
	m.syncThreadSwitcherSelection()
	if len(m.agentSessions) == 0 {
		m.threadSwitcherLoading = true
		return m, commands.ListAgentSessionsCmd(m.ctx, m.client)
	}
	return m, nil
}

func (m RootModel) handleThreadSwitcherKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	switch {
	case keymap.Matches(msg, m.keymap.Escape):
		m.closeThreadSwitcher()
		return m, nil
	case keymap.Matches(msg, m.keymap.Left), keymap.Matches(msg, m.keymap.Up):
		m.moveThreadSwitcher(-1)
		return m, nil
	case keymap.Matches(msg, m.keymap.Right), keymap.Matches(msg, m.keymap.Down):
		m.moveThreadSwitcher(1)
		return m, nil
	case keymap.Matches(msg, m.keymap.Home):
		m.threadSwitcherSelected = 0
		return m, nil
	case keymap.Matches(msg, m.keymap.End):
		m.threadSwitcherSelected = maxInt(0, len(m.agentSessions)-1)
		return m, nil
	case keymap.Matches(msg, m.keymap.Enter):
		return m.activateSelectedThread()
	default:
		return m, nil
	}
}

func (m RootModel) activateSelectedThread() (RootModel, tea.Cmd) {
	if m.threadSwitcherLoading || len(m.agentSessions) == 0 {
		return m, nil
	}
	m.syncThreadSwitcherSelection()
	session := m.agentSessions[m.threadSwitcherSelected]
	if session.ID == "" {
		m.addDiagnostic("agent_thread_switch_invalid", "warning", "The selected Operator Agent thread has no daemon session identity.")
		return m, nil
	}
	if session.ID == m.agentSessionID() {
		m.closeThreadSwitcher()
		return m, nil
	}
	m.captureThreadDraft()
	m.captureThreadResponse()
	m.threadSwitcherLoading = true
	return m, commands.ActivateAgentSessionCmd(m.ctx, m.client, session.ID)
}

func (m *RootModel) captureThreadDraft() {
	threadID := m.agentSessionID()
	if threadID == "" {
		return
	}
	m.syncComposer()
	if m.threadDrafts == nil {
		m.threadDrafts = map[string]threadDraftState{}
	}
	m.threadDrafts[threadID] = threadDraftState{Snapshot: m.composer.Snapshot(), Active: m.commandActive}
}

func (m *RootModel) restoreThreadDraft(threadID string) {
	draft, ok := m.threadDrafts[threadID]
	if !ok {
		m.commandInput = ""
		m.composer.SetValue("")
		m.setPrimaryFocus(interaction.FocusPanes)
		return
	}
	m.composer.Restore(draft.Snapshot)
	m.commandInput = draft.Snapshot.Value
	if draft.Active {
		m.setPrimaryFocus(interaction.FocusComposer)
	} else {
		m.setPrimaryFocus(interaction.FocusPanes)
	}
}

func (m *RootModel) captureThreadResponse() {
	threadID := m.agentSessionID()
	if threadID == "" {
		return
	}
	if m.threadResponses == nil {
		m.threadResponses = map[string]threadResponseState{}
	}
	m.threadResponses[threadID] = threadResponseState{
		AssistantHistory:  append([]string(nil), m.assistantHistory...),
		AssistantTimeline: append([]string(nil), m.assistantTimeline...),
		NaturalHistory:    append([]assistant.HistoryEntry(nil), m.naturalHistory...),
		AgentDelta:        m.agentDelta,
		LastAssistantLine: m.lastAssistantLine,
		HistoryExpanded:   m.historyExpanded,
		ResponseOffset:    m.responseOffset,
		ResponseFollow:    m.responseFollow,
		ResponseNewOutput: m.responseNewOutput,
	}
}

func (m *RootModel) restoreThreadResponse(threadID string) {
	state, ok := m.threadResponses[threadID]
	if !ok {
		m.assistantHistory = nil
		m.assistantTimeline = nil
		m.naturalHistory = nil
		m.agentDelta = ""
		m.lastAssistantLine = ""
		m.historyExpanded = false
		m.responseOffset = 0
		m.responseFollow = true
		m.responseNewOutput = 0
		m.refreshAssistantPrompt()
		return
	}
	m.assistantHistory = append([]string(nil), state.AssistantHistory...)
	m.assistantTimeline = append([]string(nil), state.AssistantTimeline...)
	m.naturalHistory = append([]assistant.HistoryEntry(nil), state.NaturalHistory...)
	m.agentDelta = state.AgentDelta
	m.lastAssistantLine = state.LastAssistantLine
	m.historyExpanded = state.HistoryExpanded
	m.responseOffset = state.ResponseOffset
	m.responseFollow = state.ResponseFollow
	m.responseNewOutput = state.ResponseNewOutput
	m.refreshAssistantPrompt()
}

func (m *RootModel) moveThreadSwitcher(delta int) {
	if len(m.agentSessions) == 0 || delta == 0 {
		return
	}
	m.syncThreadSwitcherSelection()
	m.threadSwitcherSelected = minInt(maxInt(m.threadSwitcherSelected+delta, 0), len(m.agentSessions)-1)
}

func (m *RootModel) syncThreadSwitcherSelection() {
	if len(m.agentSessions) == 0 {
		m.threadSwitcherSelected = 0
		return
	}
	activeID := m.agentSessionID()
	for index, session := range m.agentSessions {
		if session.ID != "" && session.ID == activeID {
			m.threadSwitcherSelected = index
			return
		}
	}
	m.threadSwitcherSelected = minInt(maxInt(m.threadSwitcherSelected, 0), len(m.agentSessions)-1)
}

func (m *RootModel) closeThreadSwitcher() {
	m.threadSwitcherVisible = false
	m.threadSwitcherLoading = false
	m.interaction.CloseTransient()
}

func (m RootModel) threadSwitcherDataForView() *views.ThreadSwitcherData {
	if !m.threadSwitcherVisible {
		return nil
	}
	data := &views.ThreadSwitcherData{Selected: m.threadSwitcherSelected, Loading: m.threadSwitcherLoading}
	activeID := m.agentSessionID()
	const visibleRows = 5
	start := maxInt(0, m.threadSwitcherSelected-visibleRows/2)
	start = minInt(start, maxInt(0, len(m.agentSessions)-visibleRows))
	end := minInt(len(m.agentSessions), start+visibleRows)
	for index, session := range m.agentSessions[start:end] {
		attention := session.RecoveredApprovalCount > 0 || session.Summary != nil && session.Summary.PendingApprovalCount > 0
		data.Entries = append(data.Entries, views.ThreadSwitcherEntry{
			Index:     start + index,
			Title:     firstNonEmpty(session.Title, "Untitled thread"),
			Active:    session.ID != "" && session.ID == activeID,
			Attention: attention,
		})
	}
	return data
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
	m.captureThreadDraft()
	m.captureThreadResponse()
	m.closeAgentStream()
	m.agentSession = nil
	m.advanceLocalThreadIdentity()
	m.commandInput = ""
	m.composer.Clear()
	m.setPrimaryFocus(interaction.FocusPanes)
	m.syncCommandPalette()
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
	m.assistantTimeline = nil
	m.naturalHistory = nil
	m.agentDelta = ""
	m.lastAssistantLine = ""
	m.agentPendingInput = ""
	m.responseOffset = 0
	m.responseFollow = true
	m.responseNewOutput = 0
	m.refreshAssistantPrompt()
}

func (m RootModel) agentSessionID() string {
	if m.agentSession == nil {
		return ""
	}
	return m.agentSession.ID
}

func (m RootModel) composerHistoryScopeID() string {
	if sessionID := strings.TrimSpace(m.agentSessionID()); sessionID != "" {
		return "agent:" + sessionID
	}
	generation := m.localThreadGeneration
	if generation == 0 {
		generation = 1
	}
	return fmt.Sprintf("local:%d", generation)
}

func (m *RootModel) syncComposerHistoryScope() {
	m.composer.SetHistoryScope(m.composerHistoryScopeID())
}

func (m *RootModel) advanceLocalThreadIdentity() {
	m.localThreadGeneration++
	if m.localThreadGeneration == 0 {
		m.localThreadGeneration = 1
	}
	m.syncComposerHistoryScope()
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
	}
	m.agentStream = nil
	m.agentStreamSessionID = ""
	m.agentStreamGeneration++
	m.agentInitialReplay = false
}

func (m *RootModel) connectAgentEventsCmd(sessionID string) tea.Cmd {
	m.closeAgentStream()
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	m.agentStreamSessionID = sessionID
	return commands.ConnectAgentEventsCmd(m.ctx, m.client, sessionID, m.agentStreamGeneration)
}

func (m RootModel) agentEventLifecycleCurrent(sessionID string, generation uint64) bool {
	return sessionID != "" &&
		sessionID == m.agentSessionID() &&
		sessionID == m.agentStreamSessionID &&
		generation == m.agentStreamGeneration
}

func (m RootModel) confirmationForView() *views.ConfirmationData {
	if m.quitConfirmation {
		return &views.ConfirmationData{
			Action:         "Quit Relaybase TUI",
			Target:         "current operator console",
			Risk:           "the memory-only composer draft will be lost",
			ExpectedResult: "the TUI exits without submitting or persisting the draft",
			Details: []string{
				fmt.Sprintf("draft size: %d bytes", len([]byte(m.commandInput))),
				fmt.Sprintf("draft lines: %d", strings.Count(m.commandInput, "\n")+1),
			},
		}
	}
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
		Details:        append([]string(nil), m.pendingConfirm.Details...),
	}
}

func (m RootModel) assistantHistoryForView() []string {
	combined := append([]string(nil), m.assistantTimeline...)
	if len(combined) == 0 {
		for _, entry := range m.naturalHistory {
			if entry.Message != "" {
				combined = append(combined, entry.Type+": "+entry.Message)
			}
		}
		combined = append(combined, m.assistantHistory...)
	}
	if delta := strings.TrimSpace(m.agentDelta); delta != "" {
		combined = append(combined, "Agent: "+assistant.SanitizeText(delta))
	}
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
	m.assistantTimeline = append(m.assistantTimeline, entry.Type+": "+entry.Message)
	if !m.responseFollow {
		m.responseNewOutput++
	}
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
	m.restorePendingSubmissionDraft()
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

func (m RootModel) activeAppCount() int {
	active := 0
	for _, isActive := range m.appInventoryByID() {
		if isActive {
			active++
		}
	}
	return active
}

func (m RootModel) registeredAppCount() int { return len(m.appInventoryByID()) }

// appInventoryByID is the single daemon-backed inventory used by both rail
// counts. Duplicate app records and component projections collapse onto the
// same stable app ID, while active is accumulated from any current daemon
// lifecycle record for that ID.
func (m RootModel) appInventoryByID() map[string]bool {
	inventory := map[string]bool{}
	add := func(appID, status string, pid int) {
		appID = strings.TrimSpace(appID)
		if appID == "" {
			return
		}
		inventory[appID] = inventory[appID] || daemonStatusIsActive(status, pid)
	}
	for _, app := range m.apps() {
		add(app.ID, app.RuntimeStatus, app.PID)
	}
	if m.state != nil {
		for _, component := range m.state.Components {
			add(component.AppID, component.Status, component.PID)
		}
		for _, group := range m.state.Groups {
			for _, component := range group.Components {
				add(component.AppID, component.Status, component.PID)
			}
		}
	}
	return inventory
}

func daemonStatusIsActive(status string, pid int) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "running", "starting", "restarting", "stopping", "degraded":
		return true
	default:
		// A daemon-reported PID is stronger evidence of an active process
		// than a missing/older status label, but mere registration is not.
		return pid > 0
	}
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

func isPasteShortcut(msg tea.KeyPressMsg) bool {
	if msg.Code == 22 {
		return true
	}
	switch msg.Keystroke() {
	case "ctrl+v", "ctrl+shift+v", "shift+insert":
		return true
	default:
		return false
	}
}

func isCopyShortcut(msg tea.KeyPressMsg) bool {
	if msg.Code == 3 {
		return true
	}
	switch msg.Keystroke() {
	case "ctrl+c", "ctrl+shift+c":
		return true
	default:
		return false
	}
}

func readClipboardCmd() tea.Cmd {
	return func() tea.Msg {
		text, err := readClipboardText()
		return clipboardPasteLoadedMsg{Text: text, Err: err}
	}
}

func writeClipboardCmd(text string) tea.Cmd {
	return func() tea.Msg {
		return clipboardCopyFinishedMsg{Err: writeClipboardText(text)}
	}
}

func writeClipboardTargetCmd(text string, target string) tea.Cmd {
	return func() tea.Msg {
		return clipboardCopyFinishedMsg{Err: writeClipboardText(text), Target: target}
	}
}

func writePaneLogsClipboardCmd(text string, paneID string, paneTitle string, lineCount int) tea.Cmd {
	return func() tea.Msg {
		return clipboardCopyFinishedMsg{
			Err:       writeClipboardText(text),
			PaneID:    paneID,
			PaneTitle: paneTitle,
			LineCount: lineCount,
		}
	}
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

func isThreadSwitcherShortcut(msg tea.KeyPressMsg) bool {
	return msg.Code == 20 || msg.Keystroke() == "ctrl+t"
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

func agentGatewayConfigured(config *relaybaseclient.AgentConfig) bool {
	return config != nil && config.Enabled && config.Provider.RemoteModelEnabled &&
		config.Provider.APIKeySource.Configured && strings.TrimSpace(config.Provider.ModelSlug) != ""
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

func registrationPreviewMessage(preview *relaybaseclient.RegistrationSetupResult) string {
	if preview == nil {
		return "Registration preview was unavailable. No files or registry state were changed."
	}
	parts := []string{preview.Message}
	if preview.App != nil && preview.App.ID != "" {
		parts = append(parts, "app "+preview.App.ID)
	}
	if preview.ManifestPath != "" {
		parts = append(parts, "manifest "+preview.ManifestPath)
	}
	if preview.FileWritePlan != nil {
		parts = append(parts, fmt.Sprintf("files %d", len(preview.FileWritePlan.Writes)))
	}
	if preview.Registered {
		parts = append(parts, "registered")
	}
	if preview.Verification != nil {
		parts = append(parts, "verification "+preview.Verification.Status)
		if preview.Verification.AssignedPort > 0 {
			parts = append(parts, fmt.Sprintf("temporary port %d", preview.Verification.AssignedPort))
		}
		if preview.Verification.Failure != nil {
			parts = append(parts,
				"failed boundary "+preview.Verification.Failure.Boundary,
				preview.Verification.Failure.Message,
				"next "+preview.Verification.Failure.RecommendedAction,
			)
			if preview.Verification.Failure.ProcessRunning {
				parts = append(parts, "process still running")
			}
			if preview.Verification.Failure.BackendPortOpen != nil && *preview.Verification.Failure.BackendPortOpen {
				parts = append(parts, "backend port still open")
			}
		}
		for _, repair := range preview.Verification.Repairs {
			if repair.Recommended {
				parts = append(parts, "recommended repair "+repair.Label)
				break
			}
		}
	} else if preview.VerificationIntent.WillStart {
		parts = append(parts, "confirmation briefly starts, checks, and stops the app")
	}
	if !preview.Started {
		parts = append(parts, "app ends stopped")
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

func int64Field(data json.RawMessage, field string) int64 {
	if len(data) == 0 {
		return 0
	}
	var record map[string]json.RawMessage
	if err := json.Unmarshal(data, &record); err != nil {
		return 0
	}
	var value int64
	_ = json.Unmarshal(record[field], &value)
	return value
}

func intField(data json.RawMessage, field string) int {
	return int(int64Field(data, field))
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

func incrementGeneration(current uint64) uint64 {
	current++
	if current == 0 {
		current = 1
	}
	return current
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
	m.clampBodyScroll()
}

func (m *RootModel) resetBodyScroll() {
	m.bodyScrollOffset = 0
}

func (m *RootModel) clampBodyScroll() {
	m.bodyScrollOffset = minInt(maxInt(0, m.bodyScrollOffset), views.BodyScrollMax(m.styles, m.shellData()))
}

func (m *RootModel) handleBodyScrollKey(msg tea.KeyPressMsg) bool {
	if !m.bodyViewportActive() {
		return false
	}
	page := maxInt(3, dashboardHeight(m.height)-2)
	if m.inventoryVisible() {
		metrics := layout.Compute(maxInt(m.width, 1), maxInt(m.height, 1), m.composer.Rows())
		page = maxInt(1, metrics.Panes.Height-1)
	}
	switch {
	case keymap.Matches(msg, m.keymap.Up):
		m.scrollBody(-1)
	case keymap.Matches(msg, m.keymap.Down):
		m.scrollBody(1)
	case keymap.Matches(msg, m.keymap.PageUp):
		m.scrollBody(-page)
	case keymap.Matches(msg, m.keymap.PageDown):
		m.scrollBody(page)
	case keymap.Matches(msg, m.keymap.Home):
		m.resetBodyScroll()
	case keymap.Matches(msg, m.keymap.End):
		m.bodyScrollOffset = views.BodyScrollMax(m.styles, m.shellData())
	default:
		return false
	}
	return true
}

func (m RootModel) bodyViewportActive() bool {
	return m.pendingAgentApproval != nil || m.pendingConfirm != nil || m.quitConfirmation || m.helpVisible || m.diagnosticsExpanded ||
		strings.TrimSpace(m.setupPanelForView()) != "" || m.inventoryVisible()
}

func (m *RootModel) toggleDiagnostics() {
	if len(m.viewDiagnostics()) == 0 {
		m.diagnosticsExpanded = false
		m.addAssistantMessage("No diagnostics are present.")
		return
	}
	m.diagnosticsExpanded = !m.diagnosticsExpanded
	m.closeHelp()
	m.resetBodyScroll()
}

func (m RootModel) inventoryVisible() bool {
	return m.connectionStatus == "connected" && !m.paneManager.Focused() &&
		len(m.paneManager.CurrentPagePanes()) == 0 && m.appInventory.Count() > 0 &&
		strings.TrimSpace(m.setupPanelForView()) == ""
}

func (m *RootModel) requestSelectedInventoryStart() tea.Cmd {
	item := m.appInventory.Selected()
	if item == nil {
		m.addAssistantMessage("No registered app is selected.")
		return nil
	}
	if !item.CanStart() {
		switch strings.ToLower(strings.TrimSpace(item.Status)) {
		case "running", "starting":
			m.addAssistantMessage("App " + item.ID + " is already " + item.Status + "; use Ctrl+O to reopen a hidden monitoring pane.")
		case "failed", "degraded":
			m.addAssistantMessage("App " + item.ID + " is " + item.Status + "; use /restart " + item.ID + " to review a daemon restart request.")
		default:
			m.addAssistantMessage("App " + item.ID + " cannot be started from its current " + valueOr(item.Status, "unknown") + " state.")
		}
		return nil
	}
	confirmation, err := m.prepareConfirmation(slash.ParsedCommand{Kind: slash.KindLaunch, Target: item.ID})
	if err != nil {
		m.addAssistantMessage(err.Error())
		return nil
	}
	m.pendingConfirm = confirmation
	m.resetBodyScroll()
	m.refreshAssistantPrompt()
	return nil
}

func (m *RootModel) followInventorySelection() {
	row := views.InventorySelectionLine(m.styles, m.shellData())
	m.ensureBodyLineVisible(row)
}

func (m *RootModel) followPaneSelection(direction int) {
	if direction == 0 {
		return
	}
	layout := m.paneManager.Layout()
	viewport := maxInt(1, dashboardHeight(m.height)-1)
	if layout.Rows*layout.PaneHeight <= viewport {
		m.resetBodyScroll()
		return
	}
	m.scrollBody(direction * maxInt(1, layout.PaneHeight))
}

func (m *RootModel) ensureBodyLineVisible(line int) {
	metrics := layout.Compute(maxInt(m.width, 1), maxInt(m.height, 1), m.composer.Rows())
	viewport := maxInt(1, metrics.Panes.Height)
	if views.BodyScrollMax(m.styles, m.shellData()) > 0 && viewport > 1 {
		viewport--
	}
	if line < m.bodyScrollOffset {
		m.bodyScrollOffset = line
	} else if line >= m.bodyScrollOffset+viewport {
		m.bodyScrollOffset = line - viewport + 1
	}
	m.clampBodyScroll()
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
