package model

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

type settingsRow struct {
	id       string
	label    string
	value    string
	hint     string
	action   bool
	readOnly bool
}

func (m *RootModel) openSettings(target string) tea.Cmd {
	m.closeHelp()
	m.closeAppManager()
	m.closePackageManager()
	m.closePaneReopen()
	m.closeThreadSwitcher()
	m.closeCodePicker()
	if m.interaction.Transient != interaction.TransientNone {
		m.interaction.CloseTransient()
	}
	m.settingsVisible = true
	m.settingsPage = "categories"
	normalizedTarget := strings.ToLower(strings.Join(strings.Fields(target), " "))
	if normalizedTarget == "agent" {
		m.settingsPage = "agent"
	} else if normalizedTarget == "agent security" {
		m.settingsPage = "agent_security"
	}
	m.settingsSelected = 0
	m.settingsOffset = 0
	m.settingsEditing = false
	m.settingsEditField = ""
	m.settingsNotice = ""
	m.settingsConfirmAction = ""
	m.agentLegacyRemovalPreview = nil
	m.interaction.OpenTransient(interaction.TransientSettings)
	if m.agentConfig == nil {
		m.settingsNotice = "Loading Agent configuration..."
		if m.settingsPage == "agent_security" {
			return tea.Batch(
				commands.FetchAgentConfigCmd(m.ctx, m.client),
				commands.DiagnoseAgentSecurityCmd(m.ctx, m.client, false),
				commands.FetchLatestAgentSecurityRepairOperationCmd(m.ctx, m.client),
			)
		}
		return commands.FetchAgentConfigCmd(m.ctx, m.client)
	}
	m.resetAgentSettingsDraft()
	if m.settingsPage == "agent_security" {
		m.settingsNotice = "Running a local Agent security check..."
		return tea.Batch(
			commands.DiagnoseAgentSecurityCmd(m.ctx, m.client, false),
			commands.FetchLatestAgentSecurityRepairOperationCmd(m.ctx, m.client),
		)
	}
	return nil
}

func (m *RootModel) closeSettings() {
	m.settingsVisible = false
	m.settingsPage = ""
	m.settingsSelected = 0
	m.settingsOffset = 0
	m.settingsEditing = false
	m.settingsEditField = ""
	m.settingsNotice = ""
	m.settingsSaving = false
	m.settingsAgentDraft = nil
	m.settingsAgentDirty = false
	m.settingsConfirmAction = ""
	m.agentLegacyRemovalPreview = nil
	m.settingsInput.Blur()
	if m.interaction.Transient == interaction.TransientSettings {
		m.interaction.CloseTransient()
	}
}

func (m RootModel) settingsRows() []settingsRow {
	switch m.settingsPage {
	case "general":
		return []settingsRow{
			{id: "daemon_status", label: "Daemon", value: m.connectionStatus, hint: "Current control-plane connection state.", readOnly: true},
			{id: "daemon_restart", label: "Restart daemon", value: "safe restart", hint: "Quiesce, replace, verify, and restore Relaybase-owned apps.", action: true},
		}
	case "appearance":
		activity := "authoritative animation"
		if !m.agentActivityAnimations {
			activity = "authoritative reduced motion"
		}
		return []settingsRow{
			{id: "theme", label: "Theme", value: m.preferences.Theme, hint: "Cycle auto, light, and dark."},
			{id: "density", label: "Layout density", value: m.preferences.Layout.Density, hint: "Cycle compact and comfortable."},
			{id: "agent_pane", label: "Agent pane", value: onOff(!m.preferences.Layout.AgentPaneCollapsed), hint: "Show or collapse the docked Agent surface."},
			{id: "activity", label: "Thinking indicator", value: activity, hint: "Visible only while an authoritative active run is working.", readOnly: true},
			{id: "activity_charset", label: "Indicator charset", value: valueOr(map[bool]string{true: "ASCII", false: "Unicode"}[m.agentActivityASCII], "Unicode"), hint: "Selected from terminal capability and RELAYBASE_TUI_ASCII.", readOnly: true},
		}
	case "interaction":
		return []settingsRow{
			{id: "history_days", label: "History retention", value: fmt.Sprintf("%d days", m.preferences.Assistant.HistoryRetentionDays), hint: "Enter a whole number from 1 to 365."},
			{id: "context_keys", label: "Context menu", value: strings.Join(m.preferences.Keymap.ContextMenu, " / "), hint: "Persisted safe shortcut bindings.", readOnly: true},
		}
	case "agent", "agent_status", "agent_provider", "agent_security", "agent_security_findings", "agent_security_preview", "agent_security_result", "agent_configuration", "agent_safety", "agent_execution", "agent_budgets", "agent_recovery":
		return m.agentSettingsRows()
	default:
		return []settingsRow{
			{id: "general", label: "General", value: "daemon and recovery", hint: "Connection state and safe daemon restart.", action: true},
			{id: "appearance", label: "Appearance", value: "theme and layout", hint: "Theme, density, Agent pane, and activity display.", action: true},
			{id: "interaction", label: "Interaction", value: "input and history", hint: "Keyboard behavior and local retention.", action: true},
			{id: "agent", label: "Agent", value: "provider, safety, and execution", hint: "All Operator Agent configuration.", action: true},
		}
	}
}

