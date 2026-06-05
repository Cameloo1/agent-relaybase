package assistant

import (
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/cameloo/relaybase/tui/internal/tui/slash"
)

const (
	ModeDeterministic = "deterministic"
	ModeLocalModel    = "local_model"
	ModeRemoteModel   = "remote_model"

	DataCategoryOperatorInput = "operator_input"
	DataCategoryLogs          = "logs"
	DataCategoryDiagnostics   = "diagnostics"

	ToolLifecycleStart = "lifecycle.start"
	ToolLifecycleStop  = "lifecycle.stop"
	ToolLifecycleRestart = "lifecycle.restart"
	ToolLogsExport     = "logs.export"
	ToolLogsShow       = "logs.show"
	ToolDiagnosticsShow = "diagnostics.show"
	ToolPageChange     = "page.change"
	ToolPanePin        = "pane.pin"
	ToolPaneColor      = "pane.color"
)

var rawAPIKeyPattern = regexp.MustCompile(`(?i)^(sk-[a-z0-9_-]{6,}|[a-z0-9_./+=-]{32,})$`)

type ProviderConfig struct {
	Mode            string       `json:"mode"`
	Provider        string       `json:"provider"`
	Model           string       `json:"model"`
	BaseURL         string       `json:"baseUrl"`
	APIKeyRef       string       `json:"apiKeyRef"`
	RemoteEnabled   bool         `json:"remoteEnabled"`
	Budget          BudgetLimits `json:"budget"`
	EnabledTools    []string     `json:"enabledTools"`
	SendLogs        bool         `json:"sendLogs"`
	SendDiagnostics bool         `json:"sendDiagnostics"`
}

type BudgetLimits struct {
	MonthlyTokenLimit int `json:"monthlyTokenLimit"`
	DailyTokenLimit   int `json:"dailyTokenLimit"`
	SessionTokenLimit int `json:"sessionTokenLimit"`
}

type ProviderDiagnostic struct {
	Code     string
	Severity string
	Message  string
}

type PromptData struct {
	UserInput   string
	Logs        []string
	Diagnostics []string
}

type PromptPreview struct {
	DataCategories []string
	PreviewLines   []string
	EstimatedTokens int
}

type ToolCall struct {
	Name      string
	Target    string
	Arguments map[string]string
}

type ToolReview struct {
	Allowed              bool
	Blocked              bool
	Reason               string
	RequiresConfirmation bool
	CanExecuteDirectly   bool
	Command              slash.ParsedCommand
}

type ModelRequestAudit struct {
	Timestamp          time.Time `json:"timestamp"`
	Provider           string    `json:"provider"`
	Model              string    `json:"model"`
	DataCategories     []string  `json:"dataCategories"`
	EstimatedTokens    int       `json:"estimatedTokens"`
	ToolCallsProposed  []string  `json:"toolCallsProposed"`
	ActionsConfirmed   []string  `json:"actionsConfirmed"`
}

func DefaultProviderConfig() ProviderConfig {
	return ProviderConfig{
		Mode:            ModeDeterministic,
		Provider:        "",
		Model:           "",
		BaseURL:         "",
		APIKeyRef:       "",
		RemoteEnabled:   false,
		Budget:          BudgetLimits{},
		EnabledTools:    []string{},
		SendLogs:        false,
		SendDiagnostics: false,
	}
}

func NormalizeProviderConfig(config ProviderConfig) ProviderConfig {
	defaults := DefaultProviderConfig()
	config.Mode = oneOf(config.Mode, []string{ModeDeterministic, ModeLocalModel, ModeRemoteModel}, defaults.Mode)
	config.Provider = safeMetadata(config.Provider)
	config.Model = safeMetadata(config.Model)
	config.BaseURL = safeMetadata(config.BaseURL)
	config.APIKeyRef = sanitizeAPIKeyRef(config.APIKeyRef)
	config.Budget.MonthlyTokenLimit = maxInt(0, config.Budget.MonthlyTokenLimit)
	config.Budget.DailyTokenLimit = maxInt(0, config.Budget.DailyTokenLimit)
	config.Budget.SessionTokenLimit = maxInt(0, config.Budget.SessionTokenLimit)
	config.EnabledTools = normalizeToolAllowlist(config.EnabledTools)
	if config.Mode == ModeDeterministic {
		config.Provider = ""
		config.Model = ""
		config.BaseURL = ""
		config.APIKeyRef = ""
		config.RemoteEnabled = false
		config.Budget = BudgetLimits{}
		config.EnabledTools = []string{}
		config.SendLogs = false
		config.SendDiagnostics = false
	}
	if config.Mode != ModeRemoteModel {
		config.RemoteEnabled = false
	}
	return config
}

