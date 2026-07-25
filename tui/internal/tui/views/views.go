package views

import (
	"fmt"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	bubbleshelp "charm.land/bubbles/v2/help"
	bubbleskey "charm.land/bubbles/v2/key"
	bubblestable "charm.land/bubbles/v2/table"
	"charm.land/bubbles/v2/viewport"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/contextmenu"
	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
	"github.com/cameloo/relaybase/tui/internal/tui/keymap"
	"github.com/cameloo/relaybase/tui/internal/tui/layout"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	safemarkdown "github.com/cameloo/relaybase/tui/internal/tui/response"
	"github.com/cameloo/relaybase/tui/internal/tui/slash"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
	usagecomponent "github.com/cameloo/relaybase/tui/internal/tui/usage"
)

var ansiEscapePattern = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

type DiagnosticLine struct {
	Code     string
	Severity string
	Message  string
}

type ShellData struct {
	OperatorConsole     bool
	Width               int
	Height              int
	BodyScrollOffset    int
	ConnectionStatus    string
	EventStatus         string
	EventCount          int
	AgentStatus         string
	AgentThreadLabel    string
	StateKnown          bool
	AppCount            int
	ActiveAppCount      int
	RegisteredAppCount  int
	GroupCount          int
	Diagnostics         []DiagnosticLine
	DiagnosticsOpen     bool
	ShowHelp            bool
	KeyMap              keymap.KeyMap
	AssistantPrompt     string
	AssistantHistory    []string
	SetupPanel          string
	SuppressEmptyState  bool
	ContextMenu         *contextmenu.Snapshot
	Confirmation        *ConfirmationData
	Panes               []panes.PaneSnapshot
	Inventory           []inventory.Item
	FocusedPane         *panes.PaneSnapshot
	PaneLayout          panes.Layout
	Page                int
	PageCount           int
	ClipboardWriteReady bool
	CommandPalette      *CommandPaletteData
	StartCompletion     *StartCompletionData
	ThreadSwitcher      *ThreadSwitcherData
	CodePicker          *CodePickerData
	AppManager          *AppManagerData
	PackageManager      *PackageManagerData
	RegistrationRepairs *RegistrationRepairData
	PaneReopen          *PaneReopenData
	Help                *HelpData
	Usage               *usagecomponent.Snapshot
	Settings            *SettingsData
	ComposerView        string
	ComposerRows        int
	ComposerPasting     bool
	ResponseSource      string
	ResponseState       string
	ResponseFollow      bool
	ResponseNewOutput   int
	ResponseOffset      int
	AgentPaneExpanded   bool
	AgentChatFull       bool
	ResponseDetails     bool
	PrimaryFocus        string
	AgentTranscript     []AgentTranscriptItem
	TranscriptExpanded  map[string]bool
	TranscriptSelected  string
	TranscriptCache     *AgentTranscriptRenderCache
	ActivityFrame       int
	ActivityASCII       bool
	ActivityAnimations  bool
}

type AgentTranscriptItem struct {
	ID              string
	RunID           string
	Kind            string
	State           string
	Label           string
	Detail          string
	Output          string
	OutputLineCount int
	OutputTruncated bool
	DurationMS      int64
	Sequence        int64
	UpdatedSequence int64
}

type SettingsData struct {
	Title      string
	Breadcrumb string
	Rows       []SettingsRowData
	Selected   int
	Editing    bool
	EditValue  string
	Notice     string
	Saving     bool
	TotalRows  int
	FirstRow   int
}

type SettingsRowData struct {
	Index    int
	Label    string
	Value    string
	Hint     string
	Action   bool
	ReadOnly bool
}

// AgentTranscriptRenderCache stores only derived, sanitized row indexes. The
// daemon transcript remains authoritative; this cache lets the docked and
// full-screen Agent surfaces render just the rows intersecting the viewport.
// Bubble Tea renders on one goroutine, so the cache intentionally has no
// synchronization or persisted state.
type AgentTranscriptRenderCache struct {
	clock  uint64
	widths map[int]*agentTranscriptWidthCache
}

type agentTranscriptWidthCache struct {
	touched uint64
	items   map[string]*agentTranscriptOutputCache
}

type agentTranscriptOutputCache struct {
	runID             string
	kind              string
	state             string
	updatedSequence   int64
	output            string
	outputLineCount   int
	outputTruncated   bool
	lines             []string
	wrappedRowOffsets []int
}

const maxAgentTranscriptCachedWidths = 4

func NewAgentTranscriptRenderCache() *AgentTranscriptRenderCache {
	return &AgentTranscriptRenderCache{widths: map[int]*agentTranscriptWidthCache{}}
}

func (cache *AgentTranscriptRenderCache) Reset() {
	if cache == nil {
		return
	}
	cache.widths = map[int]*agentTranscriptWidthCache{}
	cache.clock = 0
}

type CommandPaletteData struct {
	Matches         []slash.CommandMatch
	SelectedVisible int
	Total           int
}

// StartCompletionData is a presentation-only window over registered daemon
// state. Accepting a row only inserts a stable id into the composer.
type StartCompletionData struct {
	Items           []inventory.Item
	SelectedVisible int
	Total           int
	Query           string
}

// ThreadSwitcherData is a display-only projection. Session activation remains
// a typed daemon request owned by the root model.
type ThreadSwitcherData struct {
	Entries  []ThreadSwitcherEntry
	Selected int
	Loading  bool
}

type ThreadSwitcherEntry struct {
	Index     int
	Title     string
	Active    bool
	Attention bool
}

// CodePickerData exposes only selection labels to the view. Exact sanitized
// code remains in the root model until the explicit clipboard command runs.
type CodePickerData struct {
	LineCounts []int
	Selected   int
}

type HelpData struct {
	SearchView   string
	Query        string
	Matches      []slash.CommandMatch
	Selected     int
	DetailOffset int
}

// AppManagerData is a presentation-only projection of daemon-owned app state
// and root-model action eligibility. It never performs lifecycle work.
type AppManagerData struct {
	Items            []inventory.Item
	Selected         int
	Offset           int
	Mode             string
	Surface          string
	Actions          []AppManagerAction
	SelectedAction   int
	ActionOffset     int
	ConnectionStatus string
	StateKnown       bool
	Refreshing       bool
	Notice           string
	Rename           *AppManagerRenameData
	PackagePicker    *PackageTableData
	PackageNameInput string
}

type AppManagerRenameData struct {
	StableID    string
	CurrentName string
	InputView   string
	Draft       string
}

type AppManagerAction struct {
	ID             string
	Label          string
	Enabled        bool
	DisabledReason string
}

// PackageTableData is the shared read-only package inventory projection used
// by both the full package manager and the app-scoped add picker.
type PackageTableData struct {
	Rows       []PackageTableRow
	Selected   int
	Offset     int
	PickerMode bool
}

type PackageTableRow struct {
	ID             string
	Name           string
	MemberCount    int
	Revision       int
	LastRun        string
	Membership     string
	Enabled        bool
	DisabledReason string
}

type PackageManagerData struct {
	Surface          string
	Table            PackageTableData
	ConnectionStatus string
	Refreshing       bool
	Notice           string
	Actions          []AppManagerAction
	SelectedAction   int
	ActionOffset     int
	SelectedPackage  *PackageTableRow
	NameInput        string
	NameCurrent      string
	Creating         bool
	Members          []PackageMemberRow
	SelectedMember   int
	MemberOffset     int
	Run              *PackageRunData
	RunOffset        int
}

type PackageMemberRow struct {
	AppID    string
	Name     string
	Included bool
	Ordinal  int
	Missing  bool
}

type PackageRunData struct {
	ID      string
	Status  string
	Members []PackageRunMemberData
}

type PackageRunMemberData struct {
	AppID string
	State string
}

type RegistrationRepairData struct {
	AppID    string
	Choices  []RegistrationRepairChoice
	Selected int
}

type RegistrationRepairChoice struct {
	ID          string
	Label       string
	Reason      string
	Recommended bool
}

// PaneReopenData is a presentation-only chooser. Selecting a row only reveals
// an existing pane; daemon lifecycle state remains outside the view and TUI.
type PaneReopenData struct {
	Items    []PaneReopenItem
	Selected int
	Offset   int
	Notice   string
	AppID    string
}

type PaneReopenItem struct {
	PaneID     string
	Name       string
	Project    string
	Status     string
	UserClosed bool
}

type ShellFrame struct {
	Text   string
	HitMap components.HitMap
}

type ConfirmationData struct {
	Action         string
	Target         string
	Risk           string
	ExpectedResult string
	Details        []string
}

func RenderShell(style styles.Styles, data ShellData) string {
	return BuildShell(style, data).Text
}

func BuildShell(style styles.Styles, data ShellData) ShellFrame {
	if data.OperatorConsole {
		return buildOperatorShell(style, data)
	}
	width := data.Width
	if width <= 0 {
		width = 80
	}
	height := data.Height
	if height <= 0 {
		height = 24
	}

	header := style.Header.Width(width).Render("Relaybase TUI")
	statusLine := renderStatusLine(data, width)
	status := style.Status.Width(width).Render(truncateText(statusLine, maxInt(width-2, 1)))

	body := renderBody(style, data)
	assistantPrompt := truncateText(oneLineText(data.AssistantPrompt), maxInt(width-4, 1))
	assistant := components.RenderAssistantBar(style, assistantPrompt, width)
	palette := ""
	paletteHeight := 0
	if data.StartCompletion != nil {
		palette = renderStartCompletion(style, *data.StartCompletion, width)
		paletteHeight = lipgloss.Height(palette)
	} else if data.CommandPalette != nil {
		palette = renderCommandPalette(style, *data.CommandPalette, width)
		paletteHeight = lipgloss.Height(palette)
	}
	bodyHeight := maxInt(1, height-lipgloss.Height(header)-lipgloss.Height(status)-paletteHeight-lipgloss.Height(assistant))
	viewportFrame := renderBodyViewportFrame(body, bodyHeight, data.BodyScrollOffset, width)
	body = viewportFrame.Text
	hitMap := components.HitMap{}
	bodyTop := lipgloss.Height(header) + lipgloss.Height(status)
	for _, region := range paneHitRegions(style, data) {
		if transformed, ok := transformBodyRegion(region, viewportFrame, width, bodyTop); ok {
			hitMap.Add(transformed)
		}
	}
	for _, region := range helpHitRegions(data) {
		if transformed, ok := transformBodyRegion(region, viewportFrame, width, bodyTop); ok {
			hitMap.Add(transformed)
		}
	}
	paletteTop := bodyTop + lipgloss.Height(body)
	if data.StartCompletion != nil {
		for _, region := range startCompletionHitRegions(*data.StartCompletion, palette, width) {
			region.Rect = region.Rect.Translate(0, paletteTop)
			hitMap.Add(region)
		}
	} else if data.CommandPalette != nil {
		for _, region := range commandPaletteHitRegions(*data.CommandPalette, palette, width) {
			region.Rect = region.Rect.Translate(0, paletteTop)
			hitMap.Add(region)
		}
	}

	parts := []string{header, status, body}
	if palette != "" {
		parts = append(parts, palette)
	}
	parts = append(parts, assistant)
	return ShellFrame{Text: lipgloss.JoinVertical(lipgloss.Left, parts...), HitMap: hitMap}
}

// buildOperatorShell is deliberately a pure projection. It does not own
// lifecycle, Agent execution, thread mutation, or clipboard side effects.
func buildOperatorShell(style styles.Styles, data ShellData) ShellFrame {
	width := maxInt(data.Width, 1)
	height := maxInt(data.Height, 1)
	metrics := layout.ComputeWithOptions(width, height, data.ComposerRows, layout.Options{AgentExpanded: data.AgentPaneExpanded})
	if metrics.ResizeRequired {
		text := fixedRegion(style.Help, "Relaybase operator console needs at least 40×18 cells.\n\nResize the terminal; drafts, panes, and Agent state are preserved.", width, height)
		return ShellFrame{Text: text, HitMap: components.HitMap{}}
	}
	if data.AgentChatFull {
		return buildAgentChatShell(style, data, metrics)
	}

	rail := fixedRegion(style.Status, renderOperatorRail(style, data, metrics.Rail.Width), metrics.Rail.Width, metrics.Rail.Height)
	base := operatorPaneProjection(data)
	// The pane manager owns scrolling inside each app log. The operator pane
	// region is an exact projection and must never acquire a competing outer
	// viewport or consume a row with a global scroll indicator.
	body := renderBody(style, base)
	panesText := fixedRegion(style.Body, body, metrics.Panes.Width, metrics.Panes.Height)
	paneFrame := bodyViewportFrame{Text: panesText, ContentHeight: metrics.Panes.Height}
	if operatorInventoryViewport(base) {
		paneFrame = renderBodyViewportFrame(body, metrics.Panes.Height, data.BodyScrollOffset, metrics.Panes.Width)
		panesText = fixedRegion(style.Body, paneFrame.Text, metrics.Panes.Width, metrics.Panes.Height)
	}

	composer := strings.TrimSpace(data.ComposerView)
	if composer == "" {
		composer = "> " + cleanInlineText(data.AssistantPrompt)
	}
	composerHeader := "Composer " + style.ControlMuted.Render("[Ctrl+G agent pane]") + " > _ • Enter submit • Ctrl+J newline"
	if data.PrimaryFocus == "composer" {
		composerHeader += " " + style.Control.Render("[focused]")
	}
	if data.ComposerPasting {
		composerHeader = "Composer " + style.ControlMuted.Render("[Ctrl+G agent pane]") + " > _ • Pasting… • Esc cancel"
	}
	composerText := framedFixedRegion(style.Assistant, composerHeader+"\n"+composer, width, metrics.Composer.Height)

	workspace := lipgloss.JoinVertical(lipgloss.Left, rail, panesText)
	upper := workspace
	agentRegions := []components.HitRegion{}
	if metrics.AgentDocked {
		agentDock, regions := renderAgentDockFrame(style, data, metrics.Agent)
		agentRegions = regions
		upper = lipgloss.JoinHorizontal(lipgloss.Top, workspace, agentDock)
	}
	frame := ShellFrame{Text: lipgloss.JoinVertical(lipgloss.Left, upper, composerText)}
	for _, region := range paneHitRegions(style, base) {
		if transformed, ok := transformBodyRegion(region, paneFrame, metrics.Panes.Width, metrics.Panes.Y); ok {
			frame.HitMap.Add(transformed)
		}
	}
	if metrics.AgentDocked {
		frame.HitMap.Add(components.HitRegion{Rect: metrics.Agent, Kind: components.HitResponse})
		for _, region := range agentRegions {
			frame.HitMap.Add(region)
		}
	}
	frame.HitMap.Add(components.HitRegion{Rect: metrics.Composer, Kind: components.HitComposer})

	if overlay := operatorOverlay(style, data, metrics, frame.Text); overlay.Text != "" {
		frame.HitMap.Add(components.HitRegion{Rect: overlay.Bounds, Kind: components.HitModal})
		for _, region := range overlay.HitRegions {
			frame.HitMap.Add(region)
		}
		frame.Text = overlay.Text
		return frame
	}
	if data.StartCompletion != nil {
		palette := renderStartCompletion(style, *data.StartCompletion, metrics.Panes.Width)
		paletteHeight := lipgloss.Height(palette)
		bounds := components.Rect{
			Y:      maxInt(metrics.Rail.Height, metrics.Composer.Y-paletteHeight),
			Width:  metrics.Panes.Width,
			Height: paletteHeight,
		}
		frame.Text = composeOperatorLayer(frame.Text, palette, bounds, metrics.Bounds)
		for _, region := range startCompletionHitRegions(*data.StartCompletion, palette, metrics.Panes.Width) {
			region.Rect = region.Rect.Translate(bounds.X, bounds.Y)
			frame.HitMap.Add(region)
		}
	} else if data.CommandPalette != nil {
		palette := renderCommandPalette(style, *data.CommandPalette, metrics.Panes.Width)
		paletteHeight := lipgloss.Height(palette)
		bounds := components.Rect{
			Y:      maxInt(metrics.Rail.Height, metrics.Composer.Y-paletteHeight),
			Width:  metrics.Panes.Width,
			Height: paletteHeight,
		}
		frame.Text = composeOperatorLayer(frame.Text, palette, bounds, metrics.Bounds)
		for _, region := range commandPaletteHitRegions(*data.CommandPalette, palette, metrics.Panes.Width) {
			region.Rect = region.Rect.Translate(bounds.X, bounds.Y)
			frame.HitMap.Add(region)
		}
	}
	return frame
}