func (m RootModel) agentSettingsRows() []settingsRow {
	config := m.settingsAgentConfig()
	if config == nil {
		return []settingsRow{{id: "agent_loading", label: "Agent configuration", value: "loading", readOnly: true}}
	}
	if m.settingsPage == "agent" {
		return []settingsRow{
			{id: "agent_status_page", label: "Status", value: valueOr(config.Readiness, "unknown"), hint: "Readiness, source, credential, and runtime activity.", action: true},
			{id: "agent_provider_page", label: "Provider", value: providerConnection(config), hint: "OpenRouter connection and credential protection.", action: true},
			{id: "agent_configuration_page", label: "Configuration", value: valueOr(config.Provider.ModelSlug, "not configured"), hint: "Enablement, model, source, and revision.", action: true},
			{id: "agent_security_page", label: "Security and credentials", value: agentSecuritySummary(m.agentSecurityStatus), hint: "Protection, key health, migration, repair, and receipts.", action: true},
			{id: "agent_safety_page", label: "Safety and permissions", value: config.ApprovalPolicy, hint: "Tool access and approval gates.", action: true},
			{id: "agent_execution_page", label: "Execution", value: fmt.Sprintf("%d total turns", config.Execution.TotalMaxTurns), hint: "Timeouts, turns, output, and no-progress limits.", action: true},
			{id: "agent_budgets_page", label: "Budgets", value: budgetSummary(config.Budgets), hint: "Session, daily, and monthly limits.", action: true},
			{id: "agent_recovery_page", label: "Recovery", value: "reload and restart", hint: "Reload config, inspect errors, or restart safely.", action: true},
		}
	}
	if m.settingsPage == "agent_status" {
		rows := []settingsRow{
			{id: "readiness", label: "Readiness", value: valueOr(config.Readiness, "unknown"), readOnly: true},
			{id: "runtime_activity", label: "Runtime activity", value: valueOr(m.agentStatus, "idle"), readOnly: true},
			{id: "credential_connection", label: "Credential", value: providerConnection(config), readOnly: true},
			{id: "source_health", label: "Configuration source", value: agentSourceSummary(config), readOnly: true},
			{id: "active_revision", label: "Active revision", value: agentRevisionSummary(config), readOnly: true},
			{id: "older_run_revision", label: "Older run revision active", value: onOff(config.ActiveRunUsesOlderRevision), readOnly: true},
		}
		return appendDraftActions(rows, m.settingsAgentDirty)
	}
	if m.settingsPage == "agent_provider" {
		rows := []settingsRow{
			{id: "provider", label: "Provider", value: config.Provider.Provider, readOnly: true},
			{id: "credential_connection", label: "Connection", value: providerConnection(config), readOnly: true},
			{id: "credential_storage", label: "Credential storage", value: credentialProtection(config), readOnly: true},
			{id: "provider_model", label: "Model", value: valueOr(config.Provider.ModelSlug, "not configured"), readOnly: true},
			{id: "provider_connect", label: "Connect OpenRouter", value: "OAuth PKCE", hint: "Connect without entering a key in the TUI.", action: true},
			{id: "provider_replace", label: "Replace credential", value: "zero-downtime", hint: "Connect and validate a replacement before activation.", action: true},
			{id: "provider_manage_security", label: "Manage security", value: agentSecuritySummary(m.agentSecurityStatus), hint: "Open credential health, migration, cleanup, and repair controls.", action: true},
		}
		return rows
	}
	if m.settingsPage == "agent_security" {
		return m.agentSecurityRows(config)
	}
	if m.settingsPage == "agent_security_findings" {
		return m.agentSecurityFindingRows()
	}
	if m.settingsPage == "agent_security_preview" {
		return m.agentSecurityPreviewRows()
	}
	if m.settingsPage == "agent_security_result" {
		return m.agentSecurityResultRows()
	}
	budgets := config.Budgets
	if budgets == nil {
		budgets = &relaybaseclient.AgentBudgets{}
	}
	allowlist := strings.Join(config.ToolAllowlist, ", ")
	if config.ToolAllowlistMode == "all_registered" {
		allowlist = fmt.Sprintf("%d registered tools", len(config.ToolAllowlist))
	}
	allRows := []settingsRow{
		{id: "agent_enabled", label: "Enabled", value: onOff(config.Enabled), hint: "Enable or disable the Operator Agent gateway."},
		{id: "provider", label: "Provider", value: config.Provider.Provider, readOnly: true},
		{id: "remote_model", label: "Remote model", value: onOff(config.Provider.RemoteModelEnabled), hint: "Permit the configured remote model."},
		{id: "model_slug", label: "Model slug", value: valueOr(config.Provider.ModelSlug, "not configured"), hint: "Exact OpenRouter model slug."},
		{id: "model_source", label: "Model source", value: config.Provider.ModelSource.Label, readOnly: true},
		{id: "provider_restart", label: "Provider restart required", value: onOff(config.Provider.RestartRequired), readOnly: true},
		{id: "key_env", label: "API key env var", value: valueOr(config.Provider.APIKeySource.EnvVar, "managed credential"), hint: "Only the environment-variable name is stored; never the secret.", readOnly: config.Provider.APIKeySource.Type != "environment"},
		{id: "key_status", label: "API key status", value: onOff(config.Provider.APIKeySource.Configured), readOnly: true},
		{id: "referer_env", label: "HTTP referer env", value: valueOr(config.Provider.HTTPRefererEnvVar, "not set"), hint: "Optional environment-variable name."},
		{id: "title_env", label: "App title env", value: valueOr(config.Provider.TitleEnvVar, "not set"), hint: "Optional environment-variable name."},
		{id: "tool_mode", label: "Tool access", value: config.ToolAllowlistMode, hint: "Cycle all registered tools or an explicit allowlist."},
		{id: "tool_allowlist", label: "Tool allowlist", value: valueOr(allowlist, "empty"), hint: "Comma-separated tool names; used only in explicit mode.", readOnly: config.ToolAllowlistMode != "explicit_allowlist"},
		{id: "approval_policy", label: "Mutation approvals", value: config.ApprovalPolicy, hint: "Cycle approval-gated mutations or read-only tools."},
		{id: "setup_write_policy", label: "Setup file writes", value: config.SetupFileWritePolicy, readOnly: true},
		{id: "browser_open", label: "Browser open", value: onOff(config.AllowBrowserOpen), hint: "Allow approved browser-opening tools."},
		{id: "copy_route", label: "Copy route", value: onOff(config.AllowCopyRoute), hint: "Allow approved clipboard route copies."},
		{id: "segment_turns", label: "Turns per segment", value: strconv.Itoa(config.Execution.SegmentMaxTurns), hint: "1-32; continuation reuses the same run state."},
		{id: "total_turns", label: "Total turn ceiling", value: strconv.Itoa(config.Execution.TotalMaxTurns), hint: "1-128 and not below segment turns."},
		{id: "inactivity_seconds", label: "Inactivity timeout", value: fmt.Sprintf("%ds", config.Execution.InactivityTimeoutMS/1000), hint: "10-600 seconds; resets on real progress."},
		{id: "hard_seconds", label: "Hard run timeout", value: fmt.Sprintf("%ds", config.Execution.HardRunTimeoutMS/1000), hint: "30-3600 seconds and not below inactivity timeout."},
		{id: "max_output_tokens", label: "Max output tokens", value: strconv.Itoa(config.Execution.MaxOutputTokens), hint: "256-32768 tokens per model response."},
		{id: "reasoning", label: "Reasoning effort", value: config.Execution.ReasoningEffort, hint: "Cycle low, medium, and high."},
		{id: "no_progress", label: "No-progress repeat limit", value: strconv.Itoa(config.Execution.NoProgressRepeatLimit), hint: "2-10 repeated equivalent tool calls."},
		{id: "daily_budget", label: "Daily budget", value: budgetValue(budgets.DailyLimitUSD), hint: "USD; 0 means no configured limit."},
		{id: "monthly_budget", label: "Monthly budget", value: budgetValue(budgets.MonthlyLimitUSD), hint: "USD; 0 means no configured limit."},
		{id: "session_budget", label: "Session budget", value: budgetValue(budgets.SessionLimitUSD), hint: "USD; 0 means no configured limit."},
	}
	var rows []settingsRow
	switch m.settingsPage {
	case "agent_configuration":
		rows = filterSettingsRows(allRows, "agent_enabled", "remote_model", "model_slug", "key_env", "referer_env", "title_env", "model_source", "key_status", "provider_restart")
		rows = append(rows,
			settingsRow{id: "source_health", label: "Source health", value: agentSourceSummary(config), readOnly: true},
			settingsRow{id: "active_revision", label: "Active revision", value: agentRevisionSummary(config), readOnly: true},
			settingsRow{id: "config_reload", label: "Reload now", value: "validate and apply", hint: "Refresh the selected source for the next run.", action: true},
		)
	case "agent_safety":
		rows = filterSettingsRows(allRows, "tool_mode", "tool_allowlist", "approval_policy", "setup_write_policy", "browser_open", "copy_route")
	case "agent_execution":
		rows = filterSettingsRows(allRows, "segment_turns", "total_turns", "reasoning", "max_output_tokens", "inactivity_seconds", "hard_seconds", "no_progress")
	case "agent_budgets":
		rows = filterSettingsRows(allRows, "session_budget", "daily_budget", "monthly_budget")
	case "agent_recovery":
		rows = []settingsRow{
			{id: "recovery_error", label: "Last source error", value: agentSourceError(config), readOnly: true},
			{id: "config_reload", label: "Reload Agent config", value: "no daemon restart", hint: "Validate and atomically apply the selected source.", action: true},
			{id: "daemon_restart", label: "Restart daemon", value: "safe recovery", hint: "Use when shell environment or daemon state really requires restart.", action: true},
		}
	default:
		rows = allRows
	}
	return appendDraftActions(rows, m.settingsAgentDirty)
}

