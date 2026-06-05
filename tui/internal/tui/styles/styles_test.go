package styles

import "testing"

func TestThemeFallbackForUnsupportedTerminal(t *testing.T) {
	env := map[string]string{
		"TERM":     "dumb",
		"NO_COLOR": "1",
	}
	theme, diagnostics := ResolveTheme("auto", func(key string) string { return env[key] })

	if theme.Mode != "dark" {
		t.Fatalf("expected dark fallback, got %s", theme.Mode)
	}
	if len(diagnostics) == 0 || diagnostics[0].Code != "terminal_color_fallback" {
		t.Fatalf("expected terminal_color_fallback diagnostic, got %#v", diagnostics)
	}
}