func buildAgentChatShell(style styles.Styles, data ShellData, metrics layout.Metrics) ShellFrame {
	width := maxInt(data.Width, 1)
	chatBounds := components.Rect{Width: width, Height: maxInt(1, metrics.Composer.Y)}
	responseFrame := renderAgentResponseFrame(style, data, chatBounds.Width, chatBounds.Height)

	composer := strings.TrimSpace(data.ComposerView)
	if composer == "" {
		composer = "> " + cleanInlineText(data.AssistantPrompt)
	}
	composerHeader := "Composer " + style.ControlMuted.Render("[F6 workspace]") + " > _ • Enter submit • Ctrl+J newline"
	if data.PrimaryFocus == "composer" {
		composerHeader += " " + style.Control.Render("[focused]")
	}
	if data.ComposerPasting {
		composerHeader = "Composer " + style.ControlMuted.Render("[F6 workspace]") + " > _ • Pasting… • Esc cancel"
	}
	composerText := framedFixedRegion(style.Assistant, composerHeader+"\n"+composer, width, metrics.Composer.Height)
	frame := ShellFrame{Text: lipgloss.JoinVertical(lipgloss.Left, responseFrame.Text, composerText)}
	frame.HitMap.Add(components.HitRegion{Rect: chatBounds, Kind: components.HitResponse})
	for _, region := range responseFrame.HitRegions {
		frame.HitMap.Add(region)
	}
	frame.HitMap.Add(components.HitRegion{Rect: metrics.Composer, Kind: components.HitComposer})

	if overlay := operatorOverlay(style, data, metrics, frame.Text); overlay.Text != "" {
		frame.HitMap.Add(components.HitRegion{Rect: overlay.Bounds, Kind: components.HitModal})
		for _, region := range overlay.HitRegions {
			frame.HitMap.Add(region)
		}
		frame.Text = overlay.Text
		return frame
	}
	if data.StartCompletion != nil {
		palette := renderStartCompletion(style, *data.StartCompletion, width)
		bounds := components.Rect{Y: maxInt(0, metrics.Composer.Y-lipgloss.Height(palette)), Width: width, Height: lipgloss.Height(palette)}
		frame.Text = composeOperatorLayer(frame.Text, palette, bounds, metrics.Bounds)
		for _, region := range startCompletionHitRegions(*data.StartCompletion, palette, width) {
			region.Rect = region.Rect.Translate(bounds.X, bounds.Y)
			frame.HitMap.Add(region)
		}
	} else if data.CommandPalette != nil {
		palette := renderCommandPalette(style, *data.CommandPalette, width)
		bounds := components.Rect{Y: maxInt(0, metrics.Composer.Y-lipgloss.Height(palette)), Width: width, Height: lipgloss.Height(palette)}
		frame.Text = composeOperatorLayer(frame.Text, palette, bounds, metrics.Bounds)
		for _, region := range commandPaletteHitRegions(*data.CommandPalette, palette, width) {
			region.Rect = region.Rect.Translate(bounds.X, bounds.Y)
			frame.HitMap.Add(region)
		}
	}
	return frame
}

func operatorPaneProjection(data ShellData) ShellData {
	setupPanelOpen := strings.TrimSpace(data.SetupPanel) != ""
	data.AssistantHistory = nil
	data.Confirmation = nil
	data.ContextMenu = nil
	data.StartCompletion = nil
	data.AppManager = nil
	data.PackageManager = nil
	data.RegistrationRepairs = nil
	data.PaneReopen = nil
	data.Help = nil
	data.ShowHelp = false
	data.DiagnosticsOpen = false
	data.SetupPanel = ""
	data.SuppressEmptyState = setupPanelOpen
	return data
}

func agentDockStyle(style styles.Styles) lipgloss.Style {
	return lipgloss.NewStyle().
		Foreground(style.Body.GetForeground()).
		Background(style.Body.GetBackground()).
		Border(lipgloss.NormalBorder(), false, false, false, true).
		BorderForeground(style.Body.GetBorderLeftForeground()).
		Padding(0, 1)
}

func renderAgentDock(style styles.Styles, data ShellData, bounds components.Rect) string {
	text, _ := renderAgentDockFrame(style, data, bounds)
	return text
}

func renderAgentDockFrame(style styles.Styles, data ShellData, bounds components.Rect) (string, []components.HitRegion) {
	panelStyle := agentDockStyle(style)
	innerWidth := maxInt(1, bounds.Width-panelStyle.GetHorizontalFrameSize())
	innerHeight := maxInt(1, bounds.Height-panelStyle.GetVerticalFrameSize())
	responseFrame := renderAgentResponseFrame(style, data, innerWidth, innerHeight)
	originX := bounds.X + panelStyle.GetBorderLeftSize() + panelStyle.GetPaddingLeft()
	originY := bounds.Y + panelStyle.GetBorderTopSize() + panelStyle.GetPaddingTop()
	regions := make([]components.HitRegion, 0, len(responseFrame.HitRegions))
	for _, region := range responseFrame.HitRegions {
		region.Rect = region.Rect.Translate(originX, originY)
		regions = append(regions, region)
	}
	return panelStyle.Width(bounds.Width).Height(bounds.Height).Render(responseFrame.Text), regions
}

func renderAgentResponseContent(style styles.Styles, data ShellData, width int, height int) string {
	return renderAgentResponseFrame(style, data, width, height).Text
}

type agentResponseFrame struct {
	Text       string
	HitRegions []components.HitRegion
}

func renderAgentResponseFrame(style styles.Styles, data ShellData, width int, height int) agentResponseFrame {
	width = maxInt(1, width)
	height = maxInt(1, height)
	header := "Agent "
	if data.AgentChatFull {
		header = "Agent Chat "
	}
	header += displayAgentStatus(valueOr(data.ResponseState, valueOr(data.AgentStatus, "unknown")))
	if data.AgentThreadLabel != "" {
		header += " • " + data.AgentThreadLabel
	}
	if data.PrimaryFocus == "response" {
		header += " " + style.Control.Render("[focused]")
	}
	state := "follow"
	if !data.ResponseFollow {
		state = "paused"
		if data.ResponseNewOutput > 0 {
			state = fmt.Sprintf("%d new", data.ResponseNewOutput)
		}
	}
	controls := state + " • F6 full chat • [c] copy • [b] code • Ctrl+G close"
	if data.AgentChatFull {
		controls = state + " • F6/Esc workspace • Ctrl+E details • [c] copy • [b] code"
	}
	if len(data.AgentTranscript) > 0 {
		body := renderAgentTranscriptViewport(style, data, width, maxInt(1, height-2), data.ResponseOffset)
		regions := make([]components.HitRegion, 0, len(body.HitRegions))
		for _, region := range body.HitRegions {
			region.Rect = region.Rect.Translate(0, 2)
			regions = append(regions, region)
		}
		return agentResponseFrame{
			Text:       fixedRegion(style.Body, header+"\n"+controls+"\n"+body.Text, width, height),
			HitRegions: regions,
		}
	}
	content := ""
	contentRegions := []components.HitRegion{}
	if strings.TrimSpace(content) == "" {
		source := strings.TrimSpace(data.ResponseSource)
		if source == "" {
			source = "No Agent output yet. Submit a request in Composer."
		}
		content = (safemarkdown.SafeMarkdownRenderer{}).Render(source, maxInt(20, width)).Text
	}
	body := renderBodyViewportFrame(content, maxInt(1, height-2), data.ResponseOffset, width)
	regions := []components.HitRegion{}
	clip := components.Rect{Y: body.Offset, Width: width, Height: body.ContentHeight}
	for _, region := range contentRegions {
		transformed, ok := components.ClipAndTranslate(region.Rect, clip, 0, 2+body.IndicatorRows-body.Offset)
		if !ok {
			continue
		}
		region.Rect = transformed
		regions = append(regions, region)
	}
	return agentResponseFrame{
		Text:       fixedRegion(style.Body, header+"\n"+controls+"\n"+body.Text, width, height),
		HitRegions: regions,
	}
}

func renderAgentTranscript(style styles.Styles, data ShellData, width int) (string, []components.HitRegion) {
	if len(data.AgentTranscript) == 0 {
		return "", nil
	}
	foregroundID := ""
	foregroundSequence := int64(-1)
	for _, item := range data.AgentTranscript {
		if item.State == "active" && item.Kind == "processing" && item.UpdatedSequence >= foregroundSequence {
			foregroundID = item.ID
			foregroundSequence = item.UpdatedSequence
		}
	}
	lines := []string{}
	regions := []components.HitRegion{}
	for _, item := range data.AgentTranscript {
		if len(lines) > 0 && lines[len(lines)-1] != "" {
			lines = append(lines, "")
		}
		switch item.Kind {
		case "user", "assistant":
			title := "Agent"
			if item.Kind == "user" {
				title = "You"
			}
			lines = append(lines, style.Control.Render(title))
			textLines := wrapAgentTranscriptText(item.Output, maxInt(1, width-2))
			if len(textLines) == 0 {
				textLines = []string{"(no text)"}
			}
			for _, line := range textLines {
				lines = append(lines, "  "+line)
			}
		default:
			start := len(lines)
			animate := data.ActivityAnimations && item.ID == foregroundID
			icon := activityIcon(item.State, data.ActivityASCII, data.ActivityFrame, animate)
			label := cleanInlineText(item.Label)
			if item.Detail != "" {
				label += " — " + cleanInlineText(item.Detail)
			}
			if item.DurationMS > 0 && item.State != "active" {
				label += " " + formatActivityDuration(item.DurationMS)
			}
			header := icon + " " + label
			if item.ID == data.TranscriptSelected {
				header = "> " + header
			}
			if animate && item.State == "active" {
				header = style.Control.Render(icon+" "+activityShimmer(data.ActivityFrame, data.ActivityASCII)+" ") + label
			} else if item.State == "failed" {
				header = lipgloss.NewStyle().Foreground(style.Theme.Error).Render(header)
			} else if item.State == "waiting_approval" || item.State == "cancelled" {
				header = lipgloss.NewStyle().Foreground(style.Theme.Warning).Render(header)
			} else if item.State == "completed" {
				header = lipgloss.NewStyle().Foreground(style.Theme.Success).Render(header)
			}
			lines = append(lines, truncateStyledText(header, width))
			outputLines := wrapAgentTranscriptText(item.Output, maxInt(1, width-4))
			total := len(outputLines)
			expanded := data.TranscriptExpanded[item.ID]
			visible := len(outputLines)
			if !expanded {
				visible = minInt(5, visible)
			}
			if visible == 0 && (item.State == "completed" || item.State == "failed") {
				lines = append(lines, style.ControlMuted.Render("  ⎿ (no output)"))
			}
			for index := 0; index < visible; index++ {
				prefix := "    "
				if index == 0 {
					prefix = "  ⎿ "
				}
				lines = append(lines, prefix+truncateText(outputLines[index], maxInt(1, width-lipgloss.Width(prefix))))
			}
			hidden := maxInt(0, total-visible)
			if hidden > 0 {
				message := fmt.Sprintf("    … +%d rows — click or Enter to expand", hidden)
				if expanded && (item.OutputTruncated || total > len(outputLines)) {
					message = fmt.Sprintf("    … %d lines not retained — export the full result", hidden)
				}
				lines = append(lines, style.ControlMuted.Render(truncateText(message, width)))
			} else if item.OutputTruncated {
				lines = append(lines, style.ControlMuted.Render(truncateText("    … output was bounded — export the full result", width)))
			} else if expanded && total > 5 {
				lines = append(lines, style.ControlMuted.Render("    click or Enter to collapse"))
			}
			regions = append(regions, components.HitRegion{
				Rect: components.Rect{Y: start, Width: width, Height: maxInt(1, len(lines)-start)},
				Kind: components.HitAgentTranscript, ItemID: item.ID,
			})
		}
	}
	return strings.Join(lines, "\n"), regions
}

type agentTranscriptLayout struct {
	Blocks       []agentTranscriptBlock
	TotalRows    int
	ForegroundID string
}

type agentTranscriptBlock struct {
	ItemIndex int
	Start     int
	Rows      int
	Output    *agentTranscriptOutputCache
}

type agentTranscriptViewportFrame struct {
	Text          string
	Offset        int
	ContentHeight int
	IndicatorRows int
	TotalRows     int
	HitRegions    []components.HitRegion
}

// renderAgentTranscriptViewport virtualizes both long conversations and large
// expanded tool results. Only rows intersecting the current viewport are
// materialized; an oversize transcript is never joined into one giant string.
func renderAgentTranscriptViewport(style styles.Styles, data ShellData, width int, height int, offset int) agentTranscriptViewportFrame {
	width = maxInt(1, width)
	height = maxInt(1, height)
	layout := layoutAgentTranscript(data, width)
	contentHeight := height
	showIndicator := layout.TotalRows > height
	if showIndicator && height > 1 {
		contentHeight--
	}
	maxOffset := maxInt(0, layout.TotalRows-contentHeight)
	offset = clampInt(offset, 0, maxOffset)
	lines, regions := renderAgentTranscriptRows(style, data, layout, width, offset, contentHeight)
	for len(lines) < contentHeight {
		lines = append(lines, "")
	}
	for index, line := range lines {
		if line == "" {
			lines[index] = strings.Repeat(" ", width)
		}
	}
	indicatorRows := 0
	if showIndicator && height > 1 {
		indicator := fmt.Sprintf("scroll %d/%d  ↑/↓ PgUp/PgDn Home/End", offset, maxOffset)
		lines = append([]string{truncateText(indicator, width)}, lines...)
		indicatorRows = 1
		for index := range regions {
			regions[index].Rect = regions[index].Rect.Translate(0, 1)
		}
	}
	return agentTranscriptViewportFrame{
		Text: strings.Join(lines, "\n"), Offset: offset, ContentHeight: contentHeight,
		IndicatorRows: indicatorRows, TotalRows: layout.TotalRows, HitRegions: regions,
	}
}

func layoutAgentTranscript(data ShellData, width int) agentTranscriptLayout {
	cache := data.TranscriptCache
	if cache == nil {
		cache = NewAgentTranscriptRenderCache()
	}
	widthCache := cache.cacheForWidth(maxInt(1, width))
	layout := agentTranscriptLayout{Blocks: make([]agentTranscriptBlock, 0, len(data.AgentTranscript))}
	foregroundSequence := int64(-1)
	for index, item := range data.AgentTranscript {
		if index > 0 {
			layout.TotalRows++
		}
		outputWidth := maxInt(1, width-4)
		if item.Kind == "user" || item.Kind == "assistant" {
			outputWidth = maxInt(1, width-2)
		}
		output := widthCache.outputFor(item, outputWidth)
		rows := agentTranscriptItemRowCount(item, output, data.TranscriptExpanded[item.ID])
		layout.Blocks = append(layout.Blocks, agentTranscriptBlock{ItemIndex: index, Start: layout.TotalRows, Rows: rows, Output: output})
		layout.TotalRows += rows
		if item.State == "active" && item.Kind == "processing" && item.UpdatedSequence >= foregroundSequence {
			layout.ForegroundID = item.ID
			foregroundSequence = item.UpdatedSequence
		}
	}
	return layout
}

func (cache *AgentTranscriptRenderCache) cacheForWidth(width int) *agentTranscriptWidthCache {
	if cache.widths == nil {
		cache.widths = map[int]*agentTranscriptWidthCache{}
	}
	cache.clock++
	if current := cache.widths[width]; current != nil {
		current.touched = cache.clock
		return current
	}
	if len(cache.widths) >= maxAgentTranscriptCachedWidths {
		oldestWidth := 0
		oldestTouch := ^uint64(0)
		for candidateWidth, candidate := range cache.widths {
			if candidate.touched < oldestTouch {
				oldestWidth, oldestTouch = candidateWidth, candidate.touched
			}
		}
		delete(cache.widths, oldestWidth)
	}
	current := &agentTranscriptWidthCache{touched: cache.clock, items: map[string]*agentTranscriptOutputCache{}}
	cache.widths[width] = current
	return current
}