func (m RootModel) agentSecurityRows(config *relaybaseclient.AgentConfig) []settingsRow {
	status := m.agentSecurityStatus
	checkedAt := "not checked"
	findings := "not checked"
	readable := "unknown"
	acl := "unknown"
	if status != nil {
		checkedAt = valueOr(status.CheckedAt, "not checked")
		findings = fmt.Sprintf("%d need attention", agentSecurityIssueCount(status))
		for _, finding := range status.Findings {
			if finding.Code == "AGENT_CREDENTIAL_PROTECTED" {
				readable = "yes"
				acl = evidenceString(finding.Evidence, "acl", acl)
			}
			if finding.Code == "AGENT_CREDENTIAL_ACL_WEAK" {
				acl = "weak"
			}
		}
	}
	lastValidation := "not reported"
	source := "none"
	if config.Credential != nil {
		lastValidation = valueOr(config.Credential.LastValidatedAt, "not reported")
		source = valueOr(config.Credential.Source, "unknown")
	}
	providerNavigationLabel := "Replace in Provider"
	if config.Credential == nil || !config.Provider.APIKeySource.Configured {
		providerNavigationLabel = "Connect in Provider"
	}
	lastOutcome := "none"
	if m.agentSecurityRepairOperation != nil {
		lastOutcome = valueOr(m.agentSecurityRepairOperation.Outcome, "unknown")
	}
	lastEvent := "none"
	if status != nil && status.LastSecurityEvent != nil {
		lastEvent = valueOr(status.LastSecurityEvent.Type, "unknown") + " · " + valueOr(status.LastSecurityEvent.At, "time unavailable")
	}
	return []settingsRow{
		{id: "security_state", label: "Security status", value: agentSecuritySummary(status), readOnly: true},
		{id: "security_connection", label: "Provider connection", value: providerConnection(config), readOnly: true},
		{id: "security_source", label: "Credential source", value: source, readOnly: true},
		{id: "security_storage", label: "Storage", value: credentialProtection(config), readOnly: true},
		{id: "security_readable", label: "Protected credential readable", value: readable, readOnly: true},
		{id: "security_acl", label: "Current-user ACL", value: acl, readOnly: true},
		{id: "security_checked", label: "Last checked", value: checkedAt, readOnly: true},
		{id: "security_validated", label: "Last successful validation", value: lastValidation, readOnly: true},
		{id: "credential_label", label: "Provider key label", value: credentialLabel(config), readOnly: true},
		{id: "credential_limit", label: "Spending limit", value: credentialLimit(config), readOnly: true},
		{id: "credential_expiration", label: "Expiration", value: credentialExpiration(config), readOnly: true},
		{id: "windows_verification", label: "Require Windows verification", value: highSecurityStatus(config), hint: "Off by default; unavailable until secure daemon-owned prompt handling is proven.", readOnly: true},
		{id: "dpapi_limit", label: "DPAPI limitation", value: "does not defeat same-user malware", hint: "DPAPI reduces offline, cross-user, and accidental plaintext exposure.", readOnly: true},
		{id: "provider_guidance", label: "Dedicated-key guidance", value: "Relaybase-only + limit + expiry", hint: "Use a dedicated OpenRouter key with conservative spending and expiration.", readOnly: true},
		{id: "security_check", label: "Run security check", value: "local and silent", hint: "Does not contact OpenRouter or prompt for Windows verification.", action: true},
		{id: "security_findings", label: "Review findings", value: findings, hint: "Inspect daemon-owned findings and available recovery actions.", action: true},
		{id: "security_validate", label: "Validate now", value: "online provider check", hint: "Creates a bound external repair preview before contacting OpenRouter.", action: true},
		{id: "security_replace", label: providerNavigationLabel, value: "OAuth PKCE", hint: "Return to the canonical connection page.", action: true},
		{id: "security_migrate", label: "Move legacy key to protected storage", value: "preview + confirm", hint: "Preserves the legacy source until protected migration verifies.", action: true},
		{id: "security_cleanup", label: "Remove legacy external assignment", value: "phrase required", hint: "Removes exactly one preview-bound assignment with no plaintext backup.", action: true},
		{id: "security_key_management", label: "Open OpenRouter key management", value: "provider-owned action", hint: "Remote revocation is not claimed until the provider confirms it.", action: true},
		{id: "security_disconnect", label: "Disconnect locally", value: "phrase required", hint: "Deletes local protected storage; the remote key may remain active.", action: true},
		{id: "security_last_outcome", label: "Last repair outcome", value: lastOutcome, readOnly: true},
		{id: "security_last_event", label: "Last security event", value: lastEvent, readOnly: true},
		{id: "security_receipt", label: "Review repair receipt", value: lastOutcome, hint: "Show applied actions and post-repair verification.", action: true},
	}
}

func (m RootModel) agentSecurityFindingRows() []settingsRow {
	if m.agentSecurityStatus == nil {
		return []settingsRow{
			{id: "security_check", label: "Run security check", value: "local and silent", action: true},
		}
	}
	findings := append([]relaybaseclient.AgentSecurityFinding(nil), m.agentSecurityStatus.Findings...)
	sortAgentSecurityFindings(findings)
	rows := make([]settingsRow, 0, len(findings)+1)
	rows = append(rows, settingsRow{id: "security_check", label: "Refresh findings", value: "local and silent", action: true})
	for _, finding := range findings {
		requirements := []string{finding.Repairability}
		if finding.RequiresNetwork {
			requirements = append(requirements, "network")
		}
		if finding.RequiresRestart {
			requirements = append(requirements, "restart")
		}
		rows = append(rows, settingsRow{
			id:       "security_finding:" + finding.Code,
			label:    strings.ToUpper(finding.State) + " · " + finding.Title,
			value:    strings.Join(requirements, " · "),
			hint:     valueOr(finding.UserAction, finding.Message),
			action:   finding.RecommendedActionID != "",
			readOnly: finding.RecommendedActionID == "",
		})
	}
	return rows
}

func (m RootModel) agentSecurityPreviewRows() []settingsRow {
	preview := m.agentSecurityRepairPreview
	if preview == nil {
		return []settingsRow{{id: "security_preview_missing", label: "Repair preview", value: "unavailable", readOnly: true}}
	}
	rows := []settingsRow{
		{id: "security_preview_expiry", label: "Preview expires", value: preview.ExpiresAt, readOnly: true},
	}
	for _, action := range preview.Actions {
		rows = append(rows,
			settingsRow{id: "security_preview_action_" + action.ID, label: action.Title, value: action.RiskClass, readOnly: true},
			settingsRow{id: "security_preview_changes_" + action.ID, label: "Will change", value: strings.Join(action.Changes, " "), readOnly: true},
			settingsRow{id: "security_preview_preserves_" + action.ID, label: "Will preserve", value: strings.Join(action.Preserves, " "), readOnly: true},
			settingsRow{
				id:       "security_preview_requirements_" + action.ID,
				label:    "Requirements",
				value:    fmt.Sprintf("network %s · restart %s · reversible %s", yesNo(action.RequiresNetwork), yesNo(action.RequiresRestart), yesNo(action.Reversible)),
				readOnly: true,
			},
		)
	}
	if preview.Confirmation.Warning != "" {
		rows = append(rows, settingsRow{id: "security_preview_warning", label: "Warning", value: preview.Confirmation.Warning, readOnly: true})
	}
	confirmationHint := "Apply this exact bound preview, then verify the result."
	if preview.Confirmation.Phrase != "" {
		confirmationHint = "Requires typing the exact phrase: " + preview.Confirmation.Phrase
	}
	return append(rows,
		settingsRow{id: "security_apply", label: "Apply exact repair", value: "confirm + verify", hint: confirmationHint, action: true},
		settingsRow{id: "security_preview_cancel", label: "Cancel", value: "no changes", hint: "Return without applying the preview.", action: true},
	)
}

func (m RootModel) agentSecurityResultRows() []settingsRow {
	operation := m.agentSecurityRepairOperation
	if operation == nil {
		return []settingsRow{{id: "security_result_missing", label: "Repair receipt", value: "none", readOnly: true}}
	}
	rows := []settingsRow{
		{id: "security_result_outcome", label: "Verified outcome", value: operation.Outcome, readOnly: true},
		{id: "security_result_operation", label: "Operation", value: operation.OperationID, readOnly: true},
		{id: "security_result_applied", label: "Applied actions", value: valueOr(strings.Join(operation.AppliedActionIDs, ", "), "none"), readOnly: true},
		{id: "security_result_remaining", label: "Remaining findings", value: valueOr(strings.Join(operation.RemainingIssueCodes, ", "), "none"), readOnly: true},
	}
	if operation.RequiresExternalAction {
		rows = append(rows, settingsRow{id: "security_result_external", label: "Provider/manual action", value: "required", readOnly: true})
	}
	if operation.RequiresRestart {
		rows = append(rows, settingsRow{id: "security_result_restart", label: "Daemon restart", value: "required", readOnly: true})
	}
	return append(rows,
		settingsRow{id: "security_check", label: "Re-run security check", value: "local and silent", action: true},
		settingsRow{id: "security_result_back", label: "Back to security", value: "management", action: true},
	)
}

