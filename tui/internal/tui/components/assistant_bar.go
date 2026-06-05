package components

import "github.com/cameloo/relaybase/tui/internal/tui/styles"

func RenderAssistantBar(style styles.Styles, prompt string, width int) string {
	if width > 0 {
		return style.Assistant.Width(width).Render(prompt)
	}
	return style.Assistant.Render(prompt)
}