func (cache *agentTranscriptWidthCache) outputFor(item AgentTranscriptItem, width int) *agentTranscriptOutputCache {
	current := cache.items[item.ID]
	if current != nil && current.runID == item.RunID && current.kind == item.Kind && current.state == item.State &&
		current.updatedSequence == item.UpdatedSequence && current.output == item.Output &&
		current.outputLineCount == item.OutputLineCount && current.outputTruncated == item.OutputTruncated {
		return current
	}
	lines := agentResponseLines(item.Output)
	offsets := make([]int, len(lines)+1)
	for index, line := range lines {
		offsets[index+1] = offsets[index] + agentTranscriptLineRowCount(line, width)
	}
	current = &agentTranscriptOutputCache{
		runID: item.RunID, kind: item.Kind, state: item.State, updatedSequence: item.UpdatedSequence,
		output: item.Output, outputLineCount: item.OutputLineCount, outputTruncated: item.OutputTruncated,
		lines: lines, wrappedRowOffsets: offsets,
	}
	cache.items[item.ID] = current
	return current
}

func agentTranscriptItemRowCount(item AgentTranscriptItem, output *agentTranscriptOutputCache, expanded bool) int {
	total := output.totalRows()
	if item.Kind == "user" || item.Kind == "assistant" {
		return 1 + maxInt(1, total)
	}
	visible := total
	if !expanded {
		visible = minInt(5, visible)
	}
	rows := 1 + visible
	if visible == 0 && (item.State == "completed" || item.State == "failed") {
		rows++
	}
	hidden := maxInt(0, total-visible)
	if hidden > 0 || item.OutputTruncated || (expanded && total > 5) {
		rows++
	}
	return rows
}

func (output *agentTranscriptOutputCache) totalRows() int {
	if output == nil || len(output.wrappedRowOffsets) == 0 {
		return 0
	}
	return output.wrappedRowOffsets[len(output.wrappedRowOffsets)-1]
}

func renderAgentTranscriptRows(style styles.Styles, data ShellData, layout agentTranscriptLayout, width int, start int, count int) ([]string, []components.HitRegion) {
	if count <= 0 || start >= layout.TotalRows {
		return nil, nil
	}
	end := minInt(layout.TotalRows, start+count)
	lines := make([]string, end-start)
	regions := []components.HitRegion{}
	for _, block := range layout.Blocks {
		blockEnd := block.Start + block.Rows
		if blockEnd <= start || block.Start >= end {
			continue
		}
		item := data.AgentTranscript[block.ItemIndex]
		visibleStart := maxInt(start, block.Start)
		visibleEnd := minInt(end, blockEnd)
		localStart := visibleStart - block.Start
		rows := renderAgentTranscriptItemRows(style, data, item, block.Output, layout.ForegroundID, width, localStart, visibleEnd-visibleStart)
		copy(lines[visibleStart-start:], rows)
		if item.Kind != "user" && item.Kind != "assistant" {
			regions = append(regions, components.HitRegion{
				Rect: components.Rect{Y: visibleStart - start, Width: width, Height: visibleEnd - visibleStart},
				Kind: components.HitAgentTranscript, ItemID: item.ID,
			})
		}
	}
	return lines, regions
}

func renderAgentTranscriptItemRows(style styles.Styles, data ShellData, item AgentTranscriptItem, output *agentTranscriptOutputCache, foregroundID string, width int, start int, count int) []string {
	rows := make([]string, 0, count)
	end := start + count
	for row := start; row < end; row++ {
		if item.Kind == "user" || item.Kind == "assistant" {
			if row == 0 {
				title := "Agent"
				if item.Kind == "user" {
					title = "You"
				}
				rows = append(rows, style.Control.Render(title))
				continue
			}
			if output.totalRows() == 0 {
				rows = append(rows, "  (no text)")
				continue
			}
			rows = append(rows, "  "+output.row(row-1, maxInt(1, width-2)))
			continue
		}

		if row == 0 {
			rows = append(rows, renderAgentTranscriptHeader(style, data, item, foregroundID, width))
			continue
		}
		total := output.totalRows()
		expanded := data.TranscriptExpanded[item.ID]
		visible := total
		if !expanded {
			visible = minInt(5, visible)
		}
		contentRow := row - 1
		if visible == 0 && (item.State == "completed" || item.State == "failed") {
			if contentRow == 0 {
				rows = append(rows, style.ControlMuted.Render("  ⎿ (no output)"))
				continue
			}
			contentRow--
		}
		if contentRow >= 0 && contentRow < visible {
			prefix := "    "
			if contentRow == 0 {
				prefix = "  ⎿ "
			}
			rows = append(rows, prefix+output.row(contentRow, maxInt(1, width-4)))
			continue
		}
		hidden := maxInt(0, total-visible)
		message := ""
		if hidden > 0 {
			message = fmt.Sprintf("    … +%d rows — click or Enter to expand", hidden)
		} else if item.OutputTruncated {
			message = "    … output was bounded — export the full result"
		} else if expanded && total > 5 {
			message = "    click or Enter to collapse"
		}
		rows = append(rows, style.ControlMuted.Render(truncateText(message, width)))
	}
	return rows
}

func renderAgentTranscriptHeader(style styles.Styles, data ShellData, item AgentTranscriptItem, foregroundID string, width int) string {
	animate := data.ActivityAnimations && item.ID == foregroundID
	icon := activityIcon(item.State, data.ActivityASCII, data.ActivityFrame, animate)
	label := cleanInlineText(item.Label)
	if item.Detail != "" {
		label += " — " + cleanInlineText(item.Detail)
	}
	if item.DurationMS > 0 && item.State != "active" {
		label += " " + formatActivityDuration(item.DurationMS)
	}
	header := icon + " " + label
	if item.ID == data.TranscriptSelected {
		header = "> " + header
	}
	if animate && item.State == "active" {
		header = style.Control.Render(icon+" "+activityShimmer(data.ActivityFrame, data.ActivityASCII)+" ") + label
	} else if item.State == "failed" {
		header = lipgloss.NewStyle().Foreground(style.Theme.Error).Render(header)
	} else if item.State == "waiting_approval" || item.State == "cancelled" {
		header = lipgloss.NewStyle().Foreground(style.Theme.Warning).Render(header)
	} else if item.State == "completed" {
		header = lipgloss.NewStyle().Foreground(style.Theme.Success).Render(header)
	}
	return truncateStyledText(header, width)
}

func (output *agentTranscriptOutputCache) row(row int, width int) string {
	if output == nil || row < 0 || row >= output.totalRows() || len(output.lines) == 0 {
		return ""
	}
	lineIndex := sort.Search(len(output.lines), func(index int) bool {
		return output.wrappedRowOffsets[index+1] > row
	})
	if lineIndex >= len(output.lines) {
		return ""
	}
	wrapped := wrapAgentTranscriptLine(output.lines[lineIndex], width)
	localRow := row - output.wrappedRowOffsets[lineIndex]
	if localRow < 0 || localRow >= len(wrapped) {
		return ""
	}
	return wrapped[localRow]
}

func agentResponseLines(value string) []string {
	value = safemarkdown.SanitizeTerminalText(strings.ReplaceAll(value, "\r\n", "\n"))
	value = strings.TrimRight(value, "\n")
	if value == "" {
		return nil
	}
	return strings.Split(value, "\n")
}

// wrapAgentTranscriptText is shared by the Ctrl+G dock and the F6 full Agent
// page. It preserves explicit newlines, prefers word boundaries, and
// hard-wraps a single long token so sanitized transcript text is never lost.
func wrapAgentTranscriptText(value string, width int) []string {
	if width <= 0 {
		return nil
	}
	source := agentResponseLines(value)
	if len(source) == 0 {
		return nil
	}
	wrapped := make([]string, 0, len(source))
	for _, line := range source {
		if line == "" {
			wrapped = append(wrapped, "")
			continue
		}
		wrapped = append(wrapped, wrapAgentTranscriptLine(line, width)...)
	}
	return wrapped
}

func wrapAgentTranscriptLine(line string, width int) []string {
	line = strings.ReplaceAll(line, "\t", "    ")
	indentWidth := len(line) - len(strings.TrimLeft(line, " "))
	indentWidth = minInt(indentWidth, maxInt(0, width-1))
	indent := strings.Repeat(" ", indentWidth)
	words := strings.Fields(strings.TrimLeft(line, " "))
	if len(words) == 0 {
		return []string{truncateText(line, width)}
	}

	result := []string{}
	current := indent
	for _, word := range words {
		separator := ""
		if strings.TrimSpace(current) != "" {
			separator = " "
		}
		if lipgloss.Width(current+separator+word) <= width {
			current += separator + word
			continue
		}
		if strings.TrimSpace(current) != "" {
			result = append(result, current)
			current = indent
		}
		available := maxInt(1, width-lipgloss.Width(indent))
		chunks := hardWrapVisibleToken(word, available)
		for index, chunk := range chunks {
			if index == len(chunks)-1 {
				current = indent + chunk
			} else {
				result = append(result, indent+chunk)
			}
		}
	}
	if strings.TrimSpace(current) != "" {
		result = append(result, current)
	}
	return result
}

// agentTranscriptLineRowCount mirrors wrapAgentTranscriptLine without
// materializing every wrapped row. It is used to build the lazy row index once
// per item and terminal width.
func agentTranscriptLineRowCount(line string, width int) int {
	line = strings.ReplaceAll(line, "\t", "    ")
	indentWidth := len(line) - len(strings.TrimLeft(line, " "))
	indentWidth = minInt(indentWidth, maxInt(0, width-1))
	words := strings.Fields(strings.TrimLeft(line, " "))
	if len(words) == 0 {
		return 1
	}
	rows := 0
	currentWidth := indentWidth
	currentHasText := false
	for _, word := range words {
		separatorWidth := 0
		if currentHasText {
			separatorWidth = 1
		}
		wordWidth := lipgloss.Width(word)
		if currentWidth+separatorWidth+wordWidth <= width {
			currentWidth += separatorWidth + wordWidth
			currentHasText = true
			continue
		}
		if currentHasText {
			rows++
			currentWidth = indentWidth
			currentHasText = false
		}
		available := maxInt(1, width-indentWidth)
		chunks := hardWrapVisibleToken(word, available)
		if len(chunks) == 0 {
			continue
		}
		rows += maxInt(0, len(chunks)-1)
		currentWidth = indentWidth + lipgloss.Width(chunks[len(chunks)-1])
		currentHasText = true
	}
	if currentHasText {
		rows++
	}
	return maxInt(1, rows)
}

func hardWrapVisibleToken(value string, width int) []string {
	chunks := []string{}
	var current strings.Builder
	for _, character := range value {
		candidate := current.String() + string(character)
		if current.Len() > 0 && lipgloss.Width(candidate) > width {
			chunks = append(chunks, current.String())
			current.Reset()
		}
		current.WriteRune(character)
	}
	if current.Len() > 0 {
		chunks = append(chunks, current.String())
	}
	return chunks
}

func activityIcon(state string, ascii bool, frame int, animate bool) string {
	if ascii {
		switch state {
		case "completed":
			return "+"
		case "failed":
			return "x"
		case "waiting_approval", "cancelled":
			return "!"
		case "active":
			if animate && frame%2 == 1 {
				return "o"
			}
			return "*"
		default:
			return "o"
		}
	}
	switch state {
	case "completed":
		return "✓"
	case "failed":
		return "×"
	case "waiting_approval", "cancelled":
		return "!"
	case "active":
		if animate && frame%2 == 1 {
			return "◉"
		}
		return "●"
	default:
		return "○"
	}
}

func activityShimmer(frame int, ascii bool) string {
	if ascii {
		return []string{"=..", ".=.", "..="}[frame%3]
	}
	return []string{"▰▱▱", "▱▰▱", "▱▱▰"}[frame%3]
}

func formatActivityDuration(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("(%dms)", ms)
	}
	return fmt.Sprintf("(%.1fs)", float64(ms)/1000)
}

func operatorInventoryViewport(data ShellData) bool {
	return connectionCanRenderState(data.ConnectionStatus) && data.FocusedPane == nil && len(data.Panes) == 0 && len(data.Inventory) > 0
}

// InventorySelectionLine returns the selected row in the exact rendered
// inventory body. Keeping this geometry in the view avoids duplicating Lip
// Gloss border and padding arithmetic in the root interaction model.
func InventorySelectionLine(style styles.Styles, data ShellData) int {
	projection := operatorPaneProjection(data)
	if !operatorInventoryViewport(projection) {
		return 0
	}
	selectedLabel := ""
	rows := registeredAppTableRows(projection.Inventory)
	for index, item := range projection.Inventory {
		if item.Selected {
			selectedLabel = rows[index].Name
			break
		}
	}
	if selectedLabel == "" {
		return 0
	}
	for index, line := range strings.Split(renderBody(style, projection), "\n") {
		plain := ansiEscapePattern.ReplaceAllString(line, "")
		if strings.Contains(plain, selectedLabel) {
			return index
		}
	}
	return 0
}

const operatorRailDivider = "│"

func renderOperatorRail(style styles.Styles, data ShellData, width int) string {
	attention := actionableDiagnosticsSummary(data.Diagnostics)
	if attention == "" {
		attention = "none"
	}
	connectionState := valueOr(data.ConnectionStatus, "unknown")
	connectionLabel := displayConnectionStatus(connectionState)
	connection := operatorRailDisplayField(style, "Relaybase", connectionLabel, connectionState)
	compactConnection := operatorRailDisplayField(style, "Relaybase", compactConnectionStatus(connectionState), connectionState)
	agentStatus := valueOr(data.AgentStatus, "unknown")
	agent := style.Muted.Render("Agent ") + operatorRailTone(style, agentStatus).Render(displayAgentStatus(agentStatus))
	eventStatus := valueOr(data.EventStatus, "unknown")
	events := operatorRailDisplayField(style, "Events", displayEventStatus(eventStatus), eventStatus)
	if data.EventCount > 0 {
		events += style.Muted.Render(fmt.Sprintf(" (%d)", data.EventCount))
	}
	apps := renderOperatorAppCounts(style, data)
	compactApps := renderCompactOperatorAppCounts(style, data)
	tightApps := renderTightOperatorAppCounts(style, data)
	minimumApps := renderMinimumOperatorAppCounts(style, data)
	attentionField := style.Muted.Render("Attention ") + operatorAttentionTone(style, data.Diagnostics).Render(attention)
	page := ""
	compactPage := ""
	if data.PageCount > 1 {
		page = style.Muted.Render(fmt.Sprintf("Page %d/%d", data.Page+1, data.PageCount))
		compactPage = style.Muted.Render(fmt.Sprintf("P%d/%d", data.Page+1, data.PageCount))
	}
	group := ""
	if width >= 120 && data.GroupCount > 0 {
		group = style.Muted.Render(fmt.Sprintf("Groups %d", data.GroupCount))
	}
	thread := ""
	if data.AgentThreadLabel != "" {
		thread = style.Muted.Render(truncateText(data.AgentThreadLabel, maxInt(1, width/3)))
	}

	if width < 80 {
		columnWidths := operatorRailColumnWidths(width, 2)
		agentSlot := firstOperatorRailCandidate(columnWidths[1],
			withOperatorRailDetail(style, withOperatorRailDetail(style, agent, events), thread),
			withOperatorRailDetail(style, agent, events),
			withOperatorRailDetail(style, agent, thread),
			agent,
		)
		appsSlot := operatorAppRailSlot(style, columnWidths[0], group, apps, compactApps, tightApps, minimumApps)
		attentionSlot := firstOperatorRailCandidate(columnWidths[1],
			withOperatorRailDetail(style, attentionField, page),
			withOperatorRailDetail(style, attentionField, compactPage),
			attentionField,
		)
		firstLine := renderOperatorRailColumns(style, width, connection, agentSlot)
		secondLine := renderOperatorRailColumns(style, width, appsSlot, attentionSlot)
		return firstLine + "\n" + secondLine
	}

	columnWidths := operatorRailColumnWidths(width, 5)
	connectionSlot := firstOperatorRailCandidate(
		maxInt(1, columnWidths[0]),
		connection,
		compactConnection,
	)
	agentSlot := firstOperatorRailCandidate(maxInt(1, columnWidths[1]-1), withOperatorRailDetail(style, agent, thread), agent)
	appsSlot := operatorAppRailSlot(style, maxInt(1, columnWidths[2]-1), group, apps, compactApps, tightApps, minimumApps)
	attentionSlot := firstOperatorRailCandidate(maxInt(1, columnWidths[4]-1),
		withOperatorRailDetail(style, attentionField, page),
		page,
		withOperatorRailDetail(style, attentionField, compactPage),
		compactPage,
		attentionField,
	)
	return renderOperatorRailColumns(style, width, connectionSlot, agentSlot, appsSlot, events, attentionSlot)
}

