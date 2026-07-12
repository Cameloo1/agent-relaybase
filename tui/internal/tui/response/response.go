// Package response owns the safe, inert Agent response presentation boundary.
package response

import (
	"net/url"
	"regexp"
	"strings"

	"charm.land/bubbles/v2/viewport"
	"github.com/charmbracelet/glamour"
)

type RunState string

const (
	StateIdle            RunState = "idle"
	StateQueued          RunState = "queued"
	StateThinking        RunState = "thinking"
	StateWorking         RunState = "working"
	StateWaitingApproval RunState = "waiting_approval"
	StateCompleted       RunState = "completed"
	StateFailed          RunState = "failed"
	StateInterrupted     RunState = "interrupted"
	StateDisconnected    RunState = "stream_disconnected"
)

func (s RunState) Active() bool { return s == StateQueued || s == StateThinking || s == StateWorking }

type Rendered struct {
	Source   string
	Text     string
	Fallback bool
}

// SafeMarkdownRenderer is the only package-level route to Glamour. Input is
// scrubbed before rendering and output is scrubbed again, so markup cannot
// introduce OSC links, clipboard escapes, cursor controls, or terminal actions.
type SafeMarkdownRenderer struct{}

func (SafeMarkdownRenderer) Render(source string, width int) Rendered {
	source = SanitizeMarkdown(source)
	if width < 20 {
		width = 20
	}
	renderer, err := glamour.NewTermRenderer(glamour.WithStandardStyle("notty"), glamour.WithWordWrap(width), glamour.WithPreservedNewLines())
	if err != nil {
		return Rendered{Source: source, Text: stripTerminalControls(source), Fallback: true}
	}
	text, err := renderer.Render(source)
	if err != nil {
		return Rendered{Source: source, Text: stripTerminalControls(source), Fallback: true}
	}
	return Rendered{Source: source, Text: stripTerminalControls(strings.TrimSpace(text))}
}

var markdownLink = regexp.MustCompile(`(?s)\[([^\]]*)\]\(([^)]*)\)`)
var rawHTML = regexp.MustCompile(`(?s)<[^>]+>`)
var bareURL = regexp.MustCompile(`(?i)\b(?:https?|mailto):[^\s<>()]+`)
var sensitiveQueryKey = regexp.MustCompile(`(?i)(?:^|[_-])(token|secret|password|passwd|api[_-]?key|authorization|auth|signature|session|credential|access[_-]?key)(?:$|[_-])`)

// SanitizeMarkdown keeps human-readable markdown but makes every link inert.
func SanitizeMarkdown(value string) string {
	value = stripTerminalControls(value)
	value = rawHTML.ReplaceAllString(value, "")
	linkTokens := []string{}
	value = markdownLink.ReplaceAllStringFunc(value, func(match string) string {
		parts := markdownLink.FindStringSubmatch(match)
		label := "link"
		if len(parts) > 1 && strings.TrimSpace(parts[1]) != "" {
			label = strings.TrimSpace(parts[1])
		}
		destination := "unavailable"
		if len(parts) > 2 {
			if sanitized, ok := sanitizeDisplayURL(strings.TrimSpace(parts[2])); ok {
				destination = sanitized
			}
		}
		token := "RELAYBASEINERTLINK" + string(rune('A'+len(linkTokens))) + "TOKEN"
		linkTokens = append(linkTokens, label+" [URL: "+destination+"]")
		return token
	})
	value = bareURL.ReplaceAllStringFunc(value, func(raw string) string {
		if sanitized, ok := sanitizeDisplayURL(raw); ok {
			return "[URL: " + sanitized + "]"
		}
		return "[URL: unavailable]"
	})
	for index, rendered := range linkTokens {
		token := "RELAYBASEINERTLINK" + string(rune('A'+index)) + "TOKEN"
		value = strings.ReplaceAll(value, token, rendered)
	}
	return value
}

func sanitizeDisplayURL(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" && parsed.Scheme != "mailto" {
		return "", false
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		if parsed.Host == "" {
			return "", false
		}
		parsed.User = nil
	} else if strings.TrimSpace(parsed.Opaque) == "" && strings.TrimSpace(parsed.Path) == "" {
		return "", false
	}
	parsed.Fragment = ""
	query := parsed.Query()
	for key := range query {
		if sensitiveQueryKey.MatchString(strings.ToLower(key)) {
			query.Set(key, "[redacted]")
		}
	}
	parsed.RawQuery = query.Encode()
	display := parsed.String()
	display = strings.ReplaceAll(display, "%5Bredacted%5D", "[redacted]")
	display = strings.ReplaceAll(display, "%5Bredacted%5d", "[redacted]")
	return display, display != ""
}

