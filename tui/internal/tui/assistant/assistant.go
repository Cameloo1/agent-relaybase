package assistant

import (
	"regexp"
	"strings"
	"time"

	"github.com/cameloo/relaybase/tui/internal/tui/slash"
)

const (
	ResponseAnswer              = "answer"
	ResponseActionPreview       = "action_preview"
	ResponseActionResult        = "action_result"
	ResponseDiagnostic          = "diagnostic"
	ResponseClarificationNeeded = "clarification_needed"
	ResponseBlocked             = "blocked"

	IntentCommand       = "command"
	IntentShowLogs      = "show_logs"
	IntentBrokenSummary = "broken_summary"
	IntentDiagnostics   = "diagnostics"
	IntentAgentGateway  = "agent_gateway"

	SourceSlash   = "slash"
	SourceNatural = "natural"
)

var (
	secretLikePattern           = regexp.MustCompile(`(?i)(token|password|passwd|secret|api[_-]?key|authorization|bearer|relaybase_token|session-token)(\s*[:=]\s*)?\S*`)
	windowsAbsolutePathPattern  = regexp.MustCompile(`^[A-Za-z]:[\\/]`)
	powerShellPromptPathPattern = regexp.MustCompile(`(?i)\bPS\s+([A-Za-z]:[^>\r\n]+)>`)
)

type ParsedInput struct {
	Raw            string
	Normalized     string
	Source         string
	Intent         string
	Command        slash.ParsedCommand
	Target         string
	Path           string
	AgentInput     string
	SuggestedSlash string
	ResponseType   string
}

type ParseError struct {
	ResponseType string
	Message      string
}

func (e ParseError) Error() string {
	return e.Message
}

type HistoryEntry struct {
	At      time.Time
	Type    string
	Input   string
	Message string
}

func PromptPlaceholder() string {
	return "> _"
}

