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

	switch normalized {
	case "dark":
		return darkTheme("dark"), diagnostics
	case "light":
		return lightTheme(), diagnostics
	case "auto":
		return lightTheme(), diagnostics
	default:
		diagnostics = append(diagnostics, Diagnostic{
			Code:     "theme_mode_unknown",
			Severity: "warning",
			Message:  "Unknown theme mode; using Relaybase light theme.",
		})
		return lightTheme(), diagnostics
	}
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
