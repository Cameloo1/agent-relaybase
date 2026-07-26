package styles

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

type Theme struct {
	Name       string
	Mode       string
	Background color.Color
	Text       color.Color
	Border     color.Color
	Muted      color.Color
	Accent     color.Color
	Warning    color.Color
	Error      color.Color
	Success    color.Color
}

type Diagnostic struct {
	Code     string
	Severity string
	Message  string
}

type Styles struct {
	Theme           Theme
	Header          lipgloss.Style
	Status          lipgloss.Style
	Body            lipgloss.Style
	Diagnostic      lipgloss.Style
	Assistant       lipgloss.Style
	Help            lipgloss.Style
	Muted           lipgloss.Style
	Pane            lipgloss.Style
	PaneTitle       lipgloss.Style
	PaneLog         lipgloss.Style
	PaneLogSuccess  lipgloss.Style
	PaneLogError    lipgloss.Style
	PaneLogWarning  lipgloss.Style
	PaneLogMuted    lipgloss.Style
	PaneLogStart    lipgloss.Style
	PaneLogStop     lipgloss.Style
	Control         lipgloss.Style
	ControlMuted    lipgloss.Style
	Palette         lipgloss.Style
	PaletteSelected lipgloss.Style
}

type Options struct {
	AssistantBarColor string
}

type ThemeOption struct {
	ID   string
	Name string
}

var themeOptions = []ThemeOption{
	{ID: "auto", Name: "Automatic"},
	{ID: "light", Name: "Relaybase Light"},
	{ID: "dark", Name: "Relaybase Dark"},
	{ID: "terminal-green", Name: "Terminal Green"},
	{ID: "code-blue", Name: "Code Blue"},
	{ID: "pure-black", Name: "Pure Black"},
	{ID: "amber-crt", Name: "Amber CRT"},
	{ID: "arctic-slate", Name: "Arctic Slate"},
	{ID: "plum-night", Name: "Plum Night"},
}

// ThemeOptions is the ordered selection contract shared by preferences,
// settings, slash commands, and CLI help.
func ThemeOptions() []ThemeOption {
	return append([]ThemeOption(nil), themeOptions...)
}

func ThemeIDs() []string {
	ids := make([]string, 0, len(themeOptions))
	for _, option := range themeOptions {
		ids = append(ids, option.ID)
	}
	return ids
}

func ThemeUsage() string {
	return strings.Join(ThemeIDs(), "|")
}

func ThemeList() string {
	return strings.Join(ThemeIDs(), ", ")
}

func IsThemeID(value string) bool {
	trimmed := strings.TrimSpace(value)
	for _, option := range themeOptions {
		if trimmed == option.ID {
			return true
		}
	}
	return false
}

func ThemeDisplayName(value string) string {
	trimmed := strings.TrimSpace(value)
	for _, option := range themeOptions {
		if trimmed == option.ID {
			return option.Name
		}
	}
	return trimmed
}

func ResolveTheme(mode string, getenv func(string) string) (Theme, []Diagnostic) {
	normalized := strings.ToLower(strings.TrimSpace(mode))
	if normalized == "" {
		normalized = "auto"
	}

	diagnostics := []Diagnostic{}
	if getenv != nil {
		term := strings.ToLower(strings.TrimSpace(getenv("TERM")))
		if term == "dumb" || strings.TrimSpace(getenv("NO_COLOR")) != "" {
			diagnostics = append(diagnostics, Diagnostic{
				Code:     "terminal_color_fallback",
				Severity: "info",
				Message:  "Terminal color support is limited; using high-contrast fallback styling.",
			})
			return darkTheme("dark-fallback"), diagnostics
		}
	}

	if normalized == "auto" {
		return lightTheme(), diagnostics
	}
	if theme, ok := resolveTheme(normalized); ok {
		return theme, diagnostics
	}
	diagnostics = append(diagnostics, Diagnostic{
		Code:     "theme_mode_unknown",
		Severity: "warning",
		Message:  "Unknown theme mode; using Relaybase light theme.",
	})
	return lightTheme(), diagnostics
}

func New(theme Theme) Styles {
	return NewWithOptions(theme, Options{})
}

