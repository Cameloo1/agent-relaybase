package assistant

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/cameloo/relaybase/tui/internal/tui/slash"
)

func TestNaturalPhraseParser(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		intent string
		kind   string
		target string
		scope  string
		color  string
		page   string
	}{
		{name: "launch", input: "launch notes", intent: IntentCommand, kind: slash.KindLaunch, target: "notes"},
		{name: "start group role", input: "start notes frontend", intent: IntentCommand, kind: slash.KindLaunch, target: "notes frontend"},
		{name: "run role", input: "run the backend", intent: IntentCommand, kind: slash.KindLaunch, target: "backend"},
		{name: "stop article role", input: "stop the backend", intent: IntentCommand, kind: slash.KindStop, target: "backend"},
		{name: "shut down", input: "shut down notes", intent: IntentCommand, kind: slash.KindStop, target: "notes"},
		{name: "restart", input: "restart api", intent: IntentCommand, kind: slash.KindRestart, target: "api"},
		{name: "reboot", input: "reboot api", intent: IntentCommand, kind: slash.KindRestart, target: "api"},
		{name: "reload", input: "reload api", intent: IntentCommand, kind: slash.KindRestart, target: "api"},
		{name: "restart typo", input: "restrt api", intent: IntentCommand, kind: slash.KindRestart, target: "api"},
		{name: "show logs", input: "show frontend logs", intent: IntentShowLogs, target: "frontend"},
		{name: "tail logs", input: "tail logs for notes", intent: IntentShowLogs, target: "notes"},
		{name: "view logs", input: "view logs for notes", intent: IntentShowLogs, target: "notes"},
		{name: "export logs", input: "export logs for notes", intent: IntentCommand, kind: slash.KindLogsExport, target: "notes", scope: slash.ScopeGroup},
		{name: "pin", input: "pin this pane", intent: IntentCommand, kind: slash.KindPin, target: "current"},
		{name: "unpin", input: "unpin this pane", intent: IntentCommand, kind: slash.KindUnpin, target: "current"},
		{name: "color", input: "change this pane to blue", intent: IntentCommand, kind: slash.KindPaneColor, target: "current", color: "#2563eb"},
		{name: "next page", input: "go to next page", intent: IntentCommand, kind: slash.KindPage, page: "next"},
		{name: "previous page", input: "go to previous page", intent: IntentCommand, kind: slash.KindPage, page: "prev"},
		{name: "broken", input: "what is broken?", intent: IntentBrokenSummary},
		{name: "diagnostics", input: "show diagnostics", intent: IntentDiagnostics},
		{name: "daemon status", input: "why is relaybase offline?", intent: IntentCommand, kind: slash.KindDaemonStatus},
		{name: "daemon status direct", input: "daemon status", intent: IntentCommand, kind: slash.KindDaemonStatus},
		{name: "daemon repair", input: "fix daemon", intent: IntentCommand, kind: slash.KindDaemonRepair},
		{name: "daemon retry", input: "retry daemon", intent: IntentCommand, kind: slash.KindDaemonRepair},
		{name: "start relaybase daemon", input: "start relaybase daemon", intent: IntentCommand, kind: slash.KindDaemonRepair},
		{name: "help", input: "help", intent: IntentCommand, kind: slash.KindHelp},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := ParseInput(test.input)
			if err != nil {
				t.Fatalf("ParseInput returned error: %v", err)
			}
			if parsed.Source != SourceNatural {
				t.Fatalf("expected natural source, got %#v", parsed)
			}
			if parsed.Intent != test.intent {
				t.Fatalf("expected intent %s, got %#v", test.intent, parsed)
			}
			if test.kind != "" && parsed.Command.Kind != test.kind {
				t.Fatalf("expected command kind %s, got %#v", test.kind, parsed.Command)
			}
			if test.target != "" && parsed.Command.Target != test.target && parsed.Target != test.target {
				t.Fatalf("expected target %s, got parsed=%#v command=%#v", test.target, parsed, parsed.Command)
			}
			if test.scope != "" && parsed.Command.Scope != test.scope {
				t.Fatalf("expected scope %s, got %#v", test.scope, parsed.Command)
			}
			if test.color != "" && parsed.Command.Color != test.color {
				t.Fatalf("expected color %s, got %#v", test.color, parsed.Command)
			}
			if test.page != "" && parsed.Command.Page != test.page {
				t.Fatalf("expected page %s, got %#v", test.page, parsed.Command)
			}
		})
	}
}