func ParseInput(input string) (ParsedInput, error) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return ParsedInput{}, ParseError{ResponseType: ResponseBlocked, Message: "Enter an assistant command."}
	}

	if strings.HasPrefix(raw, "/") {
		command, err := slash.Parse(raw)
		if err == nil {
			return ParsedInput{
				Raw:          raw,
				Normalized:   normalize(strings.TrimPrefix(raw, "/")),
				Source:       SourceSlash,
				Intent:       IntentCommand,
				Command:      command,
				ResponseType: responseTypeForCommand(command),
			}, nil
		}
		if isKnownSlashCommand(raw) || !canParseSlashPrefixedNatural(raw) {
			return ParsedInput{}, err
		}
		raw = strings.TrimSpace(strings.TrimPrefix(raw, "/"))
	}

	normalized := normalize(raw)
	if normalized == "" {
		return ParsedInput{}, ParseError{ResponseType: ResponseBlocked, Message: "Enter an assistant command."}
	}

	if normalized == "what is broken" || normalized == "what is broken?" {
		return ParsedInput{Raw: input, Normalized: normalized, Source: SourceNatural, Intent: IntentBrokenSummary, ResponseType: ResponseAnswer}, nil
	}
	if normalized == "show diagnostics" || normalized == "diagnostics" {
		return ParsedInput{Raw: input, Normalized: normalized, Source: SourceNatural, Intent: IntentDiagnostics, ResponseType: ResponseDiagnostic}, nil
	}
	if normalized == "help" || normalized == "show help" || normalized == "command help" {
		return naturalCommand(input, normalized, slash.ParsedCommand{Kind: slash.KindHelp}, ResponseActionResult), nil
	}
	if normalized == "daemon status" || normalized == "relaybase status" || normalized == "why is relaybase offline" || normalized == "why is relaybase offline?" {
		return naturalCommand(input, normalized, slash.ParsedCommand{Kind: slash.KindDaemonStatus}, ResponseDiagnostic), nil
	}
	if normalized == "fix daemon" || normalized == "repair daemon" || normalized == "retry daemon" ||
		normalized == "start relaybase" || normalized == "start relaybase daemon" || normalized == "fix relaybase" ||
		normalized == "retry connection" {
		return naturalCommand(input, normalized, slash.ParsedCommand{Kind: slash.KindDaemonRepair}, ResponseActionPreview), nil
	}
	if normalized == "go to next page" || normalized == "next page" {
		return naturalCommand(input, normalized, slash.ParsedCommand{Kind: slash.KindPage, Page: "next"}, ResponseActionResult), nil
	}
	if normalized == "go to previous page" || normalized == "go to prev page" || normalized == "previous page" || normalized == "prev page" {
		return naturalCommand(input, normalized, slash.ParsedCommand{Kind: slash.KindPage, Page: "prev"}, ResponseActionResult), nil
	}
	if normalized == "pin this pane" || normalized == "pin current pane" {
		return naturalCommand(input, normalized, slash.ParsedCommand{Kind: slash.KindPin, Target: "current"}, ResponseActionResult), nil
	}
	if normalized == "unpin this pane" || normalized == "unpin current pane" {
		return naturalCommand(input, normalized, slash.ParsedCommand{Kind: slash.KindUnpin, Target: "current"}, ResponseActionResult), nil
	}
	if strings.HasPrefix(normalized, "change ") && strings.Contains(normalized, " to ") {
		target, color, ok := parseColorChange(normalized)
		if ok {
			return naturalCommand(input, normalized, slash.ParsedCommand{
				Kind:   slash.KindPaneColor,
				Target: target,
				Color:  color,
			}, ResponseActionResult), nil
		}
	}
	if parsed, ok := parseFolderAgentInput(input); ok {
		return parsed, nil
	}
	if target, ok := parseLogsPhrase(normalized); ok {
		return ParsedInput{
			Raw:          input,
			Normalized:   normalized,
			Source:       SourceNatural,
			Intent:       IntentShowLogs,
			Target:       targetOrCurrent(target),
			ResponseType: ResponseActionResult,
		}, nil
	}
	if strings.HasPrefix(normalized, "export logs for ") {
		target := cleanTarget(strings.TrimSpace(strings.TrimPrefix(normalized, "export logs for ")))
		scope := slash.ScopeGroup
		if isCurrentPane(target) {
			scope = slash.ScopePane
			target = "current"
		}
		if target == "all" {
			scope = slash.ScopeAll
			target = ""
		}
		return naturalCommand(input, normalized, slash.ParsedCommand{
			Kind:   slash.KindLogsExport,
			Scope:  scope,
			Target: target,
		}, ResponseActionPreview), nil
	}

	fields := strings.Fields(normalized)
	if len(fields) >= 2 {
		switch fields[0] {
		case "launch":
			return lifecycleCommand(input, normalized, slash.KindLaunch, strings.Join(fields[1:], " ")), nil
		case "start":
			return lifecycleCommand(input, normalized, slash.KindLaunch, strings.Join(fields[1:], " ")), nil
		case "run":
			return lifecycleCommand(input, normalized, slash.KindLaunch, strings.Join(fields[1:], " ")), nil
		case "stop":
			return lifecycleCommand(input, normalized, slash.KindStop, cleanTarget(strings.Join(fields[1:], " "))), nil
		case "restart":
			return lifecycleCommand(input, normalized, slash.KindRestart, strings.Join(fields[1:], " ")), nil
		case "reboot", "reload", "restrt":
			return lifecycleCommand(input, normalized, slash.KindRestart, strings.Join(fields[1:], " ")), nil
		}
	}
	if strings.HasPrefix(normalized, "shut down ") {
		return lifecycleCommand(input, normalized, slash.KindStop, strings.TrimPrefix(normalized, "shut down ")), nil
	}

	return ParsedInput{}, ParseError{
		ResponseType: ResponseBlocked,
		Message:      "Unsupported assistant command. Try /help or a phrase like launch notes, stop the backend, export logs for notes, or what is broken?",
	}
}

func isKnownSlashCommand(raw string) bool {
	return slash.IsKnownPrefix(raw)
}