func (m RootModel) settingsDataForView() *views.SettingsData {
	if !m.settingsVisible {
		return nil
	}
	rows := m.settingsRows()
	if len(rows) == 0 {
		return &views.SettingsData{Title: "Settings", Breadcrumb: settingsPageBreadcrumb(m.settingsPage)}
	}
	selected := clampInt(m.settingsSelected, 0, len(rows)-1)
	visible := settingsVisibleRowCount(m.height)
	if m.settingsEditing && strings.TrimSpace(m.settingsNotice) != "" {
		visible = maxInt(2, visible-1)
	}
	offset := clampInt(m.settingsOffset, 0, maxInt(0, len(rows)-visible))
	if selected < offset {
		offset = selected
	}
	if selected >= offset+visible {
		offset = selected - visible + 1
	}
	last := minInt(len(rows), offset+visible)
	projected := make([]views.SettingsRowData, 0, last-offset)
	for index := offset; index < last; index++ {
		row := rows[index]
		projected = append(projected, views.SettingsRowData{
			Index: index, Label: row.label, Value: row.value, Hint: row.hint, Action: row.action, ReadOnly: row.readOnly,
		})
	}
	title := "Settings"
	if m.settingsPage != "" && m.settingsPage != "categories" {
		title = settingsPageTitle(m.settingsPage)
	}
	return &views.SettingsData{
		Title: title, Breadcrumb: settingsPageBreadcrumb(m.settingsPage), Rows: projected, Selected: selected,
		Editing: m.settingsEditing, EditValue: m.settingsInput.View(), Notice: m.settingsNotice,
		Saving: m.settingsSaving, TotalRows: len(rows), FirstRow: offset,
	}
}

func settingsPageBreadcrumb(page string) string {
	switch page {
	case "", "categories":
		return "Settings"
	case "general":
		return "Settings / General"
	case "appearance":
		return "Settings / Appearance"
	case "interaction":
		return "Settings / Interaction"
	case "agent":
		return "Settings / Agent"
	case "agent_status":
		return "Settings / Agent / Status"
	case "agent_provider":
		return "Settings / Agent / Provider"
	case "agent_security":
		return "Settings / Agent / Security and credentials"
	case "agent_security_findings":
		return "Settings / Agent / Security and credentials / Findings"
	case "agent_security_preview":
		return "Settings / Agent / Security and credentials / Repair preview"
	case "agent_security_result":
		return "Settings / Agent / Security and credentials / Repair result"
	case "agent_configuration":
		return "Settings / Agent / Configuration"
	case "agent_safety":
		return "Settings / Agent / Safety and permissions"
	case "agent_execution":
		return "Settings / Agent / Execution"
	case "agent_budgets":
		return "Settings / Agent / Budgets"
	case "agent_recovery":
		return "Settings / Agent / Recovery"
	default:
		return "Settings / " + titleCase(strings.ReplaceAll(page, "_", " "))
	}
}

func settingsVisibleRowCount(height int) int {
	return maxInt(3, (height-12)/2)
}

func settingsPageTitle(page string) string {
	switch page {
	case "general":
		return "General settings"
	case "appearance":
		return "Appearance settings"
	case "interaction":
		return "Interaction settings"
	case "agent":
		return "Agent settings"
	case "agent_status":
		return "Agent status"
	case "agent_provider":
		return "Agent provider"
	case "agent_security":
		return "Agent security and credentials"
	case "agent_security_findings":
		return "Agent security findings"
	case "agent_security_preview":
		return "Agent security repair preview"
	case "agent_security_result":
		return "Agent security repair result"
	case "agent_configuration":
		return "Agent configuration"
	case "agent_safety":
		return "Agent safety and permissions"
	case "agent_execution":
		return "Agent execution"
	case "agent_budgets":
		return "Agent budgets"
	case "agent_recovery":
		return "Agent recovery"
	default:
		return titleCase(strings.ReplaceAll(page, "_", " ")) + " settings"
	}
}

func (m RootModel) handleSettingsKey(msg tea.KeyPressMsg) (RootModel, tea.Cmd) {
	if m.settingsEditing {
		switch msg.String() {
		case "esc":
			m.settingsEditing = false
			m.settingsEditField = ""
			m.settingsInput.Blur()
			m.settingsNotice = "Edit cancelled."
			return m, nil
		case "enter":
			return m.commitSettingsEdit()
		default:
			updated, cmd := m.settingsInput.Update(msg)
			m.settingsInput = updated
			return m, cmd
		}
	}
	rows := m.settingsRows()
	switch msg.String() {
	case "q":
		m.closeSettings()
		return m, nil
	case "esc", "left", "backspace":
		if m.settingsPage == "agent_security_findings" || m.settingsPage == "agent_security_preview" || m.settingsPage == "agent_security_result" {
			m.settingsPage = "agent_security"
			m.settingsSelected = 0
			m.settingsOffset = 0
			m.settingsNotice = ""
			m.settingsConfirmAction = ""
		} else if strings.HasPrefix(m.settingsPage, "agent_") {
			m.settingsPage = "agent"
			m.settingsSelected = 0
			m.settingsOffset = 0
			m.settingsNotice = ""
			m.settingsConfirmAction = ""
		} else if m.settingsPage != "" && m.settingsPage != "categories" {
			m.settingsPage = "categories"
			m.settingsSelected = 0
			m.settingsOffset = 0
			m.settingsNotice = ""
		} else {
			m.closeSettings()
		}
		return m, nil
	case "up", "k":
		m.settingsSelected = clampInt(m.settingsSelected-1, 0, maxInt(0, len(rows)-1))
		m.followSettingsSelection(len(rows))
		return m, nil
	case "down", "j":
		m.settingsSelected = clampInt(m.settingsSelected+1, 0, maxInt(0, len(rows)-1))
		m.followSettingsSelection(len(rows))
		return m, nil
	case "home":
		m.settingsSelected = 0
		m.followSettingsSelection(len(rows))
		return m, nil
	case "end":
		m.settingsSelected = maxInt(0, len(rows)-1)
		m.followSettingsSelection(len(rows))
		return m, nil
	case "enter", "right", " ":
		return m.activateSettingsSelection()
	}
	return m, nil
}

func (m *RootModel) followSettingsSelection(total int) {
	visible := settingsVisibleRowCount(m.height)
	if m.settingsSelected < m.settingsOffset {
		m.settingsOffset = m.settingsSelected
	}
	if m.settingsSelected >= m.settingsOffset+visible {
		m.settingsOffset = m.settingsSelected - visible + 1
	}
	m.settingsOffset = clampInt(m.settingsOffset, 0, maxInt(0, total-visible))
}