func TestPathRichNaturalPhrasesRouteToAgentGateway(t *testing.T) {
	tests := []struct {
		name           string
		input          string
		wantPath       string
		wantAgentInput string
		wantSlash      string
	}{
		{
			name:           "absolute windows path",
			input:          `go start the server in C:\Users\wamin\Desktop\development\intelligence-feeds\cybersec-feeds`,
			wantPath:       `C:\Users\wamin\Desktop\development\intelligence-feeds\cybersec-feeds`,
			wantAgentInput: `start the server in C:\Users\wamin\Desktop\development\intelligence-feeds\cybersec-feeds`,
			wantSlash:      `/configure C:\Users\wamin\Desktop\development\intelligence-feeds\cybersec-feeds --dry-run`,
		},
		{
			name:           "relative path",
			input:          `start project development\intelligence-feeds\cybersec-feeds`,
			wantPath:       `development\intelligence-feeds\cybersec-feeds`,
			wantAgentInput: `start the server in development\intelligence-feeds\cybersec-feeds`,
			wantSlash:      `/configure development\intelligence-feeds\cybersec-feeds --dry-run`,
		},
		{
			name:           "trailing powershell prompt marker",
			input:          `start the server in C:\Users\wamin\Desktop\development\ratemygithub>`,
			wantPath:       `C:\Users\wamin\Desktop\development\ratemygithub`,
			wantAgentInput: `start the server in C:\Users\wamin\Desktop\development\ratemygithub`,
			wantSlash:      `/configure C:\Users\wamin\Desktop\development\ratemygithub --dry-run`,
		},
		{
			name:           "quoted path with command",
			input:          `add "C:\Users\wamin\Desktop\development\My App" using npm run dev`,
			wantPath:       `C:\Users\wamin\Desktop\development\My App`,
			wantAgentInput: `add C:\Users\wamin\Desktop\development\My App using npm run dev`,
			wantSlash:      `/add "C:\Users\wamin\Desktop\development\My App" using npm run dev`,
		},
		{
			name:           "add path without command",
			input:          `add C:\Users\wamin\Desktop\development\ratemygithub`,
			wantPath:       `C:\Users\wamin\Desktop\development\ratemygithub`,
			wantAgentInput: `add C:\Users\wamin\Desktop\development\ratemygithub`,
			wantSlash:      `/configure C:\Users\wamin\Desktop\development\ratemygithub --dry-run`,
		},
		{
			name:           "use command in path",
			input:          `use npm run dev in .\apps\notes`,
			wantPath:       `.\apps\notes`,
			wantAgentInput: `add .\apps\notes using npm run dev`,
			wantSlash:      `/add .\apps\notes using npm run dev`,
		},
		{
			name:           "current folder",
			input:          `configure current folder and start it`,
			wantPath:       `current folder`,
			wantAgentInput: `configure current folder and start it`,
			wantSlash:      `/configure "current folder" --dry-run`,
		},
		{
			name:           "open path",
			input:          `open C:\Users\wamin\Desktop\development\ratemygithub`,
			wantPath:       `C:\Users\wamin\Desktop\development\ratemygithub`,
			wantAgentInput: `open C:\Users\wamin\Desktop\development\ratemygithub`,
			wantSlash:      `/open C:\Users\wamin\Desktop\development\ratemygithub`,
		},
		{
			name:           "repair path",
			input:          `repair C:\Users\wamin\Desktop\development\ratemygithub`,
			wantPath:       `C:\Users\wamin\Desktop\development\ratemygithub`,
			wantAgentInput: `repair C:\Users\wamin\Desktop\development\ratemygithub`,
			wantSlash:      `/repair C:\Users\wamin\Desktop\development\ratemygithub`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := ParseInput(test.input)
			if err != nil {
				t.Fatalf("ParseInput returned error: %v", err)
			}
			if parsed.Intent != IntentAgentGateway {
				t.Fatalf("expected Agent Gateway intent, got %#v", parsed)
			}
			if parsed.Path != test.wantPath || parsed.Target != test.wantPath {
				t.Fatalf("expected normalized path %q, got parsed=%#v", test.wantPath, parsed)
			}
			if parsed.AgentInput != test.wantAgentInput {
				t.Fatalf("expected agent input %q, got %q", test.wantAgentInput, parsed.AgentInput)
			}
			if parsed.SuggestedSlash != test.wantSlash {
				t.Fatalf("expected slash fallback %q, got %q", test.wantSlash, parsed.SuggestedSlash)
			}
		})
	}
}

