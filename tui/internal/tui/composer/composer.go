// Package composer wraps Bubbles textarea with Relaybase's input contract.
// It owns local draft/history state only; it never sends or persists prompts.
package composer

import (
	"errors"
	"image/color"
	"strings"
	"time"
	"unicode/utf8"

	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/styles"
)

const (
	MaxPasteBytes  = 256 * 1024
	MaxPasteLines  = 10000
	MaxContentRows = 10000
)

var ErrPasteTooLarge = errors.New("paste exceeds the Relaybase composer limit")

type Snapshot struct {
	Value          string
	Cursor         int
	SelectionStart int
	SelectionEnd   int
	Scroll         int
}

type HistoryEntry struct {
	ID        string
	Value     string
	Source    string
	ThreadID  string
	CreatedAt time.Time
}

// History preserves immutable entries and working copies separately. Values
// are intentionally process-memory only.
type History struct {
	entries []HistoryEntry
	working map[string]Snapshot
	index   int
	draft   Snapshot
	scope   string
}

func (h History) Entries() []HistoryEntry { return append([]HistoryEntry(nil), h.entries...) }
func (h *History) WorkingCopy(id string) (Snapshot, bool) {
	value, ok := h.working[id]
	return value, ok
}

func (h *History) Add(entry HistoryEntry) {
	if entry.ID == "" || entry.Value == "" {
		return
	}
	if entry.ThreadID == "" {
		entry.ThreadID = h.scope
	}
	h.entries = append(h.entries, entry)
}

func (h *History) Reset() { h.index = -1; h.draft = Snapshot{} }

func (h *History) SetScope(scope string) {
	if h.scope == scope {
		return
	}
	h.scope = scope
	h.Reset()
}

func (h History) Scope() string { return h.scope }

func (h History) matches(entry HistoryEntry) bool { return entry.ThreadID == h.scope }

func (h *History) Previous(current Snapshot) (Snapshot, bool) {
	if len(h.entries) == 0 {
		return Snapshot{}, false
	}
	if h.index < 0 {
		h.draft = current
		h.index = len(h.entries)
	} else if h.index < len(h.entries) && h.matches(h.entries[h.index]) {
		if h.working == nil {
			h.working = map[string]Snapshot{}
		}
		h.working[h.entries[h.index].ID] = current
	}
	for candidate := h.index - 1; candidate >= 0; candidate-- {
		entry := h.entries[candidate]
		if !h.matches(entry) {
			continue
		}
		h.index = candidate
		if copy, ok := h.working[entry.ID]; ok {
			return copy, true
		}
		return Snapshot{Value: entry.Value, Cursor: runeCount(entry.Value)}, true
	}
	return Snapshot{}, false
}

func (h *History) Next(current Snapshot) (Snapshot, bool) {
	if h.index < 0 {
		return Snapshot{}, false
	}
	if h.index < len(h.entries) && h.matches(h.entries[h.index]) {
		if h.working == nil {
			h.working = map[string]Snapshot{}
		}
		h.working[h.entries[h.index].ID] = current
	}
	for candidate := h.index + 1; candidate < len(h.entries); candidate++ {
		entry := h.entries[candidate]
		if !h.matches(entry) {
			continue
		}
		h.index = candidate
		if copy, ok := h.working[entry.ID]; ok {
			return copy, true
		}
		return Snapshot{Value: entry.Value, Cursor: runeCount(entry.Value)}, true
	}
	h.index = -1
	return h.draft, true
}

type Model struct {
	input          textarea.Model
	selectionStart int
	selectionEnd   int
	history        History
	assistantColor color.Color
}

func New(width int) Model {
	input := textarea.New()
	input.DynamicHeight = true
	input.MinHeight = 1
	input.MaxHeight = 3
	input.MaxContentHeight = MaxContentRows
	input.ShowLineNumbers = false
	input.Prompt = "> "
	input.Placeholder = "Ask Relaybase or enter a slash command"
	input.KeyMap.InsertNewline.SetKeys("ctrl+j")
	input.KeyMap.Paste.SetEnabled(false)
	input.SetVirtualCursor(true)
	input.SetWidth(max(8, width))
	input.SetHeight(1)
	return Model{input: input, history: History{index: -1, working: map[string]Snapshot{}}}
}