// CodeBlocks extracts fenced code from the same sanitized Markdown source the
// renderer receives. It never reads ANSI output and never treats code as an
// executable action.
func CodeBlocks(source string) []string {
	lines := strings.Split(SanitizeMarkdown(source), "\n")
	blocks := []string{}
	var current []string
	inBlock := false
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			if inBlock {
				blocks = append(blocks, strings.Join(current, "\n"))
				current = nil
				inBlock = false
			} else {
				inBlock = true
			}
			continue
		}
		if inBlock {
			current = append(current, line)
		}
	}
	return blocks
}

// stripTerminalControls removes all C0 controls except LF and strips CSI/OSC
// and related escape strings. It deliberately emits no ANSI styling.
func stripTerminalControls(value string) string {
	runes := []rune(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"))
	var out strings.Builder
	for index := 0; index < len(runes); index++ {
		r := runes[index]
		if r == 0x1b {
			index = skipEscape(runes, index)
			continue
		}
		// C1 controls (including ST) are terminal control bytes too. They are
		// not printable response content and must not survive the Markdown
		// boundary merely because they are outside the ASCII C0 range.
		if r == '\n' || r >= 32 && r != 127 && (r < 0x80 || r > 0x9f) {
			out.WriteRune(r)
		}
	}
	return out.String()
}

// SanitizeTerminalText removes terminal actions while preserving printable
// Unicode and line breaks. Callers can safely copy or style the returned text;
// the function deliberately emits no ANSI styling of its own.
func SanitizeTerminalText(value string) string { return stripTerminalControls(value) }

func skipEscape(runes []rune, index int) int {
	if index+1 >= len(runes) {
		return index
	}
	next := runes[index+1]
	if next == '[' {
		for index += 2; index < len(runes); index++ {
			if runes[index] >= 0x40 && runes[index] <= 0x7e {
				return index
			}
		}
		return len(runes) - 1
	}
	if next == ']' || next == 'P' || next == '_' || next == '^' {
		for index += 2; index < len(runes); index++ {
			if runes[index] == 0x07 {
				return index
			}
			if runes[index] == 0x1b && index+1 < len(runes) && runes[index+1] == '\\' {
				return index + 1
			}
		}
		return len(runes) - 1
	}
	return index + 1
}

type Model struct {
	renderer   SafeMarkdownRenderer
	viewport   viewport.Model
	source     string
	rendered   Rendered
	state      RunState
	follow     bool
	newOutput  int
	generation uint64
}

func New(width, height int) Model {
	if width < 20 {
		width = 20
	}
	if height < 1 {
		height = 1
	}
	view := viewport.New(viewport.WithWidth(width), viewport.WithHeight(height))
	view.MouseWheelEnabled = false
	view.FillHeight = true
	return Model{viewport: view, state: StateIdle, follow: true}
}

func (m *Model) SetSize(width, height int) {
	if width < 20 {
		width = 20
	}
	if height < 1 {
		height = 1
	}
	m.viewport.SetWidth(width)
	m.viewport.SetHeight(height)
	m.render()
}
func (m *Model) SetState(state RunState) { m.state = state }
func (m Model) State() RunState          { return m.state }
func (m Model) Following() bool          { return m.follow }
func (m Model) NewOutputCount() int      { return m.newOutput }
func (m Model) Source() string           { return m.rendered.Source }
func (m Model) View() string             { return m.viewport.View() }
func (m Model) Generation() uint64       { return m.generation }

func (m *Model) SetSource(source string) {
	wasFollowing := m.follow || m.viewport.AtBottom()
	m.source = source
	m.render()
	if wasFollowing {
		m.follow = true
		m.newOutput = 0
		m.viewport.GotoBottom()
	} else {
		m.follow = false
		m.newOutput++
	}
}

func (m *Model) SetFollow(enabled bool) {
	m.follow = enabled
	if enabled {
		m.newOutput = 0
		m.viewport.GotoBottom()
	}
}
func (m *Model) ScrollUp(lines int) { m.viewport.ScrollUp(lines); m.follow = m.viewport.AtBottom() }
func (m *Model) ScrollDown(lines int) {
	m.viewport.ScrollDown(lines)
	m.follow = m.viewport.AtBottom()
	if m.follow {
		m.newOutput = 0
	}
}
func (m *Model) GotoTop()    { m.viewport.GotoTop(); m.follow = false }
func (m *Model) GotoBottom() { m.viewport.GotoBottom(); m.follow = true; m.newOutput = 0 }

func (m *Model) render() {
	m.generation++
	m.rendered = m.renderer.Render(m.source, m.viewport.Width())
	m.viewport.SetContent(m.rendered.Text)
}