func canParseSlashPrefixedNatural(raw string) bool {
	normalized := normalize(strings.TrimPrefix(raw, "/"))
	if normalized == "what is broken" || normalized == "what is broken?" ||
		normalized == "show diagnostics" || normalized == "diagnostics" ||
		normalized == "help" || normalized == "show help" || normalized == "command help" {
		return true
	}
	if normalized == "daemon status" || normalized == "relaybase status" || normalized == "why is relaybase offline" ||
		normalized == "why is relaybase offline?" || normalized == "fix daemon" || normalized == "repair daemon" ||
		normalized == "retry daemon" || normalized == "start relaybase" || normalized == "start relaybase daemon" ||
		normalized == "fix relaybase" || normalized == "retry connection" {
		return true
	}
	if normalized == "go to next page" || normalized == "next page" ||
		normalized == "go to previous page" || normalized == "go to prev page" ||
		normalized == "previous page" || normalized == "prev page" ||
		normalized == "pin this pane" || normalized == "pin current pane" ||
		normalized == "unpin this pane" || normalized == "unpin current pane" {
		return true
	}
	if strings.HasPrefix(normalized, "change ") ||
		parseableLogsPhrase(normalized) ||
		strings.HasPrefix(normalized, "export logs for ") {
		return true
	}
	if _, ok := parseFolderAgentInput(strings.TrimPrefix(raw, "/")); ok {
		return true
	}
	fields := strings.Fields(normalized)
	if len(fields) < 2 {
		return false
	}
	switch fields[0] {
	case "launch", "start", "run", "stop", "restart", "reboot", "reload", "restrt":
		return true
	default:
		return strings.HasPrefix(normalized, "shut down ")
	}
}

func SanitizeText(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	return secretLikePattern.ReplaceAllString(trimmed, "[redacted]")
}

func naturalCommand(input string, normalized string, command slash.ParsedCommand, responseType string) ParsedInput {
	return ParsedInput{
		Raw:          input,
		Normalized:   normalized,
		Source:       SourceNatural,
		Intent:       IntentCommand,
		Command:      command,
		ResponseType: responseType,
	}
}

func lifecycleCommand(input string, normalized string, kind string, target string) ParsedInput {
	return naturalCommand(input, normalized, slash.ParsedCommand{
		Kind:   kind,
		Target: targetOrCurrent(target),
	}, ResponseActionPreview)
}

func parseFolderAgentInput(input string) (ParsedInput, bool) {
	raw := strings.TrimSpace(input)
	normalized := normalize(raw)
	if normalized == "" {
		return ParsedInput{}, false
	}

	type folderIntent struct {
		kind    string
		path    string
		command string
	}
	intent := folderIntent{}

	if after, ok := cutNormalizedPrefix(raw, normalized, "go start the server in "); ok {
		intent = folderIntent{kind: "start", path: after}
	} else if after, ok := cutNormalizedPrefix(raw, normalized, "start the server in "); ok {
		intent = folderIntent{kind: "start", path: after}
	} else if after, ok := cutNormalizedPrefix(raw, normalized, "start project "); ok {
		intent = folderIntent{kind: "start", path: after}
	} else if after, ok := cutNormalizedPrefix(raw, normalized, "start "); ok && isCurrentFolderPhrase(normalize(after)) {
		intent = folderIntent{kind: "start", path: after}
	} else if after, ok := cutNormalizedPrefix(raw, normalized, "configure "); ok {
		path := after
		if before, _, ok := cutCaseInsensitive(path, " and start it"); ok {
			path = before
		}
		if pathLooksLikeFolderTarget(path) || isCurrentFolderPhrase(normalize(path)) {
			intent = folderIntent{kind: "configure", path: path}
		}
	} else if after, ok := cutNormalizedPrefix(raw, normalized, "add "); ok {
		if path, command, ok := cutCaseInsensitive(after, " using "); ok {
			intent = folderIntent{kind: "add", path: path, command: command}
		} else if pathLooksLikeFolderTarget(after) || isCurrentFolderPhrase(normalize(after)) {
			intent = folderIntent{kind: "add", path: after}
		}
	} else if after, ok := cutNormalizedPrefix(raw, normalized, "use "); ok {
		if command, path, ok := cutCaseInsensitive(after, " in "); ok {
			intent = folderIntent{kind: "add", path: path, command: command}
		}
	} else if after, ok := cutNormalizedPrefix(raw, normalized, "open "); ok {
		if pathLooksLikeFolderTarget(after) || isCurrentFolderPhrase(normalize(after)) {
			intent = folderIntent{kind: "open", path: after}
		}
	} else if after, ok := cutNormalizedPrefix(raw, normalized, "repair "); ok {
		if pathLooksLikeFolderTarget(after) || isCurrentFolderPhrase(normalize(after)) {
			intent = folderIntent{kind: "repair", path: after}
		}
	}

	if intent.kind == "" {
		return ParsedInput{}, false
	}
	path := cleanFolderPath(intent.path)
	if path == "" {
		return ParsedInput{}, false
	}
	command := cleanFolderCommand(intent.command)
	agentInput := folderAgentInput(intent.kind, path, command)
	return ParsedInput{
		Raw:            input,
		Normalized:     normalize(agentInput),
		Source:         SourceNatural,
		Intent:         IntentAgentGateway,
		Target:         path,
		Path:           path,
		AgentInput:     agentInput,
		SuggestedSlash: folderSlashFallback(intent.kind, path, command),
		ResponseType:   ResponseActionPreview,
	}, true
}