func (m RootModel) activateSettingsSelection() (RootModel, tea.Cmd) {
	if m.settingsSaving {
		return m, nil
	}
	rows := m.settingsRows()
	if len(rows) == 0 {
		return m, nil
	}
	row := rows[clampInt(m.settingsSelected, 0, len(rows)-1)]
	config := m.settingsAgentConfig()
	if row.readOnly {
		m.settingsNotice = row.label + " is derived from authoritative runtime state."
		return m, nil
	}
	switch row.id {
	case "general", "appearance", "interaction", "agent":
		m.settingsPage = row.id
		m.settingsSelected = 0
		m.settingsOffset = 0
		m.settingsNotice = ""
		if row.id == "agent" && m.agentConfig == nil {
			return m, commands.FetchAgentConfigCmd(m.ctx, m.client)
		}
		return m, nil
	case "agent_status_page", "agent_provider_page", "agent_security_page", "agent_configuration_page", "agent_safety_page", "agent_execution_page", "agent_budgets_page", "agent_recovery_page":
		m.settingsPage = strings.TrimSuffix(row.id, "_page")
		m.settingsSelected = 0
		m.settingsOffset = 0
		m.settingsNotice = ""
		m.settingsConfirmAction = ""
		if m.settingsPage == "agent_provider" {
			return m, commands.FetchAgentProviderStatusCmd(m.ctx, m.client)
		}
		if m.settingsPage == "agent_security" {
			m.settingsSaving = true
			m.settingsNotice = "Running a local Agent security check..."
			return m, tea.Batch(
				commands.DiagnoseAgentSecurityCmd(m.ctx, m.client, false),
				commands.FetchLatestAgentSecurityRepairOperationCmd(m.ctx, m.client),
			)
		}
		return m, nil
	case "provider_manage_security":
		m.settingsPage = "agent_security"
		m.settingsSelected = 0
		m.settingsOffset = 0
		m.settingsSaving = true
		m.settingsNotice = "Running a local Agent security check..."
		return m, tea.Batch(
			commands.DiagnoseAgentSecurityCmd(m.ctx, m.client, false),
			commands.FetchLatestAgentSecurityRepairOperationCmd(m.ctx, m.client),
		)
	case "security_replace":
		m.settingsPage = "agent_provider"
		m.settingsSelected = 0
		m.settingsOffset = 0
		m.settingsNotice = "Use Replace credential to start the provider-owned OAuth PKCE flow."
		return m, commands.FetchAgentProviderStatusCmd(m.ctx, m.client)
	case "security_check":
		m.settingsSaving = true
		m.settingsNotice = "Running a local Agent security check..."
		return m, commands.DiagnoseAgentSecurityCmd(m.ctx, m.client, false)
	case "security_findings":
		m.settingsPage = "agent_security_findings"
		m.settingsSelected = 0
		m.settingsOffset = 0
		m.settingsNotice = ""
		if m.agentSecurityStatus == nil {
			m.settingsSaving = true
			return m, commands.DiagnoseAgentSecurityCmd(m.ctx, m.client, false)
		}
		return m, nil
	case "security_receipt":
		if m.agentSecurityRepairOperation == nil {
			m.settingsNotice = "No repair receipt is available in this TUI session."
			return m, nil
		}
		m.settingsPage = "agent_security_result"
		m.settingsSelected = 0
		m.settingsOffset = 0
		m.settingsNotice = ""
		return m, nil
	case "security_validate":
		return m.previewAgentSecurityAction("validate_managed_credential", "")
	case "security_migrate":
		return m.previewAgentSecurityAction("migrate_legacy_credential", "")
	case "security_cleanup":
		return m.previewAgentSecurityAction("remove_legacy_external_assignment", "")
	case "security_key_management":
		return m.previewAgentSecurityAction("open_provider_key_management", "")
	case "security_disconnect":
		return m.previewAgentSecurityAction("disconnect_local_credential", "")
	case "security_preview_cancel", "security_result_back":
		m.settingsPage = "agent_security"
		m.settingsSelected = 0
		m.settingsOffset = 0
		m.settingsNotice = "No repair was applied."
		return m, nil
	case "security_apply":
		if m.agentSecurityRepairPreview == nil {
			m.settingsNotice = "The repair preview is unavailable. Run a fresh security check."
			return m, nil
		}
		if m.agentSecurityRepairPreview.Confirmation.Phrase != "" {
			m.settingsEditing = true
			m.settingsEditField = "security_confirmation"
			m.settingsInput.SetValue("")
			_ = m.settingsInput.Focus()
			m.settingsNotice = "Type the exact confirmation phrase, then press Enter."
			return m, nil
		}
		return m.applyAgentSecurityPreview()
	case "daemon_restart":
		command := slash.ParsedCommand{Raw: "/daemon restart", Kind: slash.KindDaemonRestart}
		confirmation, err := m.prepareConfirmation(command)
		if err != nil {
			m.settingsNotice = err.Error()
			return m, nil
		}
		m.closeSettings()
		m.pendingConfirm = confirmation
		m.interaction.OpenModal(interaction.ModalConfirmation)
		return m, nil
	case "save_agent":
		return m.commitAgentSettingsDraft()
	case "discard_agent":
		m.resetAgentSettingsDraft()
		m.settingsNotice = "Unsaved Agent changes discarded."
		return m, nil
	case "config_reload":
		m.settingsSaving = true
		m.settingsNotice = "Reloading Agent configuration..."
		return m, commands.ReloadAgentConfigCmd(m.ctx, m.client)
	case "provider_connect", "provider_replace":
		m.settingsSaving = true
		mode := "connect"
		if row.id == "provider_replace" {
			mode = "replace"
		}
		m.settingsNotice = "Starting OpenRouter authorization..."
		return m, commands.StartAgentProviderConnectionCmd(m.ctx, m.client, mode)
	case "provider_migrate":
		if m.settingsConfirmAction != row.id {
			m.settingsConfirmAction = row.id
			m.settingsNotice = "Press Enter again to copy the legacy key into Windows DPAPI storage. Relaybase will not edit .env."
			return m, nil
		}
		m.settingsConfirmAction = ""
		m.settingsSaving = true
		return m, commands.MigrateAgentProviderCmd(m.ctx, m.client)
	case "provider_validate":
		m.settingsSaving = true
		m.settingsNotice = "Validating the protected credential with OpenRouter..."
		return m, commands.ValidateAgentProviderCmd(m.ctx, m.client)
	case "provider_cleanup_legacy":
		if m.settingsConfirmAction == row.id && m.agentLegacyRemovalPreview != nil {
			previewID := m.agentLegacyRemovalPreview.PreviewID
			m.settingsConfirmAction = ""
			m.settingsSaving = true
			return m, commands.ApplyLegacyAgentCredentialRemovalCmd(m.ctx, m.client, previewID)
		}
		m.settingsSaving = true
		m.settingsNotice = "Preparing an exact legacy credential removal preview..."
		return m, commands.PreviewLegacyAgentCredentialRemovalCmd(m.ctx, m.client)
	case "provider_disconnect":
		if m.settingsConfirmAction != row.id {
			m.settingsConfirmAction = row.id
			m.settingsNotice = "Press Enter again to disconnect locally. The remote OpenRouter key will remain active."
			return m, nil
		}
		m.settingsConfirmAction = ""
		m.settingsSaving = true
		return m, commands.DisconnectAgentProviderCmd(m.ctx, m.client)
	case "provider_revoke":
		m.settingsSaving = true
		m.settingsNotice = "Checking remote revocation support..."
		return m, commands.PreviewAgentProviderRevokeCmd(m.ctx, m.client)
	case "theme":
		next := nextChoice(m.preferences.Theme, []string{"auto", "light", "dark"})
		m.applyTheme(next)
		m.settingsNotice = "Theme saved."
		return m, m.persistPreferencesCmd()
	case "density":
		m.preferences.Layout.Density = nextChoice(m.preferences.Layout.Density, []string{"compact", "comfortable"})
		m.settingsNotice = "Layout density saved."
		return m, m.persistPreferencesCmd()
	case "agent_pane":
		m.preferences.Layout.AgentPaneCollapsed = !m.preferences.Layout.AgentPaneCollapsed
		m.syncOperatorLayout()
		m.settingsNotice = "Agent pane preference saved."
		return m, m.persistPreferencesCmd()
	case "history_days", "model_slug", "key_env", "referer_env", "title_env", "tool_allowlist",
		"segment_turns", "total_turns", "inactivity_seconds", "hard_seconds", "max_output_tokens",
		"no_progress", "daily_budget", "monthly_budget", "session_budget":
		m.beginSettingsEdit(row)
		return m, nil
	case "agent_enabled":
		if config == nil {
			return m, nil
		}
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Enabled: boolPointer(!config.Enabled)})
	case "remote_model":
		if config == nil {
			return m, nil
		}
		next := !config.Provider.RemoteModelEnabled
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Provider: &relaybaseclient.AgentProviderConfigUpdate{RemoteModelEnabled: &next}})
	case "tool_mode":
		if config == nil {
			return m, nil
		}
		next := nextChoice(config.ToolAllowlistMode, []string{"all_registered", "explicit_allowlist"})
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{ToolAllowlistMode: next})
	case "approval_policy":
		if config == nil {
			return m, nil
		}
		next := nextChoice(config.ApprovalPolicy, []string{"always_for_mutations", "read_only_only"})
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{ApprovalPolicy: next})
	case "browser_open":
		if config == nil {
			return m, nil
		}
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{AllowBrowserOpen: boolPointer(!config.AllowBrowserOpen)})
	case "copy_route":
		if config == nil {
			return m, nil
		}
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{AllowCopyRoute: boolPointer(!config.AllowCopyRoute)})
	case "reasoning":
		if config == nil {
			return m, nil
		}
		next := nextChoice(config.Execution.ReasoningEffort, []string{"low", "medium", "high"})
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Execution: &relaybaseclient.AgentExecutionPolicyUpdate{ReasoningEffort: next}})
	default:
		if strings.HasPrefix(row.id, "security_finding:") {
			code := strings.TrimPrefix(row.id, "security_finding:")
			finding := m.agentSecurityFinding(code)
			if finding == nil || finding.RecommendedActionID == "" {
				m.settingsNotice = "This finding requires a manual recovery action."
				return m, nil
			}
			return m.previewAgentSecurityAction(finding.RecommendedActionID, finding.Code)
		}
		m.settingsNotice = "This setting is not editable."
		return m, nil
	}
}

