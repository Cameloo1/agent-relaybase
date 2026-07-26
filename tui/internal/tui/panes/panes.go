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
	ID            string
	AppID         string
	GroupID       string
	Role          string
	PaneLabel     string
	DisplayName   string
	Title         string
	Status        string
	RouteLabel    string
	PID           int
	Port          int
	LastError     string
	Pinned        bool
	Follow        bool
	Focused       bool
	Selected      bool
	Color         string
	Page          int
	LogLines      []string
	LogLineModels []PaneLogLine
	HasMore       bool
	NextBefore    string
	LogError      string
	ScrollOffset  int
}

// ReopenCandidate describes a currently hidden pane that can be restored
// without changing the daemon-owned lifecycle state of its app.
type ReopenCandidate struct {
	PaneID      string
	AppID       string
	DisplayName string
	Title       string
	PaneLabel   string
	Status      string
	UserClosed  bool
	StableOrder int
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
	current       map[string]bool
	order         []string
	selectedIndex int
	page          int
	pageSize      int
	focusedID     string
	layout        Layout
	diagnostics   []Diagnostic
	maxScrollback int
	pinnedPrefs   map[string]bool
	hiddenPrefs   map[string]bool
	recentHidden  []string
	orderPrefs    []string
	colorPrefs    map[string]string
}

func NewManager() Manager {
	initialLayout := CalculateLayout(80, 18, 1)
	return Manager{
		panes:         map[string]*Pane{},
		current:       map[string]bool{},
		order:         []string{},
		selectedIndex: 0,
		page:          0,
		layout:        initialLayout,
		// Bubble Tea supplies the real terminal size before interactive use. Keep
		// the historical eight-pane page convention until that first Resize so a
		// persisted page is not reinterpreted through provisional geometry.
		pageSize:      MaxPanesPerPage,
		maxScrollback: DefaultMaxScrollback,
		pinnedPrefs:   map[string]bool{},
		hiddenPrefs:   map[string]bool{},
		recentHidden:  []string{},
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
		applyVisibility(existing)
	}

	for id, pane := range m.panes {
		if seen[id] {
			continue
		}
		if !pane.Pinned && pane.Status != "failed" {
			pane.Hidden = true
		}
	}
	m.current = seen

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
	m.recentHidden = uniqueStrings(hidden)
	m.orderPrefs = uniqueStrings(order)
	m.colorPrefs = copyStringMap(colors)
	for id, pane := range m.panes {
		pane.Pinned = m.pinnedPrefs[id]
		pane.UserHidden = m.hiddenPrefs[id]
		pane.Color = m.colorPrefs[id]
		applyVisibility(pane)
	}
	m.sortOrder()
	m.page = maxInt(0, lastPage)
	m.selectedIndex = m.page * m.pageCapacity()
	if len(m.visibleIDs()) > 0 {
		m.clampSelection()
	}
	m.refreshLayout()
}