func cutNormalizedPrefix(raw string, normalized string, prefix string) (string, bool) {
	if !strings.HasPrefix(normalized, prefix) {
		return "", false
	}
	words := len(strings.Fields(prefix))
	parts := strings.Fields(raw)
	if len(parts) < words {
		return "", false
	}
	return strings.TrimSpace(strings.Join(parts[words:], " ")), true
}

func cutCaseInsensitive(value string, separator string) (string, string, bool) {
	lower := strings.ToLower(value)
	index := strings.Index(lower, strings.ToLower(separator))
	if index < 0 {
		return "", "", false
	}
	return strings.TrimSpace(value[:index]), strings.TrimSpace(value[index+len(separator):]), true
}

func pathLooksLikeFolderTarget(value string) bool {
	cleaned := cleanFolderPath(value)
	if cleaned == "" {
		return false
	}
	normalized := normalize(cleaned)
	if isCurrentFolderPhrase(normalized) {
		return true
	}
	if windowsAbsolutePathPattern.MatchString(cleaned) {
		return true
	}
	if strings.HasPrefix(cleaned, `\\`) || strings.HasPrefix(cleaned, `//`) {
		return true
	}
	if strings.HasPrefix(cleaned, `.\`) || strings.HasPrefix(cleaned, `./`) ||
		strings.HasPrefix(cleaned, `..\`) || strings.HasPrefix(cleaned, `../`) {
		return true
	}
	return strings.Contains(cleaned, `\`) || strings.Contains(cleaned, `/`)
}

func isCurrentFolderPhrase(value string) bool {
	switch strings.TrimSpace(value) {
	case "cwd", "current folder", "current directory", "this folder", "this directory":
		return true
	default:
		return false
	}
}

func cleanFolderPath(value string) string {
	cleaned := strings.TrimSpace(value)
	if cleaned == "" {
		return ""
	}
	if match := powerShellPromptPathPattern.FindStringSubmatch(cleaned); len(match) == 2 {
		cleaned = match[1]
	}
	cleaned = trimPathQuotes(cleaned)
	cleaned = strings.TrimRight(cleaned, " \t\r\n>.,;!?")
	cleaned = trimPathQuotes(cleaned)
	switch normalize(cleaned) {
	case "cwd":
		return "current folder"
	case "this folder", "this directory", "current directory":
		return "current folder"
	default:
		return cleaned
	}
}

func trimPathQuotes(value string) string {
	cleaned := strings.TrimSpace(value)
	for len(cleaned) >= 2 {
		first := cleaned[0]
		last := cleaned[len(cleaned)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') || (first == '`' && last == '`') {
			cleaned = strings.TrimSpace(cleaned[1 : len(cleaned)-1])
			continue
		}
		break
	}
	return cleaned
}

func cleanFolderCommand(value string) string {
	cleaned := strings.TrimSpace(value)
	cleaned = trimPathQuotes(cleaned)
	cleaned = strings.TrimRight(cleaned, " \t\r\n>.,;!?")
	return trimPathQuotes(cleaned)
}

func folderAgentInput(kind string, path string, command string) string {
	switch kind {
	case "add":
		if command != "" {
			return "add " + path + " using " + command
		}
		return "add " + path
	case "open":
		return "open " + path
	case "repair":
		return "repair " + path
	case "configure":
		return "configure " + path + " and start it"
	default:
		return "start the server in " + path
	}
}

func folderSlashFallback(kind string, path string, command string) string {
	pathArg := quoteSlashArg(path)
	switch kind {
	case "add":
		if command != "" {
			return "/add " + pathArg + " using " + command
		}
		return "/configure " + pathArg + " --dry-run"
	case "open":
		return "/open " + pathArg
	case "repair":
		return "/repair " + pathArg
	default:
		return "/configure " + pathArg + " --dry-run"
	}
}

func quoteSlashArg(value string) string {
	if !strings.ContainsAny(value, " \t") {
		return value
	}
	return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
}

func responseTypeForCommand(command slash.ParsedCommand) string {
	if slash.RequiresConfirmation(command) && !command.Confirm {
		return ResponseActionPreview
	}
	return ResponseActionResult
}

func parseColorChange(normalized string) (string, string, bool) {
	before, after, ok := strings.Cut(strings.TrimPrefix(normalized, "change "), " to ")
	if !ok {
		return "", "", false
	}
	target := targetOrCurrent(cleanTarget(before))
	color := colorValue(after)
	if color == "" {
		return "", "", false
	}
	return target, color, true
}

func parseLogsPhrase(normalized string) (string, bool) {
	for _, verb := range []string{"show", "tail", "view"} {
		prefix := verb + " "
		if !strings.HasPrefix(normalized, prefix) {
			continue
		}
		remainder := strings.TrimSpace(strings.TrimPrefix(normalized, prefix))
		if remainder == "logs" {
			return "current", true
		}
		if strings.HasPrefix(remainder, "logs for ") {
			return cleanTarget(strings.TrimSpace(strings.TrimPrefix(remainder, "logs for "))), true
		}
		if strings.HasSuffix(remainder, " logs") {
			return cleanTarget(strings.TrimSpace(strings.TrimSuffix(remainder, " logs"))), true
		}
	}
	return "", false
}

func parseableLogsPhrase(normalized string) bool {
	_, ok := parseLogsPhrase(normalized)
	return ok
}

func targetOrCurrent(target string) string {
	cleaned := cleanTarget(target)
	if cleaned == "" || isCurrentPane(cleaned) {
		return "current"
	}
	return cleaned
}

func cleanTarget(target string) string {
	cleaned := strings.TrimSpace(target)
	for _, prefix := range []string{"the ", "this ", "current "} {
		if strings.HasPrefix(cleaned, prefix) {
			cleaned = strings.TrimSpace(strings.TrimPrefix(cleaned, prefix))
		}
	}
	return cleaned
}

func isCurrentPane(target string) bool {
	switch strings.TrimSpace(target) {
	case "pane", "this pane", "current pane", "selected pane", "current", "selected":
		return true
	default:
		return false
	}
}

func colorValue(value string) string {
	switch strings.TrimSpace(value) {
	case "blue":
		return "#2563eb"
	case "green":
		return "#216869"
	case "amber", "yellow":
		return "#8a5a00"
	case "red":
		return "#9b1c31"
	case "brown":
		return "#6d4c3d"
	case "default":
		return "default"
	default:
		if strings.HasPrefix(value, "#") {
			return value
		}
		return ""
	}
}

func normalize(input string) string {
	lower := strings.ToLower(strings.TrimSpace(input))
	lower = strings.TrimSuffix(lower, "?")
	lower = strings.TrimSuffix(lower, ".")
	lower = strings.TrimSuffix(lower, "!")
	return strings.Join(strings.Fields(lower), " ")
}