func operatorAttentionTone(style styles.Styles, diagnostics []DiagnosticLine) lipgloss.Style {
	hasWarning := false
	for _, diagnostic := range diagnostics {
		switch strings.ToLower(strings.TrimSpace(diagnostic.Severity)) {
		case "error":
			return style.PaneLogError
		case "warning", "warn":
			hasWarning = true
		}
	}
	if hasWarning {
		return style.PaneLogWarning
	}
	return style.Muted
}

func operatorRailField(style styles.Styles, label string, state string) string {
	return operatorRailDisplayField(style, label, state, state)
}

func operatorRailDisplayField(style styles.Styles, label string, display string, state string) string {
	return style.Muted.Render(label+" ") + operatorRailTone(style, state).Render(display)
}

func operatorRailTone(style styles.Styles, state string) lipgloss.Style {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "connected", "online", "running", "ready", "healthy", "active", "session", "streaming":
		return style.PaneLogSuccess
	case "waiting", "degraded", "auth_needed", "connecting", "checking", "pending", "stale", "starting", "stopping", "sending", "reconnecting", "needs_config":
		return style.PaneLogWarning
	case "offline", "failed", "error", "disconnected", "unavailable":
		return style.PaneLogError
	case "idle", "ready_no_thread", "disabled", "unknown", "":
		return style.Muted
	default:
		return style.Muted
	}
}

func displayConnectionStatus(state string) string {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "connected":
		return "online"
	case "auth_needed":
		return "auth needed"
	default:
		return valueOr(strings.ReplaceAll(strings.TrimSpace(state), "_", " "), "unknown")
	}
}

func compactConnectionStatus(state string) string {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "connected":
		return "online"
	case "auth_needed":
		return "auth"
	case "reconnecting":
		return "retry"
	case "connecting":
		return "wait"
	default:
		return valueOr(strings.ReplaceAll(strings.TrimSpace(state), "_", " "), "unknown")
	}
}

func displayAgentStatus(state string) string {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "ready_no_thread":
		return "ready"
	case "needs_config":
		return "setup needed"
	default:
		return valueOr(strings.TrimSpace(state), "unknown")
	}
}

func displayEventStatus(state string) string {
	switch strings.ToLower(strings.TrimSpace(state)) {
	case "auth_needed":
		return "auth"
	default:
		return valueOr(strings.ReplaceAll(strings.TrimSpace(state), "_", " "), "unknown")
	}
}

func renderOperatorAppCounts(style styles.Styles, data ShellData) string {
	if !data.StateKnown {
		return style.Muted.Render("Apps unknown")
	}
	registered := data.RegisteredAppCount
	if registered == 0 && data.AppCount > 0 {
		registered = data.AppCount
	}
	if data.ActiveAppCount > 0 || data.RegisteredAppCount > 0 {
		activeStyle := style.Muted
		if data.ActiveAppCount > 0 {
			activeStyle = operatorRailTone(style, "active")
		}
		return style.Muted.Render("Apps ") +
			activeStyle.Render(fmt.Sprintf("%d active", data.ActiveAppCount)) +
			style.Muted.Render(fmt.Sprintf(" / %d registered", registered))
	}
	return style.Muted.Render(fmt.Sprintf("Apps %d registered", registered))
}

func renderCompactOperatorAppCounts(style styles.Styles, data ShellData) string {
	if !data.StateKnown {
		return style.Muted.Render("Apps unknown")
	}
	registered := data.RegisteredAppCount
	if registered == 0 && data.AppCount > 0 {
		registered = data.AppCount
	}
	activeStyle := style.Muted
	if data.ActiveAppCount > 0 {
		activeStyle = operatorRailTone(style, "active")
	}
	return style.Muted.Render("Apps ") +
		activeStyle.Render(fmt.Sprintf("%d active", data.ActiveAppCount)) +
		style.Muted.Render(fmt.Sprintf("/%d registered", registered))
}

func renderTightOperatorAppCounts(style styles.Styles, data ShellData) string {
	if !data.StateKnown {
		return style.Muted.Render("Apps unknown")
	}
	registered := data.RegisteredAppCount
	if registered == 0 && data.AppCount > 0 {
		registered = data.AppCount
	}
	if data.ActiveAppCount == 0 && data.RegisteredAppCount == 0 {
		return style.Muted.Render(fmt.Sprintf("Apps %d saved", registered))
	}
	activeStyle := style.Muted
	if data.ActiveAppCount > 0 {
		activeStyle = operatorRailTone(style, "active")
	}
	return style.Muted.Render("Apps ") +
		activeStyle.Render(fmt.Sprintf("%d active", data.ActiveAppCount)) +
		style.Muted.Render(fmt.Sprintf("/%d saved", registered))
}

func renderMinimumOperatorAppCounts(style styles.Styles, data ShellData) string {
	if !data.StateKnown {
		return style.Muted.Render("Apps unknown")
	}
	registered := data.RegisteredAppCount
	if registered == 0 && data.AppCount > 0 {
		registered = data.AppCount
	}
	if data.ActiveAppCount == 0 && data.RegisteredAppCount == 0 {
		return style.Muted.Render(fmt.Sprintf("Apps %d saved", registered))
	}
	activeStyle := style.Muted
	if data.ActiveAppCount > 0 {
		activeStyle = operatorRailTone(style, "active")
	}
	return style.Muted.Render("Apps ") +
		activeStyle.Render(fmt.Sprintf("%d active", data.ActiveAppCount)) +
		style.Muted.Render(fmt.Sprintf("/%d", registered))
}

func operatorAppRailSlot(style styles.Styles, width int, group string, candidates ...string) string {
	withGroup := make([]string, 0, len(candidates))
	if group != "" {
		for _, candidate := range candidates {
			withGroup = append(withGroup, withOperatorRailDetail(style, candidate, group))
		}
	}
	return firstOperatorRailCandidate(width, append(withGroup, candidates...)...)
}

func withOperatorRailDetail(style styles.Styles, base string, detail string) string {
	if base == "" {
		return detail
	}
	if detail == "" {
		return base
	}
	return base + style.Muted.Render(" ") + detail
}

func firstOperatorRailCandidate(width int, candidates ...string) string {
	fallback := ""
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		fallback = candidate
		if ansi.StringWidth(candidate) <= width {
			return candidate
		}
	}
	return fallback
}

func renderOperatorRailColumns(style styles.Styles, width int, segments ...string) string {
	columnWidths := operatorRailColumnWidths(width, len(segments))
	divider := style.Muted.Render(operatorRailDivider)
	var rail strings.Builder
	for index, segment := range segments {
		columnWidth := columnWidths[index]
		if index > 0 && columnWidth > 0 {
			segment = style.Muted.Render(" ") + segment
		}
		fitted := truncateStyledText(segment, columnWidth)
		rail.WriteString(fitted)
		rail.WriteString(strings.Repeat(" ", maxInt(0, columnWidth-ansi.StringWidth(fitted))))
		if index < len(segments)-1 {
			rail.WriteString(divider)
		}
	}
	return rail.String()
}

func operatorRailColumnWidths(width int, count int) []int {
	if count <= 0 {
		return nil
	}
	available := maxInt(0, width-(count-1)*ansi.StringWidth(operatorRailDivider))
	base := available / count
	remainder := available % count
	widths := make([]int, count)
	for index := range widths {
		widths[index] = base
		if index < remainder {
			widths[index]++
		}
	}
	return widths
}

func fixedRegion(style lipgloss.Style, text string, width int, height int) string {
	width = maxInt(width, 1)
	height = maxInt(height, 1)
	lines := strings.Split(text, "\n")
	if len(lines) > height {
		lines = lines[:height]
	}
	for len(lines) < height {
		lines = append(lines, "")
	}
	for index := range lines {
		lines[index] = truncateStyledText(lines[index], width)
	}
	return lipgloss.NewStyle().
		Foreground(style.GetForeground()).
		Background(style.GetBackground()).
		Width(width).
		Height(height).
		Render(strings.Join(lines, "\n"))
}

func framedFixedRegion(style lipgloss.Style, text string, width int, height int) string {
	width = maxInt(1, width)
	height = maxInt(1, height)
	border := lipgloss.NewStyle().
		Foreground(style.GetBorderTopForeground()).
		Background(style.GetBackground()).
		Render(strings.Repeat("─", width))
	if height == 1 {
		return border
	}
	contentStyle := lipgloss.NewStyle().Foreground(style.GetForeground()).Background(style.GetBackground())
	return lipgloss.JoinVertical(lipgloss.Left, border, fixedRegion(contentStyle, text, width, height-1))
}

func truncateStyledText(value string, width int) string {
	if width <= 0 {
		return ""
	}
	value = oneLineText(value)
	if ansi.StringWidth(value) <= width {
		return value
	}
	if width == 1 {
		return "."
	}
	return ansi.Truncate(value, width, ".")
}

type operatorOverlayFrame struct {
	Text       string
	Bounds     components.Rect
	HitRegions []components.HitRegion
}

func operatorOverlay(style styles.Styles, data ShellData, metrics layout.Metrics, background string) operatorOverlayFrame {
	switch {
	case data.Confirmation != nil:
	case data.Usage != nil:
	case data.Settings != nil:
	case data.ContextMenu != nil:
	case data.AppManager != nil:
	case data.PackageManager != nil:
	case data.RegistrationRepairs != nil:
	case data.PaneReopen != nil:
	case data.Help != nil || data.ShowHelp:
	case data.DiagnosticsOpen:
	case strings.TrimSpace(data.SetupPanel) != "":
	case data.ThreadSwitcher != nil:
	case data.CodePicker != nil:
	case data.ResponseDetails:
	default:
		return operatorOverlayFrame{}
	}
	bounds := metrics.Modal
	if data.ThreadSwitcher != nil {
		bounds = threadSwitcherBounds(style, metrics, *data.ThreadSwitcher)
	} else if data.Usage != nil {
		bounds = usageBounds(style, metrics, *data.Usage)
	} else if data.Settings != nil {
		bounds = settingsBounds(metrics)
	}

	contentBounds := overlayContentBounds(style.Help, bounds)
	innerWidth := contentBounds.Width
	innerHeight := contentBounds.Height
	helpProjection := data
	helpProjection.Width = innerWidth + 4
	helpProjection.Height = innerHeight + 8
	content := operatorOverlayContent(style, helpProjection)
	responseRegions := []components.HitRegion{}
	if data.ThreadSwitcher != nil {
		content = renderThreadSwitcher(style, *data.ThreadSwitcher, innerWidth)
	} else if data.CodePicker != nil {
		content = renderCodePicker(*data.CodePicker)
	} else if data.Usage != nil {
		content = usagecomponent.Render(*data.Usage, maxInt(20, innerWidth), time.Now())
	} else if data.Settings != nil {
		content = renderSettings(style, *data.Settings, innerWidth)
	} else if data.ResponseDetails {
		responseFrame := renderAgentResponseFrame(style, data, innerWidth, innerHeight)
		content = responseFrame.Text
		responseRegions = responseFrame.HitRegions
	}

	viewportFrame := bodyViewportFrame{
		Text:          fixedRegion(lipgloss.NewStyle(), content, innerWidth, innerHeight),
		ContentHeight: innerHeight,
	}
	if operatorOverlayScrollsWithBody(data) {
		viewportFrame = renderBodyViewportFrame(content, innerHeight, data.BodyScrollOffset, innerWidth)
	}
	box := renderBoxedOverlay(style.Help, viewportFrame.Text, bounds)
	text := composeOperatorLayer(background, box, bounds, metrics.Bounds)
	overlay := operatorOverlayFrame{Text: text, Bounds: bounds}

	localRegions := []components.HitRegion{}
	switch {
	case data.ThreadSwitcher != nil:
		for rowIndex, entry := range data.ThreadSwitcher.Entries {
			localRegions = append(localRegions, components.HitRegion{
				Rect:  components.Rect{Y: 1 + rowIndex, Width: innerWidth, Height: 1},
				Kind:  components.HitThreadSwitcherRow,
				Index: entry.Index,
			})
		}
	case data.CodePicker != nil:
		for index := range data.CodePicker.LineCounts {
			localRegions = append(localRegions, components.HitRegion{
				Rect:  components.Rect{Y: 1 + index, Width: innerWidth, Height: 1},
				Kind:  components.HitCodePickerRow,
				Index: index,
			})
		}
	case data.Settings != nil:
		for rowIndex, row := range data.Settings.Rows {
			localRegions = append(localRegions, components.HitRegion{
				Rect:  components.Rect{Y: 3 + rowIndex*2, Width: innerWidth, Height: 2},
				Kind:  components.HitSettingsRow,
				Index: row.Index,
			})
		}
	case data.ResponseDetails:
		localRegions = append(localRegions, components.HitRegion{
			Rect: components.Rect{Width: innerWidth, Height: innerHeight},
			Kind: components.HitResponse,
		})
		localRegions = append(localRegions, responseRegions...)
	case data.AppManager != nil:
		localRegions = registeredAppHitRegions(helpProjection)
	case data.PackageManager != nil:
		localRegions = packageManagerHitRegions(helpProjection)
	case data.PaneReopen != nil:
		localRegions = paneReopenHitRegions(helpProjection)
	case data.Help != nil:
		localRegions = helpHitRegions(helpProjection)
	}
	contentOrigin := contentBounds
	for _, region := range localRegions {
		if transformed, ok := transformOverlayRegion(region, viewportFrame, contentOrigin); ok {
			overlay.HitRegions = append(overlay.HitRegions, transformed)
		}
	}
	return overlay
}

// overlayContentBounds is the single box-model projection shared by overlay
// rendering and hit testing. Lip Gloss v2 Width and Height describe the total
// styled box (including border and padding), so callers must subtract the
// frame exactly once to obtain the content viewport.
func overlayContentBounds(style lipgloss.Style, bounds components.Rect) components.Rect {
	left := style.GetBorderLeftSize() + style.GetPaddingLeft()
	right := style.GetBorderRightSize() + style.GetPaddingRight()
	top := style.GetBorderTopSize() + style.GetPaddingTop()
	bottom := style.GetBorderBottomSize() + style.GetPaddingBottom()
	return components.Rect{
		X:      bounds.X + left,
		Y:      bounds.Y + top,
		Width:  maxInt(1, bounds.Width-left-right),
		Height: maxInt(1, bounds.Height-top-bottom),
	}
}

func renderBoxedOverlay(style lipgloss.Style, content string, bounds components.Rect) string {
	return style.Width(maxInt(1, bounds.Width)).Height(maxInt(1, bounds.Height)).Render(content)
}

func operatorOverlayScrollsWithBody(data ShellData) bool {
	return data.Confirmation != nil || data.Help != nil || data.ShowHelp || data.DiagnosticsOpen || strings.TrimSpace(data.SetupPanel) != ""
}

func transformOverlayRegion(region components.HitRegion, frame bodyViewportFrame, content components.Rect) (components.HitRegion, bool) {
	clip := components.Rect{X: 0, Y: frame.Offset, Width: content.Width, Height: frame.ContentHeight}
	transformed, ok := components.ClipAndTranslate(
		region.Rect,
		clip,
		content.X,
		content.Y+frame.IndicatorRows-frame.Offset,
	)
	if !ok {
		return components.HitRegion{}, false
	}
	region.Rect = transformed
	return region, true
}