func (m *RootModel) beginSettingsEdit(row settingsRow) {
	config := m.settingsAgentConfig()
	value := row.value
	switch row.id {
	case "history_days":
		value = strconv.Itoa(m.preferences.Assistant.HistoryRetentionDays)
	case "inactivity_seconds":
		value = strconv.Itoa(config.Execution.InactivityTimeoutMS / 1000)
	case "hard_seconds":
		value = strconv.Itoa(config.Execution.HardRunTimeoutMS / 1000)
	case "daily_budget":
		value = budgetEditValue(config, "daily")
	case "monthly_budget":
		value = budgetEditValue(config, "monthly")
	case "session_budget":
		value = budgetEditValue(config, "session")
	case "tool_allowlist":
		value = strings.Join(config.ToolAllowlist, ", ")
	}
	if strings.HasSuffix(value, "not configured") || strings.HasSuffix(value, "not set") {
		value = ""
	}
	m.settingsEditing = true
	m.settingsEditField = row.id
	m.settingsInput.SetValue(value)
	m.settingsInput.CursorEnd()
	_ = m.settingsInput.Focus()
	m.settingsNotice = ""
}

func (m RootModel) commitSettingsEdit() (RootModel, tea.Cmd) {
	field := m.settingsEditField
	value := strings.TrimSpace(m.settingsInput.Value())
	m.settingsEditing = false
	m.settingsEditField = ""
	m.settingsInput.Blur()
	if field == "history_days" {
		days, err := boundedSettingsInt(value, 1, 365, "History retention")
		if err != nil {
			m.settingsNotice = err.Error()
			return m, nil
		}
		m.preferences.Assistant.HistoryRetentionDays = days
		m.settingsNotice = "History retention saved."
		return m, m.persistPreferencesCmd()
	}
	if field == "security_confirmation" {
		if m.agentSecurityRepairPreview == nil {
			m.settingsNotice = "The repair preview is unavailable. Run a fresh security check."
			return m, nil
		}
		if value != m.agentSecurityRepairPreview.Confirmation.Phrase {
			m.settingsNotice = "Confirmation phrase did not match. No repair was applied."
			return m, nil
		}
		return m.applyAgentSecurityPreview()
	}
	if m.settingsAgentConfig() == nil {
		m.settingsNotice = "Agent configuration is not loaded."
		return m, nil
	}
	switch field {
	case "model_slug":
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Provider: &relaybaseclient.AgentProviderConfigUpdate{ModelSlug: stringPointer(value)}})
	case "key_env":
		if value == "" {
			m.settingsNotice = "API key environment-variable name cannot be empty."
			return m, nil
		}
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Provider: &relaybaseclient.AgentProviderConfigUpdate{APIKeyEnvVar: stringPointer(value)}})
	case "referer_env":
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Provider: &relaybaseclient.AgentProviderConfigUpdate{HTTPRefererEnvVar: stringPointer(value)}})
	case "title_env":
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Provider: &relaybaseclient.AgentProviderConfigUpdate{TitleEnvVar: stringPointer(value)}})
	case "tool_allowlist":
		allowlist := commaSeparatedValues(value)
		return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{ToolAllowlist: &allowlist, ToolAllowlistMode: "explicit_allowlist"})
	case "segment_turns":
		return m.saveExecutionInt(value, 1, 32, func(update *relaybaseclient.AgentExecutionPolicyUpdate, parsed int) { update.SegmentMaxTurns = &parsed })
	case "total_turns":
		return m.saveExecutionInt(value, 1, 128, func(update *relaybaseclient.AgentExecutionPolicyUpdate, parsed int) { update.TotalMaxTurns = &parsed })
	case "inactivity_seconds":
		return m.saveExecutionInt(value, 10, 600, func(update *relaybaseclient.AgentExecutionPolicyUpdate, parsed int) {
			milliseconds := parsed * 1000
			update.InactivityTimeoutMS = &milliseconds
		})
	case "hard_seconds":
		return m.saveExecutionInt(value, 30, 3600, func(update *relaybaseclient.AgentExecutionPolicyUpdate, parsed int) {
			milliseconds := parsed * 1000
			update.HardRunTimeoutMS = &milliseconds
		})
	case "max_output_tokens":
		return m.saveExecutionInt(value, 256, 32768, func(update *relaybaseclient.AgentExecutionPolicyUpdate, parsed int) { update.MaxOutputTokens = &parsed })
	case "no_progress":
		return m.saveExecutionInt(value, 2, 10, func(update *relaybaseclient.AgentExecutionPolicyUpdate, parsed int) {
			update.NoProgressRepeatLimit = &parsed
		})
	case "daily_budget", "monthly_budget", "session_budget":
		return m.saveBudget(field, value)
	default:
		m.settingsNotice = "Unknown settings field."
		return m, nil
	}
}

func (m RootModel) saveExecutionInt(
	value string,
	minimum int,
	maximum int,
	assign func(*relaybaseclient.AgentExecutionPolicyUpdate, int),
) (RootModel, tea.Cmd) {
	parsed, err := boundedSettingsInt(value, minimum, maximum, "Value")
	if err != nil {
		m.settingsNotice = err.Error()
		return m, nil
	}
	update := &relaybaseclient.AgentExecutionPolicyUpdate{}
	assign(update, parsed)
	return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Execution: update})
}

func (m RootModel) saveBudget(field string, value string) (RootModel, tea.Cmd) {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || parsed < 0 || parsed > 1_000_000 {
		m.settingsNotice = "Budget must be a number from 0 to 1000000."
		return m, nil
	}
	budgets := relaybaseclient.AgentBudgets{}
	if config := m.settingsAgentConfig(); config != nil && config.Budgets != nil {
		budgets = *config.Budgets
	}
	switch field {
	case "daily_budget":
		budgets.DailyLimitUSD = parsed
	case "monthly_budget":
		budgets.MonthlyLimitUSD = parsed
	case "session_budget":
		budgets.SessionLimitUSD = parsed
	}
	return m.saveAgentSetting(relaybaseclient.AgentConfigUpdate{Budgets: &budgets})
}

func (m RootModel) saveAgentSetting(update relaybaseclient.AgentConfigUpdate) (RootModel, tea.Cmd) {
	if m.settingsAgentDraft == nil {
		m.resetAgentSettingsDraft()
	}
	if m.settingsAgentDraft == nil {
		m.settingsNotice = "Agent configuration is not loaded."
		return m, nil
	}
	applyAgentConfigUpdate(m.settingsAgentDraft, update)
	m.settingsAgentDirty = true
	m.settingsNotice = "Unsaved Agent changes. Choose Save changes to apply atomically."
	return m, nil
}