func NewWithOptions(theme Theme, options Options) Styles {
	assistantColor := AssistantColor(theme, options.AssistantBarColor)
	return Styles{
		Theme: theme,
		Header: lipgloss.NewStyle().
			Foreground(theme.Text).
			Background(theme.Background).
			Border(lipgloss.NormalBorder(), false, false, true, false).
			BorderForeground(theme.Border).
			Padding(0, 1),
		Status: lipgloss.NewStyle().
			Foreground(theme.Muted).
			Background(theme.Background).
			Padding(0, 1),
		Body: lipgloss.NewStyle().
			Foreground(theme.Text).
			Background(theme.Background).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(theme.Border).
			Padding(1, 2),
		Diagnostic: lipgloss.NewStyle().
			Foreground(theme.Warning).
			Background(theme.Background),
		Assistant: lipgloss.NewStyle().
			Foreground(assistantColor).
			Background(theme.Background).
			Border(lipgloss.NormalBorder(), true, false, false, false).
			BorderForeground(theme.Border).
			Padding(0, 1),
		Help: lipgloss.NewStyle().
			Foreground(theme.Text).
			Background(theme.Background).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(theme.Border).
			Padding(1, 2),
		Muted: lipgloss.NewStyle().
			Foreground(theme.Muted).
			Background(theme.Background),
		Pane: lipgloss.NewStyle().
			Foreground(theme.Text).
			Background(theme.Background).
			Border(lipgloss.NormalBorder()).
			BorderForeground(theme.Border).
			Padding(0, 1),
		PaneTitle: lipgloss.NewStyle().
			Foreground(theme.Accent).
			Background(theme.Background),
		PaneLog: lipgloss.NewStyle().
			Foreground(theme.Text).
			Background(theme.Background),
		PaneLogSuccess: lipgloss.NewStyle().Foreground(theme.Success).Background(theme.Background),
		PaneLogError:   lipgloss.NewStyle().Foreground(theme.Error).Background(theme.Background),
		PaneLogWarning: lipgloss.NewStyle().Foreground(theme.Warning).Background(theme.Background),
		PaneLogMuted:   lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.Background),
		PaneLogStart:   lipgloss.NewStyle().Foreground(theme.Success).Background(theme.Background),
		PaneLogStop:    lipgloss.NewStyle().Foreground(theme.Error).Background(theme.Background),
		Control:        lipgloss.NewStyle().Foreground(theme.Accent).Background(theme.Background).Bold(true),
		ControlMuted:   lipgloss.NewStyle().Foreground(theme.Muted).Background(theme.Background),
		Palette: lipgloss.NewStyle().Foreground(theme.Text).Background(theme.Background).
			Border(lipgloss.NormalBorder(), true, false, false, false).BorderForeground(theme.Border).Padding(0, 1),
		PaletteSelected: lipgloss.NewStyle().Foreground(theme.Background).Background(theme.Accent).Bold(true),
	}
}

// AssistantColor resolves the operator-selected assistant accent once so the
// shell and the Bubbles composer cannot drift onto different prompt colors.
func AssistantColor(theme Theme, configured string) color.Color {
	if configured != "" && configured != "default" {
		return lipgloss.Color(configured)
	}
	return theme.Accent
}

func lightTheme() Theme {
	return Theme{
		Name:       "Relaybase Light",
		Mode:       "light",
		Background: lipgloss.Color("#f8f4ec"),
		Text:       lipgloss.Color("#2f2118"),
		Border:     lipgloss.Color("#6d4c3d"),
		Muted:      lipgloss.Color("#7d6a5f"),
		Accent:     lipgloss.Color("#216869"),
		Warning:    lipgloss.Color("#8a5a00"),
		Error:      lipgloss.Color("#9b1c31"),
		Success:    lipgloss.Color("#287a3d"),
	}
}

func darkTheme(name string) Theme {
	return Theme{
		Name:       "Relaybase " + titleWords(name),
		Mode:       "dark",
		Background: lipgloss.Color("#171412"),
		Text:       lipgloss.Color("#f4efe6"),
		Border:     lipgloss.Color("#8b6b55"),
		Muted:      lipgloss.Color("#b8a99b"),
		Accent:     lipgloss.Color("#71b7b8"),
		Warning:    lipgloss.Color("#f2bd5c"),
		Error:      lipgloss.Color("#ff7a8a"),
		Success:    lipgloss.Color("#61d381"),
	}
}

func resolveTheme(mode string) (Theme, bool) {
	switch mode {
	case "light":
		return lightTheme(), true
	case "dark":
		return darkTheme("dark"), true
	case "terminal-green":
		return darkVariantTheme(
			mode,
			"Terminal Green",
			"#050805",
			"#55ff55",
			"#1fc742",
			"#2fb344",
			"#7cff6b",
		), true
	case "code-blue":
		return darkVariantTheme(
			mode,
			"Code Blue",
			"#1e1e1e",
			"#d4d4d4",
			"#3d6f96",
			"#9da5b4",
			"#4fc1ff",
		), true
	case "pure-black":
		return darkVariantTheme(
			mode,
			"Pure Black",
			"#000000",
			"#f2f2f2",
			"#3a3a3a",
			"#a0a0a0",
			"#ffffff",
		), true
	case "amber-crt":
		return darkVariantTheme(
			mode,
			"Amber CRT",
			"#100b00",
			"#ffbf00",
			"#7a5000",
			"#c18f28",
			"#ffd166",
		), true
	case "arctic-slate":
		return darkVariantTheme(
			mode,
			"Arctic Slate",
			"#222832",
			"#dce3ec",
			"#53657a",
			"#9aa8ba",
			"#88c0d0",
		), true
	case "plum-night":
		return darkVariantTheme(
			mode,
			"Plum Night",
			"#19131f",
			"#e9e0f0",
			"#684c78",
			"#aa9aaf",
			"#c792ea",
		), true
	default:
		return Theme{}, false
	}
}

// darkVariantTheme changes only presentation colors. Semantic status colors
// are inherited from the existing Relaybase dark theme without modification.
func darkVariantTheme(mode string, name string, background string, text string, border string, muted string, accent string) Theme {
	theme := darkTheme("dark")
	theme.Name = name
	theme.Mode = mode
	theme.Background = lipgloss.Color(background)
	theme.Text = lipgloss.Color(text)
	theme.Border = lipgloss.Color(border)
	theme.Muted = lipgloss.Color(muted)
	theme.Accent = lipgloss.Color(accent)
	return theme
}

func titleWords(value string) string {
	words := strings.Fields(strings.ReplaceAll(value, "-", " "))
	for index, word := range words {
		if word == "" {
			continue
		}
		words[index] = strings.ToUpper(word[:1]) + word[1:]
	}
	return strings.Join(words, " ")
}