func composeOperatorLayer(background string, foreground string, bounds components.Rect, terminal components.Rect) string {
	compositor := lipgloss.NewCompositor(
		lipgloss.NewLayer(background).Z(0),
		lipgloss.NewLayer(foreground).X(bounds.X).Y(bounds.Y).Z(1),
	)
	return lipgloss.NewStyle().Width(terminal.Width).Height(terminal.Height).Render(compositor.Render())
}

func operatorOverlayContent(style styles.Styles, data ShellData) string {
	switch {
	case data.Confirmation != nil:
		return renderConfirmation(*data.Confirmation)
	case data.Usage != nil:
		return usagecomponent.Render(*data.Usage, 52, time.Now())
	case data.Settings != nil:
		return renderSettings(style, *data.Settings, maxInt(24, data.Width-8))
	case data.ContextMenu != nil:
		return renderContextMenu(*data.ContextMenu)
	case data.AppManager != nil:
		return renderAppManagerModal(style, data, *data.AppManager)
	case data.PackageManager != nil:
		return renderPackageManagerModal(style, data, *data.PackageManager)
	case data.RegistrationRepairs != nil:
		return renderRegistrationRepairModal(style, data, *data.RegistrationRepairs)
	case data.PaneReopen != nil:
		return renderPaneReopenModal(style, data, *data.PaneReopen)
	case data.Help != nil:
		return renderSearchableHelp(style, data, *data.Help)
	case data.ShowHelp:
		return renderHelp(data)
	case data.DiagnosticsOpen:
		return renderDiagnosticsDrawer(data.Diagnostics)
	case data.ResponseDetails:
		return renderAgentResponseContent(style, data, maxInt(1, data.Width-4), maxInt(1, data.Height-8))
	case strings.TrimSpace(data.SetupPanel) != "":
		return safemarkdown.SanitizeTerminalText(data.SetupPanel)
	default:
		return ""
	}
}

func renderSettings(style styles.Styles, data SettingsData, width int) string {
	width = maxInt(24, width)
	title := style.Control.Render(cleanInlineText(data.Title))
	breadcrumb := valueOr(cleanInlineText(data.Breadcrumb), "Settings")
	lines := []string{title, style.Muted.Render(truncateText(breadcrumb, width)), ""}
	if len(data.Rows) == 0 {
		lines = append(lines, style.Muted.Render("No settings are available."))
	}
	for _, row := range data.Rows {
		marker := "  "
		label := truncateText(cleanInlineText(row.Label), maxInt(1, width-ansi.StringWidth(marker)))
		value := cleanInlineText(row.Value)
		if row.Index == data.Selected {
			marker = "> "
			label = style.PaletteSelected.Render(label)
		}
		if row.ReadOnly {
			if value == "" {
				value = "read only"
			} else {
				value += " · read only"
			}
		}
		primary := marker + label
		valueOnPrimary := false
		primaryWidth := ansi.StringWidth(primary)
		valueWidth := ansi.StringWidth(value)
		if value != "" && primaryWidth+3+valueWidth <= width {
			renderedValue := value
			if row.Action {
				renderedValue = style.Control.Render(value)
			}
			primary += strings.Repeat(" ", width-primaryWidth-valueWidth) + renderedValue
			valueOnPrimary = true
		}
		lines = append(lines, primary)
		detail := cleanInlineText(row.Hint)
		if !valueOnPrimary {
			if detail != "" && value != "" {
				detail = value + " · " + detail
			} else if value != "" {
				detail = value
			}
		}
		if strings.TrimSpace(detail) != "" {
			lines = append(lines, style.Muted.Render(truncateText("    "+detail, width)))
		} else {
			lines = append(lines, "")
		}
	}
	if data.Editing {
		lines = append(lines, style.Control.Render("Edit value: ")+cleanInlineText(data.EditValue))
	}
	if data.Saving {
		lines = append(lines, style.Muted.Render(truncateText(valueOr(strings.TrimSpace(data.Notice), "Working..."), width)))
	} else if strings.TrimSpace(data.Notice) != "" {
		lines = append(lines, style.Muted.Render(truncateText(data.Notice, width)))
	}
	rangeLabel := ""
	if data.TotalRows > len(data.Rows) {
		rangeLabel = fmt.Sprintf(" · rows %d-%d of %d", data.FirstRow+1, data.FirstRow+len(data.Rows), data.TotalRows)
	}
	footer := "↑↓ select · Enter select · ←/Esc back · Q close" + rangeLabel
	if data.Editing {
		footer = "Enter save · Esc cancel edit"
	}
	lines = append(lines, "", style.Muted.Render(truncateText(footer, width)))
	return strings.Join(lines, "\n")
}

func settingsBounds(metrics layout.Metrics) components.Rect {
	width := maxInt(1, metrics.Bounds.Width-2)
	height := maxInt(1, metrics.Bounds.Height-2)
	return components.Rect{
		X:      maxInt(0, (metrics.Bounds.Width-width)/2),
		Y:      maxInt(0, (metrics.Bounds.Height-height)/2),
		Width:  width,
		Height: height,
	}
}

func threadSwitcherBounds(style styles.Styles, metrics layout.Metrics, data ThreadSwitcherData) components.Rect {
	width := minInt(maxInt(32, metrics.Bounds.Width*2/3), maxInt(1, metrics.Bounds.Width-2))
	innerWidth := maxInt(1, width-style.Help.GetHorizontalFrameSize())
	contentHeight := lipgloss.Height(renderThreadSwitcher(style, data, innerWidth))
	desiredHeight := contentHeight + style.Help.GetVerticalFrameSize()
	availableHeight := maxInt(4, metrics.Bounds.Height-metrics.Rail.Height)
	height := minInt(desiredHeight, availableHeight)
	y := maxInt(metrics.Rail.Height, (metrics.Bounds.Height-height)/2)
	y = minInt(y, maxInt(metrics.Rail.Height, metrics.Bounds.Height-height))
	return components.Rect{X: maxInt(1, (metrics.Bounds.Width-width)/2), Y: y, Width: width, Height: height}
}

func usageBounds(style styles.Styles, metrics layout.Metrics, data usagecomponent.Snapshot) components.Rect {
	width := minInt(56, maxInt(1, metrics.Bounds.Width-4))
	contentWidth := overlayContentBounds(style.Help, components.Rect{Width: width, Height: metrics.Bounds.Height}).Width
	contentHeight := lipgloss.Height(usagecomponent.Render(data, maxInt(20, contentWidth), time.Now()))
	height := contentHeight + style.Help.GetBorderTopSize() + style.Help.GetPaddingTop() + style.Help.GetPaddingBottom() + style.Help.GetBorderBottomSize()
	// The minimum supported 40x18 operator console has a two-row rail. A
	// one-row outer margin still leaves the compact usage view its complete
	// twelve-line content viewport plus Help's border and padding.
	height = minInt(height, maxInt(4, metrics.Bounds.Height-2))
	return components.Rect{
		X:      maxInt(1, (metrics.Bounds.Width-width)/2),
		Y:      maxInt(metrics.Rail.Height, (metrics.Bounds.Height-height)/2),
		Width:  width,
		Height: height,
	}
}

func renderThreadSwitcher(style styles.Styles, data ThreadSwitcherData, width int) string {
	if data.Loading {
		return "Thread switcher\n\nLoading daemon-backed threads…\n\nEsc cancel"
	}
	lines := []string{"Thread switcher"}
	if len(data.Entries) == 0 {
		lines = append(lines, "No daemon-backed threads", "", "Esc cancel")
		return strings.Join(lines, "\n")
	}
	for _, entry := range data.Entries {
		prefix := "  "
		if entry.Index == data.Selected {
			prefix = "> "
		}
		label := valueOr(entry.Title, "Untitled thread")
		if entry.Active {
			label += " [active]"
		}
		if entry.Attention {
			label += " [attention]"
		}
		lines = append(lines, truncateText(prefix+label, maxInt(16, width-2)))
	}
	footer := "←/→ select • Enter activate • Esc cancel"
	if lipgloss.Width(footer) > width {
		footer = "←/→ select • Enter • Esc"
	}
	if lipgloss.Width(footer) > width {
		footer = "←/→ • Enter • Esc"
	}
	lines = append(lines, footer)
	return strings.Join(lines, "\n")
}

func renderCodePicker(data CodePickerData) string {
	lines := []string{"Code blocks"}
	if len(data.LineCounts) == 0 {
		return strings.Join(append(lines, "No sanitized code blocks", "", "Esc cancel"), "\n")
	}
	for index, lineCount := range data.LineCounts {
		prefix := "  "
		if index == data.Selected {
			prefix = "> "
		}
		lines = append(lines, fmt.Sprintf("%sCode block %d • %d lines", prefix, index+1, lineCount))
	}
	lines = append(lines, "↑/↓ select • Enter copy • Esc cancel")
	return strings.Join(lines, "\n")
}

func renderBodyViewport(body string, height int, offset int, width int) string {
	return renderBodyViewportFrame(body, height, offset, width).Text
}

type bodyViewportFrame struct {
	Text          string
	Offset        int
	ContentHeight int
	IndicatorRows int
}

func renderBodyViewportFrame(body string, height int, offset int, width int) bodyViewportFrame {
	height = maxInt(1, height)
	if width <= 0 {
		width = 80
	}
	body = lipgloss.NewStyle().MaxWidth(width).Render(body)
	lines := strings.Split(body, "\n")
	contentHeight := height
	showIndicator := len(lines) > height
	if showIndicator && height > 1 {
		contentHeight--
	}
	maxOffset := maxInt(0, len(lines)-contentHeight)
	offset = clampInt(offset, 0, maxOffset)
	view := viewport.New(viewport.WithWidth(width), viewport.WithHeight(contentHeight))
	view.SoftWrap = false
	view.FillHeight = true
	view.MouseWheelEnabled = false
	view.SetContentLines(lines)
	view.SetYOffset(offset)
	visibleLines := strings.Split(view.View(), "\n")
	if len(visibleLines) > contentHeight {
		visibleLines = visibleLines[:contentHeight]
	}
	for len(visibleLines) < contentHeight {
		visibleLines = append(visibleLines, "")
	}
	for index, line := range visibleLines {
		if line == "" {
			visibleLines[index] = strings.Repeat(" ", width)
		}
	}
	visible := strings.Join(visibleLines, "\n")
	indicatorRows := 0
	if showIndicator && height > 1 {
		indicator := fmt.Sprintf("scroll %d/%d  ↑/↓ PgUp/PgDn Home/End", offset, maxOffset)
		visible = lipgloss.JoinVertical(lipgloss.Left, truncateText(indicator, width), visible)
		indicatorRows = 1
	}
	return bodyViewportFrame{Text: visible, Offset: view.YOffset(), ContentHeight: contentHeight, IndicatorRows: indicatorRows}
}

func oneLineText(value string) string {
	value = strings.ReplaceAll(value, "\r\n", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, "\r", " ")
	return value
}

func renderBody(style styles.Styles, data ShellData) string {
	if data.Confirmation != nil {
		return style.Help.Width(contentWidth(data.Width)).Render(renderConfirmation(*data.Confirmation))
	}
	if data.ContextMenu != nil {
		return style.Help.Width(contentWidth(data.Width)).Render(renderContextMenu(*data.ContextMenu))
	}
	if data.Help != nil {
		return style.Help.Width(contentWidth(data.Width)).Render(renderSearchableHelp(style, data, *data.Help))
	}
	if data.ShowHelp {
		return style.Help.Width(contentWidth(data.Width)).Render(renderHelp(data))
	}
	if data.DiagnosticsOpen {
		return style.Help.Width(contentWidth(data.Width)).Render(renderDiagnosticsDrawer(data.Diagnostics))
	}
	if strings.TrimSpace(data.SetupPanel) != "" {
		return withDiagnosticsSummary(style, data, style.Body.Width(contentWidth(data.Width)).Render(safemarkdown.SanitizeTerminalText(data.SetupPanel)))
	}
	if !connectionCanRenderState(data.ConnectionStatus) || !hasRenderableState(data) {
		return style.Body.Width(contentWidth(data.Width)).Render(renderConnectionState(data))
	}
	if data.FocusedPane != nil {
		return withDiagnosticsSummary(style, data, renderFocusedPane(style, data, *data.FocusedPane))
	}
	return withDiagnosticsSummary(style, data, renderPaneGrid(style, data))
}

func connectionCanRenderState(status string) bool {
	return status == "connected" || status == "auth_needed"
}

func hasRenderableState(data ShellData) bool {
	if data.StateKnown {
		return true
	}
	return data.AppCount > 0 || data.GroupCount > 0 || len(data.Panes) > 0 || len(data.Inventory) > 0 || data.FocusedPane != nil
}

func renderStatusLine(data ShellData, width int) string {
	daemonStatus := displayConnectionStatus(valueOr(data.ConnectionStatus, "connecting"))
	eventStatus := displayEventStatus(valueOr(data.EventStatus, "connecting"))
	agentStatus := valueOr(data.AgentStatus, "checking")
	if width < 64 {
		line := fmt.Sprintf("d:%s e:%s a:%s apps:%d", daemonStatus, eventStatus, agentStatus, data.AppCount)
		if summary := diagnosticsSummary(data.Diagnostics); summary != "" {
			line += " !" + summary
		}
		return line
	}

	line := fmt.Sprintf("daemon: %s  events: %s  agent: %s  apps: %d", daemonStatus, eventStatus, agentStatus, data.AppCount)
	if summary := diagnosticsSummary(data.Diagnostics); summary != "" {
		line += "  diag: " + summary + " (Ctrl+D)"
	}
	line += fmt.Sprintf("  groups: %d", data.GroupCount)
	if data.AgentThreadLabel != "" {
		line += "  thread: " + data.AgentThreadLabel
	}
	return line
}

func withDiagnosticsSummary(style styles.Styles, data ShellData, body string) string {
	if data.OperatorConsole {
		// Attention remains visible in the operator rail. A second summary row
		// here would steal log geometry and desynchronize pane scrolling.
		return body
	}
	summary := diagnosticsSummary(data.Diagnostics)
	if summary == "" {
		return body
	}
	line := style.Diagnostic.Render("Diagnostics " + summary + " — Ctrl+D for details")
	return lipgloss.JoinVertical(lipgloss.Left, line, body)
}

func renderPaneGrid(style styles.Styles, data ShellData) string {
	lines := []string{}
	if len(data.AssistantHistory) > 0 {
		lines = append(lines, renderAssistantHistory(data.AssistantHistory), "")
	}
	if len(data.Panes) == 0 {
		if len(data.Inventory) > 0 {
			inventoryWidth := maxInt(1, contentWidth(data.Width)-style.Body.GetHorizontalFrameSize())
			lines = append(lines, renderInventory(style, data.Inventory, inventoryWidth)...)
			return style.Body.Width(inventoryWidth).Render(strings.Join(lines, "\n"))
		}
		if data.SuppressEmptyState {
			return ""
		}
		lines = append(lines, "No monitoring panes are open")
		lines = append(lines, "")
		lines = append(lines, "No registered app inventory was returned by the connected daemon.")
		lines = append(lines, "Use /add <path>, /configure <path> --dry-run, or /register <manifest-or-project-path>.")
		return style.Body.Width(contentWidth(data.Width)).Render(strings.Join(lines, "\n"))
	}

	if data.PageCount > 1 && !data.OperatorConsole {
		lines = append(lines, fmt.Sprintf("Page %d/%d", data.Page+1, data.PageCount), "")
	}

	grid := renderGrid(style, data.Panes, data.PaneLayout, data.ClipboardWriteReady, data.ConnectionStatus == "connected")
	lines = append(lines, grid)
	return strings.Join(lines, "\n")
}

func renderFocusedPane(style styles.Styles, data ShellData, pane panes.PaneSnapshot) string {
	paneWidth := data.PaneLayout.Width
	if paneWidth <= 0 {
		paneWidth = data.Width
	}
	return renderPane(style, pane, maxInt(paneWidth, 8), maxInt(data.PaneLayout.Height, 8), data.ClipboardWriteReady, data.ConnectionStatus == "connected")
}