func SanitizeProviderConfig(config ProviderConfig) ProviderConfig {
	return NormalizeProviderConfig(config)
}

func ProviderDiagnostics(config ProviderConfig) []ProviderDiagnostic {
	config = NormalizeProviderConfig(config)
	if config.Mode == ModeDeterministic {
		return nil
	}
	diagnostics := []ProviderDiagnostic{}
	if config.Provider == "" || config.Model == "" {
		diagnostics = append(diagnostics, ProviderDiagnostic{
			Code:     "assistant_provider_missing",
			Severity: "warning",
			Message:  "Optional LLM assistant mode is configured, but provider and model are not fully configured.",
		})
	}
	if config.Mode == ModeRemoteModel {
		if !config.RemoteEnabled {
			diagnostics = append(diagnostics, ProviderDiagnostic{
				Code:     "assistant_remote_not_enabled",
				Severity: "warning",
				Message:  "Remote model mode requires explicit remoteEnabled=true before any remote provider can be used.",
			})
		}
		if config.BaseURL == "" {
			diagnostics = append(diagnostics, ProviderDiagnostic{
				Code:     "assistant_remote_endpoint_missing",
				Severity: "warning",
				Message:  "Remote model mode is missing an endpoint/base URL.",
			})
		}
		if config.APIKeyRef == "" {
			diagnostics = append(diagnostics, ProviderDiagnostic{
				Code:     "assistant_api_key_ref_missing",
				Severity: "warning",
				Message:  "Remote model mode must use an API key reference such as env:PROVIDER_API_KEY; raw keys are not stored.",
			})
		}
	}
	diagnostics = append(diagnostics, ProviderDiagnostic{
		Code:     "assistant_provider_shell_only",
		Severity: "info",
		Message:  "Optional LLM provider execution is not implemented yet; deterministic assistant mode remains the execution path.",
	})
	return diagnostics
}

func BuildPromptPreview(config ProviderConfig, data PromptData) PromptPreview {
	config = NormalizeProviderConfig(config)
	categories := []string{DataCategoryOperatorInput}
	lines := []string{}
	if input := SanitizeText(data.UserInput); input != "" {
		lines = append(lines, "input: "+input)
	}
	if config.SendLogs {
		categories = append(categories, DataCategoryLogs)
		for _, line := range data.Logs {
			if sanitized := SanitizeText(line); sanitized != "" {
				lines = append(lines, "log: "+sanitized)
			}
		}
	}
	if config.SendDiagnostics {
		categories = append(categories, DataCategoryDiagnostics)
		for _, diagnostic := range data.Diagnostics {
			if sanitized := SanitizeText(diagnostic); sanitized != "" {
				lines = append(lines, "diagnostic: "+sanitized)
			}
		}
	}
	return PromptPreview{
		DataCategories: uniqueStrings(categories),
		PreviewLines:   lines,
		EstimatedTokens: estimateTokens(lines),
	}
}

func ReviewToolCall(config ProviderConfig, call ToolCall) ToolReview {
	config = NormalizeProviderConfig(config)
	name := safeMetadata(call.Name)
	if name == "" || !isKnownTool(name) {
		return ToolReview{Blocked: true, Reason: "Unknown tool call blocked."}
	}
	if !toolAllowed(config.EnabledTools, name) {
		return ToolReview{Blocked: true, Reason: "Tool call is not in the assistant allowlist."}
	}

	review := ToolReview{
		Allowed:            true,
		CanExecuteDirectly: false,
	}
	target := firstNonEmpty(call.Target, call.Arguments["target"], "current")
	switch name {
	case ToolLifecycleStart:
		review.RequiresConfirmation = true
		review.Command = slash.ParsedCommand{Kind: slash.KindLaunch, Target: target}
	case ToolLifecycleStop:
		review.RequiresConfirmation = true
		review.Command = slash.ParsedCommand{Kind: slash.KindStop, Target: target}
	case ToolLifecycleRestart:
		review.RequiresConfirmation = true
		review.Command = slash.ParsedCommand{Kind: slash.KindRestart, Target: target}
	case ToolLogsExport:
		review.RequiresConfirmation = true
		review.Command = slash.ParsedCommand{Kind: slash.KindLogsExport, Scope: firstNonEmpty(call.Arguments["scope"], slash.ScopePane), Target: target}
	case ToolLogsShow, ToolDiagnosticsShow, ToolPageChange, ToolPanePin, ToolPaneColor:
		review.RequiresConfirmation = false
	default:
		return ToolReview{Blocked: true, Reason: "Unknown tool call blocked."}
	}
	return review
}

