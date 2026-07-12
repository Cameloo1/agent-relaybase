package panes

import (
	"regexp"
	"strings"
	"unicode"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

const CopyLogLineLimit = 20

type LogTone string

const (
	LogToneNeutral LogTone = "neutral"
	LogToneSuccess LogTone = "success"
	LogToneError   LogTone = "error"
	LogToneWarning LogTone = "warning"
	LogToneMuted   LogTone = "muted"
	LogToneStart   LogTone = "start"
	LogToneStop    LogTone = "stop"
)

type PaneLogLine struct {
	Sequence      int64
	Timestamp     string
	At            string
	AppID         string
	GroupID       string
	ComponentRole string
	Text          string
	Tone          LogTone
	Stream        string
	Source        string
	Level         string
	Redacted      bool
}

var logANSIEscapePattern = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

func ProjectLogEvent(event relaybaseclient.LogEvent) (PaneLogLine, bool) {
	text := SanitizeLogDisplayLine(event)
	if text == "" {
		return PaneLogLine{}, false
	}
	return PaneLogLine{
		Sequence:      event.Sequence,
		Timestamp:     event.Timestamp,
		At:            event.At,
		AppID:         event.AppID,
		GroupID:       event.GroupID,
		ComponentRole: event.ComponentRole,
		Text:          text,
		Tone:          ClassifyLogTone(event),
		Stream:        strings.TrimSpace(event.Stream),
		Source:        strings.TrimSpace(event.Source),
		Level:         strings.TrimSpace(event.Level),
		Redacted:      event.Redacted,
	}, true
}

func ClassifyLogTone(event relaybaseclient.LogEvent) LogTone {
	source := strings.ToLower(strings.TrimSpace(event.Source))
	switch source {
	case "app.lifecycle_operation_completed", "lifecycle_operation_completed":
		return LogToneSuccess
	case "app.lifecycle_operation_failed", "lifecycle_operation_failed":
		return LogToneError
	case "lifecycle_start_command", "start_command":
		return LogToneStart
	case "lifecycle_stop_command", "stop_command":
		return LogToneStop
	}

	level := strings.ToLower(strings.TrimSpace(event.Level))
	switch level {
	case "success", "succeeded":
		return LogToneSuccess
	case "error", "fatal", "panic":
		return LogToneError
	case "warn", "warning":
		return LogToneWarning
	case "debug", "trace":
		return LogToneMuted
	}
	if strings.EqualFold(strings.TrimSpace(event.Stream), "stderr") {
		return LogToneWarning
	}
	return LogToneNeutral
}

func SanitizeLogDisplayLine(event relaybaseclient.LogEvent) string {
	message := event.Message
	if message == "" {
		message = event.Line
	}
	message = sanitizeLogText(message)
	if message == "" {
		return ""
	}
	stream := sanitizeLogText(event.Stream)
	if stream == "" {
		return message
	}
	return "[" + stream + "] " + message
}

func sanitizeLogText(value string) string {
	value = logANSIEscapePattern.ReplaceAllString(value, "")
	value = strings.Map(func(char rune) rune {
		if char == '\r' || char == '\n' || char == '\t' || unicode.IsControl(char) {
			return ' '
		}
		return char
	}, value)
	return strings.TrimSpace(value)
}

func projectLogEvents(events []relaybaseclient.LogEvent) []PaneLogLine {
	lines := make([]PaneLogLine, 0, len(events))
	for _, event := range events {
		if line, ok := ProjectLogEvent(event); ok {
			lines = append(lines, line)
		}
	}
	return lines
}

func paneLogLineTexts(lines []PaneLogLine) []string {
	result := make([]string, 0, len(lines))
	for _, line := range lines {
		result = append(result, line.Text)
	}
	return result
}
