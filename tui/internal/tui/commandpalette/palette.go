package commandpalette

import "github.com/cameloo/relaybase/tui/internal/tui/slash"

const DefaultMaxRows = 5

// Model is the pure selection/window state for the slash completion popup. It
// never parses, submits, or executes a command.
type Model struct {
	query       string
	matches     []slash.CommandMatch
	selected    int
	windowStart int
	maxRows     int
}

func New(maxRows ...int) Model {
	rows := DefaultMaxRows
	if len(maxRows) > 0 && maxRows[0] > 0 {
		rows = maxRows[0]
	}
	model := Model{maxRows: rows}
	model.SetQuery("")
	return model
}

func (m *Model) SetQuery(query string) {
	selectedKind := ""
	if descriptor, ok := m.Selected(); ok {
		selectedKind = descriptor.Kind
	}
	m.query = query
	m.matches = slash.SearchCatalog(query)
	m.selected = 0
	if selectedKind != "" {
		for index, match := range m.matches {
			if match.Descriptor.Kind == selectedKind {
				m.selected = index
				break
			}
		}
	}
	m.ensureVisible()
}

// SetQueryAndReset ranks a freshly edited query from the top. Interactive
// typing uses this so an old selection cannot outrank a newly exact match;
// SetQuery remains available for refreshes that intentionally preserve a
// manually selected command.
func (m *Model) SetQueryAndReset(query string) {
	m.query = query
	m.matches = slash.SearchCatalog(query)
	m.selected = 0
	m.windowStart = 0
	m.ensureVisible()
}

func (m Model) Query() string {
	return m.query
}

func (m Model) Count() int {
	return len(m.matches)
}

func (m Model) Matches() []slash.CommandMatch {
	return append([]slash.CommandMatch(nil), m.matches...)
}

func (m Model) Visible() []slash.CommandMatch {
	if len(m.matches) == 0 {
		return nil
	}
	start := clamp(m.windowStart, 0, len(m.matches)-1)
	end := min(start+m.rows(), len(m.matches))
	return append([]slash.CommandMatch(nil), m.matches[start:end]...)
}

func (m Model) Selected() (slash.CommandDescriptor, bool) {
	if m.selected < 0 || m.selected >= len(m.matches) {
		return slash.CommandDescriptor{}, false
	}
	return m.matches[m.selected].Descriptor, true
}

func (m Model) SelectedIndex() int {
	if len(m.matches) == 0 {
		return -1
	}
	return m.selected
}

func (m Model) SelectedVisibleIndex() int {
	if len(m.matches) == 0 {
		return -1
	}
	return m.selected - m.windowStart
}

func (m Model) WindowStart() int {
	return m.windowStart
}

func (m *Model) Move(delta int) {
	if len(m.matches) == 0 || delta == 0 {
		return
	}
	m.selected = clamp(m.selected+delta, 0, len(m.matches)-1)
	m.ensureVisible()
}

func (m *Model) Page(delta int) {
	m.Move(delta * m.rows())
}

func (m *Model) Home() {
	if len(m.matches) == 0 {
		return
	}
	m.selected = 0
	m.ensureVisible()
}

func (m *Model) End() {
	if len(m.matches) == 0 {
		return
	}
	m.selected = len(m.matches) - 1
	m.ensureVisible()
}

// SelectVisibleRow selects a rendered row using its zero-based visible index.
// It returns false for coordinates outside the current result window.
func (m *Model) SelectVisibleRow(row int) bool {
	if row < 0 || row >= len(m.Visible()) {
		return false
	}
	m.selected = m.windowStart + row
	m.ensureVisible()
	return true
}

// Accept returns completion text only. The caller must require a separate
// submit action after inserting it into the assistant input.
func (m Model) Accept() (string, bool) {
	descriptor, ok := m.Selected()
	if !ok {
		return "", false
	}
	return descriptor.Insertion, true
}

func (m *Model) SetMaxRows(rows int) {
	if rows < 1 {
		rows = 1
	}
	m.maxRows = rows
	m.ensureVisible()
}

func (m Model) MaxRows() int {
	return m.rows()
}

func (m *Model) ensureVisible() {
	if len(m.matches) == 0 {
		m.selected = -1
		m.windowStart = 0
		return
	}
	m.selected = clamp(m.selected, 0, len(m.matches)-1)
	if m.selected < m.windowStart {
		m.windowStart = m.selected
	}
	if m.selected >= m.windowStart+m.rows() {
		m.windowStart = m.selected - m.rows() + 1
	}
	maximumStart := max(0, len(m.matches)-m.rows())
	m.windowStart = clamp(m.windowStart, 0, maximumStart)
}

func (m Model) rows() int {
	if m.maxRows < 1 {
		return DefaultMaxRows
	}
	return m.maxRows
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func max(left, right int) int {
	if left > right {
		return left
	}
	return right
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
