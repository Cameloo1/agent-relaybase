package inventory

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

// Item is a presentation-only view of a daemon-owned registered app. It never
// starts or mutates an app; callers must route actions through the daemon.
type Item struct {
	ID           string
	Name         string
	Directory    string
	Status       string
	Readiness    string
	Route        string
	ManifestPath string
	LastError    string
	Selected     bool
}

func (i Item) CanStart() bool {
	switch strings.ToLower(strings.TrimSpace(i.Status)) {
	case "", "stopped":
		return true
	default:
		return false
	}
}

type Manager struct {
	items         []Item
	selectedIndex int
}

func (m *Manager) ApplyState(state *relaybaseclient.RelaybaseState) {
	selectedID := m.SelectedID()
	byID := map[string]Item{}
	if state != nil {
		for _, app := range state.Apps {
			id := strings.TrimSpace(app.ID)
			if id == "" {
				continue
			}
			byID[id] = Item{
				ID:           id,
				Name:         firstNonEmpty(app.Name, id),
				Directory:    firstNonEmpty(app.CWD, projectDirectory(app.ManifestPath)),
				Status:       firstNonEmpty(app.RuntimeStatus, "stopped"),
				Readiness:    app.ReadinessState,
				Route:        app.Route,
				ManifestPath: app.ManifestPath,
				LastError:    app.LastError,
			}
		}
		for _, component := range state.Components {
			mergeComponent(byID, component)
		}
		for _, group := range state.Groups {
			for _, component := range group.Components {
				mergeComponent(byID, component)
			}
		}
	}

	items := make([]Item, 0, len(byID))
	for _, item := range byID {
		items = append(items, item)
	}
	sort.SliceStable(items, func(left int, right int) bool {
		leftName := strings.ToLower(firstNonEmpty(items[left].Name, items[left].ID))
		rightName := strings.ToLower(firstNonEmpty(items[right].Name, items[right].ID))
		if leftName != rightName {
			return leftName < rightName
		}
		return items[left].ID < items[right].ID
	})

	m.items = items
	m.selectedIndex = 0
	if selectedID != "" {
		for index := range m.items {
			if m.items[index].ID == selectedID {
				m.selectedIndex = index
				break
			}
		}
	}
	m.clampSelection()
}

func (m *Manager) Move(delta int) {
	if len(m.items) == 0 {
		m.selectedIndex = 0
		return
	}
	m.selectedIndex += delta
	m.clampSelection()
}

func (m *Manager) SelectIndex(index int) {
	m.selectedIndex = index
	m.clampSelection()
}

// SelectID selects one registered app by its stable daemon id. It returns
// false without changing selection when that app is no longer present.
func (m *Manager) SelectID(id string) bool {
	for index, item := range m.items {
		if item.ID == id {
			m.selectedIndex = index
			return true
		}
	}
	return false
}

func (m Manager) Items() []Item {
	items := make([]Item, len(m.items))
	copy(items, m.items)
	for index := range items {
		items[index].Selected = index == m.selectedIndex
	}
	return items
}

func (m Manager) Selected() *Item {
	if len(m.items) == 0 {
		return nil
	}
	index := clamp(m.selectedIndex, 0, len(m.items)-1)
	item := m.items[index]
	item.Selected = true
	return &item
}

func (m Manager) SelectedID() string {
	selected := m.Selected()
	if selected == nil {
		return ""
	}
	return selected.ID
}

func (m Manager) ItemByID(id string) (Item, bool) {
	for _, item := range m.items {
		if item.ID == id {
			return item, true
		}
	}
	return Item{}, false
}

// ResolveApp accepts a stable app id or one unique registered display name.
// Exact ids take precedence over names so completion output remains
// unambiguous even when another app's display name happens to equal an id.
func (m Manager) ResolveApp(target string) (Item, error) {
	normalized := strings.ToLower(strings.TrimSpace(target))
	if normalized == "" {
		return Item{}, fmt.Errorf("Choose a registered app with /start or provide an exact app id")
	}
	for _, item := range m.items {
		if strings.ToLower(strings.TrimSpace(item.ID)) == normalized {
			return item, nil
		}
	}
	matches := []Item{}
	for _, item := range m.items {
		if strings.ToLower(strings.TrimSpace(item.Name)) == normalized {
			matches = append(matches, item)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return Item{}, fmt.Errorf("Unknown registered app %q. Use /start and Tab to choose an app id", strings.TrimSpace(target))
	default:
		ids := make([]string, 0, len(matches))
		for _, item := range matches {
			ids = append(ids, item.ID)
		}
		sort.Strings(ids)
		return Item{}, fmt.Errorf("Registered app name %q is ambiguous. Choose one app id: %s", strings.TrimSpace(target), strings.Join(ids, ", "))
	}
}

func (m Manager) SelectedIndex() int {
	if len(m.items) == 0 {
		return 0
	}
	return clamp(m.selectedIndex, 0, len(m.items)-1)
}

func (m Manager) Count() int {
	return len(m.items)
}

func (m *Manager) clampSelection() {
	if len(m.items) == 0 {
		m.selectedIndex = 0
		return
	}
	m.selectedIndex = clamp(m.selectedIndex, 0, len(m.items)-1)
}

func mergeComponent(byID map[string]Item, component relaybaseclient.AppComponent) {
	id := strings.TrimSpace(component.AppID)
	if id == "" {
		return
	}
	item, exists := byID[id]
	if !exists {
		item = Item{ID: id, Name: firstNonEmpty(component.DisplayName, id)}
	}
	item.Name = firstNonEmpty(item.Name, component.DisplayName, id)
	item.Status = firstNonEmpty(component.Status, item.Status, "stopped")
	item.Route = firstNonEmpty(component.Route.Label(), item.Route)
	item.LastError = firstNonEmpty(component.LastError, item.LastError)
	byID[id] = item
}

func projectDirectory(manifestPath string) string {
	trimmed := strings.TrimSpace(manifestPath)
	if trimmed == "" {
		return ""
	}
	return filepath.Clean(filepath.Dir(trimmed))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func clamp(value int, low int, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}