func renderGrid(style styles.Styles, paneSnapshots []panes.PaneSnapshot, layout panes.Layout, clipboardReady bool, lifecycleReady bool) string {
	columns := maxInt(layout.Columns, 1)
	rows := []string{}
	for start := 0; start < len(paneSnapshots); start += columns {
		end := minInt(start+columns, len(paneSnapshots))
		rowPanes := []string{}
		for _, pane := range paneSnapshots[start:end] {
			rowPanes = append(rowPanes, renderPane(style, pane, layout.PaneWidth, layout.PaneHeight, clipboardReady, lifecycleReady))
		}
		rows = append(rows, lipgloss.JoinHorizontal(lipgloss.Top, rowPanes...))
	}
	return lipgloss.JoinVertical(lipgloss.Left, rows...)
}

func renderPane(style styles.Styles, pane panes.PaneSnapshot, width int, height int, clipboardReady bool, lifecycleReady bool) string {
	width = maxInt(width, 8)
	height = maxInt(height, 6)

	// Width and height are the pane's complete outer geometry as projected by
	// panes.Layout. Lip Gloss v2 includes the frame in these dimensions.
	paneStyle := style.Pane.Width(width).Height(height)
	if pane.Selected {
		paneStyle = paneStyle.BorderForeground(style.Theme.Accent)
	}
	if pane.Focused {
		paneStyle = paneStyle.BorderForeground(style.Theme.Accent)
	}
	if pane.Color != "" && pane.Color != "default" {
		paneStyle = paneStyle.BorderForeground(lipgloss.Color(pane.Color))
	}
	if pane.Status == "failed" {
		paneStyle = paneStyle.BorderForeground(style.Theme.Error)
	}

	lines := []string{
		style.PaneTitle.Render(truncateText(pane.Title, width-4)),
		renderPaneStatusLine(style, pane, width-4),
	}
	if pane.RouteLabel != "" {
		lines = append(lines, truncateText("route "+pane.RouteLabel, width-4))
	}
	if pane.PID > 0 || pane.Port > 0 {
		lines = append(lines, truncateText(pidPortLine(pane), width-4))
	}
	copyEnabled := clipboardReady && (len(pane.LogLineModels) > 0 || len(pane.LogLines) > 0)
	lines = append(lines, renderPaneControls(style, copyEnabled, lifecycleReady))
	if pane.LastError != "" {
		lines = append(lines, truncateText("error "+pane.LastError, width-4))
	}
	logStart, logBudget := paneLogGeometry(style, pane, height)
	for len(lines) < logStart {
		lines = append(lines, "")
	}
	logModels := append([]panes.PaneLogLine(nil), pane.LogLineModels...)
	if len(logModels) == 0 && len(pane.LogLines) > 0 {
		for _, line := range pane.LogLines {
			logModels = append(logModels, panes.PaneLogLine{Text: line, Tone: panes.LogToneNeutral})
		}
	}
	if len(logModels) == 0 {
		logModels = []panes.PaneLogLine{{Text: "No logs yet", Tone: panes.LogToneMuted}}
	}
	if pane.LogError != "" {
		logModels = append([]panes.PaneLogLine{{Text: "logs unavailable: " + pane.LogError, Tone: panes.LogToneWarning}}, logModels...)
	}
	if logBudget == 0 {
		logModels = nil
	} else if len(logModels) > logBudget {
		logModels = logModels[len(logModels)-logBudget:]
	}
	for _, line := range logModels {
		lines = append(lines, paneLogStyle(style, line.Tone).Render(truncateText(line.Text, width-4)))
	}

	return paneStyle.Render(strings.Join(lines, "\n"))
}

func paneLogGeometry(style styles.Styles, pane panes.PaneSnapshot, height int) (start int, budget int) {
	start = 3 // title, status, controls
	if pane.RouteLabel != "" {
		start++
	}
	if pane.PID > 0 || pane.Port > 0 {
		start++
	}
	if pane.LastError != "" {
		start++
	}
	innerHeight := maxInt(1, height-style.Pane.GetVerticalFrameSize())
	if innerHeight-start > 1 {
		start++ // spacer before logs when geometry permits it
	}
	return start, maxInt(0, innerHeight-start)
}

func renderPaneControls(style styles.Styles, copyEnabled bool, restartEnabled bool) string {
	copyControl := style.ControlMuted.Render("[c]")
	if copyEnabled {
		copyControl = style.Control.Render("[c]")
	}
	restartControl := style.ControlMuted.Render("[r]")
	if restartEnabled {
		restartControl = style.Control.Render("[r]")
	}
	return copyControl + " " + restartControl + " " + style.ControlMuted.Render("[·]")
}

func paneLogStyle(style styles.Styles, tone panes.LogTone) lipgloss.Style {
	switch tone {
	case panes.LogToneSuccess:
		return style.PaneLogSuccess
	case panes.LogToneError:
		return style.PaneLogError
	case panes.LogToneWarning:
		return style.PaneLogWarning
	case panes.LogToneMuted:
		return style.PaneLogMuted
	case panes.LogToneStart:
		return style.PaneLogStart
	case panes.LogToneStop:
		return style.PaneLogStop
	default:
		return style.PaneLog
	}
}

func renderCommandPalette(style styles.Styles, data CommandPaletteData, width int) string {
	innerWidth := maxInt(12, width-2)
	lines := []string{}
	if len(data.Matches) == 0 {
		lines = append(lines, style.Muted.Render("No matching commands"))
	} else {
		for index, match := range data.Matches {
			label := match.Descriptor.Canonical
			if innerWidth >= 48 {
				label += " — " + match.Descriptor.Description
			}
			label = truncateText(label, innerWidth-2)
			if index == data.SelectedVisible {
				label = style.PaletteSelected.Render(label)
			}
			lines = append(lines, label)
		}
	}
	lines = append(lines, style.Muted.Render("↑↓ select • Tab/Enter complete • Esc close"))
	return style.Palette.Width(innerWidth).Render(strings.Join(lines, "\n"))
}

func renderStartCompletion(style styles.Styles, data StartCompletionData, width int) string {
	innerWidth := maxInt(12, width-2)
	lines := []string{style.Muted.Render("Registered apps for /start")}
	if len(data.Items) == 0 {
		lines = append(lines, style.Muted.Render("No matching registered apps"))
	} else {
		rows := registeredAppTableRows(data.Items)
		lines = append(lines, renderAppTable(style, innerWidth, len(rows), rows, data.SelectedVisible, 0))
	}
	footer := "↑↓ select • Tab complete • Enter open/submit • Esc close"
	if data.Total > len(data.Items) {
		footer = fmt.Sprintf("%d matches • %s", data.Total, footer)
	}
	lines = append(lines, style.Muted.Render(footer))
	return style.Palette.Width(innerWidth).Render(strings.Join(lines, "\n"))
}

func renderSearchableHelp(style styles.Styles, shell ShellData, data HelpData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	lines := []string{
		"Help — ? q/ctrl+c Ctrl+D Ctrl+O",
		"Search: " + data.SearchView,
		"PgUp/PgDn: pages; focused logs/older",
	}
	if len(data.Matches) == 0 {
		lines = append(lines, "No commands match this search.")
		return strings.Join(lines, "\n")
	}
	selected := clampInt(data.Selected, 0, len(data.Matches)-1)
	resultRows := minInt(8, maxInt(3, height/3))
	start := clampInt(selected-resultRows/2, 0, maxInt(0, len(data.Matches)-resultRows))
	end := minInt(len(data.Matches), start+resultRows)
	resultLines := []string{}
	for index := start; index < end; index++ {
		prefix := "  "
		if index == selected {
			prefix = "> "
		}
		resultLines = append(resultLines, truncateText(prefix+data.Matches[index].Descriptor.Canonical+" — "+data.Matches[index].Descriptor.Description, maxInt(18, width/2-2)))
	}
	descriptor := data.Matches[selected].Descriptor
	detailLines := []string{descriptor.Canonical, "category: " + descriptor.Category}
	switch descriptor.ConfirmationPolicy {
	case slash.ConfirmationWhenTargeted:
		detailLines = append(detailLines, "safety: chooser is read-only; targeted start requires confirmation")
	case slash.ConfirmationAlways:
		detailLines = append(detailLines, "safety: confirmation required")
	default:
		detailLines = append(detailLines, "safety: no confirmation required")
	}
	detailLines = append(detailLines, "", descriptor.Description, "", "Usage")
	for _, usage := range descriptor.Usages {
		detailLines = append(detailLines, "- "+usage)
	}
	detailLines = append(detailLines, "", "Examples")
	for _, example := range descriptor.Examples {
		detailLines = append(detailLines, "- "+example)
	}
	if len(descriptor.Aliases) > 0 {
		detailLines = append(detailLines, "", "Aliases", "- "+strings.Join(descriptor.Aliases, ", "))
	}
	detailLines = append(detailLines, "", "All operator keys")
	for _, binding := range shell.KeyMap.FullHelp() {
		help := binding.Help()
		detailLines = append(detailLines, "- "+help.Key+": "+help.Desc)
	}
	detailLines = append(detailLines,
		"",
		"Dashboard PageUp/PageDown changes pane pages.",
		"Focused pane PageUp/PageDown scrolls logs and fetches older logs when available.",
	)
	detailWidth := maxInt(20, width/2-2)
	detailHeight := maxInt(4, height-7)
	detailViewport := viewport.New(viewport.WithWidth(detailWidth), viewport.WithHeight(detailHeight))
	detailViewport.MouseWheelEnabled = false
	detailViewport.FillHeight = true
	detailViewport.SetContent(strings.Join(detailLines, "\n"))
	detailViewport.SetYOffset(data.DetailOffset)
	detail := detailViewport.View()
	content := ""
	if width >= 80 {
		results := strings.Join(resultLines, "\n")
		content = lipgloss.JoinHorizontal(lipgloss.Top, lipgloss.NewStyle().Width(width/2).Render(results), detail)
	} else {
		content = lipgloss.JoinVertical(lipgloss.Left, strings.Join(resultLines, "\n"), "", detail)
	}
	helpModel := bubbleshelp.New()
	helpModel.SetWidth(width)
	bindings := []bubbleskey.Binding{
		bubbleskey.NewBinding(bubbleskey.WithKeys("up", "down"), bubbleskey.WithHelp("↑↓", "select")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("ctrl+up", "ctrl+down"), bubbleskey.WithHelp("ctrl+↑↓", "detail")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("enter"), bubbleskey.WithHelp("enter", "insert")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("esc"), bubbleskey.WithHelp("esc", "close")),
	}
	footer := helpModel.ShortHelpView(bindings)
	lines = append(lines, content, "", footer)
	return strings.Join(lines, "\n")
}

type appTableRow struct {
	Name    string
	Project string
	Status  string
}

func registeredAppTableRows(items []inventory.Item) []appTableRow {
	rows := make([]appTableRow, 0, len(items))
	nameCounts := map[string]int{}
	for _, item := range items {
		nameCounts[strings.ToLower(cleanInlineText(valueOr(item.Name, item.ID)))]++
	}
	for _, item := range items {
		name := cleanInlineText(valueOr(item.Name, item.ID))
		if nameCounts[strings.ToLower(name)] > 1 {
			name += " [" + truncateText(cleanInlineText(item.ID), 12) + "]"
		}
		rows = append(rows, appTableRow{
			Name:    name,
			Project: item.Directory,
			Status:  valueOr(item.Status, "unknown"),
		})
	}
	return rows
}

func renderAppTable(style styles.Styles, width int, visibleRows int, rows []appTableRow, selected int, offset int) string {
	visibleRows = maxInt(1, visibleRows)
	start := clampInt(offset, 0, maxInt(0, len(rows)-visibleRows))
	end := minInt(len(rows), start+visibleRows)
	nameWidth, projectWidth, statusWidth := appTableColumnWidths(width)
	tableRows := make([]bubblestable.Row, 0, end-start)
	for _, row := range rows[start:end] {
		status := cleanInlineText(valueOr(row.Status, "unknown"))
		tableRows = append(tableRows, bubblestable.Row{
			cleanInlineText(valueOr(row.Name, "Unknown app")),
			shortProjectPath(row.Project, projectWidth),
			appStatusTone(style, status).Render(status),
		})
	}
	tableStyles := bubblestable.DefaultStyles()
	tableStyles.Header = lipgloss.NewStyle().Bold(true).Foreground(style.Theme.Muted).Padding(0, 1)
	tableStyles.Cell = lipgloss.NewStyle().Foreground(style.Theme.Text).Padding(0, 1)
	tableStyles.Selected = lipgloss.NewStyle().Bold(true).Foreground(style.Theme.Background).Background(style.Theme.Accent)
	model := bubblestable.New(
		bubblestable.WithColumns([]bubblestable.Column{
			{Title: "Name", Width: nameWidth},
			{Title: "Project", Width: projectWidth},
			{Title: "Status", Width: statusWidth},
		}),
		bubblestable.WithRows(tableRows),
		bubblestable.WithWidth(maxInt(1, width)),
		bubblestable.WithHeight(visibleRows+1),
		bubblestable.WithFocused(true),
		bubblestable.WithStyles(tableStyles),
	)
	if len(tableRows) > 0 {
		model.SetCursor(clampInt(selected-start, 0, len(tableRows)-1))
	}
	return model.View()
}

func appTableColumnWidths(width int) (int, int, int) {
	cellWidth := maxInt(3, width-6) // one cell of horizontal padding per column
	status := minInt(12, maxInt(5, cellWidth/4))
	name := maxInt(5, cellWidth*2/5)
	project := cellWidth - name - status
	if project < 3 {
		project = 3
		name = maxInt(1, cellWidth-status-project)
	}
	if name+project+status > cellWidth {
		status = maxInt(1, cellWidth-name-project)
	}
	return name, project, status
}

func appStatusTone(style styles.Styles, status string) lipgloss.Style {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "running", "ready", "healthy", "active":
		return lipgloss.NewStyle().Foreground(style.Theme.Success)
	case "failed", "error", "errored", "unavailable", "offline":
		return lipgloss.NewStyle().Foreground(style.Theme.Error)
	case "stopped", "warning", "warn", "degraded", "starting", "stopping", "pending", "checking", "connecting":
		return lipgloss.NewStyle().Foreground(style.Theme.Warning)
	default:
		return lipgloss.NewStyle().Foreground(style.Theme.Muted)
	}
}