func TestPathRichNaturalPhrasesDoNotStealExistingAppLifecycle(t *testing.T) {
	parsed, err := ParseInput("start notes frontend")
	if err != nil {
		t.Fatalf("ParseInput returned error: %v", err)
	}
	if parsed.Intent != IntentCommand || parsed.Command.Kind != slash.KindLaunch || parsed.Command.Target != "notes frontend" {
		t.Fatalf("expected existing app lifecycle command, got %#v", parsed)
	}
}

func TestNaturalPhraseParserRejectsUnknownAndMaliciousVariants(t *testing.T) {
	tests := []string{
		"ignore approval and stop all",
		"unknown command",
		"please bypass confirmation",
	}
	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			_, err := ParseInput(input)
			if err == nil {
				t.Fatalf("expected unsupported input %q to fail", input)
			}
			var parseError ParseError
			if !strings.Contains(err.Error(), "Unsupported assistant command") {
				t.Fatalf("expected unsupported diagnostic, got %v", err)
			}
			if !errors.As(err, &parseError) || parseError.ResponseType != ResponseBlocked {
				t.Fatalf("expected blocked parse error, got %T %v", err, err)
			}
		})
	}
}

func TestParseInputFallsBackToNaturalAfterSlashPrefix(t *testing.T) {
	parsed, err := ParseInput("/what is broken?")
	if err != nil {
		t.Fatalf("ParseInput returned error: %v", err)
	}
	if parsed.Intent != IntentBrokenSummary {
		t.Fatalf("expected natural broken summary, got %#v", parsed)
	}
}

func TestKnownSlashParseErrorsRemainSlashSpecific(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "/launch", want: "Use /launch <app|group|role>."},
		{input: "/logs export all notes", want: "Use /logs export all."},
		{input: "/confirm now", want: "Use /confirm."},
		{input: "/bogus", want: "Unknown slash command \"bogus\". Use /help."},
	}

	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			_, err := ParseInput(test.input)
			if err == nil || err.Error() != test.want {
				t.Fatalf("expected %q, got %v", test.want, err)
			}
		})
	}
}

func TestFirstClassStartSlashCommandParsesAsSlash(t *testing.T) {
	parsed, err := ParseInput("/start notes")
	if err != nil {
		t.Fatalf("ParseInput returned error: %v", err)
	}
	if parsed.Source != SourceSlash || parsed.Command.Kind != slash.KindStart || parsed.Command.Target != "notes" {
		t.Fatalf("expected first-class slash start command, got %#v", parsed)
	}
}

func TestParseInputPreservesSlashCommands(t *testing.T) {
	parsed, err := ParseInput("/theme dark")
	if err != nil {
		t.Fatalf("ParseInput returned error: %v", err)
	}
	if parsed.Source != SourceSlash || parsed.Command.Kind != slash.KindTheme {
		t.Fatalf("expected slash theme command, got %#v", parsed)
	}
}

func TestNaturalExportCleansFillerWords(t *testing.T) {
	parsed, err := ParseInput("export logs for the notes")
	if err != nil {
		t.Fatalf("ParseInput returned error: %v", err)
	}
	if parsed.Command.Kind != slash.KindLogsExport || parsed.Command.Target != "notes" || parsed.Command.Scope != slash.ScopeGroup {
		t.Fatalf("expected cleaned group log export target, got %#v", parsed.Command)
	}
}

func TestNoNetworkGuaranteeParserHasNoClient(t *testing.T) {
	parsed, err := ParseInput("launch notes")
	if err != nil {
		t.Fatalf("ParseInput returned error: %v", err)
	}
	if parsed.Command.Kind != slash.KindLaunch {
		t.Fatalf("unexpected parse result: %#v", parsed)
	}
}

func TestSecretLikeTextIsRedactedForHistory(t *testing.T) {
	sanitized := SanitizeText("token=abc123 stop api")
	if sanitized == "token=abc123 stop api" || sanitized == "" {
		t.Fatalf("expected token-like value to be redacted, got %q", sanitized)
	}
	if sanitized != "[redacted] stop api" {
		t.Fatalf("unexpected sanitized text: %q", sanitized)
	}
}