func (m RootModel) commitAgentSettingsDraft() (RootModel, tea.Cmd) {
	if !m.settingsAgentDirty || m.settingsAgentDraft == nil || m.agentConfig == nil {
		m.settingsNotice = "There are no Agent changes to save."
		return m, nil
	}
	if m.agentConfig.Revision == nil || strings.TrimSpace(m.agentConfig.Revision.ID) == "" {
		m.settingsNotice = "The active Agent revision is unavailable; reload before saving."
		return m, nil
	}
	m.settingsSaving = true
	m.settingsNotice = "Validating and applying Agent changes..."
	return m, commands.UpdateAgentConfigCmd(m.ctx, m.client, relaybaseclient.AgentConfigUpdateRequest{
		ExpectedRevisionID: m.agentConfig.Revision.ID,
		Update:             completeAgentConfigUpdate(m.settingsAgentDraft),
	})
}

func (m *RootModel) resetAgentSettingsDraft() {
	m.settingsAgentDraft = cloneAgentConfig(m.agentConfig)
	m.settingsAgentDirty = false
	m.settingsConfirmAction = ""
	m.agentLegacyRemovalPreview = nil
}

func (m RootModel) settingsAgentConfig() *relaybaseclient.AgentConfig {
	if m.settingsAgentDraft != nil {
		return m.settingsAgentDraft
	}
	return m.agentConfig
}

func cloneAgentConfig(config *relaybaseclient.AgentConfig) *relaybaseclient.AgentConfig {
	if config == nil {
		return nil
	}
	cloned := *config
	cloned.ToolAllowlist = append([]string(nil), config.ToolAllowlist...)
	if config.Budgets != nil {
		budgets := *config.Budgets
		cloned.Budgets = &budgets
	}
	if config.Revision != nil {
		revision := *config.Revision
		cloned.Revision = &revision
	}
	if config.Source != nil {
		source := *config.Source
		if config.Source.LastError != nil {
			diagnostic := *config.Source.LastError
			source.LastError = &diagnostic
		}
		cloned.Source = &source
	}
	if config.Credential != nil {
		credential := *config.Credential
		if config.Credential.LimitUSD != nil {
			value := *config.Credential.LimitUSD
			credential.LimitUSD = &value
		}
		if config.Credential.LimitRemainingUSD != nil {
			value := *config.Credential.LimitRemainingUSD
			credential.LimitRemainingUSD = &value
		}
		if config.Credential.ExpiresAt != nil {
			value := *config.Credential.ExpiresAt
			credential.ExpiresAt = &value
		}
		cloned.Credential = &credential
	}
	return &cloned
}

func applyAgentConfigUpdate(config *relaybaseclient.AgentConfig, update relaybaseclient.AgentConfigUpdate) {
	if update.Enabled != nil {
		config.Enabled = *update.Enabled
	}
	if update.Provider != nil {
		if update.Provider.ModelSlug != nil {
			config.Provider.ModelSlug = *update.Provider.ModelSlug
		}
		if update.Provider.APIKeyEnvVar != nil {
			config.Provider.APIKeySource.Type = "environment"
			config.Provider.APIKeySource.EnvVar = *update.Provider.APIKeyEnvVar
		}
		if update.Provider.RemoteModelEnabled != nil {
			config.Provider.RemoteModelEnabled = *update.Provider.RemoteModelEnabled
		}
		if update.Provider.HTTPRefererEnvVar != nil {
			config.Provider.HTTPRefererEnvVar = *update.Provider.HTTPRefererEnvVar
		}
		if update.Provider.TitleEnvVar != nil {
			config.Provider.TitleEnvVar = *update.Provider.TitleEnvVar
		}
	}
	if update.Execution != nil {
		if update.Execution.SegmentMaxTurns != nil {
			config.Execution.SegmentMaxTurns = *update.Execution.SegmentMaxTurns
		}
		if update.Execution.TotalMaxTurns != nil {
			config.Execution.TotalMaxTurns = *update.Execution.TotalMaxTurns
		}
		if update.Execution.InactivityTimeoutMS != nil {
			config.Execution.InactivityTimeoutMS = *update.Execution.InactivityTimeoutMS
		}
		if update.Execution.HardRunTimeoutMS != nil {
			config.Execution.HardRunTimeoutMS = *update.Execution.HardRunTimeoutMS
		}
		if update.Execution.MaxOutputTokens != nil {
			config.Execution.MaxOutputTokens = *update.Execution.MaxOutputTokens
		}
		if update.Execution.ReasoningEffort != "" {
			config.Execution.ReasoningEffort = update.Execution.ReasoningEffort
		}
		if update.Execution.NoProgressRepeatLimit != nil {
			config.Execution.NoProgressRepeatLimit = *update.Execution.NoProgressRepeatLimit
		}
	}
	if update.ToolAllowlist != nil {
		config.ToolAllowlist = append([]string(nil), (*update.ToolAllowlist)...)
	}
	if update.ToolAllowlistMode != "" {
		config.ToolAllowlistMode = update.ToolAllowlistMode
	}
	if update.ApprovalPolicy != "" {
		config.ApprovalPolicy = update.ApprovalPolicy
	}
	if update.AllowBrowserOpen != nil {
		config.AllowBrowserOpen = *update.AllowBrowserOpen
	}
	if update.AllowCopyRoute != nil {
		config.AllowCopyRoute = *update.AllowCopyRoute
	}
	if update.Budgets != nil {
		budgets := *update.Budgets
		config.Budgets = &budgets
	}
}

func completeAgentConfigUpdate(config *relaybaseclient.AgentConfig) relaybaseclient.AgentConfigUpdate {
	enabled := config.Enabled
	remote := config.Provider.RemoteModelEnabled
	modelSlug := config.Provider.ModelSlug
	referer := config.Provider.HTTPRefererEnvVar
	title := config.Provider.TitleEnvVar
	segmentTurns := config.Execution.SegmentMaxTurns
	totalTurns := config.Execution.TotalMaxTurns
	inactivity := config.Execution.InactivityTimeoutMS
	hardTimeout := config.Execution.HardRunTimeoutMS
	maxOutput := config.Execution.MaxOutputTokens
	noProgress := config.Execution.NoProgressRepeatLimit
	provider := &relaybaseclient.AgentProviderConfigUpdate{
		ModelSlug:          &modelSlug,
		RemoteModelEnabled: &remote,
		HTTPRefererEnvVar:  &referer,
		TitleEnvVar:        &title,
	}
	if config.Provider.APIKeySource.Type == "environment" {
		envVar := config.Provider.APIKeySource.EnvVar
		provider.APIKeyEnvVar = &envVar
	}
	allowlist := append([]string(nil), config.ToolAllowlist...)
	update := relaybaseclient.AgentConfigUpdate{
		Enabled:           &enabled,
		Provider:          provider,
		ToolAllowlist:     &allowlist,
		ToolAllowlistMode: config.ToolAllowlistMode,
		ApprovalPolicy:    config.ApprovalPolicy,
		AllowBrowserOpen:  boolPointer(config.AllowBrowserOpen),
		AllowCopyRoute:    boolPointer(config.AllowCopyRoute),
		Execution: &relaybaseclient.AgentExecutionPolicyUpdate{
			SegmentMaxTurns:       &segmentTurns,
			TotalMaxTurns:         &totalTurns,
			InactivityTimeoutMS:   &inactivity,
			HardRunTimeoutMS:      &hardTimeout,
			MaxOutputTokens:       &maxOutput,
			ReasoningEffort:       config.Execution.ReasoningEffort,
			NoProgressRepeatLimit: &noProgress,
		},
	}
	if config.Budgets != nil {
		budgets := *config.Budgets
		update.Budgets = &budgets
	}
	return update
}