func shortProjectPath(value string, width int) string {
	cleaned := strings.TrimSpace(cleanInlineText(value))
	if cleaned == "" {
		return "—"
	}
	// Registered apps can originate on a different host than the TUI. Treat
	// both path separators as display separators so the same daemon state has
	// the same readable projection on Windows, Linux, and macOS.
	cleaned = path.Clean(strings.ReplaceAll(cleaned, `\`, "/"))
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		home = path.Clean(strings.ReplaceAll(home, `\`, "/"))
		lowerPath := strings.ToLower(cleaned)
		lowerHome := strings.ToLower(home)
		if lowerPath == lowerHome {
			cleaned = "~"
		} else if strings.HasPrefix(lowerPath, lowerHome+"/") {
			cleaned = "~" + cleaned[len(home):]
		}
	}
	if ansi.StringWidth(cleaned) <= width {
		return cleaned
	}
	parts := strings.Split(strings.Trim(cleaned, "/"), "/")
	for keep := minInt(3, len(parts)); keep >= 1; keep-- {
		candidate := ".../" + strings.Join(parts[len(parts)-keep:], "/")
		if ansi.StringWidth(candidate) <= width {
			return candidate
		}
	}
	return truncateText(cleaned, maxInt(1, width))
}

func renderPaneReopenModal(style styles.Styles, shell ShellData, data PaneReopenData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	viewportHeight := paneReopenViewportRows(shell)
	contextLine := "Recently closed panes are listed first; opening a pane does not start or restart an app."
	if data.AppID != "" {
		contextLine = "Choose a monitoring pane for " + cleanInlineText(data.AppID) + "."
	}
	actionLine := "Enter opens the selected pane. Esc returns to the dashboard."
	if strings.TrimSpace(data.Notice) != "" {
		actionLine = cleanInlineText(data.Notice)
	}
	lines := []string{
		fmt.Sprintf("Reopen pane — %d available", len(data.Items)),
		contextLine,
		actionLine,
		"",
	}
	tableRows := make([]appTableRow, 0, len(data.Items))
	nameCounts := map[string]int{}
	for _, item := range data.Items {
		nameCounts[strings.ToLower(cleanInlineText(item.Name))]++
	}
	for _, item := range data.Items {
		name := cleanInlineText(item.Name)
		if nameCounts[strings.ToLower(name)] > 1 {
			name += " [" + truncateText(cleanInlineText(item.PaneID), 12) + "]"
		}
		tableRows = append(tableRows, appTableRow{Name: name, Project: item.Project, Status: valueOr(item.Status, "unknown")})
	}
	lines = append(lines, renderAppTable(style, width, viewportHeight, tableRows, data.Selected, data.Offset), "")
	helpModel := bubbleshelp.New()
	helpModel.SetWidth(width)
	bindings := []bubbleskey.Binding{
		bubbleskey.NewBinding(bubbleskey.WithKeys("up", "down"), bubbleskey.WithHelp("up/down", "select")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("pgup", "pgdown"), bubbleskey.WithHelp("pgup/pgdn", "page")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("enter"), bubbleskey.WithHelp("enter", "open pane")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("esc"), bubbleskey.WithHelp("esc", "close")),
	}
	lines = append(lines, helpModel.ShortHelpView(bindings))
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func paneReopenViewportRows(shell ShellData) int {
	return maxInt(1, maxInt(8, shell.Height-8)-7)
}

func renderAppManagerModal(style styles.Styles, shell ShellData, data AppManagerData) string {
	if data.Surface == "rename-editor" {
		return renderAppManagerRename(style, shell, data)
	}
	if data.Surface == "package-picker" {
		return renderAppPackagePicker(style, shell, data)
	}
	if data.Surface == "package-create" {
		return renderAppPackageCreate(style, shell, data)
	}
	if data.Surface == "actions" {
		return renderAppManagerActions(style, shell, data)
	}
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	viewportHeight := appManagerTableViewportRows(shell)
	title := fmt.Sprintf("Manage apps — %d registered", len(data.Items))
	if data.Mode == "start-picker" {
		title = fmt.Sprintf("Start app — %d registered", len(data.Items))
	}
	lines := []string{
		title,
		appManagerConnectionLine(data),
		appManagerActionLine(data),
		"",
	}
	tableRows := registeredAppTableRows(data.Items)
	if len(tableRows) == 0 {
		lines[2] = appManagerEmptyLine(data)
	}
	lines = append(lines, renderAppTable(style, width, viewportHeight, tableRows, data.Selected, data.Offset), "")

	helpModel := bubbleshelp.New()
	helpModel.SetWidth(width)
	bindings := []bubbleskey.Binding{
		bubbleskey.NewBinding(bubbleskey.WithKeys("up", "down"), bubbleskey.WithHelp("↑↓", "select")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("pgup", "pgdown"), bubbleskey.WithHelp("pgup/pgdn", "page")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("enter"), bubbleskey.WithHelp("enter", appManagerEnterHelp(data))),
		bubbleskey.NewBinding(bubbleskey.WithKeys("r"), bubbleskey.WithHelp("r", "refresh")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("esc"), bubbleskey.WithHelp("esc", "close")),
	}
	lines = append(lines, helpModel.ShortHelpView(bindings))
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderAppManagerRename(style styles.Styles, shell ShellData, data AppManagerData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	rename := data.Rename
	if rename == nil {
		return fixedRegion(lipgloss.NewStyle(), "Rename app\nRename editor state is unavailable.\n\nEsc back", width, height)
	}
	name := cleanInlineText(valueOr(rename.CurrentName, rename.StableID))
	notice := cleanInlineText(data.Notice)
	lines := []string{
		"Rename " + name,
		appManagerConnectionLine(data),
		"",
		"Stable ID    " + cleanInlineText(rename.StableID) + " — unchanged",
		"Current name " + name,
		"New name     " + rename.InputView,
		"",
		truncateText(valueOr(notice, "Enter requests a daemon-bound preview; no mutation occurs yet."), width),
		"",
	}
	helpModel := bubbleshelp.New()
	helpModel.SetWidth(width)
	bindings := []bubbleskey.Binding{
		bubbleskey.NewBinding(bubbleskey.WithKeys("enter"), bubbleskey.WithHelp("enter", "preview")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("ctrl+v"), bubbleskey.WithHelp("ctrl+v", "paste")),
		bubbleskey.NewBinding(bubbleskey.WithKeys("esc"), bubbleskey.WithHelp("esc", "back")),
	}
	lines = append(lines, helpModel.ShortHelpView(bindings))
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderAppManagerActions(style styles.Styles, shell ShellData, data AppManagerData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	item := inventory.Item{}
	if data.Selected >= 0 && data.Selected < len(data.Items) {
		item = data.Items[data.Selected]
	}
	name := cleanInlineText(valueOr(item.Name, item.ID))
	notice := "Enter reviews or runs the selected action through its existing safety boundary."
	if strings.TrimSpace(data.Notice) != "" {
		notice = cleanInlineText(data.Notice)
	}
	lines := []string{"Manage " + name, appManagerConnectionLine(data)}
	if height < 14 {
		lines = append(lines,
			truncateText("Status "+cleanInlineText(valueOr(item.Status, "unknown"))+"  |  Readiness "+cleanInlineText(valueOr(item.Readiness, "unknown")), width),
			"Project "+shortProjectPath(item.Directory, maxInt(8, width-8)),
		)
	} else {
		lines = append(lines,
			"",
			"Status      "+cleanInlineText(valueOr(item.Status, "unknown")),
			"Project     "+shortProjectPath(item.Directory, maxInt(8, width-13)),
			"Route       "+truncateText(cleanInlineText(valueOr(item.Route, "unavailable")), maxInt(8, width-13)),
			"Readiness   "+cleanInlineText(valueOr(item.Readiness, "unknown")),
			"",
			truncateText(notice, width),
			"",
		)
	}
	rows := appManagerActionViewportRows(shell)
	start := clampInt(data.ActionOffset, 0, maxInt(0, len(data.Actions)-rows))
	end := minInt(len(data.Actions), start+rows)
	rangeLine := fmt.Sprintf("Actions %d–%d of %d", minInt(start+1, len(data.Actions)), end, len(data.Actions))
	if start > 0 {
		rangeLine += fmt.Sprintf("  ↑ %d above", start)
	}
	if end < len(data.Actions) {
		rangeLine += fmt.Sprintf("  ↓ %d more", len(data.Actions)-end)
	}
	lines = append(lines, style.Muted.Render(truncateText(rangeLine, width)))
	for index := start; index < end; index++ {
		action := data.Actions[index]
		label := cleanInlineText(action.Label)
		if !action.Enabled {
			label += " — unavailable: " + cleanInlineText(action.DisabledReason)
		}
		label = truncateText(label, maxInt(1, width-2))
		prefix := "  "
		if index == data.SelectedAction {
			prefix = "> "
			label = style.PaletteSelected.Render(label)
		} else if !action.Enabled {
			label = style.Muted.Render(label)
		}
		lines = append(lines, prefix+label)
	}
	lines = append(lines, "", style.Muted.Render(truncateText("↑/↓ or wheel move • PgUp/PgDn page • Home/End jump • Enter select • R refresh • Esc back", width)))
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderRegistrationRepairModal(style styles.Styles, shell ShellData, data RegistrationRepairData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	lines := []string{
		"Registration repairs — " + cleanInlineText(data.AppID),
		"Choose the read-only repair preview to inspect.",
		"",
	}
	for index, choice := range data.Choices {
		label := cleanInlineText(choice.Label)
		if choice.Recommended {
			label += " [recommended]"
		}
		prefix := "  "
		if index == data.Selected {
			prefix = "> "
			label = style.PaletteSelected.Render(label)
		}
		lines = append(lines, prefix+label)
		if reason := cleanInlineText(choice.Reason); reason != "" {
			lines = append(lines, "    "+truncateText(reason, maxInt(1, width-4)))
		}
	}
	lines = append(lines, "", style.Muted.Render("↑↓ select • Enter preview • Esc close"))
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func appManagerTableViewportRows(shell ShellData) int {
	return maxInt(1, maxInt(8, shell.Height-8)-7)
}

func appManagerActionViewportRows(shell ShellData) int {
	return maxInt(1, maxInt(8, shell.Height-8)-14)
}

func appManagerActionStartY(shell ShellData) int {
	if maxInt(8, shell.Height-8) < 14 {
		return 5
	}
	return 11
}

func appManagerConnectionLine(data AppManagerData) string {
	switch data.ConnectionStatus {
	case "offline":
		if len(data.Items) > 0 {
			return "Daemon offline — showing last known registered apps; refresh is unavailable."
		}
		return "Daemon offline — registered apps are unavailable. Use /daemon repair."
	case "connecting":
		return "Connecting to the Relaybase daemon…"
	case "connected":
		if data.Refreshing {
			return "Refreshing registered apps from the Relaybase daemon…"
		}
		if data.StateKnown {
			return "Current daemon-backed registration state."
		}
	}
	return "Loading registered apps from the Relaybase daemon…"
}

func appManagerActionLine(data AppManagerData) string {
	if strings.TrimSpace(data.Notice) != "" {
		return cleanInlineText(data.Notice)
	}
	if data.ConnectionStatus != "connected" {
		if data.Mode == "manage" {
			return "Daemon-backed actions are unavailable; routes remain copyable when last-known data exists."
		}
		return "Start is unavailable until the Relaybase daemon is connected."
	}
	if len(data.Items) == 0 || data.Selected < 0 || data.Selected >= len(data.Items) {
		return "Use /register <path> or /add <path> to register an app."
	}
	if data.Mode == "manage" {
		return "Enter opens management actions for the selected app."
	}
	item := data.Items[data.Selected]
	status := strings.ToLower(strings.TrimSpace(item.Status))
	switch status {
	case "", "stopped":
		return "Enter reviews a confirmation-gated daemon start request."
	case "running":
		return "Enter opens this app's existing monitoring pane."
	case "starting", "stopping":
		return "Wait for the daemon transition to finish before choosing an action."
	case "failed", "degraded":
		return "Use /restart " + cleanInlineText(item.ID) + " to review a daemon restart request."
	default:
		return "This app cannot be started from its current state."
	}
}

func appManagerEnterHelp(data AppManagerData) string {
	if data.Selected < 0 || data.Selected >= len(data.Items) {
		return "unavailable"
	}
	if data.Mode == "manage" {
		return "actions"
	}
	switch strings.ToLower(strings.TrimSpace(data.Items[data.Selected].Status)) {
	case "running":
		return "open pane"
	case "", "stopped":
		return "review start"
	default:
		return "status guidance"
	}
}

func appManagerEmptyLine(data AppManagerData) string {
	if data.ConnectionStatus == "connected" && data.StateKnown {
		return "No registered apps. Use /register <path> or /add <path>."
	}
	if data.ConnectionStatus == "offline" {
		return "Registered apps cannot be loaded while the daemon is offline."
	}
	return "Loading registered apps…"
}

func renderDiagnosticsDrawer(diagnostics []DiagnosticLine) string {
	lines := []string{"Diagnostics", "Press Ctrl+D or Esc to return to the dashboard.", ""}
	if len(diagnostics) == 0 {
		return strings.Join(append(lines, "No diagnostics are present."), "\n")
	}
	for _, diagnostic := range diagnostics {
		lines = append(lines, fmt.Sprintf("- [%s] %s: %s", cleanInlineText(diagnostic.Severity), cleanInlineText(diagnostic.Code), cleanInlineText(diagnostic.Message)))
	}
	return strings.Join(lines, "\n")
}

func renderInventory(style styles.Styles, items []inventory.Item, width int) []string {
	lines := []string{
		"Registered apps — no monitoring panes are open",
		"Use ↑/↓ to choose a stopped app and Enter to review a daemon start request.",
		"Ctrl+O can reopen hidden monitoring panes.",
		"",
	}
	rows := registeredAppTableRows(items)
	selected := 0
	for index, item := range items {
		if item.Selected {
			selected = index
			break
		}
	}
	lines = append(lines, renderAppTable(style, width, maxInt(1, len(rows)), rows, selected, 0), "")
	if selected < len(items) {
		item := items[selected]
		lines = append(lines, inventorySelectionDetails(item)...)
	}
	return lines
}

func inventorySelectionDetails(item inventory.Item) []string {
	name := cleanInlineText(valueOr(item.Name, item.ID))
	lines := []string{"Selected: " + name}
	details := []string{}
	if readiness := strings.TrimSpace(item.Readiness); readiness != "" && !strings.EqualFold(readiness, item.Status) {
		details = append(details, "Readiness: "+cleanInlineText(readiness))
	}
	if lastError := strings.TrimSpace(item.LastError); lastError != "" {
		details = append(details, "Last error: "+cleanInlineText(lastError))
	}
	if len(details) > 0 {
		lines = append(lines, strings.Join(details, " • "))
	}
	switch {
	case item.CanStart():
		lines = append(lines, "Enter: review start")
	case item.Status == "running" || item.Status == "starting":
		lines = append(lines, "Monitoring pane hidden — use Ctrl+O to reopen it.")
	default:
		lines = append(lines, "No start action is available from the current daemon state.")
	}
	return lines
}

func renderConnectionState(data ShellData) string {
	switch data.ConnectionStatus {
	case "offline":
		lines := []string{
			"Relaybase daemon is offline",
			"",
			"The TUI is preserving local view state and retrying the daemon connection.",
			"Use /daemon repair when the launch bridge is available, or start relaybase serve in another terminal.",
		}
		if summary := diagnosticsSummary(data.Diagnostics); summary != "" {
			lines = append(lines, "", "Diagnostics: "+summary+". Press Ctrl+D for details.")
		}
		return strings.Join(lines, "\n")
	case "connecting":
		return "Connecting to Relaybase daemon…\n\nRegistered apps and monitoring panes will appear after daemon state loads."
	case "auth_needed":
		return "Relaybase authentication is required\n\nThe daemon is reachable, but this TUI cannot read its protected state. Run relaybase diagnose-token, then use /daemon retry."
	default:
		if !data.StateKnown {
			return "Loading Relaybase daemon state…"
		}
		return "Relaybase daemon state is temporarily unavailable."
	}
}

func diagnosticsSummary(diagnostics []DiagnosticLine) string {
	errors := 0
	warnings := 0
	info := 0
	for _, diagnostic := range diagnostics {
		switch strings.ToLower(strings.TrimSpace(diagnostic.Severity)) {
		case "error":
			errors++
		case "warning", "warn":
			warnings++
		default:
			info++
		}
	}
	parts := []string{}
	if errors > 0 {
		parts = append(parts, fmt.Sprintf("%dE", errors))
	}
	if warnings > 0 {
		parts = append(parts, fmt.Sprintf("%dW", warnings))
	}
	if info > 0 {
		parts = append(parts, fmt.Sprintf("%dI", info))
	}
	return strings.Join(parts, "/")
}

func actionableDiagnosticsSummary(diagnostics []DiagnosticLine) string {
	actionable := make([]DiagnosticLine, 0, len(diagnostics))
	for _, diagnostic := range diagnostics {
		severity := strings.ToLower(strings.TrimSpace(diagnostic.Severity))
		if severity == "error" || severity == "warning" || severity == "warn" {
			actionable = append(actionable, diagnostic)
		}
	}
	return diagnosticsSummary(actionable)
}

// BodyScrollMax returns the maximum safe body offset for keyboard navigation.
func BodyScrollMax(style styles.Styles, data ShellData) int {
	if data.OperatorConsole {
		metrics := layout.ComputeWithOptions(maxInt(data.Width, 1), maxInt(data.Height, 1), data.ComposerRows, layout.Options{AgentExpanded: data.AgentPaneExpanded})
		if metrics.ResizeRequired {
			return 0
		}
		if operatorOverlayScrollsWithBody(data) {
			bounds := metrics.Modal
			innerWidth := maxInt(1, bounds.Width-style.Help.GetHorizontalFrameSize())
			innerHeight := maxInt(1, bounds.Height-style.Help.GetVerticalFrameSize())
			projection := data
			projection.Width = innerWidth + 4
			projection.Height = innerHeight + 8
			content := operatorOverlayContent(style, projection)
			return renderBodyViewportFrame(content, innerHeight, maxIntValue(), innerWidth).Offset
		}
		projection := operatorPaneProjection(data)
		if operatorInventoryViewport(projection) {
			content := renderBody(style, projection)
			return renderBodyViewportFrame(content, metrics.Panes.Height, maxIntValue(), metrics.Panes.Width).Offset
		}
		return 0
	}
	width := data.Width
	if width <= 0 {
		width = 80
	}
	height := data.Height
	if height <= 0 {
		height = 24
	}
	header := style.Header.Width(width).Render("Relaybase TUI")
	status := style.Status.Width(width).Render("")
	assistant := components.RenderAssistantBar(style, "", width)
	paletteHeight := 0
	if data.StartCompletion != nil {
		paletteHeight = lipgloss.Height(renderStartCompletion(style, *data.StartCompletion, width))
	} else if data.CommandPalette != nil {
		paletteHeight = lipgloss.Height(renderCommandPalette(style, *data.CommandPalette, width))
	}
	bodyHeight := maxInt(1, height-lipgloss.Height(header)-lipgloss.Height(status)-paletteHeight-lipgloss.Height(assistant))
	body := lipgloss.NewStyle().MaxWidth(width).Render(renderBody(style, data))
	lineCount := len(strings.Split(body, "\n"))
	contentHeight := bodyHeight
	if lineCount > bodyHeight && bodyHeight > 1 {
		contentHeight--
	}
	return maxInt(0, lineCount-contentHeight)
}

// ResponseScrollMax returns the greatest safe response offset using the same
// Markdown wrapping and viewport geometry as the operator renderer.
func ResponseScrollMax(style styles.Styles, data ShellData) int {
	width := maxInt(data.Width, 1)
	height := maxInt(data.Height, 1)
	metrics := layout.ComputeWithOptions(width, height, data.ComposerRows, layout.Options{AgentExpanded: data.AgentPaneExpanded})
	if metrics.ResizeRequired {
		return 0
	}
	contentWidth := 0
	contentHeight := 0
	if data.AgentChatFull {
		contentWidth = width
		contentHeight = maxInt(1, metrics.Composer.Y)
	} else if data.ResponseDetails {
		content := overlayContentBounds(style.Help, metrics.Modal)
		contentWidth = content.Width
		contentHeight = content.Height
	} else if metrics.AgentDocked {
		panelStyle := agentDockStyle(style)
		contentWidth = maxInt(1, metrics.Agent.Width-panelStyle.GetHorizontalFrameSize())
		contentHeight = maxInt(1, metrics.Agent.Height-panelStyle.GetVerticalFrameSize())
	} else {
		return 0
	}
	if len(data.AgentTranscript) > 0 {
		layout := layoutAgentTranscript(data, contentWidth)
		viewportHeight := maxInt(1, contentHeight-2)
		visibleHeight := viewportHeight
		if layout.TotalRows > viewportHeight && viewportHeight > 1 {
			visibleHeight--
		}
		return maxInt(0, layout.TotalRows-visibleHeight)
	}
	content, _ := renderAgentTranscript(style, data, contentWidth)
	if strings.TrimSpace(content) == "" {
		source := strings.TrimSpace(data.ResponseSource)
		if source == "" {
			source = "No Agent output yet. Submit a request in Composer."
		}
		content = (safemarkdown.SafeMarkdownRenderer{}).Render(source, maxInt(20, contentWidth)).Text
	}
	return renderBodyViewportFrame(content, maxInt(1, contentHeight-2), maxIntValue(), contentWidth).Offset
}

// ResponseBottomOffset is an intention-revealing alias used when follow mode
// anchors new Agent output to the bottom of the response viewport.
func ResponseBottomOffset(style styles.Styles, data ShellData) int {
	return ResponseScrollMax(style, data)
}

// ResponseOffsetForTranscriptItem keeps keyboard selection visible using the
// exact transcript and viewport geometry used by the renderer.
func ResponseOffsetForTranscriptItem(style styles.Styles, data ShellData, itemID string) int {
	contentWidth, contentHeight, ok := responseViewportGeometry(style, data)
	if !ok || itemID == "" {
		return data.ResponseOffset
	}
	layout := layoutAgentTranscript(data, contentWidth)
	viewportHeight := maxInt(1, contentHeight-2)
	visibleHeight := viewportHeight
	if layout.TotalRows > viewportHeight && viewportHeight > 1 {
		visibleHeight--
	}
	maximum := maxInt(0, layout.TotalRows-visibleHeight)
	offset := clampInt(data.ResponseOffset, 0, maximum)
	for _, block := range layout.Blocks {
		item := data.AgentTranscript[block.ItemIndex]
		if item.ID != itemID {
			continue
		}
		if block.Rows > visibleHeight {
			return clampInt(block.Start, 0, maximum)
		}
		if block.Start < offset {
			return clampInt(block.Start, 0, maximum)
		}
		bottom := block.Start + block.Rows
		if bottom > offset+visibleHeight {
			return clampInt(bottom-visibleHeight, 0, maximum)
		}
		return offset
	}
	return offset
}

type AgentTranscriptAnchor struct {
	ItemID   string
	LocalRow int
}

// ResponseTranscriptAnchor captures the transcript row currently at the top
// of the active Agent viewport so terminal reflow can restore the same logical
// reading position instead of preserving an obsolete absolute row number.
func ResponseTranscriptAnchor(style styles.Styles, data ShellData) (AgentTranscriptAnchor, bool) {
	contentWidth, _, ok := responseViewportGeometry(style, data)
	if !ok || len(data.AgentTranscript) == 0 {
		return AgentTranscriptAnchor{}, false
	}
	layout := layoutAgentTranscript(data, contentWidth)
	offset := clampInt(data.ResponseOffset, 0, maxInt(0, layout.TotalRows-1))
	for _, block := range layout.Blocks {
		item := data.AgentTranscript[block.ItemIndex]
		if offset < block.Start {
			return AgentTranscriptAnchor{ItemID: item.ID}, true
		}
		if offset < block.Start+block.Rows {
			return AgentTranscriptAnchor{ItemID: item.ID, LocalRow: offset - block.Start}, true
		}
	}
	if len(layout.Blocks) == 0 {
		return AgentTranscriptAnchor{}, false
	}
	last := layout.Blocks[len(layout.Blocks)-1]
	item := data.AgentTranscript[last.ItemIndex]
	return AgentTranscriptAnchor{ItemID: item.ID, LocalRow: maxInt(0, last.Rows-1)}, true
}

func ResponseOffsetForTranscriptAnchor(style styles.Styles, data ShellData, anchor AgentTranscriptAnchor) int {
	contentWidth, contentHeight, ok := responseViewportGeometry(style, data)
	if !ok || anchor.ItemID == "" {
		return data.ResponseOffset
	}
	layout := layoutAgentTranscript(data, contentWidth)
	viewportHeight := maxInt(1, contentHeight-2)
	visibleHeight := viewportHeight
	if layout.TotalRows > viewportHeight && viewportHeight > 1 {
		visibleHeight--
	}
	maximum := maxInt(0, layout.TotalRows-visibleHeight)
	for _, block := range layout.Blocks {
		item := data.AgentTranscript[block.ItemIndex]
		if item.ID != anchor.ItemID {
			continue
		}
		localRow := clampInt(anchor.LocalRow, 0, maxInt(0, block.Rows-1))
		return clampInt(block.Start+localRow, 0, maximum)
	}
	return clampInt(data.ResponseOffset, 0, maximum)
}

func responseViewportGeometry(style styles.Styles, data ShellData) (int, int, bool) {
	width := maxInt(data.Width, 1)
	height := maxInt(data.Height, 1)
	metrics := layout.ComputeWithOptions(width, height, data.ComposerRows, layout.Options{AgentExpanded: data.AgentPaneExpanded})
	if metrics.ResizeRequired {
		return 0, 0, false
	}
	if data.AgentChatFull {
		return width, maxInt(1, metrics.Composer.Y), true
	}
	if data.ResponseDetails {
		content := overlayContentBounds(style.Help, metrics.Modal)
		return content.Width, content.Height, true
	}
	if metrics.AgentDocked {
		panelStyle := agentDockStyle(style)
		return maxInt(1, metrics.Agent.Width-panelStyle.GetHorizontalFrameSize()), maxInt(1, metrics.Agent.Height-panelStyle.GetVerticalFrameSize()), true
	}
	return 0, 0, false
}

func maxIntValue() int {
	return int(^uint(0) >> 1)
}

func contentWidth(width int) int {
	if width <= 0 {
		width = 80
	}
	return maxInt(width-4, 12)
}

func renderAssistantHistory(history []string) string {
	lines := []string{"Assistant"}
	for _, entry := range history {
		lines = append(lines, "- "+cleanInlineText(entry))
	}
	return strings.Join(lines, "\n")
}

func renderContextMenu(menu contextmenu.Snapshot) string {
	lines := []string{cleanInlineText(menu.Title)}
	for index, item := range menu.Items {
		prefix := "  "
		if index == menu.Selected {
			prefix = "> "
		}
		label := cleanInlineText(item.Label)
		if !item.Enabled {
			if item.DisabledReason != "" {
				label += " (unavailable: " + cleanInlineText(item.DisabledReason) + ")"
			} else {
				label += " (unavailable)"
			}
		}
		lines = append(lines, prefix+label)
	}
	return strings.Join(lines, "\n")
}

func renderConfirmation(confirmation ConfirmationData) string {
	lines := []string{
		"Confirm Action",
		"action: " + cleanInlineText(confirmation.Action),
		"target: " + cleanInlineText(confirmation.Target),
		"risk: " + cleanInlineText(confirmation.Risk),
		"expected: " + cleanInlineText(confirmation.ExpectedResult),
	}
	if len(confirmation.Details) > 0 {
		lines = append(lines, "details:")
		for _, detail := range confirmation.Details {
			lines = append(lines, "- "+cleanInlineText(detail))
		}
	}
	lines = append(lines,
		"",
		"Press Enter to confirm or Esc to cancel.",
	)
	return strings.Join(lines, "\n")
}

func renderHelp(data ShellData) string {
	lines := []string{
		"Help",
		"Ctrl+O opens the pane menu from the dashboard; while slash input is active it opens the assistant menu.",
		"Ctrl+O is the fallback when Ctrl+Z is intercepted by the terminal.",
		"Dashboard PageUp/PageDown changes pane pages.",
		"Focused pane PageUp/PageDown scrolls logs and fetches older logs when available.",
		"",
		"Keys",
	}
	for _, binding := range data.KeyMap.FullHelp() {
		lines = append(lines, "- "+binding.Help().Key+": "+binding.Help().Desc)
	}
	lines = append(lines, "")
	lines = append(lines, "Slash Commands")
	lines = append(lines, "- /launch <app|group|role>")
	lines = append(lines, "- /stop <app|group|role>")
	lines = append(lines, "- /restart <app|group|role>")
	lines = append(lines, "- /logs export <pane|app|group|page|all>")
	lines = append(lines, "- /page <next|prev|number>")
	lines = append(lines, "- /pane color <pane> <color>")
	lines = append(lines, "- /pin <pane>")
	lines = append(lines, "- /unpin <pane>")
	lines = append(lines, "- /theme <name>")
	lines = append(lines, "- /help")
	lines = append(lines, "- /manage")
	lines = append(lines, "- /daemon status")
	lines = append(lines, "- /daemon repair")
	lines = append(lines, "- /thread list")
	lines = append(lines, "- /thread new [title]")
	lines = append(lines, "- /thread switch <id|number>")
	lines = append(lines, "- /thread rename <title>")
	lines = append(lines, "- /thread clear")
	lines = append(lines, "- /thread export <json|markdown>")
	lines = append(lines, "- /thread preview")
	lines = append(lines, "- /add <path>")
	lines = append(lines, "- /add <path> using <command>")
	lines = append(lines, "- /register <manifest-or-project-path>")
	lines = append(lines, "- /configure current folder --dry-run")
	lines = append(lines, "- /configure <path>")
	lines = append(lines, "- /open <path-or-app>")
	lines = append(lines, "- /prove <app>")
	lines = append(lines, "- /health <app> --prove")
	lines = append(lines, "- /repair <app-or-path>")
	lines = append(lines, "- /manifest inspect <app-or-path>")
	lines = append(lines, "- /manifest edit <field> <value>")
	lines = append(lines, "- /health route <app> <route>")
	lines = append(lines, "- /port pinned <app> <port>")
	lines = append(lines, "- /component role <app> <role>")
	lines = append(lines, "- /component group <app> <groupId>")
	lines = append(lines, "- /component label <app> <label>")
	return strings.Join(lines, "\n")
}

func statusLine(pane panes.PaneSnapshot) string {
	parts := []string{"status " + pane.Status}
	if pane.Focused {
		parts = append(parts, "focused")
	} else if pane.Selected {
		parts = append(parts, "selected")
	}
	if pane.Follow {
		parts = append(parts, "follow on")
	} else {
		parts = append(parts, "follow off")
	}
	if pane.Pinned {
		parts = append(parts, "pinned")
	}
	if pane.NextBefore != "" {
		parts = append(parts, "older available")
	} else if pane.HasMore {
		parts = append(parts, "older unavailable")
	}
	if pane.ScrollOffset > 0 {
		parts = append(parts, fmt.Sprintf("scroll +%d", pane.ScrollOffset))
	}
	return strings.Join(parts, " | ")
}

func renderPaneStatusLine(style styles.Styles, pane panes.PaneSnapshot, width int) string {
	status := cleanInlineText(pane.Status)
	if status == "" {
		status = "unknown"
	}
	plain := statusLine(pane)
	prefix := "status "
	suffix := strings.TrimPrefix(plain, prefix+status)
	styled := prefix + paneStatusTone(style, status).Render(status) + suffix
	return truncateStyledText(styled, width)
}

func paneStatusTone(style styles.Styles, status string) lipgloss.Style {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "running", "ready", "healthy", "active":
		return lipgloss.NewStyle().Foreground(style.Theme.Success)
	case "stopped", "failed", "error", "errored", "conflict", "unavailable", "offline":
		return lipgloss.NewStyle().Foreground(style.Theme.Error)
	case "starting", "stopping", "restarting", "degraded", "warning", "pending", "unknown":
		return lipgloss.NewStyle().Foreground(style.Theme.Warning)
	default:
		return lipgloss.NewStyle().Foreground(style.Theme.Muted)
	}
}

func pidPortLine(pane panes.PaneSnapshot) string {
	parts := []string{}
	if pane.PID > 0 {
		parts = append(parts, fmt.Sprintf("pid %d", pane.PID))
	}
	if pane.Port > 0 {
		parts = append(parts, fmt.Sprintf("backend port %d", pane.Port))
	}
	return strings.Join(parts, " | ")
}

func truncateText(value string, width int) string {
	if width <= 0 {
		return ""
	}
	value = cleanInlineText(value)
	if lipgloss.Width(value) <= width {
		return value
	}
	if width == 1 {
		return "."
	}
	budget := width - lipgloss.Width(".")
	var visible strings.Builder
	for _, character := range value {
		candidate := visible.String() + string(character)
		if lipgloss.Width(candidate) > budget {
			break
		}
		visible.WriteRune(character)
	}
	return visible.String() + "."
}

func cleanInlineText(value string) string {
	value = safemarkdown.SanitizeTerminalText(value)
	value = ansiEscapePattern.ReplaceAllString(value, "")
	value = oneLineText(value)
	return strings.Map(func(char rune) rune {
		if char < 32 && char != '\t' {
			return ' '
		}
		return char
	}, value)
}

func valueOr(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func clampInt(value int, minimum int, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}