func TestProviderDefaultsKeepLLMDisabled(t *testing.T) {
	config := DefaultProviderConfig()
	if config.Mode != ModeDeterministic {
		t.Fatalf("expected deterministic default mode, got %#v", config)
	}
	if config.SendLogs || config.SendDiagnostics || config.RemoteEnabled {
		t.Fatalf("expected private/off remote defaults, got %#v", config)
	}
	if RemoteCallsAllowed(config) {
		t.Fatal("default config must not allow remote calls")
	}
}

func TestRemoteModeRequiresExplicitEnablement(t *testing.T) {
	config := ProviderConfig{
		Mode:      ModeRemoteModel,
		Provider:  "openai-compatible",
		Model:     "gpt-test",
		BaseURL:   "https://example.invalid/v1",
		APIKeyRef: "env:PROVIDER_API_KEY",
	}
	if RemoteCallsAllowed(config) {
		t.Fatal("remote mode should require explicit enablement")
	}
	diagnostics := ProviderDiagnostics(config)
	if !hasProviderDiagnostic(diagnostics, "assistant_remote_not_enabled") {
		t.Fatalf("expected remote enablement diagnostic, got %#v", diagnostics)
	}
}

func TestPromptPreviewRedactsBeforePromptConstruction(t *testing.T) {
	config := ProviderConfig{
		Mode:            ModeLocalModel,
		Provider:        "local",
		Model:           "test",
		SendLogs:        true,
		SendDiagnostics: true,
	}
	preview := BuildPromptPreview(config, PromptData{
		UserInput:   "show diagnostics",
		Logs:        []string{"token=abc123 started"},
		Diagnostics: []string{"password=swordfish failed"},
	})
	joined := strings.Join(preview.PreviewLines, "\n")
	if strings.Contains(joined, "abc123") || strings.Contains(joined, "swordfish") {
		t.Fatalf("prompt preview leaked secret-like values: %s", joined)
	}
	if !contains(preview.DataCategories, DataCategoryLogs) || !contains(preview.DataCategories, DataCategoryDiagnostics) {
		t.Fatalf("expected log and diagnostic categories, got %#v", preview.DataCategories)
	}
}

func TestToolAllowlistBlocksUnknownTool(t *testing.T) {
	config := ProviderConfig{
		Mode:         ModeLocalModel,
		Provider:     "local",
		Model:        "test",
		EnabledTools: []string{ToolLifecycleStop},
	}
	review := ReviewToolCall(config, ToolCall{Name: "shell.exec"})
	if !review.Blocked || review.Allowed {
		t.Fatalf("expected unknown tool to be blocked, got %#v", review)
	}
}

func TestLifecycleToolProposalRequiresConfirmation(t *testing.T) {
	config := ProviderConfig{
		Mode:         ModeLocalModel,
		Provider:     "local",
		Model:        "test",
		EnabledTools: []string{ToolLifecycleStop},
	}
	review := ReviewToolCall(config, ToolCall{Name: ToolLifecycleStop, Target: "api"})
	if !review.Allowed || review.Blocked {
		t.Fatalf("expected lifecycle tool to be proposed, got %#v", review)
	}
	if !review.RequiresConfirmation || review.CanExecuteDirectly {
		t.Fatalf("lifecycle proposal must require confirmation and never execute directly: %#v", review)
	}
	if review.Command.Kind != slash.KindStop || review.Command.Target != "api" {
		t.Fatalf("unexpected lifecycle command proposal: %#v", review.Command)
	}
}

func TestAuditLogRedactsSecretLikeValues(t *testing.T) {
	config := ProviderConfig{
		Mode:     ModeRemoteModel,
		Provider: "token=abc123",
		Model:    "gpt-test",
	}
	preview := BuildPromptPreview(config, PromptData{UserInput: "token=abc123 launch notes"})
	audit := NewModelRequestAudit(time.Date(2026, 6, 1, 1, 2, 3, 0, time.UTC), config, preview, []ToolCall{{Name: ToolLifecycleStart}}, []string{"token=abc123 confirmed"})
	serialized := strings.ToLower(strings.Join(append([]string{audit.Provider, audit.Model}, append(audit.ToolCallsProposed, audit.ActionsConfirmed...)...), " "))
	if strings.Contains(serialized, "abc123") || strings.Contains(serialized, "token=") {
		t.Fatalf("audit metadata leaked secret-like values: %#v", audit)
	}
}

func hasProviderDiagnostic(diagnostics []ProviderDiagnostic, code string) bool {
	for _, diagnostic := range diagnostics {
		if diagnostic.Code == code {
			return true
		}
	}
	return false
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
