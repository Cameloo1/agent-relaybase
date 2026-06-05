package panes

import (
	"fmt"
	"sort"
	"strings"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

const (
	MaxPanesPerPage       = 8
	DefaultMaxScrollback  = 500
	DefaultLogFetchLimit  = 200
	modeReplace           = "replace"
	modeMergeLatest       = "merge_latest"
	modePrependOlder      = "prepend_older"
	defaultStoppedStatus  = "stopped"
	defaultComponentRole  = "other"
	defaultComponentLabel = "app"
)

type Diagnostic struct {
	Code     string
	Severity string
	Message  string
}

type Pane struct {
	ID           string
	AppID        string
	GroupID      string
	Role         string
	PaneLabel    string
	DisplayName  string
	Title        string
	Status       string
	Route        relaybaseclient.RouteInfo
	PID          int
	Port         int
	LastError    string
	Pinned       bool
	Hidden       bool
	UserHidden   bool
	Follow       bool
	ScrollOffset int
	Logs         []relaybaseclient.LogEvent
	HasMore      bool
	NextBefore   string
	LogError     string
	Color        string
	SortKey      string
}

type PaneSnapshot struct {
	ID           string
	AppID        string
	GroupID      string
	Role         string
	PaneLabel    string
	DisplayName  string
	Title        string
	Status       string
	RouteLabel   string
	PID          int
	Port         int
	LastError    string
	Pinned       bool
	Follow       bool
	Focused      bool
	Selected     bool
	Color        string
	Page         int
	LogLines     []string
	HasMore      bool
	NextBefore   string
	LogError     string
	ScrollOffset int
}

type LogTarget struct {
	PaneID string
	AppID  string
	Before string
	Mode   string
	Limit  int
}

type Layout struct {
	Width      int
	Height     int
	Columns    int
	Rows       int
	PaneWidth  int
	PaneHeight int
	Narrow     bool
}

type Manager struct {
	panes         map[string]*Pane
	order         []string
	selectedIndex int
	page          int
	focusedID     string
	layout        Layout
	diagnostics   []Diagnostic
	maxScrollback int
	pinnedPrefs   map[string]bool
	hiddenPrefs   map[string]bool
	orderPrefs    []string
	colorPrefs    map[string]string
}

func NewManager() Manager {
	return Manager{
		panes:         map[string]*Pane{},
		order:         []string{},
		selectedIndex: 0,
		page:          0,
		layout:        CalculateLayout(80, 18, 1),
		maxScrollback: DefaultMaxScrollback,
		pinnedPrefs:   map[string]bool{},
		hiddenPrefs:   map[string]bool{},
		orderPrefs:    []string{},
		colorPrefs:    map[string]string{},
	}
}

func (m *Manager) ApplyState(state *relaybaseclient.RelaybaseState) []Diagnostic {
	if m.panes == nil {
		*m = NewManager()
	}

	selectedID := m.SelectedPaneID()
	m.diagnostics = nil
	components := componentsFromState(state)
	groupNames := groupNamesFromState(state)
	seen := map[string]bool{}

	for _, component := range components {
		normalized, ok := m.normalizeComponent(component, groupNames)
		if !ok {
			continue
		}

		id := paneID(normalized)
		seen[id] = true
		existing, exists := m.panes[id]
		if !exists {
			existing = &Pane{ID: id, Follow: true}
			m.panes[id] = existing
			m.order = append(m.order, id)
		}

		preserved := Pane{
			Pinned:       existing.Pinned,
			Hidden:       existing.Hidden,
			UserHidden:   existing.UserHidden,
			Follow:       existing.Follow,
			ScrollOffset: existing.ScrollOffset,
			Logs:         existing.Logs,
			HasMore:      existing.HasMore,
			NextBefore:   existing.NextBefore,
			LogError:     existing.LogError,
			Color:        existing.Color,
		}
		if !exists {
			preserved.Pinned = m.pinnedPrefs[id]
			preserved.UserHidden = m.hiddenPrefs[id]
			preserved.Hidden = !shouldAutoOpen(normalized.Status)
			preserved.Follow = true
			preserved.Color = m.colorPrefs[id]
		}

		groupDisplayName := firstNonEmpty(groupNames[normalized.GroupID], normalized.DisplayName, normalized.GroupID)
		*existing = Pane{
			ID:           id,
			AppID:        normalized.AppID,
			GroupID:      normalized.GroupID,
			Role:         normalized.Role,
			PaneLabel:    normalized.PaneLabel,
			DisplayName:  normalized.DisplayName,
			Title:        formatTitle(normalized.DisplayName, normalized.PaneLabel, normalized.Role),
			Status:       normalized.Status,
			Route:        normalized.Route,
			PID:          normalized.PID,
			Port:         normalized.Port,
			LastError:    normalized.LastError,
			Pinned:       preserved.Pinned,
			Hidden:       preserved.Hidden,
			UserHidden:   preserved.UserHidden,
			Follow:       preserved.Follow,
			ScrollOffset: preserved.ScrollOffset,
			Logs:         preserved.Logs,
			HasMore:      preserved.HasMore,
			NextBefore:   preserved.NextBefore,
			LogError:     preserved.LogError,
			Color:        preserved.Color,
			SortKey:      fmt.Sprintf("%s/%04d/%s/%s", groupDisplayName, normalized.PaneOrder, normalized.PaneLabel, normalized.AppID),
		}
		applyVisibility(existing, exists)
	}

	for id, pane := range m.panes {
		if seen[id] {
			continue
		}
		if !pane.Pinned && pane.Status != "failed" {
			pane.Hidden = true
		}
	}

	m.sortOrder()
	m.restoreSelection(selectedID)
	m.refreshLayout()
	return m.Diagnostics()
}

func (m *Manager) ApplyPreferences(pinned []string, hidden []string, order []string, colors map[string]string, lastPage int) {
	if m.panes == nil {
		*m = NewManager()
	}
	m.pinnedPrefs = boolSet(pinned)
	m.hiddenPrefs = boolSet(hidden)
	m.orderPrefs = uniqueStrings(order)
	m.colorPrefs = copyStringMap(colors)
	for id, pane := range m.panes {
		pane.Pinned = m.pinnedPrefs[id]
		pane.UserHidden = m.hiddenPrefs[id]
		pane.Color = m.colorPrefs[id]
		applyVisibility(pane, true)
	}
	m.sortOrder()
	m.page = maxInt(0, lastPage)
	m.selectedIndex = m.page * MaxPanesPerPage
	if len(m.visibleIDs()) > 0 {
		m.clampSelection()
	}
	m.refreshLayout()
}

func (m *Manager) Resize(width int, height int) {
	m.layout = CalculateLayout(width, height, len(m.CurrentPagePanes()))
}

func (m Manager) Layout() Layout {
	return m.layout
}

func (m Manager) Diagnostics() []Diagnostic {
	return append([]Diagnostic(nil), m.diagnostics...)
}

func (m Manager) VisiblePanes() []PaneSnapshot {
	return m.snapshotsForIDs(m.visibleIDs())
}

func (m Manager) CurrentPagePanes() []PaneSnapshot {
	return m.snapshotsForIDs(m.currentPageIDs())
}

func (m Manager) FocusedPane() *PaneSnapshot {
	if m.focusedID == "" {
		return nil
	}
	pane := m.panes[m.focusedID]
	if pane == nil || pane.Hidden {
		return nil
	}
	snapshot := m.snapshotForPane(*pane, true, true)
	return &snapshot
}

func (m Manager) Page() int {
	return m.page
}

func (m Manager) PageCount() int {
	count := len(m.visibleIDs())
	if count == 0 {
		return 1
	}
	pages := count / MaxPanesPerPage
	if count%MaxPanesPerPage != 0 {
		pages++
	}
	if pages < 1 {
		return 1
	}
	return pages
}

func (m Manager) SelectedPaneID() string {
	ids := m.visibleIDs()
	if len(ids) == 0 {
		return ""
	}
	index := clamp(m.selectedIndex, 0, len(ids)-1)
	return ids[index]
}

func (m Manager) SelectedPane() *PaneSnapshot {
	id := m.SelectedPaneID()
	if id == "" {
		return nil
	}
	pane := m.panes[id]
	if pane == nil || pane.Hidden {
		return nil
	}
	snapshot := m.snapshotForPane(*pane, true, id == m.focusedID)
	return &snapshot
}

func (m Manager) Focused() bool {
	return m.focusedID != ""
}

func (m Manager) PinnedIDs() []string {
	ids := []string{}
	for _, id := range m.order {
		pane := m.panes[id]
		if pane != nil && pane.Pinned {
			ids = append(ids, id)
		}
	}
	return ids
}

func (m Manager) HiddenIDs() []string {
	ids := []string{}
	for _, id := range m.order {
		pane := m.panes[id]
		if pane != nil && pane.UserHidden {
			ids = append(ids, id)
		}
	}
	return ids
}

func (m Manager) OrderIDs() []string {
	return append([]string(nil), m.order...)
}

func (m Manager) Colors() map[string]string {
	colors := map[string]string{}
	for _, id := range m.order {
		pane := m.panes[id]
		if pane != nil && pane.Color != "" {
			colors[id] = pane.Color
		}
	}
	for id, color := range m.colorPrefs {
		if _, exists := colors[id]; !exists && color != "" {
			colors[id] = color
		}
	}
	return colors
}

func (m *Manager) MoveSelection(dx int, dy int) {
	if m.focusedID != "" {
		return
	}
	ids := m.currentPageIDs()
	if len(ids) == 0 {
		m.selectedIndex = 0
		return
	}

	local := m.selectedIndex - m.page*MaxPanesPerPage
	if local < 0 || local >= len(ids) {
		local = 0
	}
	columns := maxInt(1, m.layout.Columns)
	row := local / columns
	column := local % columns
	row = clamp(row+dy, 0, maxInt(0, m.layout.Rows-1))
	column = clamp(column+dx, 0, columns-1)

	next := row*columns + column
	if next >= len(ids) {
		next = len(ids) - 1
	}
	m.selectedIndex = m.page*MaxPanesPerPage + next
	m.clampSelection()
}

func (m *Manager) NextPage() {
	if m.PageCount() <= 1 {
		return
	}
	m.page = clamp(m.page+1, 0, m.PageCount()-1)
	m.selectedIndex = m.page * MaxPanesPerPage
	m.clampSelection()
	m.refreshLayout()
}

func (m *Manager) PreviousPage() {
	if m.PageCount() <= 1 {
		return
	}
	m.page = clamp(m.page-1, 0, m.PageCount()-1)
	m.selectedIndex = m.page * MaxPanesPerPage
	m.clampSelection()
	m.refreshLayout()
}

func (m *Manager) SetPage(page int) {
	m.page = clamp(page, 0, m.PageCount()-1)
	m.selectedIndex = m.page * MaxPanesPerPage
	m.clampSelection()
	m.refreshLayout()
}

func (m *Manager) SelectPane(id string) bool {
	if strings.TrimSpace(id) == "" {
		return false
	}
	for index, visibleID := range m.visibleIDs() {
		if visibleID != id {
			continue
		}
		m.selectedIndex = index
		m.page = index / MaxPanesPerPage
		m.clampSelection()
		m.refreshLayout()
		return true
	}
	return false
}

func (m *Manager) FocusSelected() {
	id := m.SelectedPaneID()
	if id != "" {
		m.focusedID = id
	}
}

func (m *Manager) BlurFocus() {
	m.focusedID = ""
}

func (m *Manager) TogglePinSelected() {
	pane := m.selectedPane()
	if pane == nil {
		return
	}
	pane.Pinned = !pane.Pinned
	if pane.Pinned {
		pane.UserHidden = false
		pane.Hidden = false
	}
}

func (m *Manager) SetPanePinned(id string, pinned bool) bool {
	pane := m.panes[id]
	if pane == nil {
		return false
	}
	pane.Pinned = pinned
	if pinned {
		pane.UserHidden = false
		pane.Hidden = false
	}
	if !pinned {
		applyVisibility(pane, true)
	}
	m.clampSelection()
	return true
}

func (m *Manager) CloseSelected() {
	pane := m.selectedPane()
	if pane == nil {
		return
	}
	pane.Hidden = true
	pane.UserHidden = true
	pane.Pinned = false
	if m.focusedID == pane.ID {
		m.focusedID = ""
	}
	m.clampSelection()
}

func (m Manager) CanReopen() bool {
	return m.reopenCandidate() != nil
}

func (m *Manager) ReopenSelectedOrFirstAvailable() bool {
	pane := m.reopenCandidate()
	if pane == nil {
		return false
	}
	pane.UserHidden = false
	pane.Hidden = false
	if pane.Status == "stopped" {
		pane.Pinned = true
	}
	for index, id := range m.visibleIDs() {
		if id == pane.ID {
			m.selectedIndex = index
			m.page = index / MaxPanesPerPage
			break
		}
	}
	m.clampSelection()
	m.refreshLayout()
	return true
}

func (m Manager) reopenCandidate() *Pane {
	for _, id := range m.order {
		candidate := m.panes[id]
		if candidate != nil && candidate.Hidden {
			return candidate
		}
	}
	return nil
}

func (m *Manager) ToggleFollowSelected() {
	pane := m.selectedPane()
	if pane == nil {
		return
	}
	pane.Follow = !pane.Follow
	if pane.Follow {
		pane.ScrollOffset = 0
	}
}

func (m *Manager) ScrollSelected(delta int) {
	pane := m.selectedPane()
	if pane == nil {
		return
	}
	pane.ScrollOffset = clamp(pane.ScrollOffset+delta, 0, len(pane.Logs))
	if pane.ScrollOffset > 0 {
		pane.Follow = false
	} else {
		pane.Follow = true
	}
}

func (m *Manager) SetPaneColor(id string, color string) bool {
	pane := m.panes[id]
	if pane == nil {
		return false
	}
	pane.Color = strings.TrimSpace(color)
	m.colorPrefs[id] = pane.Color
	return true
}

func (m *Manager) CycleSelectedColor(palette []string) (string, bool) {
	pane := m.selectedPane()
	if pane == nil {
		return "", false
	}
	if len(palette) == 0 {
		palette = []string{"default"}
	}
	current := pane.Color
	nextIndex := 0
	for index, color := range palette {
		if color == current {
			nextIndex = (index + 1) % len(palette)
			break
		}
	}
	pane.Color = palette[nextIndex]
	if pane.Color == "default" {
		pane.Color = ""
		delete(m.colorPrefs, pane.ID)
		return "default", true
	}
	m.colorPrefs[pane.ID] = pane.Color
	return pane.Color, true
}

func (m *Manager) RefreshLogTargets() []LogTarget {
	targets := []LogTarget{}
	for _, pane := range m.CurrentPagePanes() {
		targets = append(targets, LogTarget{
			PaneID: pane.ID,
			AppID:  pane.AppID,
			Mode:   modeReplace,
			Limit:  DefaultLogFetchLimit,
		})
	}
	return targets
}

func (m *Manager) OlderLogTarget() *LogTarget {
	pane := m.selectedPane()
	if pane == nil || pane.NextBefore == "" {
		return nil
	}
	return &LogTarget{
		PaneID: pane.ID,
		AppID:  pane.AppID,
		Before: pane.NextBefore,
		Mode:   modePrependOlder,
		Limit:  DefaultLogFetchLimit,
	}
}

func (m Manager) TargetsForLogEvent(event relaybaseclient.LogEvent) []LogTarget {
	targets := []LogTarget{}
	for _, id := range m.visibleIDs() {
		pane := m.panes[id]
		if pane == nil {
			continue
		}
		if paneMatchesLog(*pane, event) {
			targets = append(targets, LogTarget{
				PaneID: pane.ID,
				AppID:  pane.AppID,
				Mode:   modeMergeLatest,
				Limit:  DefaultLogFetchLimit,
			})
		}
	}
	return targets
}

func (m *Manager) MergeSnapshot(target LogTarget, snapshot *relaybaseclient.LogSnapshot) {
	pane := m.panes[target.PaneID]
	if pane == nil || snapshot == nil {
		return
	}

	events := snapshot.Events
	if len(events) == 0 && len(snapshot.Logs) > 0 {
		events = eventsFromStrings(pane.AppID, pane.GroupID, pane.Role, snapshot.Logs)
	}

	switch target.Mode {
	case modePrependOlder:
		pane.Logs = mergeLogs(events, pane.Logs)
		if len(events) > 0 {
			pane.ScrollOffset += len(events)
		}
	default:
		pane.Logs = mergeLogs(pane.Logs, events)
	}
	pane.HasMore = snapshot.Page.HasMore || snapshot.Page.HasOlder
	pane.NextBefore = firstNonEmpty(snapshot.Page.NextBefore, sequenceBefore(snapshot.Page.OldestSequence))
	pane.LogError = ""
	pane.trimLogs(m.maxScrollback)
	if pane.Follow && target.Mode != modePrependOlder {
		pane.ScrollOffset = 0
	}
}

func (m *Manager) MarkLogFetchFailed(target LogTarget, message string) {
	pane := m.panes[target.PaneID]
	if pane == nil {
		return
	}
	pane.LogError = strings.TrimSpace(message)
}

func (m *Manager) AppendLog(event relaybaseclient.LogEvent) {
	for _, id := range m.visibleIDs() {
		pane := m.panes[id]
		if pane == nil || !paneMatchesLog(*pane, event) {
			continue
		}
		pane.appendLog(event, m.maxScrollback)
	}
}

func (m *Manager) selectedPane() *Pane {
	id := m.SelectedPaneID()
	if id == "" {
		return nil
	}
	return m.panes[id]
}

func (m *Manager) visibleIDs() []string {
	ids := []string{}
	for _, id := range m.order {
		pane := m.panes[id]
		if pane == nil || pane.Hidden {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

func (m *Manager) currentPageIDs() []string {
	ids := m.visibleIDs()
	start := m.page * MaxPanesPerPage
	if start >= len(ids) {
		start = 0
	}
	end := minInt(start+MaxPanesPerPage, len(ids))
	return ids[start:end]
}

func (m Manager) snapshotsForIDs(ids []string) []PaneSnapshot {
	snapshots := make([]PaneSnapshot, 0, len(ids))
	selectedID := m.SelectedPaneID()
	for _, id := range ids {
		pane := m.panes[id]
		if pane == nil {
			continue
		}
		snapshots = append(snapshots, m.snapshotForPane(*pane, id == selectedID, id == m.focusedID))
	}
	return snapshots
}

func (m Manager) snapshotForPane(pane Pane, selected bool, focused bool) PaneSnapshot {
	height := maxInt(m.layout.PaneHeight-5, 3)
	if focused {
		height = maxInt(m.layout.Height-6, 8)
	}
	return PaneSnapshot{
		ID:           pane.ID,
		AppID:        pane.AppID,
		GroupID:      pane.GroupID,
		Role:         pane.Role,
		PaneLabel:    pane.PaneLabel,
		DisplayName:  pane.DisplayName,
		Title:        pane.Title,
		Status:       pane.Status,
		RouteLabel:   pane.Route.Label(),
		PID:          pane.PID,
		Port:         pane.Port,
		LastError:    pane.LastError,
		Pinned:       pane.Pinned,
		Follow:       pane.Follow,
		Focused:      focused,
		Selected:     selected,
		Color:        pane.Color,
		Page:         m.page,
		LogLines:     pane.logLines(height),
		HasMore:      pane.HasMore,
		NextBefore:   pane.NextBefore,
		LogError:     pane.LogError,
		ScrollOffset: pane.ScrollOffset,
	}
}

func (m *Manager) sortOrder() {
	sort.SliceStable(m.order, func(left int, right int) bool {
		leftPane := m.panes[m.order[left]]
		rightPane := m.panes[m.order[right]]
		if leftPane == nil || rightPane == nil {
			return m.order[left] < m.order[right]
		}
		leftPreference := preferredOrderIndex(m.orderPrefs, leftPane.ID)
		rightPreference := preferredOrderIndex(m.orderPrefs, rightPane.ID)
		if leftPreference != rightPreference {
			return leftPreference < rightPreference
		}
		return leftPane.SortKey < rightPane.SortKey
	})
}

func (m *Manager) restoreSelection(selectedID string) {
	ids := m.visibleIDs()
	if len(ids) == 0 {
		m.selectedIndex = 0
		m.page = 0
		m.focusedID = ""
		return
	}
	if selectedID != "" {
		for index, id := range ids {
			if id == selectedID {
				m.selectedIndex = index
				m.page = index / MaxPanesPerPage
				return
			}
		}
	}
	m.clampSelection()
}

func (m *Manager) clampSelection() {
	ids := m.visibleIDs()
	if len(ids) == 0 {
		m.selectedIndex = 0
		m.page = 0
		m.focusedID = ""
		return
	}
	m.page = clamp(m.page, 0, m.PageCount()-1)
	m.selectedIndex = clamp(m.selectedIndex, 0, len(ids)-1)
	if m.selectedIndex/MaxPanesPerPage != m.page {
		m.selectedIndex = m.page * MaxPanesPerPage
		m.selectedIndex = clamp(m.selectedIndex, 0, len(ids)-1)
	}
}

func (m *Manager) refreshLayout() {
	m.layout = CalculateLayout(m.layout.Width, m.layout.Height, len(m.CurrentPagePanes()))
}

func (m *Manager) normalizeComponent(component relaybaseclient.AppComponent, groupNames map[string]string) (relaybaseclient.AppComponent, bool) {
	if strings.TrimSpace(component.AppID) == "" {
		m.diagnostics = append(m.diagnostics, Diagnostic{
			Code:     "component_app_id_missing",
			Severity: "warning",
			Message:  "A component from daemon state did not include appId and was not rendered.",
		})
		return relaybaseclient.AppComponent{}, false
	}

	component.AppID = strings.TrimSpace(component.AppID)
	component.GroupID = firstNonEmpty(component.GroupID, component.AppID)
	component.Role = normalizeRole(component.Role, &m.diagnostics, component.AppID)
	component.PaneLabel = firstNonEmpty(component.PaneLabel, defaultLabelForRole(component.Role))
	component.DisplayName = firstNonEmpty(component.DisplayName, groupNames[component.GroupID], component.AppID)
	component.Status = normalizeStatus(component.Status, &m.diagnostics, component.AppID)
	return component, true
}

func componentsFromState(state *relaybaseclient.RelaybaseState) []relaybaseclient.AppComponent {
	if state == nil {
		return nil
	}
	if len(state.Components) > 0 {
		return append([]relaybaseclient.AppComponent(nil), state.Components...)
	}
	components := []relaybaseclient.AppComponent{}
	for _, group := range state.Groups {
		components = append(components, group.Components...)
	}
	if len(components) > 0 {
		return components
	}
	for _, app := range state.Apps {
		components = append(components, relaybaseclient.AppComponent{
			AppID:       app.ID,
			GroupID:     app.ID,
			Role:        defaultComponentRole,
			PaneLabel:   defaultComponentLabel,
			DisplayName: firstNonEmpty(app.Name, app.ID),
			Status:      firstNonEmpty(app.RuntimeStatus, defaultStoppedStatus),
			PID:         app.PID,
			Port:        app.Port,
			LastError:   app.LastError,
		})
	}
	return components
}

func groupNamesFromState(state *relaybaseclient.RelaybaseState) map[string]string {
	names := map[string]string{}
	if state == nil {
		return names
	}
	for _, group := range state.Groups {
		if group.GroupID != "" && group.DisplayName != "" {
			names[group.GroupID] = group.DisplayName
		}
	}
	return names
}

func paneID(component relaybaseclient.AppComponent) string {
	return component.GroupID + ":" + component.AppID + ":" + component.Role + ":" + component.PaneLabel
}

func applyVisibility(pane *Pane, existed bool) {
	if pane.Pinned {
		pane.Hidden = false
		return
	}
	if pane.UserHidden {
		pane.Hidden = true
		return
	}
	switch pane.Status {
	case "starting", "running":
		pane.Hidden = false
	case "stopped":
		pane.Hidden = true
	case "failed":
		if !existed {
			pane.Hidden = false
		}
	default:
		if shouldAutoOpen(pane.Status) {
			pane.Hidden = false
		}
	}
}

func shouldAutoOpen(status string) bool {
	switch status {
	case "starting", "running", "stopping", "failed", "degraded":
		return true
	default:
		return false
	}
}

func normalizeRole(role string, diagnostics *[]Diagnostic, appID string) string {
	normalized := strings.ToLower(strings.TrimSpace(role))
	switch normalized {
	case "frontend", "backend", "worker", "database", "service", "other":
		return normalized
	case "":
		return defaultComponentRole
	default:
		*diagnostics = append(*diagnostics, Diagnostic{
			Code:     "component_role_unknown",
			Severity: "warning",
			Message:  fmt.Sprintf("Component %s used unknown role %q; rendering as other.", appID, role),
		})
		return defaultComponentRole
	}
}

func normalizeStatus(status string, diagnostics *[]Diagnostic, appID string) string {
	normalized := strings.ToLower(strings.TrimSpace(status))
	switch normalized {
	case "stopped", "starting", "running", "stopping", "failed", "degraded":
		return normalized
	case "":
		return defaultStoppedStatus
	default:
		*diagnostics = append(*diagnostics, Diagnostic{
			Code:     "component_status_unknown",
			Severity: "warning",
			Message:  fmt.Sprintf("Component %s used unknown status %q; rendering as degraded.", appID, status),
		})
		return "degraded"
	}
}

func defaultLabelForRole(role string) string {
	if role == "" || role == defaultComponentRole {
		return defaultComponentLabel
	}
	return role
}

func formatTitle(displayName string, paneLabel string, role string) string {
	label := firstNonEmpty(paneLabel, role, defaultComponentLabel)
	return firstNonEmpty(displayName, "App") + ": " + label
}

func paneMatchesLog(pane Pane, event relaybaseclient.LogEvent) bool {
	if event.AppID != "" && event.AppID != pane.AppID {
		return false
	}
	if event.GroupID != "" && event.GroupID != pane.GroupID {
		return false
	}
	if event.ComponentRole != "" && event.ComponentRole != pane.Role {
		return false
	}
	return event.AppID != "" || event.GroupID != "" || event.ComponentRole != ""
}

func (pane *Pane) appendLog(event relaybaseclient.LogEvent, maxScrollback int) {
	pane.Logs = mergeLogs(pane.Logs, []relaybaseclient.LogEvent{event})
	if !pane.Follow {
		pane.ScrollOffset++
	} else {
		pane.ScrollOffset = 0
	}
	pane.trimLogs(maxScrollback)
}

func (pane *Pane) trimLogs(maxScrollback int) {
	if maxScrollback <= 0 {
		maxScrollback = DefaultMaxScrollback
	}
	if len(pane.Logs) <= maxScrollback {
		return
	}
	removed := len(pane.Logs) - maxScrollback
	pane.Logs = pane.Logs[removed:]
	pane.ScrollOffset = maxInt(0, pane.ScrollOffset-removed)
}

func (pane Pane) logLines(limit int) []string {
	if limit <= 0 {
		return nil
	}
	if len(pane.Logs) == 0 {
		return nil
	}
	end := len(pane.Logs) - pane.ScrollOffset
	end = clamp(end, 0, len(pane.Logs))
	start := maxInt(0, end-limit)
	lines := []string{}
	for _, event := range pane.Logs[start:end] {
		lines = append(lines, event.DisplayLine())
	}
	return lines
}

func mergeLogs(first []relaybaseclient.LogEvent, second []relaybaseclient.LogEvent) []relaybaseclient.LogEvent {
	result := append([]relaybaseclient.LogEvent(nil), first...)
	seenSequences := map[int64]bool{}
	for _, event := range result {
		if event.Sequence > 0 {
			seenSequences[event.Sequence] = true
		}
	}
	for _, event := range second {
		if event.Sequence > 0 && seenSequences[event.Sequence] {
			continue
		}
		result = append(result, event)
		if event.Sequence > 0 {
			seenSequences[event.Sequence] = true
		}
	}
	sort.SliceStable(result, func(left int, right int) bool {
		if result[left].Sequence == 0 || result[right].Sequence == 0 {
			return left < right
		}
		return result[left].Sequence < result[right].Sequence
	})
	return result
}

func eventsFromStrings(appID string, groupID string, role string, lines []string) []relaybaseclient.LogEvent {
	events := make([]relaybaseclient.LogEvent, 0, len(lines))
	for index, line := range lines {
		events = append(events, relaybaseclient.LogEvent{
			Sequence:      int64(index + 1),
			AppID:         appID,
			GroupID:       groupID,
			ComponentRole: role,
			Stream:        "system",
			Message:       line,
		})
	}
	return events
}

func CalculateLayout(width int, height int, paneCount int) Layout {
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 18
	}
	count := clamp(paneCount, 1, MaxPanesPerPage)
	narrow := width < 64 || height < 14

	columns := 1
	rows := 1
	if narrow {
		rows = count
	} else {
		switch {
		case count <= 1:
			columns, rows = 1, 1
		case count <= 2:
			columns, rows = 2, 1
		case count <= 4:
			columns, rows = 2, 2
		case count <= 6:
			columns, rows = 3, 2
		default:
			columns, rows = 4, 2
		}
	}

	return Layout{
		Width:      width,
		Height:     height,
		Columns:    columns,
		Rows:       rows,
		PaneWidth:  maxInt(20, width/columns),
		PaneHeight: maxInt(6, height/rows),
		Narrow:     narrow,
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func boolSet(values []string) map[string]bool {
	set := map[string]bool{}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			set[strings.TrimSpace(value)] = true
		}
	}
	return set
}

func copyStringMap(input map[string]string) map[string]string {
	output := map[string]string{}
	for key, value := range input {
		if strings.TrimSpace(key) != "" && strings.TrimSpace(value) != "" {
			output[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return output
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

func preferredOrderIndex(order []string, id string) int {
	for index, value := range order {
		if value == id {
			return index
		}
	}
	return len(order) + 1
}

func sequenceBefore(sequence int64) string {
	if sequence <= 0 {
		return ""
	}
	return fmt.Sprintf("%d", sequence)
}

func clamp(value int, low int, high int) int {
	if high < low {
		return low
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
