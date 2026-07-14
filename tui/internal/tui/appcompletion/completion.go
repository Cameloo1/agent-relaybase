// Package appcompletion owns the pure selection and filtering state for the
// registered-app completion popup. It never starts apps or talks to the
// daemon; accepted values are stable registered app ids.
package appcompletion

import (
	"sort"
	"strings"
	"unicode"

	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
)

const DefaultMaxRows = 5

type Model struct {
	query       string
	matches     []inventory.Item
	selected    int
	windowStart int
	maxRows     int
}

func New(maxRows ...int) Model {
	rows := DefaultMaxRows
	if len(maxRows) > 0 && maxRows[0] > 0 {
		rows = maxRows[0]
	}
	return Model{selected: -1, maxRows: rows}
}

// SetQuery preserves the selected app when daemon state refreshes while the
// operator is navigating the popup.
func (m *Model) SetQuery(query string, items []inventory.Item) {
	selectedID := ""
	if selected, ok := m.Selected(); ok {
		selectedID = selected.ID
	}
	m.setMatches(query, items)
	if selectedID != "" {
		for index, item := range m.matches {
			if item.ID == selectedID {
				m.selected = index
				break
			}
		}
	}
	m.ensureVisible()
}

// SetQueryAndReset ranks a freshly edited query from the first result.
func (m *Model) SetQueryAndReset(query string, items []inventory.Item) {
	m.setMatches(query, items)
	m.selected = 0
	m.windowStart = 0
	m.ensureVisible()
}

func (m *Model) Clear() {
	m.query = ""
	m.matches = nil
	m.selected = -1
	m.windowStart = 0
}

func (m Model) Query() string { return m.query }
func (m Model) Count() int    { return len(m.matches) }

func (m Model) Visible() []inventory.Item {
	if len(m.matches) == 0 {
		return nil
	}
	start := clamp(m.windowStart, 0, len(m.matches)-1)
	end := min(start+m.rows(), len(m.matches))
	return append([]inventory.Item(nil), m.matches[start:end]...)
}

func (m Model) Selected() (inventory.Item, bool) {
	if m.selected < 0 || m.selected >= len(m.matches) {
		return inventory.Item{}, false
	}
	return m.matches[m.selected], true
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

func (m Model) WindowStart() int { return m.windowStart }

func (m *Model) Move(delta int) {
	if len(m.matches) == 0 || delta == 0 {
		return
	}
	m.selected = clamp(m.selected+delta, 0, len(m.matches)-1)
	m.ensureVisible()
}

func (m *Model) Page(delta int) { m.Move(delta * m.rows()) }

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

func (m *Model) SelectVisibleRow(row int) bool {
	if row < 0 || row >= len(m.Visible()) {
		return false
	}
	m.selected = m.windowStart + row
	m.ensureVisible()
	return true
}

// Accept returns completion text only. Submission remains a separate action.
func (m Model) Accept() (string, bool) {
	item, ok := m.Selected()
	if !ok || strings.TrimSpace(item.ID) == "" {
		return "", false
	}
	return "/start " + item.ID, true
}

func (m *Model) SetMaxRows(rows int) {
	if rows < 1 {
		rows = 1
	}
	m.maxRows = rows
	m.ensureVisible()
}

func (m *Model) setMatches(query string, items []inventory.Item) {
	m.query = strings.TrimSpace(query)
	type rankedItem struct {
		item  inventory.Item
		score int
	}
	ranked := make([]rankedItem, 0, len(items))
	for _, item := range items {
		score, ok := matchScore(m.query, item)
		if ok {
			ranked = append(ranked, rankedItem{item: item, score: score})
		}
	}
	sort.SliceStable(ranked, func(left, right int) bool {
		if ranked[left].score != ranked[right].score {
			return ranked[left].score > ranked[right].score
		}
		leftName := strings.ToLower(strings.TrimSpace(ranked[left].item.Name))
		rightName := strings.ToLower(strings.TrimSpace(ranked[right].item.Name))
		if leftName != rightName {
			return leftName < rightName
		}
		return strings.ToLower(ranked[left].item.ID) < strings.ToLower(ranked[right].item.ID)
	})
	m.matches = make([]inventory.Item, 0, len(ranked))
	for _, match := range ranked {
		m.matches = append(m.matches, match.item)
	}
}

func matchScore(query string, item inventory.Item) (int, bool) {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return 1, true
	}
	id := strings.ToLower(strings.TrimSpace(item.ID))
	name := strings.ToLower(strings.TrimSpace(item.Name))
	switch {
	case query == id:
		return 700, true
	case strings.HasPrefix(id, query):
		return 600, true
	case query == name:
		return 500, true
	case strings.HasPrefix(name, query):
		return 450, true
	case tokenHasPrefix(id, query):
		return 400, true
	case tokenHasPrefix(name, query):
		return 350, true
	case strings.Contains(id, query):
		return 250, true
	case strings.Contains(name, query):
		return 200, true
	default:
		return 0, false
	}
}

func tokenHasPrefix(value, query string) bool {
	for _, token := range strings.FieldsFunc(value, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		if strings.HasPrefix(token, query) {
			return true
		}
	}
	return false
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
	m.windowStart = clamp(m.windowStart, 0, max(0, len(m.matches)-m.rows()))
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