func appendDraftActions(rows []settingsRow, dirty bool) []settingsRow {
	if !dirty {
		return rows
	}
	return append(rows,
		settingsRow{id: "save_agent", label: "Save changes", value: "validate + apply", hint: "Applies the complete draft only if the active revision still matches.", action: true},
		settingsRow{id: "discard_agent", label: "Discard changes", value: "restore active config", action: true},
	)
}

func filterSettingsRows(rows []settingsRow, ids ...string) []settingsRow {
	byID := make(map[string]settingsRow, len(rows))
	for _, row := range rows {
		byID[row.id] = row
	}
	filtered := make([]settingsRow, 0, len(ids))
	for _, id := range ids {
		if row, ok := byID[id]; ok {
			filtered = append(filtered, row)
		}
	}
	return filtered
}

func providerConnection(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Credential == nil {
		return "not connected"
	}
	return valueOr(config.Credential.Connection, "not connected")
}

func budgetSummary(budgets *relaybaseclient.AgentBudgets) string {
	if budgets == nil || (budgets.DailyLimitUSD <= 0 && budgets.MonthlyLimitUSD <= 0 && budgets.SessionLimitUSD <= 0) {
		return "no local limit"
	}
	values := []string{}
	if budgets.SessionLimitUSD > 0 {
		values = append(values, fmt.Sprintf("$%.2f session", budgets.SessionLimitUSD))
	}
	if budgets.DailyLimitUSD > 0 {
		values = append(values, fmt.Sprintf("$%.2f daily", budgets.DailyLimitUSD))
	}
	if budgets.MonthlyLimitUSD > 0 {
		values = append(values, fmt.Sprintf("$%.2f monthly", budgets.MonthlyLimitUSD))
	}
	return strings.Join(values, " / ")
}

func agentSourceSummary(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Source == nil {
		return "unknown"
	}
	return valueOr(config.Source.Health, "unknown") + " · " + valueOr(config.Source.Label, config.Source.Mode)
}

func agentRevisionSummary(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Revision == nil {
		return "unavailable"
	}
	return fmt.Sprintf("generation %d · %s", config.Revision.Generation, valueOr(config.Revision.ID, "unknown"))
}

func credentialProtection(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Credential == nil {
		return "none"
	}
	return valueOr(config.Credential.Protection, "none")
}

func credentialLabel(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Credential == nil {
		return "not reported"
	}
	return valueOr(config.Credential.KeyLabel, "not reported")
}

func credentialLimit(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Credential == nil || config.Credential.LimitUSD == nil {
		return "not reported"
	}
	limit := fmt.Sprintf("$%.2f", *config.Credential.LimitUSD)
	if config.Credential.LimitRemainingUSD != nil {
		limit += fmt.Sprintf(" · $%.2f remaining", *config.Credential.LimitRemainingUSD)
	}
	return limit
}

func credentialExpiration(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Credential == nil || config.Credential.ExpiresAt == nil || *config.Credential.ExpiresAt == "" {
		return "not reported"
	}
	return *config.Credential.ExpiresAt
}

func highSecurityStatus(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Credential == nil {
		return "unavailable"
	}
	return valueOr(config.Credential.HighSecurityMode, "unavailable")
}

func agentSourceError(config *relaybaseclient.AgentConfig) string {
	if config == nil || config.Source == nil || config.Source.LastError == nil {
		return "none"
	}
	return valueOr(config.Source.LastError.Message, config.Source.LastError.Code)
}

func (m RootModel) previewAgentSecurityAction(actionID string, issueCode string) (RootModel, tea.Cmd) {
	m.settingsSaving = true
	m.settingsNotice = "Preparing a daemon-bound repair preview..."
	request := relaybaseclient.AgentSecurityRepairPreviewRequest{ActionIDs: []string{actionID}}
	if issueCode != "" {
		request.IssueCodes = []string{issueCode}
	}
	return m, commands.PreviewAgentSecurityRepairCmd(m.ctx, m.client, request)
}

func (m RootModel) applyAgentSecurityPreview() (RootModel, tea.Cmd) {
	if m.agentSecurityRepairPreview == nil {
		m.settingsNotice = "The repair preview is unavailable. Run a fresh security check."
		return m, nil
	}
	m.settingsSaving = true
	m.settingsNotice = "Applying the bound repair and verifying the result..."
	if m.agentSecurityIdempotencyKey == "" || m.agentSecurityIdempotencyPreviewID != m.agentSecurityRepairPreview.PreviewID {
		m.agentSecurityIdempotencyKey = newAgentSecurityIdempotencyKey()
		m.agentSecurityIdempotencyPreviewID = m.agentSecurityRepairPreview.PreviewID
	}
	return m, commands.ApplyAgentSecurityRepairCmd(
		m.ctx,
		m.client,
		m.agentSecurityRepairPreview.PreviewID,
		m.agentSecurityIdempotencyKey,
		m.agentSecurityRepairPreview.Confirmation.Value,
	)
}

func (m RootModel) agentSecurityFinding(code string) *relaybaseclient.AgentSecurityFinding {
	if m.agentSecurityStatus == nil {
		return nil
	}
	for index := range m.agentSecurityStatus.Findings {
		if m.agentSecurityStatus.Findings[index].Code == code {
			return &m.agentSecurityStatus.Findings[index]
		}
	}
	return nil
}

func agentSecuritySummary(status *relaybaseclient.AgentSecurityStatus) string {
	if status == nil {
		return "not checked"
	}
	if status.Healthy {
		return "healthy"
	}
	return valueOr(status.State, "attention")
}

func agentSecurityIssueCount(status *relaybaseclient.AgentSecurityStatus) int {
	if status == nil {
		return 0
	}
	count := 0
	for _, finding := range status.Findings {
		if finding.State != "healthy" {
			count++
		}
	}
	return count
}

func evidenceString(evidence map[string]any, key string, fallback string) string {
	value, ok := evidence[key].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func sortAgentSecurityFindings(findings []relaybaseclient.AgentSecurityFinding) {
	rank := func(state string) int {
		switch state {
		case "blocked":
			return 0
		case "attention":
			return 1
		default:
			return 2
		}
	}
	for index := 1; index < len(findings); index++ {
		for current := index; current > 0 && rank(findings[current].State) < rank(findings[current-1].State); current-- {
			findings[current], findings[current-1] = findings[current-1], findings[current]
		}
	}
}

func newAgentSecurityIdempotencyKey() string {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err == nil {
		return "tui-" + hex.EncodeToString(random)
	}
	return fmt.Sprintf("tui-%d", time.Now().UnixNano())
}

type agentProviderStatusTickMsg struct {
	attemptID string
}

func pollAgentProviderStatus(attemptID string) tea.Cmd {
	return tea.Tick(2*time.Second, func(time.Time) tea.Msg {
		return agentProviderStatusTickMsg{attemptID: attemptID}
	})
}

func onOff(value bool) string {
	if value {
		return "on"
	}
	return "off"
}

func nextChoice(current string, choices []string) string {
	for index, choice := range choices {
		if current == choice {
			return choices[(index+1)%len(choices)]
		}
	}
	return choices[0]
}

func boundedSettingsInt(value string, minimum int, maximum int, label string) (int, error) {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed < minimum || parsed > maximum {
		return 0, fmt.Errorf("%s must be a whole number from %d to %d.", label, minimum, maximum)
	}
	return parsed, nil
}

func commaSeparatedValues(value string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		result = append(result, item)
	}
	return result
}

func budgetValue(value float64) string {
	if value <= 0 {
		return "not limited"
	}
	return fmt.Sprintf("$%.2f", value)
}

func budgetEditValue(config *relaybaseclient.AgentConfig, field string) string {
	if config == nil || config.Budgets == nil {
		return "0"
	}
	value := config.Budgets.DailyLimitUSD
	if field == "monthly" {
		value = config.Budgets.MonthlyLimitUSD
	}
	if field == "session" {
		value = config.Budgets.SessionLimitUSD
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func boolPointer(value bool) *bool { return &value }

func stringPointer(value string) *string { return &value }

func clampInt(value int, minimum int, maximum int) int {
	return minInt(maxInt(value, minimum), maximum)
}