func (m *Model) Focus() tea.Cmd             { return m.input.Focus() }
func (m *Model) Blur()                      { m.input.Blur() }
func (m Model) Focused() bool               { return m.input.Focused() }
func (m Model) View() string                { return m.input.View() }
func (m Model) Value() string               { return m.input.Value() }
func (m Model) Rows() int                   { return m.input.Height() }
func (m Model) Line() int                   { return m.input.Line() }
func (m Model) LineCount() int              { return m.input.LineCount() }
func (m Model) ScrollOffset() int           { return m.input.ScrollYOffset() }
func (m Model) History() History            { return m.history }
func (m Model) AssistantColor() color.Color { return m.assistantColor }

func (m *Model) SetHistoryScope(scope string) { m.history.SetScope(scope) }

func (m Model) AtVisualTop() bool {
	info := m.input.LineInfo()
	return m.input.Line() == 0 && info.RowOffset == 0
}

func (m Model) AtVisualBottom() bool {
	info := m.input.LineInfo()
	return m.input.Line() == m.input.LineCount()-1 && info.RowOffset >= max(0, info.Height-1)
}

func (m *Model) SetWidth(width int) { m.input.SetWidth(max(8, width)) }

func (m *Model) ApplyTheme(theme styles.Theme, assistantBarColor ...string) {
	configured := ""
	if len(assistantBarColor) > 0 {
		configured = assistantBarColor[0]
	}
	accent := styles.AssistantColor(theme, configured)
	m.assistantColor = accent
	base := lipgloss.NewStyle().Foreground(theme.Text).Background(theme.Background)
	focused := textarea.StyleState{
		Base:        base,
		Text:        base,
		CursorLine:  base,
		EndOfBuffer: base,
		Placeholder: lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.Background),
		Prompt:      lipgloss.NewStyle().Foreground(accent).Background(theme.Background).Bold(true),
	}
	blurred := focused
	blurred.Prompt = lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.Background)
	m.input.SetStyles(textarea.Styles{
		Focused: focused,
		Blurred: blurred,
		Cursor: textarea.CursorStyle{
			Color: accent,
			Shape: tea.CursorBar,
			Blink: true,
		},
	})
}

func (m *Model) SetValue(value string) {
	m.input.SetValue(value)
	m.clearSelection()
}

func (m *Model) Clear() { m.SetValue(""); m.history.Reset() }

func (m *Model) Snapshot() Snapshot {
	start, end := m.Selection()
	return Snapshot{Value: m.Value(), Cursor: m.cursorOffset(), SelectionStart: start, SelectionEnd: end, Scroll: m.input.ScrollYOffset()}
}

func (m *Model) Restore(snapshot Snapshot) {
	m.input.SetValue(snapshot.Value)
	m.setCursorOffset(snapshot.Cursor)
	m.SetSelection(snapshot.SelectionStart, snapshot.SelectionEnd)
}

func (m *Model) Update(msg tea.Msg) tea.Cmd {
	before := m.Value()
	updated, command := m.input.Update(msg)
	m.input = updated
	if before != m.Value() {
		m.clearSelection()
	}
	return command
}

func (m *Model) Insert(text string) { m.replaceRange(m.cursorOffset(), m.cursorOffset(), text) }

func (m *Model) Paste(text string) error {
	clean := SanitizePaste(text)
	if len([]byte(clean)) > MaxPasteBytes || lineCount(clean) > MaxPasteLines {
		return ErrPasteTooLarge
	}
	start, end := m.Selection()
	if start == end {
		start = m.cursorOffset()
		end = start
	}
	m.replaceRange(start, end, clean)
	return nil
}

func (m *Model) SetSelection(start, end int) {
	limit := runeCount(m.Value())
	m.selectionStart = clamp(start, 0, limit)
	m.selectionEnd = clamp(end, 0, limit)
}