func NewModelRequestAudit(timestamp time.Time, config ProviderConfig, preview PromptPreview, proposed []ToolCall, confirmed []string) ModelRequestAudit {
	config = NormalizeProviderConfig(config)
	if timestamp.IsZero() {
		timestamp = time.Now().UTC()
	}
	return ModelRequestAudit{
		Timestamp:         timestamp.UTC(),
		Provider:          SanitizeText(config.Provider),
		Model:             SanitizeText(config.Model),
		DataCategories:    uniqueStrings(preview.DataCategories),
		EstimatedTokens:   maxInt(0, preview.EstimatedTokens),
		ToolCallsProposed: sanitizeToolNames(proposed),
		ActionsConfirmed:  sanitizeStrings(confirmed),
	}
}

func RemoteCallsAllowed(config ProviderConfig) bool {
	config = NormalizeProviderConfig(config)
	return config.Mode == ModeRemoteModel &&
		config.RemoteEnabled &&
		config.Provider != "" &&
		config.Model != "" &&
		config.BaseURL != "" &&
		config.APIKeyRef != ""
}

func safeMetadata(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if SanitizeText(trimmed) != trimmed {
		return ""
	}
	return trimmed
}

func sanitizeAPIKeyRef(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	if strings.Contains(trimmed, " ") || strings.Contains(trimmed, "\t") || rawAPIKeyPattern.MatchString(lower) {
		return ""
	}
	for _, prefix := range []string{"env:", "keychain:", "file:", "secretref:"} {
		if strings.HasPrefix(lower, prefix) && len(trimmed) > len(prefix) {
			return trimmed
		}
	}
	return ""
}

func normalizeToolAllowlist(tools []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, tool := range tools {
		normalized := safeMetadata(tool)
		if normalized == "" || !isKnownTool(normalized) || seen[normalized] {
			continue
		}
		seen[normalized] = true
		result = append(result, normalized)
	}
	sort.Strings(result)
	return result
}

func toolAllowed(allowlist []string, name string) bool {
	for _, allowed := range allowlist {
		if allowed == name {
			return true
		}
	}
	return false
}

func isKnownTool(name string) bool {
	switch name {
	case ToolLifecycleStart,
		ToolLifecycleStop,
		ToolLifecycleRestart,
		ToolLogsExport,
		ToolLogsShow,
		ToolDiagnosticsShow,
		ToolPageChange,
		ToolPanePin,
		ToolPaneColor:
		return true
	default:
		return false
	}
}

func estimateTokens(lines []string) int {
	words := 0
	for _, line := range lines {
		words += len(strings.Fields(line))
	}
	if words == 0 {
		return 0
	}
	return maxInt(1, words*4/3)
}

func sanitizeToolNames(calls []ToolCall) []string {
	result := []string{}
	for _, call := range calls {
		if name := safeMetadata(call.Name); name != "" {
			result = append(result, name)
		}
	}
	return uniqueStrings(result)
}

func sanitizeStrings(values []string) []string {
	result := []string{}
	for _, value := range values {
		if sanitized := SanitizeText(value); sanitized != "" {
			result = append(result, sanitized)
		}
	}
	return uniqueStrings(result)
}

func oneOf(value string, allowed []string, fallback string) string {
	trimmed := strings.TrimSpace(value)
	for _, option := range allowed {
		if trimmed == option {
			return trimmed
		}
	}
	return fallback
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

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}