func (m *Manager) Resize(width int, height int) {
	oldHeights := map[string]int{}
	for id, pane := range m.panes {
		if pane != nil && !pane.Follow {
			oldHeights[id] = m.logDisplayHeight(*pane, id == m.focusedID)
		}
	}
	m.pageSize = CalculatePageCapacity(width, height)
	if len(m.visibleIDs()) > 0 {
		m.page = m.selectedIndex / m.pageCapacity()
		m.clampSelection()
	}
	m.layout = CalculateLayout(width, height, len(m.currentPageIDs()))
	for id, oldHeight := range oldHeights {
		pane := m.panes[id]
		if pane == nil || pane.Follow {
			continue
		}
		newHeight := m.logDisplayHeight(*pane, id == m.focusedID)
		pane.ScrollOffset += oldHeight - newHeight
		m.clampPaneScrollOffset(id, pane)
	}
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
	pageSize := m.pageCapacity()
	pages := count / pageSize
	if count%pageSize != 0 {
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

func (m Manager) PaneSnapshot(id string) *PaneSnapshot {
	pane := m.panes[id]
	if pane == nil {
		return nil
	}
	snapshot := m.snapshotForPane(*pane, id == m.SelectedPaneID(), id == m.focusedID)
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
	seen := map[string]bool{}
	for _, id := range m.recentHidden {
		pane := m.panes[id]
		if pane != nil && pane.UserHidden {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	for _, id := range m.order {
		pane := m.panes[id]
		if pane != nil && pane.UserHidden && !seen[id] {
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

	pageSize := m.pageCapacity()
	local := m.selectedIndex - m.page*pageSize
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
	m.selectedIndex = m.page*pageSize + next
	m.clampSelection()
}

func (m *Manager) NextPage() {
	if m.PageCount() <= 1 {
		return
	}
	m.page = clamp(m.page+1, 0, m.PageCount()-1)
	m.selectedIndex = m.page * m.pageCapacity()
	m.clampSelection()
	m.refreshLayout()
}

func (m *Manager) PreviousPage() {
	if m.PageCount() <= 1 {
		return
	}
	m.page = clamp(m.page-1, 0, m.PageCount()-1)
	m.selectedIndex = m.page * m.pageCapacity()
	m.clampSelection()
	m.refreshLayout()
}

func (m *Manager) SetPage(page int) {
	m.page = clamp(page, 0, m.PageCount()-1)
	m.selectedIndex = m.page * m.pageCapacity()
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
		m.page = index / m.pageCapacity()
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
	} else {
		applyVisibility(pane)
	}
	m.clampSelection()
	m.refreshLayout()
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
		applyVisibility(pane)
	}
	m.clampSelection()
	m.refreshLayout()
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
	m.recentHidden = moveToFront(m.recentHidden, pane.ID)
	if m.focusedID == pane.ID {
		m.focusedID = ""
	}
	m.clampSelection()
	m.refreshLayout()
}

func (m Manager) CanReopen() bool {
	return len(m.ReopenCandidates()) > 0
}

// ReopenCandidates returns user-closed panes in most-recently-closed order,
// followed by other hidden panes in stable pane order.
func (m Manager) ReopenCandidates() []ReopenCandidate {
	result := []ReopenCandidate{}
	seen := map[string]bool{}
	appendCandidate := func(id string, userClosed bool) {
		pane := m.panes[id]
		if pane == nil || !m.current[id] || !pane.Hidden || seen[id] {
			return
		}
		seen[id] = true
		result = append(result, ReopenCandidate{
			PaneID:      pane.ID,
			AppID:       pane.AppID,
			DisplayName: pane.DisplayName,
			Title:       pane.Title,
			PaneLabel:   pane.PaneLabel,
			Status:      pane.Status,
			UserClosed:  userClosed,
			StableOrder: len(result),
		})
	}
	for _, id := range m.recentHidden {
		pane := m.panes[id]
		appendCandidate(id, pane != nil && pane.UserHidden)
	}
	for _, id := range m.order {
		appendCandidate(id, false)
	}
	return result
}

// PaneIDsForApp returns every pane for an app in stable pane order, including
// panes that are currently hidden.
func (m Manager) PaneIDsForApp(appID string) []string {
	ids := []string{}
	for _, id := range m.order {
		pane := m.panes[id]
		if pane != nil && m.current[id] && pane.AppID == appID {
			ids = append(ids, id)
		}
	}
	return ids
}

// RevealAndSelectPane restores the exact pane requested and selects it. It
// never starts, stops, or restarts the daemon-owned app.
func (m *Manager) RevealAndSelectPane(paneID string) bool {
	pane := m.panes[paneID]
	if pane == nil || !m.current[paneID] {
		return false
	}
	pane.UserHidden = false
	pane.Hidden = false
	if pane.Status == "stopped" {
		pane.Pinned = true
	}
	for index, id := range m.visibleIDs() {
		if id == paneID {
			m.selectedIndex = index
			m.page = index / m.pageCapacity()
			break
		}
	}
	m.clampSelection()
	m.refreshLayout()
	return true
}

// ReopenPane restores one explicit candidate and removes it from close recency.
func (m *Manager) ReopenPane(paneID string) bool {
	if !m.RevealAndSelectPane(paneID) {
		return false
	}
	m.recentHidden = removeString(m.recentHidden, paneID)
	return true
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
	m.ScrollPane(m.SelectedPaneID(), delta)
}

func (m *Manager) ScrollPane(id string, delta int) bool {
	pane := m.panes[id]
	if pane == nil {
		return false
	}
	pane.ScrollOffset += delta
	m.clampPaneScrollOffset(id, pane)
	if pane.ScrollOffset > 0 {
		pane.Follow = false
	} else {
		pane.Follow = true
	}
	return true
}

func (m Manager) Last20LogDisplayLines(id string) []string {
	pane := m.panes[id]
	if pane == nil || len(pane.Logs) == 0 {
		return nil
	}
	lines := make([]string, 0, minInt(CopyLogLineLimit, len(pane.Logs)))
	for index := len(pane.Logs) - 1; index >= 0 && len(lines) < CopyLogLineLimit; index-- {
		line, ok := ProjectLogEvent(pane.Logs[index])
		if !ok {
			continue
		}
		lines = append(lines, line.Text)
	}
	for left, right := 0, len(lines)-1; left < right; left, right = left+1, right-1 {
		lines[left], lines[right] = lines[right], lines[left]
	}
	return lines
}

func (m Manager) Last20LogPayload(id string) (string, int) {
	lines := m.Last20LogDisplayLines(id)
	return strings.Join(lines, "\n"), len(lines)
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
	return m.OlderLogTargetForPane(m.SelectedPaneID())
}

func (m *Manager) OlderLogTargetForPane(id string) *LogTarget {
	pane := m.panes[id]
	if pane == nil || !pane.HasMore || pane.NextBefore == "" {
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

// IsPaneAtOldestLogBoundary reports whether the current pane viewport has
// reached its oldest retained display line. It intentionally uses projected
// lines, so empty/raw log events cannot create a false scroll boundary.
func (m Manager) IsPaneAtOldestLogBoundary(id string) bool {
	pane := m.panes[id]
	if pane == nil {
		return false
	}
	lineCount := len(pane.projectedLogLines())
	height := m.logDisplayHeight(*pane, id == m.focusedID)
	maximumOffset := maxInt(0, lineCount-height)
	return pane.ScrollOffset >= maximumOffset
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

	beforeLineCount := len(pane.projectedLogLines())
	switch target.Mode {
	case modePrependOlder:
		pane.Logs = mergeLogs(events, pane.Logs)
	default:
		pane.Logs = mergeLogs(pane.Logs, events)
		if !pane.Follow {
			pane.ScrollOffset += maxInt(0, len(pane.projectedLogLines())-beforeLineCount)
		}
	}
	pane.HasMore = snapshot.Page.HasMore || snapshot.Page.HasOlder
	pane.NextBefore = firstNonEmpty(string(snapshot.Page.NextBefore), sequenceBefore(snapshot.Page.OldestSequence))
	pane.LogError = ""
	pane.trimLogs(m.maxScrollback)
	if pane.Follow && target.Mode != modePrependOlder {
		pane.ScrollOffset = 0
	}
	m.clampPaneScrollOffset(target.PaneID, pane)
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
		m.clampPaneScrollOffset(id, pane)
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
	pageSize := m.pageCapacity()
	start := m.page * pageSize
	if start >= len(ids) {
		start = 0
	}
	end := minInt(start+pageSize, len(ids))
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
	logProjection := pane.logProjection(m.logDisplayHeight(pane, focused))
	logLineModels := logProjection.Lines
	return PaneSnapshot{
		ID:            pane.ID,
		AppID:         pane.AppID,
		GroupID:       pane.GroupID,
		Role:          pane.Role,
		PaneLabel:     pane.PaneLabel,
		DisplayName:   pane.DisplayName,
		Title:         pane.Title,
		Status:        pane.Status,
		RouteLabel:    pane.Route.Label(),
		PID:           pane.PID,
		Port:          pane.Port,
		LastError:     pane.LastError,
		Pinned:        pane.Pinned,
		Follow:        pane.Follow,
		Focused:       focused,
		Selected:      selected,
		Color:         pane.Color,
		Page:          m.page,
		LogLines:      paneLogLineTexts(logLineModels),
		LogLineModels: logLineModels,
		HasMore:       pane.HasMore,
		NextBefore:    pane.NextBefore,
		LogError:      pane.LogError,
		ScrollOffset:  logProjection.ManagerScrollOffset,
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
				m.page = index / m.pageCapacity()
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
	pageSize := m.pageCapacity()
	if m.selectedIndex/pageSize != m.page {
		m.selectedIndex = m.page * pageSize
		m.selectedIndex = clamp(m.selectedIndex, 0, len(ids)-1)
	}
}

func (m *Manager) refreshLayout() {
	m.layout = CalculateLayout(m.layout.Width, m.layout.Height, len(m.CurrentPagePanes()))
}

func (m Manager) pageCapacity() int {
	if m.pageSize > 0 {
		return clamp(m.pageSize, 1, MaxPanesPerPage)
	}
	return CalculatePageCapacity(m.layout.Width, m.layout.Height)
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

func applyVisibility(pane *Pane) {
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
	case "failed", "degraded":
		// A daemon-reported failure must become observable even when the pane was
		// previously auto-hidden while stopped. Explicit user-hidden state is
		// handled above and remains authoritative.
		pane.Hidden = false
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
	beforeLineCount := len(pane.projectedLogLines())
	pane.Logs = mergeLogs(pane.Logs, []relaybaseclient.LogEvent{event})
	if !pane.Follow {
		pane.ScrollOffset += maxInt(0, len(pane.projectedLogLines())-beforeLineCount)
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
}

func (pane Pane) logLines(limit int) []string {
	return paneLogLineTexts(pane.logLineModels(limit))
}

func (pane Pane) logLineModels(limit int) []PaneLogLine {
	return pane.logProjection(limit).Lines
}

func (pane Pane) projectedLogLines() []PaneLogLine {
	return projectLogEvents(pane.Logs)
}

func (pane Pane) logProjection(height int) LogViewportProjection {
	return ProjectLogViewport(pane.projectedLogLines(), 1, maxInt(height, 1), pane.ScrollOffset)
}

func (m Manager) logDisplayHeight(pane Pane, focused bool) int {
	containerHeight := maxInt(m.layout.PaneHeight, 6)
	if focused {
		containerHeight = maxInt(m.layout.Height, 8)
	}
	linesBeforeLogs := 2
	if pane.Route.Label() != "" {
		linesBeforeLogs++
	}
	if pane.PID > 0 || pane.Port > 0 {
		linesBeforeLogs++
	}
	linesBeforeLogs++ // pane controls
	if pane.LastError != "" {
		linesBeforeLogs++
	}
	linesBeforeLogs++ // spacer before the log viewport
	logHeight := maxInt(1, containerHeight-linesBeforeLogs-2)
	if pane.LogError != "" {
		logHeight = maxInt(1, logHeight-1)
	}
	return logHeight
}

func (m Manager) clampPaneScrollOffset(id string, pane *Pane) {
	if pane == nil {
		return
	}
	maximumOffset := maxInt(0, len(pane.projectedLogLines())-m.logDisplayHeight(*pane, id == m.focusedID))
	pane.ScrollOffset = clamp(pane.ScrollOffset, 0, maximumOffset)
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
	preferredColumns := 1
	switch {
	case count <= 1:
		preferredColumns = 1
	case count <= 4:
		preferredColumns = 2
	case count <= 6:
		preferredColumns = 3
	default:
		preferredColumns = 4
	}

	const minimumPaneWidth = 28
	widthColumns := clamp(width/minimumPaneWidth, 1, 4)
	columns := minInt(preferredColumns, widthColumns)
	if height < 12 {
		columns = 1
	}
	rows := (count + columns - 1) / columns
	narrow := columns == 1 && count > 1

	return Layout{
		Width:      width,
		Height:     height,
		Columns:    columns,
		Rows:       rows,
		PaneWidth:  maxInt(12, width/columns),
		PaneHeight: maxInt(6, height/rows),
		Narrow:     narrow,
	}
}

// CalculatePageCapacity returns the largest dashboard page that preserves a
// complete full-metadata pane and at least one independently scrollable log
// row in every visible pane. Narrow terminals deliberately show one pane per
// page so controls, status, and logs remain usable instead of being clipped.
func CalculatePageCapacity(width int, height int) int {
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 18
	}
	if width < 80 {
		return 1
	}

	const minimumScrollablePaneHeight = 9
	for count := MaxPanesPerPage; count >= 1; count-- {
		if CalculateLayout(width, height, count).PaneHeight >= minimumScrollablePaneHeight {
			return count
		}
	}
	return 1
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

func moveToFront(values []string, value string) []string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return uniqueStrings(values)
	}
	result := []string{trimmed}
	for _, candidate := range uniqueStrings(values) {
		if candidate != trimmed {
			result = append(result, candidate)
		}
	}
	return result
}

func removeString(values []string, value string) []string {
	result := []string{}
	for _, candidate := range uniqueStrings(values) {
		if candidate != value {
			result = append(result, candidate)
		}
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