func (m Model) Selection() (int, int) {
	if m.selectionStart <= m.selectionEnd {
		return m.selectionStart, m.selectionEnd
	}
	return m.selectionEnd, m.selectionStart
}

func (m *Model) DeleteSelection() bool {
	start, end := m.Selection()
	if start == end {
		return false
	}
	m.replaceRange(start, end, "")
	return true
}

func (m *Model) Backspace() bool {
	if m.DeleteSelection() {
		return true
	}
	cursor := m.cursorOffset()
	if cursor == 0 {
		return false
	}
	m.replaceRange(cursor-1, cursor, "")
	return true
}

func (m *Model) DeleteForward() bool {
	if m.DeleteSelection() {
		return true
	}
	cursor := m.cursorOffset()
	if cursor >= runeCount(m.Value()) {
		return false
	}
	m.replaceRange(cursor, cursor+1, "")
	return true
}

func (m *Model) DeleteBeforeCursor() bool {
	if m.DeleteSelection() {
		return true
	}
	cursor := m.cursorOffset()
	if cursor == 0 {
		return false
	}
	m.replaceRange(0, cursor, "")
	return true
}

func (m Model) SelectedText() string {
	start, end := m.Selection()
	return string(sliceRunes([]rune(m.Value()), start, end))
}

func (m *Model) PreviousHistory() bool {
	if snapshot, ok := m.history.Previous(m.Snapshot()); ok {
		m.Restore(snapshot)
		return true
	}
	return false
}

func (m *Model) NextHistory() bool {
	if snapshot, ok := m.history.Next(m.Snapshot()); ok {
		m.Restore(snapshot)
		return true
	}
	return false
}

func (m *Model) AddHistory(entry HistoryEntry) { m.history.Add(entry) }

func (m *Model) replaceRange(start, end int, replacement string) {
	value := []rune(m.Value())
	start = clamp(start, 0, len(value))
	end = clamp(end, start, len(value))
	combined := make([]rune, 0, len(value)-(end-start)+runeCount(replacement))
	combined = append(combined, value[:start]...)
	combined = append(combined, []rune(replacement)...)
	combined = append(combined, value[end:]...)
	m.input.SetValue(string(combined))
	m.setCursorOffset(start + runeCount(replacement))
	m.clearSelection()
}

func (m *Model) cursorOffset() int {
	lines := strings.Split(m.Value(), "\n")
	offset := 0
	for index := 0; index < m.input.Line() && index < len(lines); index++ {
		offset += len([]rune(lines[index])) + 1
	}
	return offset + m.input.Column()
}

func (m *Model) setCursorOffset(offset int) {
	offset = clamp(offset, 0, runeCount(m.Value()))
	lines := strings.Split(m.Value(), "\n")
	remaining := offset
	m.input.CursorStart()
	for row, line := range lines {
		width := len([]rune(line))
		if remaining <= width || row == len(lines)-1 {
			m.input.SetCursorColumn(remaining)
			return
		}
		remaining -= width + 1
		m.input.CursorDown()
	}
}

func (m *Model) clearSelection() { m.selectionStart, m.selectionEnd = 0, 0 }

// SanitizePaste preserves Unicode and LF while removing terminal control
// sequences. It is intentionally content-only: paste never executes input.
func SanitizePaste(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	runes := []rune(value)
	var out strings.Builder
	for index := 0; index < len(runes); index++ {
		r := runes[index]
		if r == 0x1b {
			index = skipEscape(runes, index)
			continue
		}
		if r == '\n' {
			out.WriteRune(r)
			continue
		}
		if r == '\t' {
			out.WriteString("    ")
			continue
		}
		if r < 32 || r == 127 || r >= 0x80 && r <= 0x9f {
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}

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

func lineCount(value string) int {
	if value == "" {
		return 0
	}
	return strings.Count(value, "\n") + 1
}
func runeCount(value string) int { return utf8.RuneCountInString(value) }
func sliceRunes(value []rune, start, end int) []rune {
	return value[clamp(start, 0, len(value)):clamp(end, start, len(value))]
}
func clamp(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
func max(left, right int) int {
	if left > right {
		return left
	}
	return right
}
